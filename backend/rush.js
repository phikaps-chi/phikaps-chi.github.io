const { Mutex } = require('async-mutex');
const config = require('./config');
const { getSheetsClient, cache } = require('./sheets');
const { deleteFromGCS } = require('./gcs');

const rushMutex = new Mutex();

const RUSH_CACHE_TTL = 60;

function nowEpochMs() { return Date.now(); }

function coerceToEpochMs(v) {
  if (v == null) return null;
  if (v instanceof Date) { const t = v.getTime(); return isNaN(t) ? null : t; }
  if (typeof v === 'number') return isNaN(v) ? null : v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!isNaN(n) && /^\d+$/.test(v.trim())) return n;
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Rush Index data — cached reads from the "Rush Index" sheet
// ---------------------------------------------------------------------------

async function getRushIndexData() {
  const key = 'rushIndexData';
  const cached = cache.get(key);
  if (cached) return cached;

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.rushSpreadsheetId,
    range: 'Rush Index',
  });
  const rows = res.data.values || [];
  cache.set(key, rows, RUSH_CACHE_TTL);
  return rows;
}

function clearRushIndexCache() { cache.del('rushIndexData'); }

async function getRecruitsData(tabId) {
  const key = `recruitsData_${tabId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const sheets = await getSheetsClient();
  const sheetMeta = await sheets.spreadsheets.get({
    spreadsheetId: config.rushSpreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const sheetInfo = sheetMeta.data.sheets.find(
    (s) => s.properties.sheetId === Number(tabId),
  );
  if (!sheetInfo) return [];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.rushSpreadsheetId,
    range: sheetInfo.properties.title,
  });
  const rows = res.data.values || [];
  cache.set(key, rows, RUSH_CACHE_TTL);
  return rows;
}
function clearRecruitsCache(tabId) { cache.del(`recruitsData_${tabId}`); }

async function getCommentsData(tabId) {
  const key = `commentsData_${tabId}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const sheets = await getSheetsClient();
  const sheetMeta = await sheets.spreadsheets.get({
    spreadsheetId: config.rushSpreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const sheetInfo = sheetMeta.data.sheets.find(
    (s) => s.properties.sheetId === Number(tabId),
  );
  if (!sheetInfo) return [];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.rushSpreadsheetId,
    range: sheetInfo.properties.title,
  });
  const rows = res.data.values || [];
  cache.set(key, rows, RUSH_CACHE_TTL);
  return rows;
}
function clearCommentsCache(tabId) { cache.del(`commentsData_${tabId}`); }

// ---------------------------------------------------------------------------
// Recruit / comment parsing
// ---------------------------------------------------------------------------

async function getRecruitsForRush(recruitsTabId) {
  const data = await getRecruitsData(recruitsTabId);
  if (data.length <= 1) return [];
  const headers = data[0];
  const h = Object.fromEntries(headers.map((col, i) => [col, i]));
  return data.slice(1).map((r) => ({
    id: r[h.ID], name: r[h.Name], email: r[h.Email], phone: r[h.Phone],
    instagram: r[h.Instagram], tier: r[h.Tier], photoURL: r[h.PhotoURL],
    primaryContacts: (r[h.PrimaryContacts] || '').split(',').map((s) => s.trim()).filter(Boolean),
    likes: r[h.Likes] || '[]', dislikes: r[h.Dislikes] || '[]', met: r[h.Met] || '[]',
  }));
}

