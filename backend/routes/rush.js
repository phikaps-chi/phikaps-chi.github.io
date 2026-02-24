const express = require('express');
const { authMiddleware, getName } = require('../auth');
const rush = require('../rush');
const { getParentSheet } = require('../sheets');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  next();
});

// --- Rush Archives routes (Phase 3) ---

router.get('/events', async (_req, res) => {
  try { res.json(await rush.getRushEvents()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/events', async (req, res) => {
  try { res.json(await rush.addRushEventToSheet(req.body)); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/events/:id', async (req, res) => {
  try { res.json(await rush.deleteRushEvent(req.params.id)); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/events/:id/lock', async (req, res) => {
  try { res.json(await rush.toggleRushLock(req.params.id, req.user.position)); }
  catch (err) {
    const status = err.message.includes('UNAUTHORIZED') ? 403 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.get('/events/:id/engagement', async (req, res) => {
  try { res.json(await rush.calculateRushEngagement(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Rush Page routes (Phase 4b) ---

router.get('/page/:rushId/details', async (req, res) => {
  try { res.json(await rush.getRushPageDetails(req.params.rushId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/page/:rushId/recruits', async (req, res) => {
  try {
    const details = await rush.getRushPageDetails(req.params.rushId);
    if (!details) return res.status(404).json({ error: 'Rush event not found' });
    res.json(await rush.getRecruitsForRush(details.recruitsTabId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/page/:rushId/comments', async (req, res) => {
  try {
    const details = await rush.getRushPageDetails(req.params.rushId);
    if (!details) return res.status(404).json({ error: 'Rush event not found' });
    res.json(await rush.getCommentsForRush(details.commentsTabId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/recruits/save', async (req, res) => {
  try {
    const { recruitsTabId, id, name, email, phone, instagram, contactsJson, base64Data, addedBy } = req.body;
    res.json(await rush.addOrUpdateRecruitWithPhoto(recruitsTabId, id, name, email, phone, instagram, contactsJson, base64Data, addedBy));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/recruits/:tabId/:recruitId', async (req, res) => {
  try { res.json(await rush.deleteRecruit(req.params.tabId, req.params.recruitId)); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/recruits/tier', async (req, res) => {
  try {
    const { tabId, recruitId, tier } = req.body;
    res.json(await rush.updateRecruitTier(tabId, recruitId, tier));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/recruits/like', async (req, res) => {
  try {
    const { tabId, recruitId } = req.body;
    const sigmaData = await getParentSheet('Sigma');
    const userName = getName(sigmaData, req.user.email) || req.user.name;
    res.json(await rush.addLike(tabId, recruitId, userName));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/recruits/dislike', async (req, res) => {
  try {
    const { tabId, recruitId } = req.body;
    const sigmaData = await getParentSheet('Sigma');
    const userName = getName(sigmaData, req.user.email) || req.user.name;
    res.json(await rush.addDislike(tabId, recruitId, userName));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/recruits/met', async (req, res) => {
  try {
    const { tabId, recruitId } = req.body;
    const sigmaData = await getParentSheet('Sigma');
    const userName = getName(sigmaData, req.user.email) || req.user.name;
    res.json(await rush.addMet(tabId, recruitId, userName));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/comments/save', async (req, res) => {
  try {
    const { commentsTabId, recruitId, text } = req.body;
    const sigmaData = await getParentSheet('Sigma');
    const authorName = getName(sigmaData, req.user.email) || req.user.name;
    res.json(await rush.addOrUpdateComment(commentsTabId, recruitId, text, authorName));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/comments/delete', async (req, res) => {
  try {
    const { commentsTabId, recruitId, authorName } = req.body;
    const sigmaData = await getParentSheet('Sigma');
    const requestingName = getName(sigmaData, req.user.email) || req.user.name;
    const isRho = req.user.position && req.user.position.includes('Rho');
    if (requestingName !== authorName && !isRho) {
      return res.status(403).json({ success: false, error: 'You can only delete your own comments unless you are Rho.' });
    }
    res.json(await rush.deleteComment(commentsTabId, recruitId, authorName));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// --- Admin settings ---

router.get('/admin-settings', (_req, res) => {
  try { res.json(rush.getAdminSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin-settings/global', (req, res) => {
  try {
    const { key, value } = req.body;
    res.json(rush.setGlobalSetting(key, value));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/admin-settings/brother', (req, res) => {
  try {
    const { email, settings } = req.body;
    res.json(rush.setBrotherSettings(email, settings));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// --- Brothers list (for rush page admin panel) ---

router.get('/brothers', async (_req, res) => {
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
  } catch (err) { res.status(500).json([]); }
});

module.exports = router;
