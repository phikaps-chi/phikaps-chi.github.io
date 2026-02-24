const express = require('express');
const { authMiddleware } = require('../auth');
const { saveRosterChangesSimple } = require('../roster');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  next();
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