async function getCommentsForRush(commentsTabId) {
  const data = await getCommentsData(commentsTabId);
  if (!data || data.length <= 1) return [];
  const headers = data[0];
  const h = Object.fromEntries(headers.map((col, i) => [col, i]));
  const tsIdx = h.TimestampMs !== undefined ? h.TimestampMs : h.Timestamp;
  return data.slice(1).map((r) => ({
    commentId: r[h.CommentID],
    recruitId: r[h.RecruitID],
    author: r[h.Author],
    text: r[h.Text],
    timestamp: coerceToEpochMs(r[tsIdx]),
  }));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

async function calculateRushStatistics(recruitsTabId) {
  try {
    const recruits = await getRecruitsForRush(recruitsTabId);
    const totalRecruits = recruits.length;
    const bids = recruits.filter((r) => r.tier === 4 || r.tier === '4').length;
    const flushes = recruits.filter((r) => r.tier === 'flushed').length;
    const yieldRate = totalRecruits > 0 ? parseFloat(((bids / totalRecruits) * 100).toFixed(1)) : 0;
    return { totalRecruits, bids, flushes, yieldRate };
  } catch (e) {
    console.error(`Error calculating stats for tabId ${recruitsTabId}:`, e.message);
    return { totalRecruits: 0, bids: 0, flushes: 0, yieldRate: 0 };
  }
}

function calculateBrotherStats(brotherName, recruits, comments) {
  let recruitsMetCount = 0;
  let recruitsLikedCount = 0;
  let recruitsDislikedCount = 0;
  let commentsCount = 0;
  let points = 0;
  let primaryContactCount = 0;
  let bidSuccessBonus = 0;

  const brotherCommentsByRecruit = {};
  comments.forEach((c) => {
    if (c.author === brotherName) {
      commentsCount++;
      if (!brotherCommentsByRecruit[c.recruitId]) brotherCommentsByRecruit[c.recruitId] = [];
      brotherCommentsByRecruit[c.recruitId].push(c);
    }
  });

  recruits.forEach((r) => {
    let metThis = false;
    let likedThis = false;
    let dislikedThis = false;
    try { metThis = JSON.parse(r.met || '[]').includes(brotherName); } catch (_) {}
    try { likedThis = JSON.parse(r.likes || '[]').includes(brotherName); } catch (_) {}
    try { dislikedThis = JSON.parse(r.dislikes || '[]').includes(brotherName); } catch (_) {}

    if (metThis) {
      recruitsMetCount++;
      points += 6;
      try {
        const metArr = JSON.parse(r.met || '[]');
        if (metArr[0] === brotherName) points += 10;
      } catch (_) {}
    }

    if (likedThis) {
      recruitsLikedCount++;
      if (metThis) {
        const hasComment = !!brotherCommentsByRecruit[r.id];
        points += hasComment ? 5 : 2;
      }
      try {
        const likesArr = JSON.parse(r.likes || '[]');
        if (likesArr[0] === brotherName) points += 8;
      } catch (_) {}
    }

    if (dislikedThis) {
      recruitsDislikedCount++;
      const hasComment = !!brotherCommentsByRecruit[r.id];
      points += hasComment ? 8 : 5;
    }

    if ((r.primaryContacts || []).includes(brotherName)) {
      primaryContactCount++;
      points += 50;
      if (r.tier === 4 || r.tier === '4') {
        bidSuccessBonus += 50;
        points += 50;
      }
    }
  });

  comments.filter((c) => c.author === brotherName).forEach((c) => {
    const len = (c.text || '').length;
    points += 5;
    if (len >= 100) points += 10;
    else if (len >= 50) points += 5;
  });

  const totalVotes = recruitsLikedCount + recruitsDislikedCount;
  if (totalVotes > 0) {
    const commentRate = commentsCount / totalVotes;
    if (commentRate >= 0.75) points = Math.round(points * 1.5);
    else if (commentRate >= 0.5) points = Math.round(points * 1.2);
  }

  return { name: brotherName, recruitsMetCount, recruitsLikedCount, recruitsDislikedCount, commentsCount, bidSuccessBonus, points };
}

function calculateBadges(stats, totalRecruits) {
  const badges = [];
  if (stats.recruitsMetCount >= totalRecruits * 0.75 && totalRecruits > 0)
    badges.push({ name: 'Social Butterfly', emoji: '\uD83E\uDD8B', description: 'Met 75%+ of recruits' });
  if (stats.commentsCount >= 10)
    badges.push({ name: 'Commentator', emoji: '\uD83D\uDCAC', description: 'Left 10+ comments' });
  if (stats.recruitsLikedCount >= 5)
    badges.push({ name: 'Hype Man', emoji: '\uD83D\uDD25', description: 'Liked 5+ recruits' });
  if (stats.points >= 50)
    badges.push({ name: 'Rush MVP', emoji: '\uD83C\uDFC6', description: 'Scored 50+ points' });
  return badges;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function getRushEvents() {
  const data = await getRushIndexData();
  if (data.length <= 1) return [];

  const events = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const ts = coerceToEpochMs(row[4]);
    const recruitsTabId = row[5];
    const stats = await calculateRushStatistics(recruitsTabId);
    events.push({
      id: String(row[0]), name: row[1], date: row[2], description: row[3],
      timestamp: ts, timestampMs: ts,
      recruitsTabId, commentsTabId: row[6],
      isLocked: row[7] === true || row[7] === 'TRUE' || row[7] === '1' || row[7] === 1,
      totalRecruits: stats.totalRecruits, bids: stats.bids,
      flushes: stats.flushes, yieldRate: stats.yieldRate,
    });
  }
  return events;
}

async function getRushEvent(id) {
  const data = await getRushIndexData();
  const row = data.find((r, i) => i > 0 && String(r[0]) === String(id));
  if (!row) return null;
  const ts = coerceToEpochMs(row[4]);
  const stats = await calculateRushStatistics(row[5]);
  return {
    id: String(row[0]), name: row[1], date: row[2], description: row[3],
    timestamp: ts, timestampMs: ts,
    recruitsTabId: row[5], commentsTabId: row[6],
    isLocked: row[7] === true || row[7] === 'TRUE' || row[7] === '1' || row[7] === 1,
    totalRecruits: stats.totalRecruits, bids: stats.bids,
    flushes: stats.flushes, yieldRate: stats.yieldRate,
  };
}

async function calculateRushEngagement(rushId) {
  try {
    const rushEvent = await getRushEvent(rushId);
    if (!rushEvent) return { error: 'Rush event not found' };

    const recruits = await getRecruitsForRush(rushEvent.recruitsTabId);
    const comments = await getCommentsForRush(rushEvent.commentsTabId);
    const totalRecruits = recruits.length;

    const brotherNamesSet = new Set();
    recruits.forEach((r) => {
      try { JSON.parse(r.met || '[]').forEach((n) => brotherNamesSet.add(n)); } catch (_) {}
      try { JSON.parse(r.likes || '[]').forEach((n) => brotherNamesSet.add(n)); } catch (_) {}
      try { JSON.parse(r.dislikes || '[]').forEach((n) => brotherNamesSet.add(n)); } catch (_) {}
    });
    comments.forEach((c) => { if (c.author) brotherNamesSet.add(c.author); });

    const allBrotherStats = Array.from(brotherNamesSet).map((brotherName) => {
      const stats = calculateBrotherStats(brotherName, recruits, comments);
      const badges = calculateBadges(stats, totalRecruits);
      return { ...stats, badges };
    });

    allBrotherStats.sort((a, b) => b.points - a.points);
    const topRushers = allBrotherStats;
    const avgPoints = allBrotherStats.length > 0
      ? parseFloat((allBrotherStats.reduce((sum, b) => sum + b.points, 0) / allBrotherStats.length).toFixed(1))
      : 0;

    return {
      topRushers,
      allRushers: allBrotherStats,
      avgPoints,
      averagePoints: avgPoints,
      totalParticipants: allBrotherStats.length,
      rushName: rushEvent.name || '',
    };
  } catch (e) {
    console.error('Error calculating engagement:', e.message);
    return { error: e.message };
  }
}

async function addRushEventToSheet(event) {
  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const data = await getRushIndexData();
    const existingIdx = data.findIndex((r, i) => i > 0 && String(r[0]) === String(event.id));

    if (existingIdx === -1) {
      // Create new tabs
      const recruitsName = `Recruits - ${event.name}`;
      const commentsName = `Comments - ${event.name}`;

      const batchRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.rushSpreadsheetId,
        requestBody: {
          requests: [
            { addSheet: { properties: { title: recruitsName } } },
            { addSheet: { properties: { title: commentsName } } },
          ],
        },
      });

      const recruitsTabId = batchRes.data.replies[0].addSheet.properties.sheetId;
      const commentsTabId = batchRes.data.replies[1].addSheet.properties.sheetId;

      // Set headers
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.rushSpreadsheetId,
        range: `${recruitsName}!A1:K1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['ID', 'Name', 'Email', 'Phone', 'Instagram', 'Tier', 'PhotoURL', 'PrimaryContacts', 'Likes', 'Dislikes', 'Met']] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.rushSpreadsheetId,
        range: `${commentsName}!A1:E1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['CommentID', 'RecruitID', 'Author', 'Text', 'TimestampMs']] },
      });

      const now = nowEpochMs();
      const dateStr = new Date(now).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const newRow = [event.id, event.name, dateStr, event.description, now, recruitsTabId, commentsTabId, false];

      await sheets.spreadsheets.values.append({
        spreadsheetId: config.rushSpreadsheetId,
        range: 'Rush Index',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [newRow] },
      });

      clearRushIndexCache();

      return {
        id: event.id, name: event.name, date: dateStr, description: event.description,
        timestamp: now, timestampMs: now, recruitsTabId, commentsTabId, isLocked: false,
      };
    } else {
      // Update existing event
      const rushIndexTitle = 'Rush Index';
      const rowInSheet = existingIdx + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.rushSpreadsheetId,
        range: `'${rushIndexTitle}'!B${rowInSheet}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[event.name]] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.rushSpreadsheetId,
        range: `'${rushIndexTitle}'!D${rowInSheet}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[event.description]] },
      });
      clearRushIndexCache();
      return event;
    }
  } finally {
    release();
  }
}

