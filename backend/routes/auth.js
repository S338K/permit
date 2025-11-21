const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Admin = require('../models/admin');
const Approver = require('../models/approver');
const User = require('../models/user');
require('dotenv').config();
const logger = require('../logger');

// ----- REGISTER -----
router.post('/register', async (req, res) => {
  try {
    const { username, company, email, phone, mobile, password, role, city, country } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Server-side validation rules (mirror client-side rules)
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const alphaRe = /^[A-Za-z\s]+$/;
    const numericRe = /^\d+$/;
    const phoneRe = /^\+974\d{8,}$/;
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        message:
          'Password must be minimum 8 characters and contain upper, lower case letters, a number and special characters.',
      });
    }

    // Require confirmPassword and ensure it matches password
    if (
      typeof req.body.confirmPassword === 'undefined' ||
      String(req.body.confirmPassword || '').trim() === ''
    ) {
      return res.status(400).json({ message: 'Confirm Password is required.' });
    }
    const confirm = String(req.body.confirmPassword || '');
    if (confirm !== String(password || '')) {
      return res.status(400).json({ message: 'Password and Confirm Password do not match.' });
    }

    if (!emailRe.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }

    // Validate username and company (letters and spaces only)
    if (username && !alphaRe.test(username)) {
      return res.status(400).json({ message: 'Full name should contain letters only.' });
    }
    if (company && !alphaRe.test(company)) {
      return res.status(400).json({ message: 'Company name should contain letters only.' });
    }

    // Ensure email is unique across all account collections
    const emailExists =
      (await Admin.findOne({ email })) ||
      (await Approver.findOne({ email })) ||
      (await User.findOne({ email }));
    if (emailExists) return res.status(409).json({ message: 'Email id is already in use.' });

    // Ensure phone number is provided and valid
    let phoneVal = (phone && phone.trim()) || (mobile && mobile.trim()) || '';
    if (!phoneVal) {
      return res.status(400).json({ message: 'Phone number is required.' });
    }
    // normalize separators so values like '+974 1234-5678' are accepted
    phoneVal = phoneVal.replace(/[\s\-()]/g, '');
    if (!phoneRe.test(phoneVal)) {
      return res
        .status(400)
        .json({ message: 'Phone must start with +974 and contain at least 8 digits.' });
    }

    // Accept either `phone` or `mobile` from different frontends/forms and validate
    const newUser = new User({
      username,
      email,
      phone: phoneVal,
      password, // plain text here, pre-save hook will hash it
      company: company || '',
      role: role || 'Requester',
      lastLogin: null,
    });

    // Validate city/country (alpha)
    if (city && city.trim() && !alphaRe.test(city.trim())) {
      return res.status(400).json({ message: 'City should contain letters only.' });
    }
    if (country && country.trim() && !alphaRe.test(country.trim())) {
      return res.status(400).json({ message: 'Country should contain letters only.' });
    }

    // Ensure phone number is unique across Admin, Approver and User collections
    const phoneExists =
      (await Admin.findOne({ phone: phoneVal })) ||
      (await Approver.findOne({ phone: phoneVal })) ||
      (await User.findOne({ phone: phoneVal }));
    if (phoneExists) return res.status(409).json({ message: 'Phone number is already in use' });

    await newUser.save();
    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        company: newUser.company,
        phone: newUser.phone,
        role: newUser.role,
        lastLogin: newUser.lastLogin,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Registration error');
    res.status(500).json({ message: 'Something went wrong', error: err.message });
  }
});

