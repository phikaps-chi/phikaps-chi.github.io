const express = require('express');
const { authMiddleware, getName } = require('../auth');
const { getParentSheet } = require('../sheets');
const { getFullRoster } = require('../sigma');
const { canManageRoster } = require('../roster');
const { getRushEvents } = require('../rush');
const config = require('../config');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) {
    return res.status(401).send('<p style="color:red;">Not authenticated. Please refresh the page.</p>');
  }
  next();
});

// ---------------------------------------------------------------------------
// Static pages — no template vars, no server calls
// ---------------------------------------------------------------------------

router.get('/records', (_req, res) => {
  res.render('records');
});

router.get('/accessdenied', (_req, res) => {
  res.render('accessdenied');
});

// ---------------------------------------------------------------------------
// Roster Management — needs permission check + roster data
// ---------------------------------------------------------------------------

router.get('/rostermanagement', async (req, res) => {
  try {
    if (!canManageRoster(req.user.position)) {
      return res.send(
        '<div style="color: #f44336; text-align: center; padding: 2rem;">You do not have permission to manage the roster. Only Alpha, Beta, Sigma, and Chi officers can access this feature.</div>',
      );
    }

    const sigmaData = await getParentSheet('Sigma');
    const fullRoster = getFullRoster(sigmaData);

    const htmlContent = await new Promise((resolve, reject) => {
      res.app.render('rostermanagement', {
        email: req.user.email,
        position: req.user.position,
        sessionId: req.user.sessionId,
        baseUrl: '',
        roster: fullRoster,
      }, (err, html) => (err ? reject(err) : resolve(html)));
    });

    const dataScript = `<script>
      window.preloadedRosterData = ${JSON.stringify(fullRoster)};
    </script>`;

    const bodyIndex = htmlContent.indexOf('<body');
    if (bodyIndex !== -1) {
      const bodyEndIndex = htmlContent.indexOf('>', bodyIndex);
      return res.send(htmlContent.slice(0, bodyEndIndex + 1) + dataScript + htmlContent.slice(bodyEndIndex + 1));
    }
    res.send(dataScript + htmlContent);
  } catch (err) {
    console.error('Roster view error:', err);
    res.status(500).send('<p style="color:red;">Error loading roster management.</p>');
  }
});

// ---------------------------------------------------------------------------
// Button Manager — officers only
// ---------------------------------------------------------------------------

router.get('/buttonmanager', (req, res) => {
  if (req.user.position && req.user.position.includes('Pledge')) {
    return res.send(
      '<div style="color: #f44336; text-align: center; padding: 2rem;">You do not have permission to manage buttons. This feature is only available to officers.</div>',
    );
  }

  res.render('buttonmanager', {
    email: req.user.email,
    position: req.user.position,
    sessionId: req.user.sessionId,
    baseUrl: '',
  });
});

// ---------------------------------------------------------------------------
// Rush Archives
// ---------------------------------------------------------------------------

router.get('/rusharchives', async (req, res) => {
  try {
    const events = await getRushEvents();
    res.render('rusharchives', {
      events,
      baseUrl: '',
      position: req.user.position,
    });
  } catch (err) {
    console.error('Rush archives view error:', err);
    res.status(500).send('<p style="color:red;">Error loading rush archives.</p>');
  }
});

// ---------------------------------------------------------------------------
// Admin Dashboard — Chi only
// ---------------------------------------------------------------------------

router.get('/admindashboard', async (req, res) => {
  if (!req.user.position || !req.user.position.includes('Chi')) {
    return res.send(
      '<div style="color: #f44336; text-align: center; padding: 2rem; font-family: sans-serif;"><h2>Access Denied</h2><p>This dashboard is only accessible to the Chi (Tech Chair).</p></div>',
    );
  }

  try {
    const sigmaData = await getParentSheet('Sigma');
    res.render('admindashboard', {
      email: req.user.email,
      name: getName(sigmaData, req.user.email) || 'Chi',
      position: req.user.position,
      baseUrl: '',
    });
  } catch (err) {
    console.error('Admin dashboard view error:', err);
    res.status(500).send('<p style="color:red;">Error loading admin dashboard.</p>');
  }
});

// ---------------------------------------------------------------------------
// Ranked Choice Voting
// ---------------------------------------------------------------------------

router.get('/rankchoice', (req, res) => {
  const rushId = req.query.rushId || '';
  res.render('rankChoice', {
    email: req.user.email,
    name: req.user.name,
    position: req.user.position,
    sessionId: req.user.sessionId,
    isAdmin: config.isDev,
    rushId,
    baseUrl: '',
    contacts: [],
  });
});

// ---------------------------------------------------------------------------
// Rush Page — needs rush event details + contacts
// ---------------------------------------------------------------------------

router.get('/rushpage', async (req, res) => {
  const rushId = req.query.rushId || '';
  if (!rushId) {
    return res.status(400).send('<p style="color:red;">No Rush Event ID provided.</p>');
  }

  try {
    const { getRushEvent } = require('../rush');
    const rushEvent = await getRushEvent(rushId);
    const isLocked = rushEvent ? rushEvent.isLocked : false;
    const { getListOfBrothers } = require('../sigma');
    const sigmaData = await getParentSheet('Sigma');
    const contacts = getListOfBrothers(sigmaData);

    res.render('rushpage', {
      name: req.user.name,
      email: req.user.email,
      position: req.user.position,
      contacts,
      rushId,
      baseUrl: '',
      isLocked,
      sessionId: req.user.sessionId,
    });
  } catch (err) {
    console.error('Rush page view error:', err);
    res.status(500).send('<p style="color:red;">Error loading rush page.</p>');
  }
});

module.exports = router;