async function deleteRushEvent(id) {
  const data = await getRushIndexData();
  const eventRow = data.find((r, i) => i > 0 && String(r[0]) === String(id));
  if (!eventRow) return { success: false, error: 'Event not found.' };

  const recruitsTabId = eventRow[5];
  const commentsTabId = eventRow[6];

  // Delete photos from GCS
  try {
    const recruits = await getRecruitsForRush(recruitsTabId);
    for (const recruit of recruits) {
      if (recruit.photoURL) {
        const fileName = decodeURIComponent(recruit.photoURL.substring(recruit.photoURL.lastIndexOf('/') + 1));
        await deleteFromGCS(config.gcs.rushImagesBucket, fileName);
      }
    }
  } catch (e) {
    console.error(`Could not delete photos for rush event ${id}:`, e.message);
  }

  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();

    // Delete the recruit and comment sheets
    const requests = [];
    if (recruitsTabId) requests.push({ deleteSheet: { sheetId: Number(recruitsTabId) } });
    if (commentsTabId) requests.push({ deleteSheet: { sheetId: Number(commentsTabId) } });
    if (requests.length) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: config.rushSpreadsheetId,
          requestBody: { requests },
        });
      } catch (e) { console.error('Could not delete sheets:', e.message); }
    }

    // Delete the row from Rush Index
    const freshData = await (async () => {
      cache.del('rushIndexData');
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: config.rushSpreadsheetId,
        range: 'Rush Index',
      });
      return res.data.values || [];
    })();

    const rowToDelete = freshData.findIndex((r, i) => i > 0 && String(r[0]) === String(id));
    if (rowToDelete !== -1) {
      // Get Rush Index sheet ID
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: config.rushSpreadsheetId,
        fields: 'sheets(properties(sheetId,title))',
      });
      const rushIndexSheet = meta.data.sheets.find((s) => s.properties.title === 'Rush Index');
      if (rushIndexSheet) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: config.rushSpreadsheetId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: rushIndexSheet.properties.sheetId,
                  dimension: 'ROWS',
                  startIndex: rowToDelete,
                  endIndex: rowToDelete + 1,
                },
              },
            }],
          },
        });
      }
    }
    clearRushIndexCache();
    clearRecruitsCache(recruitsTabId);
    clearCommentsCache(commentsTabId);
  } finally {
    release();
  }

  try {
    const { notifySSE } = require('./server');
    notifySSE('refresh');
  } catch (_) {}

  return { success: true };
}