// ----- LOGIN -----
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        field: !email ? 'email' : 'password',
        message: 'Email address and password are required',
      });
    }

    // 🔎 Try each collection in turn
    let account = await Admin.findOne({ email });
    if (!account) account = await Approver.findOne({ email });
    if (!account) account = await User.findOne({ email });

    if (!account) {
      return res.status(400).json({
        field: 'email',
        message: 'Please enter a valid email address.',
      });
    }

    // Debug logging
    // Safely build a sample of the stored password hash for debug (only if string)
    const passwordSample =
      typeof account.password === 'string' ? account.password.slice(0, 20) + '...' : null;
    logger.debug(
      {
        emailFromBody: email,
        passwordProvided: !!password,
        accountRole: account.role,
        accountHasPassword: !!account.password,
        accountPasswordSample: passwordSample,
      },
      'Login attempt'
    );

    // ✅ Compare using schema method — guard against comparePassword throwing (malformed/missing hash)
    let passwordMatch = false;
    try {
      passwordMatch = await account.comparePassword(password);
    } catch (pwErr) {
      // Log at warn level and return a validation-like error instead of a 500
      logger.warn({ pwErr, accountId: account._id }, 'Password comparison failed');
      return res.status(400).json({ field: 'password', message: 'Please enter a valid password.' });
    }
    if (!passwordMatch) {
      return res.status(400).json({ field: 'password', message: 'Please enter a valid password.' });
    }

    // ---- Single active-session enforcement ----
    // Detect client info for context
    const userAgent = req.headers['user-agent'] || '';
    let clientIp = null;
    try {
      const xff = req.headers['x-forwarded-for'];
      if (xff) clientIp = String(xff).split(',')[0].trim();
      if (!clientIp && req.headers['cf-connecting-ip']) clientIp = req.headers['cf-connecting-ip'];
      if (!clientIp && req.headers['x-real-ip']) clientIp = req.headers['x-real-ip'];
      if (!clientIp && req.socket && req.socket.remoteAddress) clientIp = req.socket.remoteAddress;
      if (!clientIp && req.ip) clientIp = req.ip;
    } catch (_) {
      clientIp = req.ip || null;
    }

    const displayName = account.fullName || account.username || account.email;

    // If there's an existing active session for this account, and it's still live, block unless force=true
    if (account.activeSessionId) {
      try {
        await new Promise((resolve) => {
          req.sessionStore.get(account.activeSessionId, (_err, sess) => {
            // If session exists and is not the same as current (new) session id, it's an active conflict
            const hasConflict = !!sess && account.activeSessionId !== req.sessionID;
            if (hasConflict && !req.body.force) {
              return res.status(409).json({
                code: 'ACTIVE_SESSION',
                message: `You're already signed in as ${displayName} on another device or browser. Continue here to sign out there and use this device instead?`,
                user: { displayName },
              });
            }
            // If force requested and a prior session exists, destroy it
            if (hasConflict && req.body.force) {
              req.sessionStore.destroy(account.activeSessionId, () => resolve());
              return;
            }
            resolve();
          });
        });
      } catch (e) {
        // ignore store errors; proceed with login
      }
    }

    // 🔑 Set session values
    req.session.userId = account._id;
    req.session.userRole = account.role;
    req.session.cookie.maxAge = 2 * 60 * 60 * 1000; // 2 hours

    // Save previous login before updating
    const previousLogin = account.lastLogin;

    // Move lastLogin → prevLogin
    account.prevLogin = previousLogin;

    // Update lastLogin to now
    account.lastLogin = new Date();
    await account.save();

    req.session.save(async (err) => {
      if (err) {
        logger.error({ err }, 'Session save error');
        return res.status(500).json({ message: 'Failed to save session' });
      }

      // Record this session as the active one on the account
      try {
        account.activeSessionId = req.sessionID;
        account.activeSessionCreatedAt = new Date();
        account.activeSessionUserAgent = userAgent;
        account.activeSessionIp = clientIp;
        await account.save();
      } catch (e) {
        logger.warn({ e }, 'Failed to persist activeSession metadata');
      }

      // ---- Issue access + refresh tokens for per-tab authentication ----
      try {
        const jwt = require('jsonwebtoken');
        const accessExpiry = process.env.ACCESS_TOKEN_EXPIRES || '15m';
        const refreshExpiryMs = parseInt(
          process.env.REFRESH_TOKEN_MAX_AGE_MS || String(7 * 24 * 60 * 60 * 1000),
          10
        );
        const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-jwt-secret';

        // Use a lightweight random id for refresh token rotation (jti)
        const refreshId = require('crypto').randomBytes(16).toString('hex');

        const accessToken = jwt.sign({ sub: String(account._id), role: account.role }, secret, {
          expiresIn: accessExpiry,
        });

        const refreshToken = jwt.sign(
          { sub: String(account._id), role: account.role, jti: refreshId },
          secret,
          { expiresIn: Math.floor(refreshExpiryMs / 1000) + 's' }
        );

        // Persist refresh id so we can validate/rotate/revoke refresh tokens
        try {
          account.refreshTokenId = refreshId;
          await account.save();
        } catch (e) {
          logger.warn({ e }, 'Failed to persist refreshTokenId');
        }

        // Set refresh token as httpOnly cookie (rotate on login)
        res.cookie('refreshToken', refreshToken, {
          httpOnly: true,
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge: refreshExpiryMs,
          path: '/api',
        });

        // Return access token in body so frontend can store in sessionStorage
        return res.json({
          message: 'Login successful',
          accessToken,
          user: {
            id: account._id,
            username: account.username,
            email: account.email,
            company: account.company,
            role: account.role,
            lastLogin: account.lastLogin?.toISOString(),
            prevLogin: previousLogin
              ? previousLogin.toISOString()
              : account.lastLogin?.toISOString(),
          },
        });
      } catch (tokenErr) {
        logger.warn(
          { tokenErr },
          'Failed to create tokens - falling back to session-only response'
        );
        return res.json({
          message: 'Login successful',
          user: {
            id: account._id,
            username: account.username,
            email: account.email,
            company: account.company,
            role: account.role,
            lastLogin: account.lastLogin?.toISOString(),
            prevLogin: previousLogin
              ? previousLogin.toISOString()
              : account.lastLogin?.toISOString(),
          },
        });
      }
    });
  } catch (err) {
    logger.error({ err }, 'Login error');
    res.status(500).json({
      message: 'Something went wrong, try again',
      error: err.message,
    });
  }
});

