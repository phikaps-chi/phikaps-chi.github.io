const express = require('express');
const { authMiddleware } = require('../auth');
const dieElo = require('../dieElo');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  next();
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await dieElo.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/games', async (req, res) => {
  try {
    // We use req.user.name to filter games, assuming name is available
    const games = await dieElo.getGameHistory(req.user.name || req.user.email);
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/games', async (req, res) => {
  try {
    const result = await dieElo.addGame(req.body, req.user.email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/games/:id', async (req, res) => {
  try {
    const result = await dieElo.editGame(req.params.id, req.body, req.user.email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/games/:id', async (req, res) => {
  try {
    const result = await dieElo.deleteGame(req.params.id, req.user.email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
