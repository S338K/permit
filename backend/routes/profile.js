const express = require('express');
const router = express.Router();

const User = require('../models/user');
const Admin = require('../models/admin');
const Approver = require('../models/approver');

const sanitizeUserPayload = (doc) => {
  if (!doc) {
    return null;
  }

  const payload = doc.toObject ? doc.toObject() : { ...doc };

  delete payload.password;
  delete payload.resetPasswordToken;
  delete payload.resetPasswordExpires;

  if (payload.createdAt instanceof Date) {
    payload.createdAt = payload.createdAt.toISOString();
  }

  if (payload.updatedAt instanceof Date) {
    payload.updatedAt = payload.updatedAt.toISOString();
  }

  if (payload.lastLogin instanceof Date) {
    payload.lastLogin = payload.lastLogin.toISOString();
  }

  if (payload.prevLogin instanceof Date) {
    payload.prevLogin = payload.prevLogin.toISOString();
  }

  if (payload.passwordUpdatedAt instanceof Date) {
    payload.passwordUpdatedAt = payload.passwordUpdatedAt.toISOString();
  }

  if (payload.profileUpdatedAt instanceof Date) {
    payload.profileUpdatedAt = payload.profileUpdatedAt.toISOString();
  }

  if (Array.isArray(payload.profileUpdateLogs)) {
    payload.profileUpdateLogs = payload.profileUpdateLogs.map((entry) => ({
      remark: entry.remark || '',
      updatedAt: entry.updatedAt instanceof Date ? entry.updatedAt.toISOString() : entry.updatedAt,
    }));
  }

  if (Array.isArray(payload.passwordUpdateLogs)) {
    payload.passwordUpdateLogs = payload.passwordUpdateLogs.map((entry) => ({
      remark: entry.remark || '',
      updatedAt: entry.updatedAt instanceof Date ? entry.updatedAt.toISOString() : entry.updatedAt,
    }));
  }

  return payload;
};

router.get('/dashboard/me', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId, userRole } = req.session;

    let account = null;
    switch (userRole) {
      case 'Admin':
        account = await Admin.findById(userId);
        break;
      case 'Approver':
      case 'PreApprover':
      case 'Pre-Approver':
        account = await Approver.findById(userId);
        break;
      default:
        account = await User.findById(userId);
        break;
    }

    if (!account) {
      return res.status(404).json({ message: 'User not found' });
    }

    const clientIp = (() => {
      try {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) {
          const parts = String(forwarded).split(',');
          if (parts.length) {
            return parts[0].trim();
          }
        }
        if (req.headers['cf-connecting-ip']) {
          return String(req.headers['cf-connecting-ip']).trim();
        }
        if (req.headers['x-real-ip']) {
          return String(req.headers['x-real-ip']).trim();
        }
        if (req.socket && req.socket.remoteAddress) {
          return req.socket.remoteAddress;
        }
        if (req.ip) {
          return req.ip;
        }
      } catch (error) {
        console.warn('clientIp resolution error:', error);
      }
      return null;
    })();

    const payload = sanitizeUserPayload(account);

    return res.json({
      user: {
        id: payload._id,
        fullName: payload.fullName || payload.username || '',
        email: payload.email || '',
        role: userRole || payload.role || '',
        phone: payload.phone || payload.mobile || '',
        company: payload.company || '',
        department: payload.department || '',
        designation: payload.designation || '',
        memberSince: payload.createdAt || '',
        lastLogin: payload.lastLogin || payload.prevLogin || '',
        prevLogin: payload.prevLogin || '',
        profileUpdatedAt: payload.profileUpdatedAt || '',
        passwordUpdatedAt: payload.passwordUpdatedAt || '',
        status: payload.userStatus || payload.status || '',
        ipAddress: clientIp || '',
      },
      clientIp,
    });
  } catch (error) {
    console.error('Failed to load dashboard user profile', error);
    res.status(500).json({ message: 'Failed to load user profile' });
  }
});

module.exports = router;