// ----- PROFILE -----
router.get('/profile', async (req, res) => {
  try {
    if (!req.session.userId)
      return res.status(401).json({ message: 'Unauthorized - session expired' });

    let user = null;
    const role = req.session.userRole;
    if (role === 'Admin') {
      const Admin = require('../models/admin');
      user = await Admin.findById(req.session.userId).select('-password');
    } else if (role === 'Approver' || role === 'PreApprover') {
      const Approver = require('../models/approver');
      user = await Approver.findById(req.session.userId).select('-password');
    } else {
      user = await User.findById(req.session.userId).select(
        '-password -resetPasswordToken -resetPasswordExpires'
      );
    }

    if (!user) {
      const Admin = require('../models/admin');
      const Approver = require('../models/approver');
      user =
        (await User.findById(req.session.userId).select(
          '-password -resetPasswordToken -resetPasswordExpires'
        )) ||
        (await Approver.findById(req.session.userId).select('-password')) ||
        (await Admin.findById(req.session.userId).select('-password'));
    }

    if (!user) {
      req.session.destroy();
      return res.status(401).json({ message: 'Unauthorized - user not found' });
    }

    // Provide client IP (prefer common proxy headers, then socket remote address)
    let clientIp = null;
    try {
      const xff = req.headers['x-forwarded-for'];
      if (xff) {
        clientIp = String(xff).split(',')[0].trim();
      }
      if (!clientIp && req.headers['cf-connecting-ip']) clientIp = req.headers['cf-connecting-ip'];
      if (!clientIp && req.headers['x-real-ip']) clientIp = req.headers['x-real-ip'];
      if (!clientIp && req.socket && req.socket.remoteAddress) clientIp = req.socket.remoteAddress;
      if (!clientIp && req.ip) clientIp = req.ip;
    } catch (e) {
      clientIp = req.ip || null;
    }
    const safeUser = user.toObject ? user.toObject() : { ...user };
    safeUser.profileUpdatedAt = safeUser.profileUpdatedAt
      ? safeUser.profileUpdatedAt.toISOString()
      : null;
    safeUser.passwordUpdatedAt = safeUser.passwordUpdatedAt
      ? safeUser.passwordUpdatedAt.toISOString()
      : null;

    try {
      const ipSource = req.headers['x-forwarded-for']
        ? 'x-forwarded-for'
        : req.headers['cf-connecting-ip']
          ? 'cf-connecting-ip'
          : req.headers['x-real-ip']
            ? 'x-real-ip'
            : req.socket && req.socket.remoteAddress
              ? 'socket.remoteAddress'
              : req.ip
                ? 'req.ip'
                : 'unknown';
      logger.debug({ clientIp, ipSource }, 'Profile response - client IP detected');
    } catch (e) {
      // ignore
    }

    res.json({
      user: safeUser,
      session: { id: req.session.userId, role: req.session.userRole },
      clientIp,
    });
  } catch (err) {
    logger.error({ err }, 'Profile fetch error');
    res.status(500).json({ message: 'Unable to fetch profile', error: err.message });
  }
});

