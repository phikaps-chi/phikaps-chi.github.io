const express = require('express');
const { authMiddleware } = require('../auth');
const {
  getButtonsForManager, saveCustomButton, saveBulkButtons,
  updateCustomButton, deleteCustomButton, getAllOfficerPositions,
  fetchHtmlFromGCS: fetchBtnHtml,
} = require('../buttons');
const { getParentSheet } = require('../sheets');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  next();
});

router.get('/manager', async (req, res) => {
  try {
    const buttons = await getButtonsForManager(req.user.email, req.user.position);
    res.json(buttons);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/brothers', async (req, res) => {
  try {
    const data = await getParentSheet('Sigma');
    const brothers = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][4] && data[i][5]) {
        brothers.push({ email: data[i][4].trim(), name: data[i][5].trim() });
      }
    }
    brothers.sort((a, b) => a.name.localeCompare(b.name));
    res.json(brothers);
  } catch (err) {
    res.status(500).json([]);
  }
});

router.get('/positions', (_req, res) => {
  res.json(getAllOfficerPositions());
});

router.post('/save', async (req, res) => {
  try {
    const result = await saveCustomButton(req.body, req.user.email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/bulk-save', async (req, res) => {
  try {
    const result = await saveBulkButtons(req.body, req.user.email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/update', async (req, res) => {
  try {
    const result = await updateCustomButton(req.body, req.user.email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await deleteCustomButton(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/fetch-html', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL required' });
    const html = await fetchBtnHtml(url);
    res.json({ success: true, html: html || '' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
