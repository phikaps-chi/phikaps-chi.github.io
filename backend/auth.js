const NodeCache = require('node-cache');
const crypto = require('crypto');
const config = require('./config');
const { getParentSheet, isValidEmail, searchByEmail, findRowByValue } = require('./sheets');

const sessionCache = new NodeCache({ stdTTL: config.cache.sessionTTL, checkperiod: 60 });

// ---------------------------------------------------------------------------
// Token validation — mirrors validateTokenUsingTokeninfo() in Code.gs
// ---------------------------------------------------------------------------

async function validateIdToken(idToken) {
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Token validation failed:', res.status, await res.text());
      return null;
    }

    const payload = await res.json();

    if (payload.aud !== config.clientId) {
      console.error('Token validation failed: audience mismatch. Expected:', config.clientId, 'Got:', payload.aud);
      return null;
    }
    if (payload.exp * 1000 < Date.now()) {
      console.error('Token validation failed: token expired');
      return null;
    }
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      console.error('Token validation failed: invalid issuer:', payload.iss);
      return null;
    }

    return payload;
  } catch (err) {
    console.error('Error validating ID token:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session management — mirrors CacheService session logic in Code.gs
// ---------------------------------------------------------------------------

function createSession(email, userId) {
  const sessionId = crypto.randomUUID();
  const sessionData = { email, id: userId };
  sessionCache.set(config.session.keyPrefix + sessionId, sessionData);
  console.log(`Session ${sessionId} created for ${email}`);
  return sessionId;
}

function getSession(sessionId) {
  return sessionCache.get(config.session.keyPrefix + sessionId) || null;
}

function extendSession(sessionId) {
  const data = sessionCache.get(config.session.keyPrefix + sessionId);
  if (data) {
    sessionCache.set(config.session.keyPrefix + sessionId, data);
  }
}

function clearSession(sessionId) {
  sessionCache.del(config.session.keyPrefix + sessionId);
}

// ---------------------------------------------------------------------------
// User lookups — mirrors Sigma.gs getName / getPosition
// ---------------------------------------------------------------------------

function getName(sigmaData, email) {
  const row = findRowByValue(sigmaData, email, 4);
  if (!row) return null;
  return row[5] || null; // Column F (index 5) = Name
}

function getPosition(sigmaData, email) {
  const row = findRowByValue(sigmaData, email, 4);
  if (!row) return '';
  return row[6] || ''; // Column G (index 6) = Officer Position
}

// ---------------------------------------------------------------------------
// Express middleware — to be wired up in Phase 1
//
// Reads id_token or session_id from query params, validates, and attaches
// req.user = { email, name, position, sessionId } for downstream routes.
// ---------------------------------------------------------------------------

async function authMiddleware(req, res, next) {
  const idToken = req.query.id_token;
  const sessionId = req.query.session_id;

  let email = null;
  let userId = null;
  let currentSessionId = sessionId;

  // 1. Try resuming an existing session
  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      const sigmaData = await getParentSheet('Sigma');
      if (isValidEmail(sigmaData, session.email)) {
        email = session.email;
        userId = session.id;
        extendSession(sessionId);
      } else {
        clearSession(sessionId);
      }
    }
  }

  // 2. Fall back to ID token validation
  if (!email && idToken) {
    const payload = await validateIdToken(idToken);
    if (payload && payload.email && payload.sub) {
      email = payload.email;
      userId = payload.sub;
      currentSessionId = createSession(email, userId);
    }
  }

  // 3. Not authenticated
  if (!email) {
    req.user = null;
    return next();
  }

  // 4. Authorisation — check Sigma sheet
  const sigmaData = await getParentSheet('Sigma');
  if (!isValidEmail(sigmaData, email)) {
    req.user = null;
    req.unauthorizedEmail = email;
    return next();
  }

  // 5. Attach user context
  req.user = {
    email,
    userId,
    name: getName(sigmaData, email) || 'Member',
    position: getPosition(sigmaData, email) || '',
    sessionId: currentSessionId,
  };
  next();
}

/**
 * Mirrors validateUserMatchesSession() — throws if the claimed email
 * doesn't match the session.
 */
function validateUserMatchesSession(sessionId, claimedEmail) {
  if (config.isDev) return true;

  if (!sessionId || sessionId.trim() === '') {
    throw new Error('SESSION_EXPIRED: Please refresh the page to continue');
  }

  const session = getSession(sessionId);
  if (!session) {
    throw new Error('SESSION_EXPIRED: Your session has expired. Please refresh the page');
  }

  if (session.email.trim().toLowerCase() !== claimedEmail.trim().toLowerCase()) {
    console.error(`SECURITY: Email mismatch! Session: ${session.email}, Claimed: ${claimedEmail}`);
    throw new Error('UNAUTHORIZED: You are not authorized to perform actions as this user');
  }

  extendSession(sessionId);
  return true;
}

module.exports = {
  validateIdToken,
  createSession,
  getSession,
  extendSession,
  clearSession,
  getName,
  getPosition,
  authMiddleware,
  validateUserMatchesSession,
  sessionCache,
};