async function toggleRushLock(rushId, userPosition) {
  if (!userPosition || !userPosition.includes('Rho')) {
    throw new Error('UNAUTHORIZED: Only the Rho (Rush Chair) can lock or unlock rush events');
  }

  const release = await rushMutex.acquire();
  try {
    const data = await getRushIndexData();
    const rowIndex = data.findIndex((r, i) => i > 0 && String(r[0]) === String(rushId));
    if (rowIndex === -1) throw new Error('Rush event not found');

    const currentLock = data[rowIndex][7];
    const newLock = !(currentLock === true || currentLock === 'TRUE' || currentLock === '1' || currentLock === 1);
    const rowInSheet = rowIndex + 1;

    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.rushSpreadsheetId,
      range: `'Rush Index'!H${rowInSheet}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[newLock]] },
    });

    clearRushIndexCache();

    try {
      const { notifySSE } = require('./server');
      notifySSE('refresh');
    } catch (_) {}

    return {
      success: true,
      isLocked: newLock,
      message: newLock ? 'Rush event locked successfully' : 'Rush event unlocked successfully',
    };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Admin settings — stored in node-cache (replaces ScriptProperties)
// ---------------------------------------------------------------------------

const ADMIN_SETTINGS_KEY = 'rushAdminSettings';

function getAdminSettings() {
  return cache.get(ADMIN_SETTINGS_KEY) || {
    globalDisableAddRecruits: false,
    globalDisableCommenting: false,
    disabledBrotherSettings: {},
  };
}

function setGlobalSetting(key, value) {
  const settings = getAdminSettings();
  settings[key] = value;
  cache.set(ADMIN_SETTINGS_KEY, settings, 0);
  return { success: true };
}

function setBrotherSettings(brotherEmail, settingsObj) {
  const settings = getAdminSettings();
  if (!settings.disabledBrotherSettings) settings.disabledBrotherSettings = {};
  settings.disabledBrotherSettings[brotherEmail] = settingsObj;
  cache.set(ADMIN_SETTINGS_KEY, settings, 0);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Rush page details
// ---------------------------------------------------------------------------

async function getRushPageDetails(rushId) {
  const data = await getRushIndexData();
  const row = data.find((r, i) => i > 0 && String(r[0]) === String(rushId));
  return row ? { recruitsTabId: row[5], commentsTabId: row[6], name: row[1] } : null;
}

// ---------------------------------------------------------------------------
// Sheet-by-tabId helpers
// ---------------------------------------------------------------------------

async function getSheetTitleByTabId(tabId) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.rushSpreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const info = meta.data.sheets.find((s) => s.properties.sheetId === Number(tabId));
  return info ? info.properties.title : null;
}

// ---------------------------------------------------------------------------
// Recruit CRUD
// ---------------------------------------------------------------------------

async function getNextAvailableId(tabId) {
  const release = await rushMutex.acquire();
  try {
    const cacheKey = `lastId_${tabId}`;
    let lastId = cache.get(cacheKey) || 0;
    if (lastId === 0) {
      const data = await getRecruitsData(tabId);
      lastId = data.slice(1).reduce((m, r) => {
        const id = Number(r[0]);
        return !isNaN(id) && id > m ? id : m;
      }, 0);
    }
    const next = lastId + 1;
    cache.set(cacheKey, next, 0);
    return next;
  } finally {
    release();
  }
}

async function addOrUpdateRecruitWithPhoto(recruitsTabId, id, name, email, phone, instagram, contactsJson, base64Data, addedBy) {
  const adminSettings = getAdminSettings();
  if (adminSettings.globalDisableAddRecruits) {
    throw new Error('Adding recruits is currently disabled by an administrator.');
  }

  const { uploadFileWithDynamicName } = require('./gcs');
  const BASE_FILE_NAME = `user-upload_${Date.now()}_${name}`;
  const publicUrl = base64Data ? await uploadFileWithDynamicName(config.gcs.rushImagesBucket, BASE_FILE_NAME, base64Data) : '';

  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const sheetTitle = await getSheetTitleByTabId(recruitsTabId);
    if (!sheetTitle) throw new Error('Recruits sheet not found');

    cache.del(`recruitsData_${recruitsTabId}`);
    const data = await getRecruitsData(recruitsTabId);
    const headers = data[0];
    const h = Object.fromEntries(headers.map((col, i) => [col, i]));

    const contacts = JSON.parse(contactsJson || '[]');
    const rowObj = { Name: name, Email: email || '', Phone: phone || '', Instagram: instagram || '', PrimaryContacts: contacts.join(',') };
    if (publicUrl) rowObj.PhotoURL = publicUrl;

    let newId;
    if (id) {
      const rowIndex = data.findIndex((r, i) => i > 0 && String(r[h.ID]) === String(id));
      if (rowIndex < 0) throw new Error('Recruit ID not found: ' + id);
      const updatedRow = [...data[rowIndex]];
      headers.forEach((header, i) => { if (rowObj[header] !== undefined) updatedRow[i] = rowObj[header]; });

      await sheets.spreadsheets.values.update({
        spreadsheetId: config.rushSpreadsheetId,
        range: `'${sheetTitle}'!A${rowIndex + 1}:${String.fromCharCode(64 + headers.length)}${rowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [updatedRow] },
      });
    } else {
      newId = await getNextAvailableId(recruitsTabId);
      rowObj.ID = newId;
      rowObj.Tier = 0;
      rowObj.Likes = '[]';
      rowObj.Dislikes = '[]';
      rowObj.Met = addedBy ? JSON.stringify([addedBy]) : '[]';
      const newRow = headers.map((hdr) => rowObj[hdr] ?? '');

      await sheets.spreadsheets.values.append({
        spreadsheetId: config.rushSpreadsheetId,
        range: `'${sheetTitle}'`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [newRow] },
      });
    }

    clearRecruitsCache(recruitsTabId);
    try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
    return newId !== undefined ? newId : { success: true };
  } finally {
    release();
  }
}

