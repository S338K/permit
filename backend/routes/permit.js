const express = require('express');
const router = express.Router();
const multer = require('multer');
const Permit = require('../models/permit');
const User = require('../models/user');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { requireAuth } = require('../middleware/authMiddleware');
const { createNotification } = require('./notifications');

require('dotenv').config();

// ----- Multer config -----
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ----- GET all permits for current requester -----
router.get('/permit', requireAuth, async (req, res) => {
  try {
    const permits = await Permit.find({ requester: req.session.userId })
      .populate('requester', 'fullName username email')
      .populate('preApprovedBy', 'fullName username email')
      .populate('approvedBy', 'fullName username email')
      .sort({ createdAt: -1 });

    // Debug logging
    console.log('Fetched permits:', permits.length);
    if (permits.length > 0) {
      console.log('Sample permit data:', {
        id: permits[0]._id,
        status: permits[0].status,
        preApprovedBy: permits[0].preApprovedBy,
        approvedBy: permits[0].approvedBy,
      });
    }

    res.json(permits);
  } catch (err) {
    console.error('Permit fetch error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----- GET single permit -----
router.get('/permit/:id', requireAuth, async (req, res) => {
  try {
    const permit = await Permit.findOne({
      _id: req.params.id,
      requester: req.session.userId,
    });
    if (!permit) return res.status(404).json({ message: 'Permit not found' });
    res.json(permit);
  } catch (err) {
    console.error('Error fetching permit:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----- POST new permit -----
router.post('/permit', requireAuth, upload.array('files', 5), async (req, res) => {
  try {
    const uploadedFiles = req.files.map((file) => ({
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      data: file.buffer,
    }));

    const permit = new Permit({
      fullName: req.body.fullName,
      lastName: req.body.lastName,
      contactDetails: req.body.contactDetails,
      altContactDetails: req.body.altContactDetails,
      corpEmailId: req.body.corpEmailId,
      permitTitle: req.body.permitTitle,
      terminal: req.body.terminal,
      facility: req.body.facility,
      specifyTerminal: req.body.specifyTerminal,
      specifyFacility: req.body.specifyFacility,
      workDescription: req.body.workDescription,
      impact: req.body.impact,
      equipmentTypeInput: req.body.equipmentTypeInput,
      impactDetailsInput: req.body.impactDetailsInput,
      ePermit: req.body.ePermit,
      ePermitReason: req.body.ePermitReason,
      fmmWorkorder: req.body.fmmWorkorder,
      noFmmWorkorder: req.body.noFmmWorkorder,
      hseRisk: req.body.hseRisk,
      noHseRiskAssessmentReason: req.body.noHseRiskAssessmentReason,
      opRisk: req.body.opRisk,
      noOpsRiskAssessmentReason: req.body.noOpsRiskAssessmentReason,
      startDateTime: req.body.startDateTime,
      endDateTime: req.body.endDateTime,
      signName: req.body.signName,
      signDate: req.body.signDate,
      signTime: req.body.signTime,
      designation: req.body.designation,
      files: uploadedFiles,
      requester: req.session.userId,
      role: req.session.userRole,
    });

    await permit.save();

    // Create notification for successful permit submission
    try {
      await createNotification(
        req.session.userId,
        'permit_submitted',
        'Permit Submitted Successfully',
        `Your permit "${permit.permitTitle || 'N/A'}" has been submitted and is awaiting review.`,
        {
          permitId: permit._id.toString(),
          permitNumber: permit.permitNumber || '',
          status: 'Pending',
        }
      );
    } catch (notifErr) {
      console.error('Failed to create submission notification:', notifErr);
      // Don't fail the request if notification fails
    }

    // Notify all PreApprover users about the new submission
    try {
      const preApprovers = await User.find({ role: 'PreApprover', userStatus: 'Active' }).lean();
      const notifPromises = preApprovers.map((u) =>
        createNotification(
          u._id,
          'permit_submitted',
          'New Permit Submitted',
          `A new permit "${permit.permitTitle || 'N/A'}" has been submitted and requires your review.`,
          {
            permitId: permit._id.toString(),
            permitNumber: permit.permitNumber || '',
            status: 'Pending',
            requester: req.session.userId,
          }
        )
      );
      await Promise.allSettled(notifPromises);
    } catch (e) {
      console.error('Failed to notify pre-approvers about new permit:', e);
    }

    res.status(201).json({ message: 'Permit saved successfully', permit });
  } catch (err) {
    console.error('Permit save error:', err);
    res.status(500).json({ message: 'Failed to save permit', error: err.message });
  }
});

// ----- PATCH update permit status -----
router.patch('/permit/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, comments, approverName } = req.body;
    const permit = await Permit.findOne({
      _id: req.params.id,
      requester: req.session.userId,
    });
    if (!permit) return res.status(404).json({ message: 'Permit not found' });

    const oldStatus = permit.status;

    if (status === 'Approved' && !permit.permitNumber) {
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');

      const datePart = `${dd}${mm}${yyyy}`;
      const timePart = `${hh}${min}${ss}`;

      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      const endOfDay = new Date(now.setHours(23, 59, 59, 999));

      const countToday = await Permit.countDocuments({
        status: 'Approved',
        approvedAt: { $gte: startOfDay, $lte: endOfDay },
      });

      const serial = String(countToday + 1).padStart(3, '0');
      permit.permitNumber = `BHS-${datePart}-${timePart}-${serial}`;
      permit.approvedAt = new Date();
    }

    permit.status = status;
    await permit.save();

    // Create notification if status changed
    if (oldStatus !== status) {
      try {
        let notifType = 'permit_updated';
        let notifTitle = 'Permit Status Updated';
        let notifMessage = `Your permit "${permit.permitTitle || permit.permitNumber || 'N/A'}" status has been updated to ${status}.`;

        if (status === 'Approved') {
          notifType = 'permit_approved';
          notifTitle = 'Permit Approved';
          notifMessage = `Your permit "${permit.permitTitle || permit.permitNumber || 'N/A'}" has been approved!`;
        } else if (status === 'Rejected') {
          notifType = 'permit_rejected';
          notifTitle = 'Permit Rejected';
          notifMessage = `Your permit "${permit.permitTitle || permit.permitNumber || 'N/A'}" has been rejected.`;
        }

        await createNotification(permit.requester, notifType, notifTitle, notifMessage, {
          permitId: permit._id.toString(),
          permitNumber: permit.permitNumber,
          status: status,
          approverName: approverName || 'Approver',
          comments: comments || '',
        });
      } catch (notifErr) {
        console.error('Failed to create notification:', notifErr);
      }
    }

    res.json({ message: 'Status updated', permit });
  } catch (err) {
    console.error('Error updating permit:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----- GET PDF for an approved permit -----
router.get('/permit/:id/pdf', requireAuth, async (req, res) => {
  let browser;
  let page;
  let launchedOwnBrowser = false;
  try {
    const getBrowser = req.app.get('getBrowser');
    if (typeof getBrowser === 'function') {
      // Reuse the shared browser from server.js for stability
      browser = await getBrowser();
    } else {
      // Fallback to launching our own browser instance (Windows/dev friendly)
      const launchOptions = {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--font-render-hinting=none',
          '--disable-gpu',
        ],
        headless: true,
      };
      try {
        const execPath = await chromium.executablePath();
        browser = await puppeteer.launch({
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: execPath,
          headless: chromium.headless,
        });
        launchedOwnBrowser = true;
      } catch (e) {
        try {
          browser = await puppeteer.launch(launchOptions);
          launchedOwnBrowser = true;
        } catch (e2) {
          const candidates = [
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          ];
          let launched = false;
          for (const execPath of candidates) {
            try {
              browser = await puppeteer.launch({ ...launchOptions, executablePath: execPath });
              launchedOwnBrowser = true;
              launched = true;
              break;
            } catch (e3) {
              // ignore
            }
          }
          if (!launched) {
            throw e2;
          }
        }
      }
    }

    const permit = await Permit.findOne({
      _id: req.params.id,
      requester: req.session.userId,
    });

    if (!permit) return res.status(404).json({ message: 'Permit not found' });
    if (permit.status !== 'Approved')
      return res.status(403).json({ message: 'Permit not approved yet' });

    const user = await User.findById(req.session.userId);

    // 🔑 Date/time formatting constants (Qatar timezone)
    const FORMAT_LOCALE = 'en-GB'; // dd/mm/yyyy style
    const FORMAT_OPTS_DATE = {
      timeZone: 'Asia/Qatar',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    };
    const FORMAT_OPTS_TIME = {
      timeZone: 'Asia/Qatar',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    };
    const FORMAT_OPTS_DATETIME = { timeZone: 'Asia/Qatar' };

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            @page { size: A4; margin: 1cm; }
            /* Use standard project base font-size for printable reports */
            body { font-size: 16px; line-height: 1.4; border: 2px solid #000; padding: 20px; box-sizing: border-box; }
            header { text-align: center; margin-bottom: 20px; background-color: #273172; color: #fff; padding: 10px; }
            header h1 { font-size: 1.25rem; margin: 0; }
            header h2 { font-size: 1rem; margin: 5px 0 0 0; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
            td { border: 1px solid #000; padding: 6px; vertical-align: top; }
            td.label { font-weight: bold; width: 35%; background: #f2f2f2; }
            blockquote { font-style: italic; margin: 20px 0; padding-left: 10px; border-left: 3px solid #999; }
            footer { font-size: 0.6875rem; margin-top: 30px; border-top: 1px solid #ccc; padding-top: 8px; display: flex; justify-content: space-between; align-items: center; }
            footer .center { flex: 1; text-align: center; }
            footer .left { text-align: left; flex: 1; }
            footer .right { text-align: right; flex: 1; }
          </style>
        </head>
        <body>
          <header>
            <h1>HIA Baggage Handling System - A Gateway to Access the BHS</h1>
            <h2>Permit Status Report</h2>
          </header>
          <table>
            <tr><td class="label">Full Name</td><td>${permit.fullName || ''} ${
              permit.lastName || ''
            }</td></tr>
            <tr><td class="label">Mobile Number</td><td>${permit.contactDetails || ''}</td></tr>
            <tr><td class="label">Alternate Mobile Number</td><td>${
              permit.altContactDetails || ''
            }</td></tr>
            <tr><td class="label">Designation</td><td>${permit.designation || ''}</td></tr>
            <tr><td class="label">Permit Title</td><td>${permit.permitTitle || ''}</td></tr>
            <tr><td class="label">Permit Number</td><td>${permit.permitNumber || ''}</td></tr>
            <tr><td class="label">Start Date and Time</td><td>${
              permit.startDateTime
                ? new Date(permit.startDateTime).toLocaleString(FORMAT_LOCALE, FORMAT_OPTS_DATETIME)
                : ''
            }</td></tr>
            <tr><td class="label">End Date and Time</td><td>${
              permit.endDateTime
                ? new Date(permit.endDateTime).toLocaleString(FORMAT_LOCALE, FORMAT_OPTS_DATETIME)
                : ''
            }</td></tr>
            <tr><td class="label">Work Description</td><td>${permit.workDescription || ''}</td></tr>
            <tr><td class="label">Status</td><td>${permit.status || ''}</td></tr>
          </table>

          <blockquote>
            "Safety and teamwork are the foundation of every successful operation."
          </blockquote>

          <p>
            Thank you for your commitment to safe and professional work practices.
            Your dedication ensures smooth operations and a secure environment.
          </p>

          <footer>
              <div class="left">Printed by: ${user?.username || 'Unknown User'}</div>
              <div class="center">This is a system generated report and does not require signature.</div>
              <div class="right">
                Date: ${new Date().toLocaleDateString(FORMAT_LOCALE, FORMAT_OPTS_DATE)}<br/>
                Time: ${new Date().toLocaleTimeString(FORMAT_LOCALE, FORMAT_OPTS_TIME)}
              </div>
          </footer>
        </body>
      </html>
    `;

    page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.emulateMediaType('print');
    await page.waitForSelector('body', { timeout: 3000 });
    await page
      .waitForFunction('document.body && document.body.innerText.trim().length > 0', {
        timeout: 3000,
      })
      .catch(() => {
        /* ignore */
      });
    let pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    // Fallback: if buffer suspiciously small, try data URL approach with screen media
    if (!pdfBuffer || pdfBuffer.length < 2000) {
      try {
        await page.close();
        page = await browser.newPage();
        await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
        await page.emulateMediaType('screen');
        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        await page.goto(dataUrl, { waitUntil: 'load' });
        await page.waitForSelector('body', { timeout: 3000 });
        await page
          .waitForFunction('document.body && document.body.innerText.trim().length > 0', {
            timeout: 3000,
          })
          .catch(() => {
            /* ignore */
          });
        pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          preferCSSPageSize: true,
        });
      } catch (e) {
        // keep original buffer if fallback fails
      }
    }
    await page.close();
    if (launchedOwnBrowser) await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    const safeName = (permit.permitNumber || `permit-${permit._id}`).replace(
      /[^a-zA-Z0-9._-]+/g,
      '-'
    );
    res.setHeader('Content-Disposition', `attachment; filename="BHS-${safeName}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating PDF:', err);
    try {
      if (page) await page.close();
    } catch (closeErr) {
      console.error('Error closing page after PDF failure:', closeErr);
    }
    if (launchedOwnBrowser && browser) await browser.close();
    const payload = { message: 'Error generating PDF' };
    if (process.env.NODE_ENV !== 'production') {
      payload.detail = err?.message || String(err);
    }
    res.status(500).json(payload);
  }
});

module.exports = router;
