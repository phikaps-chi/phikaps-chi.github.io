const express = require('express');
const config = require('../config');
const { authMiddleware } = require('../auth');

const router = express.Router();

function escapeForTemplate(str) {
  if (!str) return str;
  return str.replace(/'/g, "\\'");
}

/**
 * Inline HTML snippets that post a message to the parent frame.
 * These mirror the exact postMessage payloads that app.html expects
 * (see Code.gs lines 140-202).
 */
function postMessagePage(payload) {
  const script = typeof payload === 'string'
    ? `window.top.postMessage("${payload}", "*");`
    : `window.top.postMessage(${JSON.stringify(payload)}, "*");`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body><script>${script}</script></body>
</html>`;
}

// ---------------------------------------------------------------------------
// GET / — mirrors doGet() from Code.gs
//
// Auth flow:
//   1. ?health=1         → plain-text "OK"
//   2. Not authenticated → postMessage AUTH_REQUIRED or SESSION_EXPIRED
//   3. Authenticated but not authorised → postMessage UNAUTHORIZED_USER
//   4. Authenticated + authorised → render home.ejs with AUTH_SUCCESS injected
// ---------------------------------------------------------------------------
router.get('/', authMiddleware, (req, res) => {
  // 0. Health check
  if (req.query.health === '1') {
    return res.type('text').send('OK');
  }

  // 1. Not authenticated
  if (!req.user && !req.unauthorizedEmail) {
    const hadSession = !!req.query.session_id;
    const html = hadSession
      ? postMessagePage({ type: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' })
      : postMessagePage('AUTH_REQUIRED');
    return res.send(html);
  }

  // 2. Authenticated but not authorised
  if (!req.user && req.unauthorizedEmail) {
    return res.send(postMessagePage('UNAUTHORIZED_USER'));
  }

  // 3. Authenticated + authorised → serve home page
  const { email, name, position, sessionId } = req.user;
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.render('home', {
    email,
    position: escapeForTemplate(position),
    baseUrl,
    sessionId: sessionId || '',
  }, (err, html) => {
    if (err) {
      console.error('Error rendering home template:', err);
      return res.status(500).send('Internal server error');
    }

    // Inject AUTH_SUCCESS postMessage script right after <body>, mirroring
    // the exact pattern from Code.gs lines 218-254.
    const authSuccessScript = `
    <script>
      (function() {
        try {
          window.top.postMessage({
            type: "AUTH_SUCCESS",
            sessionId: ${JSON.stringify(sessionId)}
          }, "*");
        } catch (e) {
          console.error("Failed to send AUTH_SUCCESS message:", e);
        }
      })();
    </script>`;

    const bodyIndex = html.toLowerCase().indexOf('<body');
    if (bodyIndex !== -1) {
      const bodyEndIndex = html.indexOf('>', bodyIndex);
      html = html.substring(0, bodyEndIndex + 1) + authSuccessScript + html.substring(bodyEndIndex + 1);
    } else {
      html += authSuccessScript;
    }

    res.send(html);
  });
});

module.exports = router;