// LOGOUT (Support both session-based and token-based logouts)
router.post('/logout', async (req, res) => {
  const sessionId = req.sessionID;
  const role = req.session && req.session.userRole;
  const userId = req.session && req.session.userId;

  // Clear refresh cookie in all cases
  res.clearCookie('refreshToken', { path: '/api' });

  // If there's a session, destroy it and clear activeSessionId on account
  if (req.session) {
    req.session.destroy(async (err) => {
      if (err) {
        logger.error({ err }, 'Logout error');
        return res.status(500).json({ message: 'Logout failed' });
      }
      res.clearCookie('sessionId', {
        httpOnly: true,
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        secure: process.env.NODE_ENV === 'production',
      });

      // Clear activeSessionId on the account if it matches this session
      try {
        if (userId && role) {
          if (role === 'Admin') {
            const Admin = require('../models/admin');
            await Admin.updateOne(
              { _id: userId, activeSessionId: sessionId },
              {
                $unset: {
                  activeSessionId: 1,
                  activeSessionCreatedAt: 1,
                  activeSessionUserAgent: 1,
                  activeSessionIp: 1,
                },
              }
            );
          } else if (role === 'Approver' || role === 'PreApprover') {
            const Approver = require('../models/approver');
            await Approver.updateOne(
              { _id: userId, activeSessionId: sessionId },
              {
                $unset: {
                  activeSessionId: 1,
                  activeSessionCreatedAt: 1,
                  activeSessionUserAgent: 1,
                  activeSessionIp: 1,
                },
              }
            );
          } else {
            await User.updateOne(
              { _id: userId, activeSessionId: sessionId },
              {
                $unset: {
                  activeSessionId: 1,
                  activeSessionCreatedAt: 1,
                  activeSessionUserAgent: 1,
                  activeSessionIp: 1,
                },
              }
            );
          }
        }
      } catch (e) {
        logger.warn('Failed to clear activeSession on logout:', e && e.message);
      }

      // Also clear persisted refreshTokenId server-side if present (best-effort)
      try {
        if (userId && role) {
          const AccountModel =
            role === 'Admin'
              ? require('../models/admin')
              : role === 'Approver' || role === 'PreApprover'
                ? require('../models/approver')
                : require('../models/user');
          await AccountModel.updateOne({ _id: userId }, { $unset: { refreshTokenId: 1 } });
        }
      } catch (e) {
        logger.warn('Failed to clear refreshTokenId on logout:', e && e.message);
      }
      return res.json({ message: 'Logged out successfully' });
    });
  } else {
    // No session — may be token-only. Attempt to clear server-side refreshTokenId if cookie exists.
    try {
      const cookie = req.cookies && req.cookies.refreshToken;
      if (cookie) {
        const jwt = require('jsonwebtoken');
        const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-jwt-secret';
        try {
          const payload = jwt.verify(cookie, secret);
          const id = payload.sub;
          const roleFromToken = payload.role;
          if (id) {
            const AccountModel =
              roleFromToken === 'Admin'
                ? require('../models/admin')
                : roleFromToken === 'Approver' || roleFromToken === 'PreApprover'
                  ? require('../models/approver')
                  : require('../models/user');
            await AccountModel.updateOne({ _id: id }, { $unset: { refreshTokenId: 1 } });
          }
        } catch (_) {
          // ignore invalid token
        }
      }
    } catch (e) {
      // ignore
    }
    return res.json({ message: 'Logged out (token-only) — refresh cookie cleared' });
  }
});

