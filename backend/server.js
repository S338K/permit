require('dotenv').config({ path: __dirname + '/.env' });
const logger = require('./logger');

// Do not print sensitive environment variables to logs in any environment.
// If you need to verify env vars during development, use a local-only debug flag.

const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const apiRoutes = require('./routes/api');
const puppeteerCore = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
let puppeteer = puppeteerCore; // may be swapped to full 'puppeteer' if available
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// parse cookies so routes that check refreshToken can read the cookie
app.use(cookieParser());

// ===== Serve Frontend Static Files =====
// In development, serve the entire parent directory so all pages
// (login, admin, approver, etc.) are same-origin with the API on :5000
// This ensures session cookies work correctly without cross-origin issues
const frontendRoot = path.join(__dirname, '..');
logger.info('Serving frontend static files from:', frontendRoot);
app.use(express.static(frontendRoot));

// Use Helmet for sensible security headers
app.use(helmet());

// ===== CORS Setup =====
const allowedOrigins = (process.env.ALLOWED_ORIGIN || 'http://127.0.0.1:5000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

logger.info('CORS allowed for origins:', allowedOrigins.join(', '));

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or Postman)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true, // allow cookies
  })
);

// ===== Security & Cache Headers ===== //
app.use((req, res, next) => {
  // Prevent caching of sensitive responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Allow scripts/styles from self and secure CDNs (https:). Keep other directives restrictive.
  // In production you may want to tighten these directives further and add a report-uri.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: https:",
    "font-src 'self' https: data:",
    "connect-src 'self' https:",
    "frame-ancestors 'none'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);

  next();
});

// ===== SESSION SETUP ===== //
if (isProd) app.set('trust proxy', 1);

// Use environment-specific session secrets
const DEFAULT_DEV_SECRET = 'PTW-2024-simple-dev-session-key-for-local-testing';
// Accept multiple env names for convenience. In production provide SESSION_SECRET_PROD;
// if it's missing but SESSION_SECRET exists (common), use that as a fallback.
const sessionSecret = isProd
  ? process.env.SESSION_SECRET_PROD ||
    process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET_DEV ||
    DEFAULT_DEV_SECRET
  : process.env.SESSION_SECRET_DEV || process.env.SESSION_SECRET || DEFAULT_DEV_SECRET;

// Ensure a session secret is provided in production for cryptographic safety
if (isProd && !sessionSecret) {
  throw new Error('SESSION_SECRET_PROD (or SESSION_SECRET) must be set in production environment');
}

app.use(
  session({
    name: 'sessionId',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      dbName: 'PTW',
      ttl: 2 * 60 * 60, // 2 hours in seconds
    }),
    cookie: {
      maxAge: 2 * 60 * 60 * 1000, // 2 hours
      httpOnly: true,
      sameSite: isProd ? 'none' : 'lax',
      secure: isProd,
    },
  })
);

// ===== Token Authentication Middleware ===== //
app.use((req, res, next) => {
  try {
    const authHeader = req.headers && req.headers.authorization;
    if (
      authHeader &&
      typeof authHeader === 'string' &&
      authHeader.toLowerCase().startsWith('bearer ')
    ) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const jwt = require('jsonwebtoken');
        const secret = process.env.JWT_SECRET || sessionSecret || 'dev-jwt-secret';
        try {
          const payload = jwt.verify(token, secret);
          req.session = req.session || {};
          req.session.userId = payload.sub || payload.id || null;
          req.session.userRole = payload.role || payload.r || null;
          req.tokenAuth = true;
        } catch (e) {
          // invalid token: ignore and continue without setting session
        }
      }
    }
  } catch (e) {
    // ignore and proceed
  }
  return next();
});

// 🔎 Debug middleware: log session on every request in non-production only
if (!isProd) {
  app.use((req, res, next) => {
    if (req.session) {
      logger.debug(
        {
          id: req.session.id,
          userId: req.session.userId || null,
          cookie: req.session.cookie,
        },
        '📦 Session check'
      );
    } else {
      logger.debug('⚠️ No session object on request');
    }
    next();
  });
}

