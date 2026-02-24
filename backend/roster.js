const { Mutex } = require('async-mutex');
const config = require('./config');
const {
  getParentSheet,
  getSheetsClient,
  clearSheetCache,
  cache,
} = require('./sheets');

const rosterMutex = new Mutex();

/**
 * Checks if the user's position allows roster management.
 * Alpha, Beta, Sigma, and Chi can manage the roster.
 * @param {string} userPosition - Comma-separated positions (e.g. "Alpha, Pledge")
 * @returns {boolean}
 */
function canManageRoster(userPosition) {
  if (!userPosition || typeof userPosition !== 'string') return false;
  const positions = ['Alpha', 'Beta', 'Sigma', 'Chi'];
  const userPositions = userPosition.split(',').map((p) => p.trim()).filter(Boolean);
  return userPositions.some((pos) => positions.includes(pos));
}

/**
 * Normalizes email for consistent lookup.
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

/**
 * Saves roster changes to the Sigma sheet.
 * Uses async-mutex for locking. Reads sheet, applies updates/removes/adds,
 * clears and writes back. Invalidates caches and notifies SSE on changes.
 *
 * @param {Object} changesData
 * @param {Array<{email: string, name: string, position: string}>} changesData.updatedRoster - Full roster after edits
 * @param {Array<{email: string, name: string, position: string}>} changesData.removedBrothers - Brothers to remove
 * @returns {Promise<{success: boolean, message?: string, updateCount?: number, removeCount?: number, addCount?: number}>}
 */
async function saveRosterChangesSimple(changesData) {
  const { updatedRoster = [], removedBrothers = [] } = changesData || {};

  const release = await rosterMutex.acquire();
  try {
    const sheets = await getSheetsClient();

    // Get current Sigma data (bypass cache to ensure fresh read inside lock)
    const cacheKey = 'sheetData_Sigma';
    cache.del(cacheKey);
    let data = await getParentSheet('Sigma');

    if (!data || data.length === 0) {
      return { success: false, message: 'Sigma sheet is empty or could not be read' };
    }

    const removeSet = new Set(
      removedBrothers.map((b) => normalizeEmail(b.email)).filter(Boolean)
    );
    const updateMap = new Map();
    for (const b of updatedRoster) {
      const email = normalizeEmail(b.email);
      if (email) {
        updateMap.set(email, {
          email: (b.email || '').trim(),
          name: (b.name || '').trim() || 'Unknown',
          position: (b.position || '').trim() || 'None',
        });
      }
    }

    const originalEmails = new Set();
    const rowsToDelete = [];
    let updateCount = 0;

    // Process existing rows (skip header at i=0)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const email = normalizeEmail(row && row[4]);
      if (!email) continue;

      originalEmails.add(email);

      if (removeSet.has(email)) {
        rowsToDelete.push(i);
        continue;
      }

      if (updateMap.has(email)) {
        const upd = updateMap.get(email);
        const maxCol = Math.max(row.length - 1, 6);
        while (row.length <= maxCol) row.push('');
        row[4] = upd.email;
        row[5] = upd.name;
        row[6] = upd.position;
        updateCount++;
      }
    }

    // Remove rows (splice backwards to preserve indices)
    for (let j = rowsToDelete.length - 1; j >= 0; j--) {
      data.splice(rowsToDelete[j], 1);
    }
    const removeCount = rowsToDelete.length;

    // Add new brothers (in updateMap but not in original sheet)
    const headerRow = data[0];
    const numCols = headerRow ? Math.max(headerRow.length, 7) : 7;
    let addCount = 0;

    for (const [email, upd] of updateMap) {
      if (!originalEmails.has(email)) {
        const newRow = Array(numCols).fill('');
        newRow[4] = upd.email;
        newRow[5] = upd.name;
        newRow[6] = upd.position;
        data.push(newRow);
        addCount++;
      }
    }

    // Clear and write back
    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range: 'Sigma',
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: 'Sigma',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: data },
    });

    // Clear caches
    clearSheetCache('Sigma');
    for (const b of removedBrothers) {
      const email = normalizeEmail(b.email);
      if (email) cache.del('validEmail:' + email);
    }

    // Notify SSE if any changes (lazy require to avoid circular dependency)
    const totalChanges = updateCount + removeCount + addCount;
    if (totalChanges > 0) {
      try {
        const { notifySSE } = require('./server');
        notifySSE('roster');
      } catch (err) {
        console.warn('Could not notify SSE:', err.message);
      }
    }

    const parts = [];
    if (updateCount > 0) parts.push(`${updateCount} updated`);
    if (removeCount > 0) parts.push(`${removeCount} removed`);
    if (addCount > 0) parts.push(`${addCount} added`);
    const message = parts.length > 0 ? parts.join(', ') : 'No changes';

    return {
      success: true,
      message,
      updateCount,
      removeCount,
      addCount,
    };
  } catch (err) {
    console.error('saveRosterChangesSimple error:', err);
    return { success: false, message: err.message };
  } finally {
    release();
  }
}

module.exports = {
  canManageRoster,
  saveRosterChangesSimple,
};
