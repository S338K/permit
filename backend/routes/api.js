const express = require('express');
const router = express.Router();
const axios = require('axios');

// ===== SYSTEM MESSAGE ROUTES =====
const SystemMessage = require('../models/systemMessage');
const { enforceActiveSession } = require('../middleware/authMiddleware');

// Get current system message
router.get('/system-message', async (req, res) => {
  try {
    const msg = await SystemMessage.findOne({}, {}, { sort: { updatedAt: -1 } });
    res.json({ message: msg ? msg.message : '' });
  } catch (err) {
    res.status(500).json({ message: 'Unable to fetch announcement message', error: err.message });
  }
});

// Get all active system messages for carousel
router.get('/system-messages', async (req, res) => {
  try {
    const now = new Date();
    // Only include messages that are active and within optional scheduling window
    const messages = await SystemMessage.find({
      isActive: { $ne: false },
      $and: [
        { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const formattedMessages = messages.map((msg) => ({
      id: msg._id,
      title: msg.title || 'Announcement',
      message: msg.message || '',
      icon: msg.icon || 'fa-bullhorn',
      isActive: msg.isActive !== false,
    }));

    res.json(formattedMessages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.json([]); // Return empty array on error instead of 500
  }
});

// Update system message (admin only)
router.post('/system-message', async (req, res) => {
  try {
    if (!req.session || !req.session.userId || req.session.userRole !== 'Admin') {
      return res.status(403).json({ message: 'Forbidden: Admins only' });
    }
    const { title, message, icon, isActive, startAt, endAt } = req.body;
    const errors = [];
    // Validate presence and lengths
    if (!message || typeof message !== 'string' || !message.trim())
      errors.push({ field: 'message', message: 'Message is required' });
    if (title && title.length > 200)
      errors.push({ field: 'title', message: 'Title is too long (max 200 chars)' });
    if (message && message.length > 2000)
      errors.push({ field: 'message', message: 'Message is too long (max 2000 chars)' });
    if (icon && icon.length > 100) errors.push({ field: 'icon', message: 'Icon value too long' });
    // Validate dates
    let s = null,
      e = null;
    if (startAt) {
      s = new Date(startAt);
      if (Number.isNaN(s.getTime()))
        errors.push({ field: 'startAt', message: 'Invalid startAt datetime' });
    }
    if (endAt) {
      e = new Date(endAt);
      if (Number.isNaN(e.getTime()))
        errors.push({ field: 'endAt', message: 'Invalid endAt datetime' });
    }
    if (s && e && s > e) errors.push({ field: 'startAt', message: 'startAt must be before endAt' });

    if (errors.length)
      return res
        .status(400)
        .json({ message: 'Validation failed', code: 'VALIDATION_ERROR', details: errors });

    const newMsg = new SystemMessage({
      title: title || 'Announcement',
      message: message || '',
      icon: icon || 'fa-bullhorn',
      isActive: typeof isActive === 'boolean' ? isActive : true,
      startAt: s,
      endAt: e,
      updatedBy: req.session.userId,
    });
    await newMsg.save();
    res.json({ message: 'System message created', id: newMsg._id });
  } catch (err) {
    console.error('Create system message error:', err);
    res.status(500).json({ message: 'Unable to create system message', error: err.message });
  }
});

// List all system messages (including inactive)
router.get('/admin/system-messages', async (req, res) => {
  try {
    if (!req.session || !req.session.userId || req.session.userRole !== 'Admin') {
      return res.status(403).json({ message: 'Forbidden: Admins only' });
    }
    const messages = await SystemMessage.find({}).sort({ createdAt: -1 }).lean();
    res.json(
      messages.map((m) => ({
        id: m._id,
        title: m.title,
        message: m.message,
        icon: m.icon,
        isActive: m.isActive,
        startAt: m.startAt,
        endAt: m.endAt,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        updatedBy: m.updatedBy,
      }))
    );
  } catch (err) {
    console.error('Error fetching admin messages:', err);
    res.status(500).json({ message: 'Unable to fetch messages' });
  }
});

// Update a system message
router.put('/system-message/:id', async (req, res) => {
  try {
    if (!req.session || !req.session.userId || req.session.userRole !== 'Admin') {
      return res.status(403).json({ message: 'Forbidden: Admins only' });
    }
    const id = req.params.id;
    const { title, message, icon, isActive, startAt, endAt } = req.body;
    const errors = [];
    const update = {};
    if (typeof title === 'string') {
      if (title.length > 200) errors.push({ field: 'title', message: 'Title too long' });
      else update.title = title;
    }
    if (typeof message === 'string') {
      if (!message.trim()) errors.push({ field: 'message', message: 'Message is required' });
      else if (message.length > 2000)
        errors.push({ field: 'message', message: 'Message too long' });
      else update.message = message;
    }
    if (typeof icon === 'string') {
      if (icon.length > 100) errors.push({ field: 'icon', message: 'Icon value too long' });
      else update.icon = icon;
    }
    if (typeof isActive === 'boolean') update.isActive = isActive;

    let s = null,
      e = null;
    if (startAt) {
      s = new Date(startAt);
      if (Number.isNaN(s.getTime()))
        errors.push({ field: 'startAt', message: 'Invalid startAt datetime' });
    }
    if (endAt) {
      e = new Date(endAt);
      if (Number.isNaN(e.getTime()))
        errors.push({ field: 'endAt', message: 'Invalid endAt datetime' });
    }
    if (s && e && s > e) errors.push({ field: 'startAt', message: 'startAt must be before endAt' });
    if (s) update.startAt = s;
    if (e) update.endAt = e;

    if (errors.length)
      return res
        .status(400)
        .json({ message: 'Validation failed', code: 'VALIDATION_ERROR', details: errors });

    update.updatedAt = new Date();
    update.updatedBy = req.session.userId;

    const updated = await SystemMessage.findByIdAndUpdate(id, update, { new: true });
    if (!updated) return res.status(404).json({ message: 'Message not found' });
    res.json({ message: 'System message updated' });
  } catch (err) {
    console.error('Error updating message:', err);
    res.status(500).json({ message: 'Unable to update message' });
  }
});

// Delete a system message
router.delete('/system-message/:id', async (req, res) => {
  try {
    if (!req.session || !req.session.userId || req.session.userRole !== 'Admin') {
      return res.status(403).json({ message: 'Forbidden: Admins only' });
    }
    const id = req.params.id;
    const deleted = await SystemMessage.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: 'Message not found' });
    res.json({ message: 'System message deleted' });
  } catch (err) {
    console.error('Error deleting message:', err);
    res.status(500).json({ message: 'Unable to delete message' });
  }
});

// Mount new route modules
router.use('/', require('./auth'));

// Enforce single active session after auth routes are mounted
router.use(enforceActiveSession);
router.use('/', require('./permit'));
router.use('/', require('./api-permit-details'));
router.use('/', require('./notifications'));
router.use('/', require('./profile'));
router.use('/', require('./lookups'));

// ===== KEEP SESSION ALIVE =====
router.get('/ping', (req, res) => {
  if (req.session && req.session.userId) {
    req.session.touch();
    return res.json({ message: 'Session is alive' });
  }
  res.status(401).json({ message: 'Session has expired' });
});

// ===== WEATHER ROUTE =====
router.get('/weather', async (req, res) => {
  try {
    const city = req.query.city || 'Doha';
    const cfg = require('../config/config');
    const apiKey = cfg.API_KEY;
    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
      city
    )}&appid=${apiKey}&units=metric`;

    const weatherRes = await axios.get(weatherUrl);
    const w = weatherRes.data;

    const temp = Math.round(w.main.temp);
    const feelsLike = Math.round(w.main.feels_like);
    const humidity = Math.round(w.main.humidity);
    const windSpeed = Math.round(w.wind.speed);
    const visibility = Math.round((w.visibility || 0) / 1000);
    const pressure = w.main.pressure;
    const condition = w.weather[0].description;
    const conditionIcon = `https://openweathermap.org/img/wn/${w.weather[0].icon}@2x.png`;

    const { lat, lon } = w.coord;
    const airUrl = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${apiKey}`;
    const airRes = await axios.get(airUrl);
    const aqi = airRes.data.list[0].main.aqi;
    const aqiStatus =
      { 1: 'Good', 2: 'Fair', 3: 'Moderate', 4: 'Poor', 5: 'Very Poor' }[aqi] || 'Unknown';

    res.json({
      temperature: temp,
      condition,
      feelsLike: feelsLike,
      humidity: humidity,
      windSpeed: windSpeed,
      visibility: visibility,
      pressure: pressure,
      aqi: aqi,
      aqiStatus: aqiStatus,
      detailsLine: `Temperature: ${temp}°C (feels like ${feelsLike}°C) | Weather status: ${condition} | Humidity: ${humidity}% | Visibility: ${visibility} km | Wind Speed: ${windSpeed} m/s | AQI: ${aqi} | Quality: ${aqiStatus}`,
      icons: { condition: conditionIcon },
    });
  } catch (err) {
    console.error('Weather fetch error:', err.response?.data || err.message);
    res
      .status(500)
      .json({ message: 'Unable to fetch weather', error: err.response?.data || err.message });
  }
});

// ===== DASHBOARD STATISTICS =====
router.get('/dashboard/stats', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const Permit = require('../models/permit');

    // Get permit statistics
    const [pending, approved, rejected, total] = await Promise.all([
      Permit.countDocuments({ status: { $in: ['Pending', 'In Progress'] } }),
      Permit.countDocuments({ status: 'Approved' }),
      Permit.countDocuments({ status: 'Rejected' }),
      Permit.countDocuments({}),
    ]);

    res.json({
      pending,
      approved,
      rejected,
      total,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Failed to fetch dashboard statistics' });
  }
});

// ===== CLIENT IP helper endpoint =====
router.get('/client-ip', (req, res) => {
  try {
    let clientIp = null;
    const xff = req.headers['x-forwarded-for'];
    if (xff) clientIp = String(xff).split(',')[0].trim();
    if (!clientIp && req.headers['cf-connecting-ip']) clientIp = req.headers['cf-connecting-ip'];
    if (!clientIp && req.headers['x-real-ip']) clientIp = req.headers['x-real-ip'];
    if (!clientIp && req.socket && req.socket.remoteAddress) clientIp = req.socket.remoteAddress;
    if (!clientIp && req.ip) clientIp = req.ip;

    res.json({ ip: clientIp || null });
  } catch (err) {
    console.error('client-ip endpoint error', err);
    res.status(500).json({ ip: null });
  }
});

// ===== PERMITS DATA =====
router.get('/permits', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const Permit = require('../models/permit');
    const { status, limit = 50, page = 1 } = req.query;

    let query = {};
    if (status) {
      query.status = status;
    }

    // Scope results by user role so non-admins only see permits relevant to them
    const role = req.session.userRole;
    const uid = req.session.userId;

    if (!role || role === 'User') {
      // Regular users: only their own permits
      query.requester = uid;
    } else if (role === 'Approver' || role === 'PreApprover') {
      // Approvers / Pre-approvers: only permits they requested or that they have acted on
      query.$or = [{ requester: uid }, { preApprovedBy: uid }, { approvedBy: uid }];
    } else if (role === 'Admin') {
      // Admins see everything
    } else {
      // Fallback: safest option is to show only user's own permits
      query.requester = uid;
    }

    const permits = await Permit.find(query)
      .populate('requester', 'username email phone fullName')
      .populate('preApprovedBy', 'username email fullName')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Permit.countDocuments(query);

    res.json({
      permits,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Permits fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch permits' });
  }
});

// Get single permit details
router.get('/permit/:id', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const Permit = require('../models/permit');
    const permit = await Permit.findById(req.params.id)
      .populate('requester', 'username email phone fullName')
      .populate('preApprovedBy', 'username email fullName')
      .populate('approvedBy', 'username email fullName');

    if (!permit) {
      return res.status(404).json({ error: 'Permit not found' });
    }

    res.json(permit);
  } catch (error) {
    console.error('Error fetching permit details:', error);
    res.status(500).json({ error: 'Failed to fetch permit details' });
  }
});

// ===== DEBUG ENDPOINT (no auth required) =====
router.get('/debug/permits', async (req, res) => {
  try {
    const Permit = require('../models/permit');
    const permits = await Permit.find({}).limit(10);
    const stats = {
      total: await Permit.countDocuments({}),
      pending: await Permit.countDocuments({ status: { $in: ['Pending', 'In Progress'] } }),
      approved: await Permit.countDocuments({ status: 'Approved' }),
      rejected: await Permit.countDocuments({ status: 'Rejected' }),
    };

    res.json({
      message: 'Debug data (no auth required)',
      stats,
      samplePermits: permits.slice(0, 3).map((p) => ({
        id: p._id,
        title: p.permitTitle,
        status: p.status,
        createdAt: p.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== DEV-ONLY: inspect session & headers =====
router.get('/debug/session', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ message: 'Not found' });
  }
  try {
    const safeSession = req.session
      ? {
          id: req.session.id,
          userId: req.session.userId || null,
          userRole: req.session.userRole || null,
          cookie: req.session.cookie || null,
        }
      : null;
    const headers = {
      origin: req.headers.origin || null,
      cookie: req.headers.cookie || null,
      'x-forwarded-for': req.headers['x-forwarded-for'] || null,
      'cf-connecting-ip': req.headers['cf-connecting-ip'] || null,
      'x-real-ip': req.headers['x-real-ip'] || null,
    };
    res.json({ session: safeSession, headers, ip: req.ip || req.socket?.remoteAddress || null });
  } catch (err) {
    console.error('Debug session endpoint error', err);
    res.status(500).json({ error: err.message });
  }
});

// Quick uniqueness check endpoints for client-side validation
router.get('/check-email', async (req, res) => {
  try {
    const Admin = require('../models/admin');
    const Approver = require('../models/approver');
    const User = require('../models/user');
    const email = String(req.query.email || '')
      .trim()
      .toLowerCase();
    if (!email) return res.status(400).json({ message: 'Email id is required' });
    const exists =
      (await Admin.findOne({ email })) ||
      (await Approver.findOne({ email })) ||
      (await User.findOne({ email }));
    return res.json({ exists: !!exists });
  } catch (err) {
    console.error('check-email error', err);
    return res.status(500).json({ message: 'Error checking email id' });
  }
});

// Check-phone?phone=...
router.get('/check-phone', async (req, res) => {
  try {
    const Admin = require('../models/admin');
    const Approver = require('../models/approver');
    const User = require('../models/user');
    let phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ message: 'Phone required' });
    phone = phone.replace(/[\s\-()]/g, '');
    const exists =
      (await Admin.findOne({ mobile: phone })) ||
      (await Approver.findOne({ mobile: phone })) ||
      (await User.findOne({ $or: [{ phone: phone }, { mobile: phone }] }));
    return res.json({ exists: !!exists });
  } catch (err) {
    console.error('check-phone error', err);
    return res.status(500).json({ message: 'Error checking phone' });
  }
});

module.exports = router;