// ===== Puppeteer Browser Reuse ===== //
let browser;
async function getBrowser() {
  if (!browser) {
    // Determine executable path in a resilient way across OSes and environments
    const fs = require('fs');
    let executablePath;

    // 1) Env var override (highest priority), but only if file exists
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
      if (fs.existsSync(envPath)) {
        executablePath = envPath;
        logger.debug('Using PUPPETEER_EXECUTABLE_PATH from env:', executablePath);
      } else {
        logger.warn('PUPPETEER_EXECUTABLE_PATH is set but file does not exist:', envPath);
      }
    }

    // 2) Try @sparticuz/chromium helper (may throw if binary not present)
    if (!executablePath) {
      try {
        executablePath = await chromium.executablePath();
        logger.debug('chromium.executablePath() returned:', executablePath);
      } catch (err) {
        logger.warn('chromium.executablePath() failed:', err && err.message);
      }
    }

    // 3) Try common OS locations if still missing
    if (!executablePath) {
      const candidates = [];
      if (process.platform === 'win32') {
        candidates.push(
          `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['LOCALAPPDATA'] || process.env.USERPROFILE + '\\AppData\\Local'}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['LOCALAPPDATA'] || process.env.USERPROFILE + '\\AppData\\Local'}\\Microsoft\\Edge\\Application\\msedge.exe`
        );
      } else if (process.platform === 'darwin') {
        candidates.push(
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        );
      } else {
        // linux/unix
        candidates.push(
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium'
        );
      }

      for (const p of candidates) {
        try {
          if (p && fs.existsSync(p)) {
            executablePath = p;
            logger.debug('Found local Chrome/Chromium executable at', p);
            break;
          }
        } catch (ex) {
          logger.warn('Error checking candidate executable path', ex && ex.message);
        }
      }
    }

    if (!executablePath && puppeteer === puppeteerCore) {
      try {
        // try to require full puppeteer dynamically
        // eslint-disable-next-line global-require
        const fullPuppeteer = require('puppeteer');
        puppeteer = fullPuppeteer;
        logger.info('Using full puppeteer package (bundled Chromium) as fallback');
      } catch (err) {
        logger.debug('Full puppeteer not available as a fallback:', err && err.message);
      }
    }

    const launchOptions = {
      args: [...(chromium.args || []), '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      headless: process.env.PUPPETEER_HEADLESS === '0' ? false : chromium.headless,
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    } else if (puppeteer === puppeteerCore) {
      // puppeteer-core requires an executable; if we reach here, none was found
      logger.error(
        'Chromium executable not found and puppeteer-core is in use. Set PUPPETEER_EXECUTABLE_PATH or install the full "puppeteer" package. See https://pptr.dev/troubleshooting'
      );
      throw new Error('No Chromium executable found for puppeteer-core');
    } else {
      // using full puppeteer which includes a Chromium; no executablePath required
      logger.debug('Launching full puppeteer (bundled Chromium)');
    }

    browser = await puppeteer.launch(launchOptions);
    logger.info('✅ Chromium/Chrome launched and cached');
  }
  return browser;
}

app.set('getBrowser', getBrowser);

// Optional: close browser gracefully on shutdown
async function closeBrowser() {
  if (browser) {
    await browser.close();
    logger.info('🛑 Chromium closed');
    browser = null;
  }
}

//=========ADMIN======= //
const adminRoutes = require('./routes/admin');
app.use('/admin', adminRoutes);

//=========PRE APPROVER======= //
const preApproverRoutes = require('./routes/preApprover');
app.use('/preapprover', preApproverRoutes);

//=========NOTIFICATIONS======= //
const notificationRoutes = require('./routes/notifications');
app.use(notificationRoutes);

//=========DEBUG (dev-only)======= //
try {
  const debugRoutes = require('./routes/debug');
  app.use(debugRoutes);
} catch (e) {
  logger.debug('No debug routes found or failed to load');
}

//=========REPORTS======= //
const reportsRoutes = require('./routes/reports');
app.use(reportsRoutes);

// ===== ROUTES ===== //
app.get('/', (req, res) => {
  res.send('Backend is running successfully 🚀');
});

app.use('/api', apiRoutes);

// ===== MONGODB CONNECTION =====//
mongoose
  .connect(process.env.MONGO_URI, {
    dbName: 'PTW',
  })
  .then(() => logger.info('MongoDB Connected'))
  .catch((err) => logger.error(err));

// ===== GLOBAL ERROR HANDLER ===== //
// Mongoose validation error translator and global error handler
app.use((err, req, res, _next) => {
  const timestamp = new Date().toISOString();
  logger.error(
    { method: req.method, url: req.originalUrl, stack: err.stack },
    `[${timestamp}] Error handler`
  );

  // If this is a Mongoose ValidationError, normalize to 400 and provide field-level details
  if (err && err.name === 'ValidationError' && err.errors) {
    const fields = {};
    Object.keys(err.errors).forEach((k) => {
      try {
        fields[k] = err.errors[k].message || String(err.errors[k]);
      } catch (e) {
        fields[k] = String(err.errors[k]);
      }
    });
    return res.status(400).json({
      message: 'Validation failed',
      errors: fields,
    });
  }

  res.status(err.status || 500).json({
    message: isProd ? 'An unexpected error occurred' : err.message,
    ...(isProd ? {} : { stack: err.stack }),
  });
});

// ===== START SERVER ======= //
const PORT = process.env.PORT || 5000;
// Before starting the server, run a quick browser health-check so failures are visible early.
async function startServerWithBrowserCheck() {
  // Diagnostic: print Puppeteer executable path and file status
  const fs = require('fs');
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  logger.info('[DIAGNOSTIC] PUPPETEER_EXECUTABLE_PATH env:', execPath);
  if (execPath) {
    try {
      const exists = fs.existsSync(execPath);
      logger.info(`[DIAGNOSTIC] Executable exists: ${exists}`);
      if (exists) {
        const stat = fs.statSync(execPath);
        logger.info(
          `[DIAGNOSTIC] Executable permissions: mode=${stat.mode.toString(8)} size=${stat.size}`
        );
      }
    } catch (e) {
      logger.error('[DIAGNOSTIC] Error checking executable:', e && e.message);
    }
  } else {
    logger.warn('[DIAGNOSTIC] PUPPETEER_EXECUTABLE_PATH env not set');
  }

  logger.info('Running browser startup check...');
  try {
    // Attempt to launch browser once to validate environment
    const b = await getBrowser();
    if (b) {
      logger.info('Browser startup check passed');
    }
  } catch (err) {
    logger.error('Browser startup check failed:', err && err.message);
    if (process.env.NODE_ENV === 'production') {
      logger.error('Exiting because browser is required in production.');
      process.exit(1);
    } else {
      logger.warn(
        'Continuing startup in development despite browser startup failure. PDF generation may not work until resolved.'
      );
    }
  }

  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.debug(`CORS allowed for origins: ${allowedOrigins}`);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      await closeBrowser();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await closeBrowser();
      process.exit(0);
    });
  });
}

startServerWithBrowserCheck();