async function deleteRecruit(recruitsTabId, recruitId) {
  const data = await getRecruitsData(recruitsTabId);
  const hdr = data[0];
  const idCol = hdr.indexOf('ID');
  const photoCol = hdr.indexOf('PhotoURL');
  if (idCol === -1) throw new Error('ID column not found.');

  const recruitRow = data.find((r) => String(r[idCol]) === String(recruitId));

  if (recruitRow && photoCol !== -1 && recruitRow[photoCol]) {
    try {
      const photoURL = recruitRow[photoCol];
      const fileName = decodeURIComponent(photoURL.substring(photoURL.lastIndexOf('/') + 1));
      await deleteFromGCS(config.gcs.rushImagesBucket, fileName);
    } catch (e) { console.error('Could not delete photo:', e.message); }
  }

  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const sheetTitle = await getSheetTitleByTabId(recruitsTabId);
    if (!sheetTitle) throw new Error('Recruits sheet not found');

    cache.del(`recruitsData_${recruitsTabId}`);
    const freshData = (await sheets.spreadsheets.values.get({
      spreadsheetId: config.rushSpreadsheetId,
      range: sheetTitle,
    })).data.values || [];

    const rowIndex = freshData.findIndex((r, i) => i > 0 && String(r[idCol]) === String(recruitId));
    if (rowIndex === -1) return { success: false, error: 'Recruit not found' };

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.rushSpreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    const sheetInfo = meta.data.sheets.find((s) => s.properties.title === sheetTitle);
    if (sheetInfo) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.rushSpreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheetInfo.properties.sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex,
                endIndex: rowIndex + 1,
              },
            },
          }],
        },
      });
    }

    clearRecruitsCache(recruitsTabId);
    try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
    return { success: true };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Cell update helpers
