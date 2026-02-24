const express = require('express');
const { authMiddleware } = require('../auth');
const admin = require('../admin');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  if (!req.user.position || !req.user.position.includes('Chi')) {
    return res.status(403).json({ success: false, message: 'Only Chi (Tech Chair) can access the admin dashboard' });
  }
  next();
});

router.get('/brothers', async (_req, res) => {
  try { res.json(await admin.getAllBrothers()); }
  catch (err) { res.status(500).json([]); }
});

router.post('/brothers', async (req, res) => {
  try {
    const { email, name, position } = req.body;
    res.json(await admin.addBrother(email, name, position));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/brothers/:email', async (req, res) => {
  try { res.json(await admin.deleteBrother(decodeURIComponent(req.params.email))); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/deactivate-alumni', async (_req, res) => {
  try { res.json(await admin.deactivateAlumni()); }
  catch (err) { res.status(500).json({ count: 0, message: err.message }); }
});

router.post('/announcement', (req, res) => {
  try {
    admin.sendGlobalAnnouncement(req.body.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/stats', async (_req, res) => {
  try { res.json(await admin.getSystemStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/export-brothers', async (_req, res) => {
  try {
    const csv = await admin.exportBrothers();
    res.type('text/csv').send(csv);
  } catch (err) { res.status(500).send(''); }
});

router.get('/audit-log', (_req, res) => {
  try { res.json(admin.getAuditLog()); }
  catch (err) { res.status(500).json([]); }
});

router.get('/export-audit-log', (_req, res) => {
  try {
    const csv = admin.exportAuditLog();
    res.type('text/csv').send(csv);
  } catch (err) { res.status(500).send(''); }
});

router.post('/force-logout', (_req, res) => {
  try {
    admin.forceLogoutAllUsers();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/reset-passwords', (_req, res) => {
  try { res.json(admin.resetAllPasswords()); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/clear-cache', (_req, res) => {
  try {
    admin.clearAllCache();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
