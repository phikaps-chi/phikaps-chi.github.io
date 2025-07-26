// server.js
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

// === Presence / SSE housekeeping ===
const HEARTBEAT_MS = 15_000; // send a ping this often
const STALE_MS = 45_000;     // drop a client if no successful write in this long

/**
 * clients: Map<id, { id, name, res, lastOk }>
 *  - id: unique per connection
 *  - name: username from query
 *  - res: Express response used as SSE stream
 *  - lastOk: timestamp of the last successful write (ping or data)
 */
let clients = new Map();

function now() { return Date.now(); }

function uniqueNames() {
  // Deduplicate to avoid showing the same user N times for multiple tabs
  return Array.from(new Set(Array.from(clients.values()).map(c => c.name)));
}

function writeSafe(client, payload) {
  try {
    // If socket already closed/destroyed, treat as failure
    if (!client.res || client.res.writableEnded || client.res.socket?.destroyed) {
      throw new Error('socket not writable');
    }
    client.res.write(payload);
    client.lastOk = now();
    return true;
  } catch (e) {
    // Mark for cleanup by returning false
    return false;
  }
}

function removeClient(id, reason = 'unknown') {
  const c = clients.get(id);
  if (!c) return;
  try { c.res?.end(); } catch {}
  clients.delete(id);
  console.log(`[SSE] removed client ${id} (${c.name}) :: ${reason}`);
}

/** Broadcast the current active user list */
function broadcastActiveUsers() {
  const names = uniqueNames();
  const eventData = `data: ${JSON.stringify({ activeUsers: names })}\n\n`;
  for (const c of clients.values()) {
    if (!writeSafe(c, eventData)) removeClient(c.id, 'broadcast failed');
  }
  console.log('[SSE] Broadcast active users:', names);
}

/** Heartbeat: keep connections alive and prune dead ones promptly */
setInterval(() => {
  const ts = now();
  for (const c of clients.values()) {
    // Stale?
    if (ts - c.lastOk > STALE_MS) {
      removeClient(c.id, 'stale');
      continue;
    }
    // Send a ping to flush dead sockets
    const ok = writeSafe(c, `event: ping\ndata: ${ts}\n\n`);
    if (!ok) removeClient(c.id, 'ping write failed');
  }
  // Only broadcast if something changed; here we keep it simple and broadcast after pruning
  broadcastActiveUsers();
}, HEARTBEAT_MS);

// --- SSE endpoint accepts a username ---
app.get('/sse', (req, res) => {
  const { user } = req.query;

  if (!user) {
    res.status(400).send('Username is required.');
    return;
  }

  // SSE headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // for some proxies (e.g., Nginx) to disable buffering
  });
  res.flushHeaders?.();

  // Ask the browser to retry quickly if dropped
  res.write(`retry: 2000\n\n`);

  // Register client
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const client = { id: clientId, name: String(user), res, lastOk: now() };
  clients.set(clientId, client);
  console.log(`[SSE] ${client.name} connected (${clientId}). Total: ${clients.size}`);

  // Send an immediate welcome + current roster so UI updates quickly
  writeSafe(client, `data: ${JSON.stringify({ activeUsers: uniqueNames() })}\n\n`);

  // Clean up on connection end/abort
  const cleanup = (why) => {
    if (!clients.has(clientId)) return;
    removeClient(clientId, why);
    broadcastActiveUsers();
  };

  req.on('close',   () => cleanup('req close'));
  req.on('aborted', () => cleanup('req aborted'));
  res.on('close',   () => cleanup('res close'));
  res.on('error',   () => cleanup('res error'));

  // Let everyone know someone joined
  broadcastActiveUsers();
});

// --- GET endpoint for Google Apps Script to ping for a data refresh ---
app.get('/rush-update', (req, res) => {
  let delivered = 0;
  for (const c of clients.values()) {
    if (writeSafe(c, `data: {"refresh": true}\n\n`)) delivered++;
    else removeClient(c.id, 'refresh write failed');
  }
  res.json({ ok: true, delivered });
});

// --- Health check ---
app.get('/', (req, res) => {
  res.json({
    status: 'SSE server is running.',
    activeClients: clients.size,
    activeUsers: uniqueNames(),
  });
});

app.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
});
