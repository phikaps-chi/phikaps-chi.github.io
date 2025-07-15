// server.js
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Allow CORS for all origins ---
app.use(cors());
app.use(express.json());

// --- List of connected clients (response objects) ---
let clients = [];

// --- SSE endpoint ---
app.get('/sse', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  // Add this client
  clients.push(res);

  // Remove client on close
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

// --- GET endpoint for Google Apps Script to ping for update ---
app.get('/rush-update', (req, res) => {
    // No payload, just a refresh signal
    clients.forEach(client => {
      client.write(`data: {"refresh": true}\n\n`);
    });
    res.json({ ok: true, delivered: clients.length });
  });

// --- Health check ---
app.get('/', (req, res) => {
  res.send('SSE server is running.');
});

// --- Start the server ---
app.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
});
