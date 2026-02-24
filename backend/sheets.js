const { google } = require('googleapis');
const NodeCache = require('node-cache');
const config = require('./config');

const cache = new NodeCache({ stdTTL: config.cache.sheetTTL, checkperiod: 30 });

let sheetsClient = null;

/**
 * Lazily initialise and return an authenticated Sheets v4 client.
 * Supports two credential modes:
 *   1. GOOGLE_SERVICE_ACCOUNT_JSON env var (raw JSON string — used on Render)
 *   2. A local service-account.json file (for local dev)
 */
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/devstorage.read_write',
      ],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: config.serviceAccountPath,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/devstorage.read_write',
      ],
    });
  }

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

/**
 * Get a raw auth client for GCS or other Google API calls.
 */
async function getAuthClient() {
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/devstorage.read_write',
      ],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: config.serviceAccountPath,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/devstorage.read_write',
      ],
    });
  }
  return auth.getClient();
}

// ---------------------------------------------------------------------------
// Core sheet operations — direct equivalents of the Apps Script helpers
// ---------------------------------------------------------------------------

/**
 * Mirrors Apps Script `getParentSheet(sheetName)`.
 * Returns a 2D array of all values in the named sheet, with caching.
 */
async function getParentSheet(sheetName) {
  const cacheKey = `sheetData_${sheetName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: sheetName,
    });
    const data = res.data.values || [];
    cache.set(cacheKey, data);
    return data;
  } catch (err) {
    console.error(`Error fetching sheet "${sheetName}":`, err.message);
    return [];
  }
}

/**
 * Mirrors Apps Script `findRowByValue(data, valueToFind, lookupColumnIndex)`.
 * Searches a 2D data array (skipping header row) for a matching value.
 */
function findRowByValue(data, valueToFind, lookupColumnIndex) {
  if (!data || data.length < 1) return null;
  const needle = String(valueToFind).trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    const cell = data[i][lookupColumnIndex];
    if (cell != null && String(cell).trim().toLowerCase() === needle) {
      return data[i];
    }
  }
  return null;
}

/**
 * Mirrors Apps Script `searchByEmail(data, email, col)`.
 * Email is always in column index 4 of the Sigma sheet.
 */
function searchByEmail(data, email, col) {
  const needle = email.trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (data[i][4] && data[i][4].trim().toLowerCase() === needle) {
      return data[i][col];
    }
  }
  return '';
}

/**
 * Mirrors Apps Script `searchByDoc(data, docName, col)`.
 */
function searchByDoc(data, docName, col) {
  const needle = docName.trim().toLowerCase();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].trim().toLowerCase() === needle) {
      return data[i][col];
    }
  }
  return '';
}

/**
 * Mirrors `isValidEmail(sigma_sheet, email)` with caching.
 */
function isValidEmail(sigmaData, email) {
  const key = 'validEmail:' + email.trim().toLowerCase();
  if (cache.get(key)) return true;

  for (let i = 1; i < sigmaData.length; i++) {
    const cell = sigmaData[i][4];
    if (cell && cell.toString().trim().toLowerCase() === email.trim().toLowerCase()) {
      cache.set(key, true, config.cache.emailValidationTTL);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Read a specific range and return a 2D array.
 */
async function getRange(sheetName, range) {
  const sheets = await getSheetsClient();
  const fullRange = `${sheetName}!${range}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: fullRange,
  });
  return res.data.values || [];
}

/**
 * Write a 2D array into a specific range.
 * Mirrors `sheet.getRange(...).setValues(values)`.
 */
async function setValues(sheetName, range, values) {
  const sheets = await getSheetsClient();
  const fullRange = `${sheetName}!${range}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: fullRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  clearSheetCache(sheetName);
}

/**
 * Write a single value to one cell.
 * Mirrors `sheet.getRange(row, col).setValue(value)`.
 */
async function setValue(sheetName, cellRange, value) {
  await setValues(sheetName, cellRange, [[value]]);
}

/**
 * Append a row at the bottom of the sheet.
 * Mirrors `sheet.appendRow(rowArray)`.
 */
async function appendRow(sheetName, rowArray) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowArray] },
  });
  clearSheetCache(sheetName);
}

/**
 * Delete a row by its 1-based row index.
 * Requires the sheet's numeric ID (gid), which we look up automatically.
 */
async function deleteRow(sheetName, rowIndex) {
  const sheets = await getSheetsClient();
  const sheetId = await getSheetId(sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1, // 0-based
            endIndex: rowIndex,
          },
        },
      }],
    },
  });
  clearSheetCache(sheetName);
}

/**
 * Get the last row number (1-based) with data.
 * Mirrors `sheet.getLastRow()`.
 */
async function getLastRow(sheetName) {
  const data = await getParentSheet(sheetName);
  return data.length;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const sheetIdCache = {};

async function getSheetId(sheetName) {
  if (sheetIdCache[sheetName] != null) return sheetIdCache[sheetName];

  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets.properties',
  });
  for (const s of meta.data.sheets) {
    if (s.properties.title === sheetName) {
      sheetIdCache[sheetName] = s.properties.sheetId;
      return s.properties.sheetId;
    }
  }
  throw new Error(`Sheet "${sheetName}" not found`);
}

function clearSheetCache(sheetName) {
  cache.del(`sheetData_${sheetName}`);
}

function flushAllSheetCaches() {
  cache.flushAll();
  console.log('All sheet caches flushed');
}

module.exports = {
  getSheetsClient,
  getAuthClient,
  getParentSheet,
  findRowByValue,
  searchByEmail,
  searchByDoc,
  isValidEmail,
  getRange,
  setValues,
  setValue,
  appendRow,
  deleteRow,
  getLastRow,
  clearSheetCache,
  flushAllSheetCaches,
  cache,
};
