const express = require('express');
const router = express.Router();
const Permit = require('../models/permit');
const { requireAuth, requirePreApprover } = require('../middleware/authMiddleware');
const { createNotification } = require('./notifications');

// Helper: build scoped query for non-admin users
function buildScopedQuery(role, uid, extra = {}) {
  const base = { ...extra };
  if (role === 'Admin') return base;
  // Strict scoping: user sees permits they requested or acted on
  base.$or = [{ requester: uid }, { preApprovedBy: uid }, { approvedBy: uid }];
  return base;
}

// GET /preapprover/stats
// Returns counts for dashboard cards (scoped to user unless Admin)
router.get('/stats', requireAuth, requirePreApprover, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.userRole;

    const totalPermits = await Permit.countDocuments(buildScopedQuery(role, uid));

    // Pre-Approvers/Approvers/Admins should see the global pending count (all submitted permits)
    let pendingReview;
    if (role === 'PreApprover' || role === 'Approver' || role === 'Admin') {
      pendingReview = await Permit.countDocuments({ status: 'Pending' });
    } else {
      pendingReview = await Permit.countDocuments(
        buildScopedQuery(role, uid, { status: 'Pending' })
      );
    }

    // Count pre-approved permits as those currently in 'In Progress' state.
    // Previous implementation counted any permit with `preApprovedBy` set,
    // which also included rejected permits (reject endpoint sets preApprovedBy).
    // Use status 'In Progress' so KPI matches the analytics doughnut semantics.
    const preApproved =
      role === 'Admin'
        ? await Permit.countDocuments({ status: 'In Progress' })
        : await Permit.countDocuments({ preApprovedBy: uid, status: 'In Progress' });

    const rejectedByMe =
      role === 'Admin'
        ? await Permit.countDocuments({ status: 'Rejected' })
        : await Permit.countDocuments({ preApprovedBy: uid, status: 'Rejected' });

    res.json({ totalPermits, pendingReview, preApproved, rejectedByMe });
  } catch (err) {
    console.error('preapprover/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /preapprover/permits?filter=submitted
// Returns submitted (Pending) permits scoped to the user (Option A strict)
router.get('/permits', requireAuth, requirePreApprover, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.userRole;
    const filter = req.query.filter || 'all';

    if (filter === 'submitted') {
      // Pre-Approvers and Approvers should see all pending submissions (not just their own)
      let q;
      if (role === 'PreApprover' || role === 'Approver' || role === 'Admin') {
        q = { status: 'Pending' };
      } else {
        q = buildScopedQuery(role, uid, { status: 'Pending' });
      }
      const permits = await Permit.find(q)
        .populate('requester', 'username email phone fullName')
        .populate('preApprovedBy', 'username email fullName')
        .populate('approvedBy', 'username email fullName')
        .sort({ createdAt: -1 })
        .lean();
      return res.json(permits);
    }

    // default: return scoped permits regardless of status
    const q = buildScopedQuery(role, uid);
    const permits = await Permit.find(q)
      .populate('requester', 'username email phone fullName')
      .populate('preApprovedBy', 'username email fullName')
      .populate('approvedBy', 'username email fullName')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json(permits);
  } catch (err) {
    console.error('preapprover/permits error:', err);
    res.status(500).json({ error: 'Failed to fetch permits' });
  }
});

// GET /preapprover/my-actions
// Option A (strict): return permits where approvedBy === me & status Approved OR preApprovedBy === me & status Rejected
router.get('/my-actions', requireAuth, requirePreApprover, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.userRole;

    if (role === 'Admin') {
      // Admin sees all approved/rejected and all pre-approved
      const approved = await Permit.find({ status: 'Approved' })
        .populate('requester', 'username email phone fullName')
        .populate('approvedBy', 'username email fullName')
        .lean();
      const rejected = await Permit.find({ status: 'Rejected' })
        .populate('requester', 'username email phone fullName')
        .populate('preApprovedBy', 'username email fullName')
        .lean();
      const preApproved = await Permit.find({ status: { $in: ['In Progress', 'Approved'] } })
        .populate('requester', 'username email phone fullName')
        .populate('preApprovedBy', 'username email fullName')
        .lean();
      return res.json({ approved, rejected, preApproved });
    }

    const approved = await Permit.find({ approvedBy: uid, status: 'Approved' })
      .populate('requester', 'username email phone fullName')
      .populate('approvedBy', 'username email fullName')
      .lean();

    const rejected = await Permit.find({ preApprovedBy: uid, status: 'Rejected' })
      .populate('requester', 'username email phone fullName')
      .populate('preApprovedBy', 'username email fullName')
      .lean();

    const preApproved = await Permit.find({
      preApprovedBy: uid,
      status: { $in: ['In Progress', 'Approved'] },
    })
      .populate('requester', 'username email phone fullName')
      .populate('preApprovedBy', 'username email fullName')
      .lean();

    res.json({ approved, rejected, preApproved });
  } catch (err) {
    console.error('preapprover/my-actions error:', err);
    res.status(500).json({ error: 'Failed to fetch my actions' });
  }
});

