const express = require('express');
const config = require('../config');
const { getParentSheet, isValidEmail, cache } = require('../sheets');
const { authMiddleware, validateUserMatchesSession, getName } = require('../auth');
const { getWelcomeMessage } = require('../sigma');
const { getButtonsForDisplay } = require('../buttons');

const router = express.Router();

// All /api routes require authentication
router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ---------------------------------------------------------------------------
// GET /api/home-data — mirrors getHomePageData() from Code.gs
// ---------------------------------------------------------------------------
router.get('/home-data', async (req, res) => {
  try {
    const { email, position } = req.user;
    const sigmaData = await getParentSheet('Sigma');
    const officerPositions = position.split(',').map((p) => p.trim()).filter(Boolean);

    const navCards = [
      { icon: '\u{1F465}', title: 'Brother Directory', description: 'View contact information of all chapter members', href: 'https://docs.google.com/spreadsheets/d/1NR823yfHQvoTJcE_9jp6xNAZGmLMtTtoydTlVV9FVOY/edit?usp=sharing' },
      { icon: '\u{1F465}', title: 'Officers', description: 'View officers for each semester', href: 'https://docs.google.com/spreadsheets/d/1peDU0jsQChNQmq8uKdsAI0E1vGyNJN7XfmzoIdPbXX8/edit?usp=sharing' },
      { icon: '\u{1F3AF}', title: 'Rush', description: 'Access current Rush page and Archives', page: 'rusharchives', restrict: 'Pledge' },
      { icon: '\u{2699}\u{FE0F}', title: 'PKS Admin', description: 'Officer resources. Requires authorization.', href: 'https://drive.google.com/drive/folders/1Zxai_m_j1DxIdpON-N8brQCGVWBhXWwg?usp=drive_link' },
      { icon: '\u{2699}\u{FE0F}', title: 'Phi Kap Connect', description: 'External portal for management with Nationals', href: 'https://login.phikapconnect.org/' },
      { icon: '\u{1F5F3}\u{FE0F}', title: 'Rank Choice', description: 'Page for voting for options', page: 'rankChoice' },
    ];

    const allowedRosterManagers = ['Alpha', 'Beta', 'Sigma', 'Chi'];
    if (officerPositions.some((pos) => allowedRosterManagers.includes(pos))) {
      navCards.splice(2, 0, {
        icon: '\u{1F4DD}',
        title: 'Manage Roster',
        description: 'Update brother information and officer positions',
        page: 'rostermanagement',
        requiresOfficer: true,
      });
    }

    if (officerPositions.length > 0 && !officerPositions.includes('Pledge')) {
      navCards.push({
        icon: '\u{1F518}',
        title: 'Button Manager',
        description: 'Create custom buttons and shortcuts',
        page: 'buttonmanager',
        requiresOfficer: true,
      });
    }

    if (officerPositions.includes('Chi')) {
      navCards.push({
        icon: '\u{1F6E1}\u{FE0F}',
        title: 'Chi Admin Resources',
        description: 'Manage the Internal Website',
        href: 'https://drive.google.com/drive/folders/1czp6YJXz5_PWjrGsUF7sgwUL0oGYqBe6?dmr=1&ec=wgc-drive-hero-goto',
        requiresOfficer: true,
      });
    }

    let customButtons = [];
    try {
      customButtons = await getButtonsForDisplay(email);
    } catch (err) {
      console.error('Error loading custom buttons:', err.message);
    }

    res.json({
      welcomeMessage: getWelcomeMessage(sigmaData, email, position),
      navCards,
      customButtons,
    });
  } catch (err) {
    console.error('Error in /api/home-data:', err);
    res.status(500).json({ error: 'Failed to load home page data' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/verify-dev-password — mirrors verifyDevPassword() from Utilities.gs
// ---------------------------------------------------------------------------
router.post('/verify-dev-password', (req, res) => {
  const { password } = req.body;
  res.json({ valid: password === 'Werdna24' });
});

// ---------------------------------------------------------------------------
// POST /api/save-button-order — mirrors saveUserButtonOrder() from Code.gs
// Uses node-cache instead of PropertiesService.getUserProperties()
// ---------------------------------------------------------------------------
router.post('/save-button-order', (req, res) => {
  try {
    const { email, sessionId } = req.user;
    const { buttonOrder } = req.body;
    validateUserMatchesSession(sessionId, email);

    const key = `button_order_${email.toLowerCase()}`;
    cache.set(key, buttonOrder, 0); // TTL=0 means no expiry
    console.log(`Button order saved for ${email}: ${buttonOrder.length} buttons`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving button order:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/load-button-order — mirrors loadUserButtonOrder() from Code.gs
// ---------------------------------------------------------------------------
router.post('/load-button-order', (req, res) => {
  try {
    const { email, sessionId } = req.user;
    validateUserMatchesSession(sessionId, email);

    const key = `button_order_${email.toLowerCase()}`;
    const savedOrder = cache.get(key);
    res.json(savedOrder || null);
  } catch (err) {
    console.error('Error loading button order:', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