// ---------------------------------------------------------------------------

async function updateCell(tabId, recruitId, columnHeader, value) {
  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const sheetTitle = await getSheetTitleByTabId(tabId);
    if (!sheetTitle) throw new Error('Sheet not found');

    cache.del(`recruitsData_${tabId}`);
    const data = await getRecruitsData(tabId);
    const headers = data[0];
    const idCol = headers.indexOf('ID');
    const targetCol = headers.indexOf(columnHeader);
    if (targetCol === -1) throw new Error(`Column "${columnHeader}" not found.`);

    const rowIndex = data.findIndex((r, i) => i > 0 && String(r[idCol]) === String(recruitId));
    if (rowIndex === -1) return { success: false };

    const colLetter = String.fromCharCode(65 + targetCol);
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.rushSpreadsheetId,
      range: `'${sheetTitle}'!${colLetter}${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[value]] },
    });

    clearRecruitsCache(tabId);
    try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
    return { success: true };
  } finally {
    release();
  }
}

async function updateRecruitTier(tabId, recruitId, newTier) {
  return updateCell(tabId, recruitId, 'Tier', newTier);
}

async function toggleUserInJsonArray(tabId, recruitId, columnHeader, user) {
  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const sheetTitle = await getSheetTitleByTabId(tabId);
    if (!sheetTitle) throw new Error('Sheet not found');

    cache.del(`recruitsData_${tabId}`);
    const data = await getRecruitsData(tabId);
    const headers = data[0];
    const idCol = headers.indexOf('ID');
    const targetCol = headers.indexOf(columnHeader);
    const rowIndex = data.findIndex((r, i) => i > 0 && String(r[idCol]) === String(recruitId));
    if (rowIndex === -1) return { success: false };

    let arr = JSON.parse(data[rowIndex][targetCol] || '[]');
    const userIndex = arr.indexOf(user);
    if (userIndex === -1) arr.push(user);
    else arr.splice(userIndex, 1);

    const colLetter = String.fromCharCode(65 + targetCol);
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.rushSpreadsheetId,
      range: `'${sheetTitle}'!${colLetter}${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[JSON.stringify(arr)]] },
    });

    if (columnHeader === 'Likes' || columnHeader === 'Dislikes') {
      const oppositeCol = headers.indexOf(columnHeader === 'Likes' ? 'Dislikes' : 'Likes');
      if (oppositeCol !== -1) {
        let opposite = JSON.parse(data[rowIndex][oppositeCol] || '[]');
        opposite = opposite.filter((u) => u !== user);
        const oppLetter = String.fromCharCode(65 + oppositeCol);
        await sheets.spreadsheets.values.update({
          spreadsheetId: config.rushSpreadsheetId,
          range: `'${sheetTitle}'!${oppLetter}${rowIndex + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[JSON.stringify(opposite)]] },
        });
      }
    }

    clearRecruitsCache(tabId);
    try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
    return { success: true };
  } finally {
    release();
  }
}

async function addLike(tabId, recruitId, userName) {
  return toggleUserInJsonArray(tabId, recruitId, 'Likes', userName);
}

async function addDislike(tabId, recruitId, userName) {
  return toggleUserInJsonArray(tabId, recruitId, 'Dislikes', userName);
}

async function addMet(tabId, recruitId, userName) {
  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const sheetTitle = await getSheetTitleByTabId(tabId);
    if (!sheetTitle) throw new Error('Sheet not found');

    cache.del(`recruitsData_${tabId}`);
    const data = await getRecruitsData(tabId);
    const headers = data[0];
    const idCol = headers.indexOf('ID');
    const metCol = headers.indexOf('Met');
    const rowIndex = data.findIndex((r, i) => i > 0 && String(r[idCol]) === String(recruitId));
    if (rowIndex === -1) return { success: false };

    let arr = JSON.parse(data[rowIndex][metCol] || '[]');
    const idx = arr.indexOf(userName);
    if (idx === -1) arr.push(userName);
    else arr.splice(idx, 1);

    const colLetter = String.fromCharCode(65 + metCol);
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.rushSpreadsheetId,
      range: `'${sheetTitle}'!${colLetter}${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[JSON.stringify(arr)]] },
    });

    clearRecruitsCache(tabId);
    try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
    return { success: true };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Comment CRUD
// ---------------------------------------------------------------------------

async function addOrUpdateComment(commentsTabId, recruitId, commentText, authorName) {
  const ts = nowEpochMs();
  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const sheetTitle = await getSheetTitleByTabId(commentsTabId);
    if (!sheetTitle) throw new Error('Comments sheet not found');

    cache.del(`commentsData_${commentsTabId}`);
    const data = await getCommentsData(commentsTabId);
    const headers = data[0];
    const h = Object.fromEntries(headers.map((col, i) => [col, i]));

    const rowIndex = data.findIndex(
      (r, i) => i > 0 && String(r[h.RecruitID]) === String(recruitId) && r[h.Author] === authorName,
    );

    if (rowIndex === -1) {
      const newRow = Array(headers.length).fill('');
      newRow[h.CommentID] = crypto.randomUUID();
      newRow[h.RecruitID] = recruitId;
      newRow[h.Author] = authorName;
      newRow[h.Text] = commentText;
      const tsIdx = headers.indexOf('TimestampMs') !== -1 ? headers.indexOf('TimestampMs') : headers.indexOf('Timestamp');
      if (tsIdx !== -1) newRow[tsIdx] = ts;

      await sheets.spreadsheets.values.append({
        spreadsheetId: config.rushSpreadsheetId,
        range: `'${sheetTitle}'`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [newRow] },
      });
    } else {
      const textCol = String.fromCharCode(65 + h.Text);
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.rushSpreadsheetId,
        range: `'${sheetTitle}'!${textCol}${rowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[commentText]] },
      });
      const tsIdx = headers.indexOf('TimestampMs') !== -1 ? headers.indexOf('TimestampMs') : headers.indexOf('Timestamp');
      if (tsIdx !== -1) {
        const tsCol = String.fromCharCode(65 + tsIdx);
        await sheets.spreadsheets.values.update({
          spreadsheetId: config.rushSpreadsheetId,
          range: `'${sheetTitle}'!${tsCol}${rowIndex + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ts]] },
        });
      }
    }

    clearCommentsCache(commentsTabId);
    try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
    return { success: true };
  } finally {
    release();
  }
}