// GET /preapprover/analytics
// Returns simple chart data: counts by status and monthly counts for the last 6 months
router.get('/analytics', requireAuth, requirePreApprover, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.userRole;
    // Analytics: Pre-Approvers/Approvers/Admins should see global analytics; others get scoped analytics
    const scoped =
      role === 'PreApprover' || role === 'Approver' || role === 'Admin'
        ? {}
        : buildScopedQuery(role, uid);

    // counts by status
    const statuses = ['Pending', 'In Progress', 'Approved', 'Rejected'];
    const countsByStatus = {};
    await Promise.all(
      statuses.map(async (s) => {
        countsByStatus[s] = await Permit.countDocuments({ ...scoped, status: s });
      })
    );

    // monthly counts (last 6 months)
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }

    const monthlyCounts = [];
    for (const m of months) {
      const start = new Date(m.year, m.month - 1, 1);
      const end = new Date(m.year, m.month, 1);
      const cnt = await Permit.countDocuments({
        ...scoped,
        createdAt: { $gte: start, $lt: end },
      });
      monthlyCounts.push({ year: m.year, month: m.month, count: cnt });
    }

    res.json({ countsByStatus, monthlyCounts });
  } catch (err) {
    console.error('preapprover/analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;

// PATCH /preapprover/permit/:id/times
// Allows a pre-approver to adjust scheduled start and end times
router.patch('/permit/:id/times', requireAuth, requirePreApprover, async (req, res) => {
  try {
    const { startDateTime, endDateTime } = req.body || {};
    if (!startDateTime || !endDateTime) {
      return res.status(400).json({ error: 'startDateTime and endDateTime are required' });
    }

    const start = new Date(startDateTime);
    const end = new Date(endDateTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    if (end < start) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }

    // Optional: restrict to Pending or In Progress permits
    const updated = await Permit.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ['Pending', 'In Progress'] } },
      { $set: { startDateTime: start, endDateTime: end } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Permit not found or not editable' });
    return res.json({ message: 'Times updated', permit: updated });
  } catch (err) {
    console.error('preapprover/permit/:id/times error:', err);
    return res.status(500).json({ error: 'Failed to update times' });
  }
});

// POST /preapprover/approve/:id
router.post('/approve/:id', requireAuth, requirePreApprover, async (req, res) => {
  try {
    const preApproverId = req.session.userId;
    const comments = req.body?.comments || '';
    const updated = await Permit.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: 'In Progress',
          preApprovedBy: preApproverId,
          preApprovedAt: new Date(),
          preApproverComments: comments,
        },
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Permit not found' });

    try {
      await createNotification(
        updated.requester,
        'permit_preapproved',
        'Permit Pre-Approved',
        `Your permit "${updated.permitTitle || updated.permitNumber || 'N/A'}" has been pre-approved.`,
        { permitId: updated._id.toString(), status: 'In Progress', approver: preApproverId }
      );
    } catch (e) {
      console.error('notify error', e);
    }

    res.json({ message: 'Permit pre-approved', permit: updated });
  } catch (err) {
    console.error('preapprover approve error:', err);
    res.status(500).json({ error: 'Failed to pre-approve permit' });
  }
});

// POST /preapprover/reject/:id
router.post('/reject/:id', requireAuth, requirePreApprover, async (req, res) => {
  try {
    const preApproverId = req.session.userId;
    const comments = req.body?.comments || '';
    const updated = await Permit.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: 'Rejected',
          preApprovedBy: preApproverId,
          preApprovedAt: new Date(),
          preApproverComments: comments,
        },
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Permit not found' });

    try {
      await createNotification(
        updated.requester,
        'permit_rejected',
        'Permit Rejected',
        `Your permit "${updated.permitTitle || updated.permitNumber || 'N/A'}" has been rejected.`,
        { permitId: updated._id.toString(), status: 'Rejected', approver: preApproverId }
      );
    } catch (e) {
      console.error('notify error', e);
    }

    res.json({ message: 'Permit rejected', permit: updated });
  } catch (err) {
    console.error('preapprover reject error:', err);
    res.status(500).json({ error: 'Failed to reject permit' });
  }
});
