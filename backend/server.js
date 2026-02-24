const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const mainRoutes = require('./routes/index');
const apiRoutes = require('./routes/api');
const viewRoutes = require('./routes/views');
const rosterRoutes = require('./routes/roster');
const buttonRoutes = require('./routes/buttons');
const rushRoutes = require('./routes/rush');
const adminRoutes = require('./routes/admin');
const pollRoutes = require('./routes/polls');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Render terminates TLS at the load balancer
if (!config.isDev) app.set('trust proxy', 1);

app.use(cors({
  origin: config.allowedOrigins,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again shortly.' },
});
app.use('/api', apiLimiter);

// Allow iframe embedding (mirrors Apps Script XFrameOptionsMode.ALLOWALL)
app.use((_req, res, next) => {
  res.removeHeader('X-Frame-Options');
  next();
});

// EJS templates
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------------------------------------------------------------------------
// SSE — preserved from the original server
// ---------------------------------------------------------------------------
let sseClients = [];

app.get('/sse', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

app.get('/rush-update', (_req, res) => {
  broadcastSSE({ refresh: true });
  res.json({ ok: true, delivered: sseClients.length });
});

app.get('/roster-update', (_req, res) => {
  broadcastSSE({ rosterUpdate: true });
  res.json({ ok: true, delivered: sseClients.length });
});

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => client.write(msg));
}

/**
 * Local SSE notify — replaces the UrlFetchApp calls in Utilities.gs.
 * Other modules can call this instead of making an HTTP round-trip.
 */
function notifySSE(eventType = 'refresh') {
  const payload = eventType === 'roster'
    ? { rosterUpdate: true }
    : { refresh: true };
  broadcastSSE(payload);
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// API routes — JSON endpoints called by the frontend via fetch()
// ---------------------------------------------------------------------------
app.use('/api', apiRoutes);
app.use('/api/roster', rosterRoutes);
app.use('/api/buttons', buttonRoutes);
app.use('/api/rush', rushRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/polls', pollRoutes);

// ---------------------------------------------------------------------------
// View routes — return rendered HTML for sub-pages (rush, rankChoice, etc.)
// ---------------------------------------------------------------------------
app.use('/api/views', viewRoutes);

// ---------------------------------------------------------------------------
// Main app route — mirrors Apps Script doGet()
// Handles auth + serves home page or postMessage error responses
// ---------------------------------------------------------------------------
app.use('/', mainRoutes);

// ---------------------------------------------------------------------------
// Global error handler — keeps the process alive on unhandled route errors
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: config.isDev ? err.message : 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(config.port, () => {
  console.log(`PKS Internal backend listening on port ${config.port}`);
  console.log(`  Environment: ${config.isDev ? 'development' : 'production'}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received — closing connections…`);
  sseClients.forEach((c) => c.end());
  sseClients = [];
  server.close(() => {
    console.log('Server shut down.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, notifySSE, broadcastSSE };
