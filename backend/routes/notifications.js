const express = require('express');
const router = express.Router();
const Notification = require('../models/notification');
const sse = require('../sse');

// GET /notifications or /api/notifications
// Returns notifications for the signed-in user from the database
router.get(['/notifications', '/api/notifications'], async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const userId = req.session.userId;

    // Fetch only unread notifications from database
    const notifications = await Notification.find({ userId, read: false })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Transform to expected format
    const formattedNotifications = notifications.map((n) => ({
      _id: n._id,
      id: n._id.toString(),
      userId: n.userId,
      type: n.type,
      title: n.title,
      message: n.message,
      read: n.read,
      metadata: n.metadata || {},
      createdAt: n.createdAt,
      timestamp: n.createdAt,
    }));

    res.json({ notifications: formattedNotifications });
  } catch (err) {
    console.error('Notifications endpoint error:', err);
    res.status(500).json({ message: 'Failed to fetch notifications', error: err.message });
  }
});

// SSE stream for real-time notifications
router.get('/api/notifications/stream', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }
    const userId = req.session.userId;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Add to clients map
    sse.addClient(userId, res);

    // Send initial payload (unread notifications)
    const notifications = await Notification.find({ userId, read: false })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const formatted = notifications.map((n) => ({
      _id: n._id,
      id: n._id.toString(),
      userId: n.userId,
      type: n.type,
      title: n.title,
      message: n.message,
      read: n.read,
      metadata: n.metadata || {},
      createdAt: n.createdAt,
    }));

    // send init event as notification event with type 'init'
    try {
      res.write(`event: notification\n`);
      res.write(`data: ${JSON.stringify({ type: 'init', notifications: formatted })}\n\n`);
    } catch (e) {
      // Silently handle write errors for SSE connection
    }

    // keep connection alive with periodic comments
    const iv = setInterval(() => {
      try {
        res.write(`: keepalive\n\n`);
      } catch (e) {
        // Silently handle write errors for SSE connection
      }
    }, 20000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(iv);
      sse.removeClient(userId, res);
    });
  } catch (err) {
    console.error('SSE stream error', err);
    try {
      res.end();
    } catch (_) {
      // Silently handle end errors for closed SSE connection
    }
  }
});

// PUT /api/notifications/:id/read
// Mark a specific notification as read
router.put('/api/notifications/:id/read', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.session.userId },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({ notification });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: 'Failed to mark notification as read' });
  }
});

// PUT /api/notifications/mark-all-read
// Mark all notifications as read for the current user
router.put('/api/notifications/mark-all-read', async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ message: 'Failed to mark all notifications as read' });
  }
});

// Helper function to create a notification (exported for use by other routes)
async function createNotification(userId, type, title, message, metadata = {}) {
  try {
    const notification = new Notification({
      userId,
      type,
      title,
      message,
      metadata,
      read: false,
    });
    await notification.save();
    // push via SSE (best-effort)
    try {
      const payload = {
        type: 'notification',
        notification: {
          _id: notification._id,
          id: notification._id.toString(),
          userId: notification.userId,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          read: notification.read,
          metadata: notification.metadata || {},
          createdAt: notification.createdAt,
        },
      };
      sse.sendToUser(String(userId), payload);
    } catch (e) {
      console.warn('Failed to push SSE notification (non-fatal)', e);
    }
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
