const config = require('./config');
const { getParentSheet, getSheetsClient, clearSheetCache, cache } = require('./sheets');
const { sessionCache } = require('./auth');

/**
 * Returns all brothers from the Sigma sheet.
 */
async function getAllBrothers() {
  const data = await getParentSheet('Sigma');
  const brothers = [];
  for (let i = 1; i < data.length; i++) {
    const email = data[i][4];
    const name = data[i][5];
    const position = data[i][6] || '';
    if (email && name) {
      brothers.push({ email: email.trim(), name: name.trim(), position: position.trim() });
    }
  }
  brothers.sort((a, b) => a.name.localeCompare(b.name));
  return brothers;
}

/**
 * Adds a new brother to the Sigma sheet.
 */
async function addBrother(email, name, position) {
  if (!email || !name) return { success: false, message: 'Email and name are required' };

  const sheets = await getSheetsClient();
  const data = await getParentSheet('Sigma');

  for (let i = 1; i < data.length; i++) {
    if (data[i][4] && data[i][4].toLowerCase().trim() === email.toLowerCase().trim()) {
      return { success: false, message: 'A brother with this email already exists' };
    }
  }

  const numCols = data[0] ? Math.max(data[0].length, 7) : 7;
  const newRow = Array(numCols).fill('');
  newRow[4] = email.trim();
  newRow[5] = name.trim();
  newRow[6] = (position || '').trim();

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: 'Sigma',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [newRow] },
  });

  clearSheetCache('Sigma');
  return { success: true, message: 'Brother added successfully' };
}

/**
 * Deletes a brother from the Sigma sheet by email.
 */
async function deleteBrother(email) {
  if (!email) return { success: false, message: 'Email is required' };

  const sheets = await getSheetsClient();
  const data = await getParentSheet('Sigma');

  const rowIndex = data.findIndex(
    (row, i) => i > 0 && row[4] && row[4].toLowerCase().trim() === email.toLowerCase().trim(),
  );

  if (rowIndex === -1) return { success: false, message: 'Brother not found' };

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const sigmaSheet = meta.data.sheets.find((s) => s.properties.title === 'Sigma');
  if (!sigmaSheet) return { success: false, message: 'Sigma sheet not found' };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sigmaSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    },
  });

  clearSheetCache('Sigma');
  cache.del('validEmail:' + email.trim().toLowerCase());
  return { success: true, message: 'Brother deleted successfully' };
}

/**
 * Deactivates alumni by removing brothers whose position includes "Alumni".
 */
async function deactivateAlumni() {
  const sheets = await getSheetsClient();
  const data = await getParentSheet('Sigma');

  const alumniRows = [];
  for (let i = 1; i < data.length; i++) {
    const pos = (data[i][6] || '').toLowerCase();
    if (pos.includes('alumni')) alumniRows.push(i);
  }

  if (alumniRows.length === 0) return { count: 0 };

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const sigmaSheet = meta.data.sheets.find((s) => s.properties.title === 'Sigma');
  if (!sigmaSheet) return { count: 0 };

  const requests = alumniRows.reverse().map((idx) => ({
    deleteDimension: {
      range: {
        sheetId: sigmaSheet.properties.sheetId,
        dimension: 'ROWS',
        startIndex: idx,
        endIndex: idx + 1,
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: { requests },
  });

  clearSheetCache('Sigma');
  return { count: alumniRows.length };
}

/**
 * Broadcasts a global announcement via SSE.
 */
function sendGlobalAnnouncement(message) {
  try {
    const { broadcastSSE } = require('./server');
    broadcastSSE({ announcement: message });
  } catch (_) {}
}

/**
 * Returns basic system statistics.
 */
async function getSystemStats() {
  const data = await getParentSheet('Sigma');
  const totalBrothers = data.length - 1;
  const activeSessions = sessionCache.keys().length;
  const cacheKeys = cache.keys().length;

  return {
    totalBrothers,
    activeSessions,
    cacheEntries: cacheKeys,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
    memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

/**
 * Exports all brothers as CSV text.
 */
async function exportBrothers() {
  const brothers = await getAllBrothers();
  const header = 'Email,Name,Position';
  const rows = brothers.map((b) => `"${b.email}","${b.name}","${b.position}"`);
  return [header, ...rows].join('\n');
}

/**
 * Returns the audit log from cache.
 * Audit log entries are stored as they happen; kept in memory.
 */
function getAuditLog() {
  return cache.get('auditLog') || [];
}

function logAudit(action, email, details) {
  const log = cache.get('auditLog') || [];
  log.push({ timestamp: new Date().toISOString(), action, email, details });
  if (log.length > 500) log.splice(0, log.length - 500);
  cache.set('auditLog', log, 0);
}

/**
 * Exports the audit log as CSV text.
 */
function exportAuditLog() {
  const log = getAuditLog();
  const header = 'Timestamp,Action,Email,Details';
  const rows = log.map((e) => `"${e.timestamp}","${e.action}","${e.email}","${(e.details || '').replace(/"/g, '""')}"`);
  return [header, ...rows].join('\n');
}

/**
 * Clears all active user sessions.
 */
function forceLogoutAllUsers() {
  sessionCache.flushAll();
}

/**
 * Stub — passwords are handled by Google Sign-In, not our system.
 */
function resetAllPasswords() {
  return { count: 0, message: 'Passwords are managed by Google Sign-In' };
}

/**
 * Clears all node-cache entries.
 */
function clearAllCache() {
  cache.flushAll();
}

module.exports = {
  getAllBrothers,
  addBrother,
  deleteBrother,
  deactivateAlumni,
  sendGlobalAnnouncement,
  getSystemStats,
  exportBrothers,
  getAuditLog,
  logAudit,
  exportAuditLog,
  forceLogoutAllUsers,
  resetAllPasswords,
  clearAllCache,
};
