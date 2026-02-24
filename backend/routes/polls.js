const express = require('express');
const { authMiddleware } = require('../auth');
const polls = require('../polls');

const router = express.Router();

router.use(authMiddleware);
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  next();
});

router.get('/', async (_req, res) => {
  try { res.json(await polls.getAllActiveRankedChoicePolls()); }
  catch (err) { res.status(500).json([]); }
});

router.post('/', async (req, res) => {
  try {
    const { question, options, threshold, isAnonymous } = req.body;
    const pollId = await polls.createRankedChoicePoll(question, options, req.user.email, threshold, isAnonymous);
    res.json(pollId);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/vote', async (req, res) => {
  try {
    const { ranking } = req.body;
    await polls.submitRankedChoiceVote(req.params.id, req.user.email, ranking);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/close', async (req, res) => {
  try {
    await polls.closeRankedChoicePoll(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await polls.deleteRankedChoicePoll(req.params.id, req.user.email);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/reset', async (req, res) => {
  try {
    await polls.resetPollVotes(req.params.id, req.user.email);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