// REFRESH TOKEN
router.post('/refresh-token', async (req, res) => {
  try {
    const cookie = req.cookies && req.cookies.refreshToken;
    if (!cookie) return res.status(401).json({ message: 'No refresh token' });
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-jwt-secret';
    let payload;
    try {
      payload = jwt.verify(cookie, secret);
    } catch (e) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const userId = payload.sub;
    const jti = payload.jti;
    if (!userId) return res.status(401).json({ message: 'Invalid token payload' });

    // Find account in appropriate collection
    let account = await User.findById(userId).select('refreshTokenId');
    if (!account) account = await Approver.findById(userId).select('refreshTokenId');
    if (!account) account = await Admin.findById(userId).select('refreshTokenId');
    if (!account) return res.status(401).json({ message: 'Account not found' });

    // ensure the jti matches stored id
    if (!jti || account.refreshTokenId !== jti) {
      return res.status(401).json({ message: 'Refresh token revoked' });
    }

    // issue new access token and rotate refresh token for stronger security.
    const accessExpiry = process.env.ACCESS_TOKEN_EXPIRES || '15m';
    const refreshExpiryMs = parseInt(
      process.env.REFRESH_TOKEN_MAX_AGE_MS || String(7 * 24 * 60 * 60 * 1000),
      10
    );

    // create new identifiers and tokens
    const newRefreshId = require('crypto').randomBytes(16).toString('hex');
    const accessToken = jwt.sign({ sub: String(userId), role: payload.role }, secret, {
      expiresIn: accessExpiry,
    });
    const newRefreshToken = jwt.sign(
      { sub: String(userId), role: payload.role, jti: newRefreshId },
      secret,
      { expiresIn: Math.floor(refreshExpiryMs / 1000) + 's' }
    );

    // persist rotated refresh id
    try {
      account.refreshTokenId = newRefreshId;
      await account.save();
    } catch (e) {
      logger.warn({ e }, 'Failed to persist rotated refreshTokenId');
    }

    // set cookie (rotate)
    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: refreshExpiryMs,
      path: '/api',
    });

    return res.json({ accessToken });
  } catch (err) {
    logger.error({ err }, 'Refresh token error');
    return res.status(500).json({ message: 'Unable to refresh token' });
  }
});

// ----- FORGOT PASSWORD -----
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const genericOk = { message: 'If the email exists, a reset link will be sent' };
    const user = await User.findOne({ email });
    if (!user) return res.status(200).json(genericOk);

    const rawToken = crypto.randomBytes(20).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 1000 * 60 * 15;
    await user.save();

    const frontendBase = process.env.FRONTEND_BASE_URL || 'https://s338k.github.io';
    const resetLink = `${frontendBase}/PTW/reset-password.html?token=${rawToken}`;

    if (process.env.NODE_ENV !== 'production') {
      logger.debug({ resetLink, token: rawToken }, '[DEV MODE] Reset link');
      return res
        .status(200)
        .json({ message: 'Password reset link (dev mode)', resetLink, token: rawToken });
    }
    return res.status(200).json(genericOk);
  } catch (err) {
    next(err);
  }
});

// ----- RESET PASSWORD -----
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword)
      return res.status(400).json({ message: 'Token and new password are required' });

    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
    if (!strongPasswordRegex.test(newPassword)) {
      return res.status(400).json({
        message:
          'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.',
      });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });
    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });

    user.password = newPassword; // plain text, pre-save hook will hash
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    logger.error({ err }, '[Reset Password] Error');
    res.status(500).json({ message: 'Error resetting password', error: err.message });
  }
});