async function deleteComment(commentsTabId, recruitId, targetAuthorName) {
  const release = await rushMutex.acquire();
  try {
    const sheets = await getSheetsClient();
    const sheetTitle = await getSheetTitleByTabId(commentsTabId);
    if (!sheetTitle) return { success: false, error: 'Sheet not found' };

    cache.del(`commentsData_${commentsTabId}`);
    const data = await getCommentsData(commentsTabId);
    const headers = data[0];
    const h = Object.fromEntries(headers.map((col, i) => [col, i]));

    const rowIndex = data.findIndex(
      (r, i) => i > 0 && String(r[h.RecruitID]) === String(recruitId) && r[h.Author] === targetAuthorName,
    );

    if (rowIndex === -1) return { success: false, error: 'Comment not found or already deleted.' };

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.rushSpreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    const sheetInfo = meta.data.sheets.find((s) => s.properties.title === sheetTitle);
    if (sheetInfo) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.rushSpreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheetInfo.properties.sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex,
                endIndex: rowIndex + 1,
              },
            },
          }],
        },
      });
    }

    clearCommentsCache(commentsTabId);
    try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
    return { success: true };
  } finally {
    release();
  }
}

module.exports = {
  getRushEvents,
  getRushEvent,
  addRushEventToSheet,
  deleteRushEvent,
  toggleRushLock,
  calculateRushEngagement,
  getRecruitsForRush,
  getCommentsForRush,
  clearRushIndexCache,
  getRushPageDetails,
  addOrUpdateRecruitWithPhoto,
  deleteRecruit,
  updateCell,
  updateRecruitTier,
  toggleUserInJsonArray,
  addLike,
  addDislike,
  addMet,
  addOrUpdateComment,
  deleteComment,
  getAdminSettings,
  setGlobalSetting,
  setBrotherSettings,
};
