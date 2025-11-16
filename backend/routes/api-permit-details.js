const express = require('express');
const router = express.Router();
const Permit = require('../models/permit');
const mongoose = require('mongoose');
const { createNotification } = require('./notifications');

// GET /api/permits/:permitId/file/:fileId - Download a specific file attached to a permit
router.get('/permits/:permitId/file/:fileId', async (req, res) => {
  try {
    const { permitId, fileId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(permitId) || !mongoose.Types.ObjectId.isValid(fileId)) {
      return res.status(400).json({ message: 'Invalid permit or file ID' });
    }
    const permit = await Permit.findById(permitId);
    if (!permit) return res.status(404).json({ message: 'Permit not found' });
    const file = (permit.files || []).find((f) => f._id && f._id.equals(fileId));
    if (!file) return res.status(404).json({ message: 'File not found' });
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${file.originalName}"`,
      'Content-Length': file.size,
    });
    res.send(file.data);
  } catch (err) {
    console.error('Error serving permit file:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/permits/:id - Get full permit details for admin/approver modal
router.get('/permits/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid permit ID' });
    }
    // Find permit and populate requester, preApprover, and approver user details
    // Populate requester with fuller profile so frontend can show all requester details
    const permit = await Permit.findById(id)
      .populate({
        path: 'requester',
        select: 'fullName username email phone company role officeAddress lastLogin prevLogin',
      })
      .populate({ path: 'preApprovedBy', select: 'fullName username email role' })
      .populate({ path: 'approvedBy', select: 'fullName username email role' });
    if (!permit) return res.status(404).json({ message: 'Permit not found' });

    // Compose response with all required fields for modal
    const permitObj = permit.toObject({ virtuals: true });
    // Attach file URLs for frontend
    permitObj.files = (permitObj.files || []).map((f) => ({
      ...f,
      url: `/api/permits/${permit._id}/file/${f._id}`,
    }));
    res.json(permitObj);
  } catch (err) {
    console.error('Error fetching permit details:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

// ----- POST action on permit: approve/reject -----
router.post('/permits/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, comments } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ message: 'Invalid permit ID' });
    if (!action || !['approve', 'reject'].includes(action))
      return res.status(400).json({ message: 'Invalid action' });
    // simple validation for comments
    if (!comments || String(comments).trim().length < 3)
      return res.status(400).json({ message: 'Comments are required (min 3 characters)' });

    const permit = await Permit.findById(id);
    if (!permit) return res.status(404).json({ message: 'Permit not found' });

    if (action === 'approve') {
      permit.status = 'Approved';
      permit.approverComments = String(comments).trim();
      permit.approvedAt = new Date();
      permit.approvedBy = req.session?.userId || req.user?._id;
      // generate permit number if not present (simple serial by date)
      if (!permit.permitNumber) {
        const now = new Date();
        const dd = String(now.getDate()).padStart(2, '0');
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yyyy = now.getFullYear();
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const datePart = `${dd}${mm}${yyyy}`;
        const timePart = `${hh}${min}${ss}`;
        const countToday = await Permit.countDocuments({
          approvedAt: {
            $gte: new Date(now.setHours(0, 0, 0, 0)),
            $lte: new Date(now.setHours(23, 59, 59, 999)),
          },
          status: 'Approved',
        });
        const serial = String((countToday || 0) + 1).padStart(3, '0');
        permit.permitNumber = `BHS-${datePart}-${timePart}-${serial}`;
      }
    } else if (action === 'reject') {
      permit.status = 'Rejected';
      permit.approverComments = String(comments).trim();
      permit.approvedAt = new Date();
      permit.approvedBy = req.session?.userId || req.user?._id;
    }

    await permit.save();

    // Create notification for permit requester
    try {
      const approverUser = req.session?.userId
        ? await require('../models/user').findById(req.session.userId).select('fullName username')
        : null;
      const approverName = approverUser
        ? approverUser.fullName || approverUser.username
        : 'Approver';

      let notifType, notifTitle, notifMessage;

      if (action === 'approve') {
        notifType = 'permit_approved';
        notifTitle = 'Permit Approved';
        notifMessage = `Your permit "${permit.permitTitle || permit.permitNumber || 'N/A'}" has been approved by ${approverName}!`;
      } else {
        notifType = 'permit_rejected';
        notifTitle = 'Permit Rejected';
        notifMessage = `Your permit "${permit.permitTitle || permit.permitNumber || 'N/A'}" has been rejected by ${approverName}.`;
      }

      await createNotification(permit.requester, notifType, notifTitle, notifMessage, {
        permitId: permit._id.toString(),
        permitNumber: permit.permitNumber || '',
        status: permit.status,
        approverName: approverName,
        comments: comments || '',
      });
    } catch (notifErr) {
      console.error('Failed to create notification:', notifErr);
      // Don't fail the request if notification fails
    }

    return res.json({ message: 'Action applied', permit });
  } catch (err) {
    console.error('Error applying permit action:', err);
    res.status(500).json({ message: 'Server error' });
  }
});
