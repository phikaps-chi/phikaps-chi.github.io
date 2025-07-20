// server.js
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Store clients as objects with an id and name ---
let clients = [];

// --- Helper function to broadcast the current list of active users ---
const broadcastActiveUsers = () => {
  const activeUserNames = clients.map(client => client.name);
  const eventData = `data: ${JSON.stringify({ activeUsers: activeUserNames })}\n\n`;
  
  clients.forEach(client => {
    client.res.write(eventData);
  });
  console.log('Broadcasted active users:', activeUserNames);
};

// --- SSE endpoint now accepts a username ---
app.get('/sse', (req, res) => {
  const { user } = req.query;

  // Require a user to connect
  if (!user) {
    res.status(400).send('Username is required.');
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  
  // --- Create a unique ID for this client connection ---
  const clientId = Date.now();
  const newClient = {
    id: clientId,
    name: user,
    res: res, // The response object to send events
  };

  clients.push(newClient);
  console.log(`${user} connected.`);
  
  // --- Send the updated list to all clients ---
  broadcastActiveUsers();

  // Remove client on close and broadcast the new list
  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
    console.log(`${user} disconnected.`);
    broadcastActiveUsers();
  });
});

// --- GET endpoint for Google Apps Script to ping for a data refresh ---
// This remains unchanged
app.get('/rush-update', (req, res) => {
  clients.forEach(client => {
    client.res.write(`data: {"refresh": true}\n\n`);
  });
  res.json({ ok: true, delivered: clients.length });
});

// --- Health check ---
app.get('/', (req, res) => {
  res.json({
    status: 'SSE server is running.',
    activeClients: clients.length,
    activeUsers: clients.map(c => c.name),
  });
});

// --- Start the server ---
app.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
});