// ----- CHECK CURRENT PASSWORD (authenticated users) -----
router.post('/check-password', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }
    const { currentPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({ message: 'Current password is required' });
    }

    // Locate the account in the correct collection depending on role
    let account = null;
    const role = req.session.userRole;
    if (role === 'Admin') {
      const Admin = require('../models/admin');
      account = await Admin.findById(req.session.userId);
    } else if (role === 'Approver' || role === 'PreApprover') {
      const Approver = require('../models/approver');
      account = await Approver.findById(req.session.userId);
    } else {
      account = await User.findById(req.session.userId);
    }

    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    let ok = false;
    try {
      ok = await account.comparePassword(currentPassword);
    } catch (pwErr) {
      logger.warn({ pwErr, accountId: account._id }, '[Check Password] Password comparison failed');
      return res.status(400).json({ message: 'Current password is incorrect' });
    }
    if (!ok) return res.status(400).json({ message: 'Current password is incorrect' });
    return res.json({ valid: true });
  } catch (err) {
    logger.error({ err }, '[Check Password] Error');
    res.status(500).json({ message: 'Error checking password', error: err.message });
  }
});

// ----- UPDATE PASSWORD (authenticated users) -----
router.put('/update-password', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required' });
    }

    // Password validation
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        message:
          'Password must have minimum 8 characters and contain lower, upper case letter, a number, and special characters',
      });
    }

    // Locate the account in the correct collection depending on role
    let account = null;
    const role = req.session.userRole;
    if (role === 'Admin') {
      const Admin = require('../models/admin');
      account = await Admin.findById(req.session.userId);
    } else if (role === 'Approver' || role === 'PreApprover') {
      const Approver = require('../models/approver');
      account = await Approver.findById(req.session.userId);
    } else {
      account = await User.findById(req.session.userId);
    }

    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    // Verify current password
    let passwordMatch = false;
    try {
      passwordMatch = await account.comparePassword(currentPassword);
    } catch (pwErr) {
      logger.warn(
        { pwErr, accountId: account._id },
        '[Update Password] Password comparison failed'
      );
      return res.status(400).json({ message: 'Current password is incorrect' });
    }
    if (!passwordMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password (pre-save hook will hash it)
    account.password = newPassword;
    account.passwordUpdatedAt = new Date();
    const pwdRemark = req.body.remark;
    if (pwdRemark) {
      account.passwordUpdateLogs = account.passwordUpdateLogs || [];
      account.passwordUpdateLogs.push({ remark: pwdRemark, updatedAt: new Date() });
    }
    await account.save();

    logger.info({ userId: account._id }, 'Password updated successfully');
    res.json({
      message: 'Password has been successfully updated',
      passwordUpdatedAt: account.passwordUpdatedAt,
    });
  } catch (err) {
    logger.error({ err }, '[Update Password] Error');
    res.status(500).json({ message: 'Error updating password', error: err.message });
  }
});

// ----- UPDATE PROFILE (authenticated users) -----
router.put('/update-profile', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const { username, email, company, phone, remark } = req.body;

    const user = await User.findById(req.session.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (req.session.userRole === 'Admin') {
      if (!username || !email) {
        return res.status(400).json({ message: 'Username and email id are required' });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return res.status(400).json({ message: 'Invalid email format' });
      if (email !== user.email) {
        const existingUser = await User.findOne({ email, _id: { $ne: user._id } });
        if (existingUser)
          return res.status(409).json({ message: 'Email id is already in use by another account' });
      }
      user.username = username;
      user.email = email;
      user.company = company || '';
    }

    // Always allow updating phone
    user.phone = phone || user.phone || '';
    user.profileUpdatedAt = new Date();

    if (remark) {
      user.profileUpdateLogs = user.profileUpdateLogs || [];
      user.profileUpdateLogs.push({ remark: remark, updatedAt: new Date() });
    }

    await user.save();

    logger.info({ userId: user._id }, 'Profile has been successfully updated');

    res.json({
      message: 'Profile has been successfully updated',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        company: user.company,
        phone: user.phone,
        role: user.role,
        profileUpdatedAt: user.profileUpdatedAt,
      },
    });
  } catch (err) {
    logger.error({ err }, '[Update Profile] Error');
    res.status(500).json({ message: 'Error updating profile', error: err.message });
  }
});

module.exports = router;
