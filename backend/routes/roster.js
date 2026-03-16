const express = require('express');
const { authMiddleware } = require('../auth');
const { saveRosterChangesSimple, canManageRoster } = require('../roster');
const { getParentSheet, clearSheetCache } = require('../sheets');
const { getFullRoster } = require('../sigma');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  next();
});

router.get('/data', async (req, res) => {
  try {
    if (!canManageRoster(req.user.position)) {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }
    clearSheetCache('Sigma');
    const sigmaData = await getParentSheet('Sigma');
    const roster = getFullRoster(sigmaData);
    res.json(roster);
  } catch (err) {
    console.error('Roster data fetch error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/save', async (req, res) => {
  try {
    const result = await saveRosterChangesSimple(req.body);
    res.json(result);
  } catch (err) {
    console.error('Roster save error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
