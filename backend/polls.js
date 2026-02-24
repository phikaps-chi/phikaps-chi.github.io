const crypto = require('crypto');
const config = require('./config');
const { getParentSheet, getSheetsClient, clearSheetCache, cache } = require('./sheets');
const { getName } = require('./auth');

const POLL_SHEET_NAME = 'RankedChoicePolls';

async function ensurePollSheet() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(title))',
  });
  const exists = meta.data.sheets.some((s) => s.properties.title === POLL_SHEET_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: POLL_SHEET_NAME } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${POLL_SHEET_NAME}'!A1:I1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['Poll ID', 'Question', 'Options (JSON)', 'Votes (JSON)', 'Creator', 'Created At', 'Status', 'Threshold', 'Anonymous']],
      },
    });
  }
}

function parsePollRow(row) {
  return {
    id: row[0],
    question: row[1],
    options: JSON.parse(row[2] || '[]'),
    votes: JSON.parse(row[3] || '{}'),
    creator: row[4],
    createdAt: row[5],
    status: row[6],
    threshold: row[7] || 0.5,
    isAnonymous: row[8] !== undefined ? row[8] : true,
  };
}

async function createRankedChoicePoll(question, options, creatorEmail, threshold, isAnonymous) {
  await ensurePollSheet();

  const sigmaData = await getParentSheet('Sigma');
  const creatorName = getName(sigmaData, creatorEmail) || 'Admin';

  const pollId = crypto.randomUUID();
  const now = new Date().toISOString();
  const winThreshold = threshold || 0.5;
  const anonymous = isAnonymous !== undefined ? isAnonymous : true;

  const rowData = [
    pollId, question, JSON.stringify(options), JSON.stringify({}),
    creatorName, now, 'active', winThreshold, anonymous,
  ];

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: POLL_SHEET_NAME,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowData] },
  });

  clearSheetCache(POLL_SHEET_NAME);
  try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}

  return pollId;
}

async function getAllActiveRankedChoicePolls() {
  const data = await getParentSheet(POLL_SHEET_NAME);
  if (!data || data.length <= 1) return [];

  const allPolls = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) {
      allPolls.push(parsePollRow(data[i]));
    }
  }

  allPolls.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return allPolls;
}

async function submitRankedChoiceVote(pollId, voterEmail, ranking) {
  const sigmaData = await getParentSheet('Sigma');
  const voterName = getName(sigmaData, voterEmail) || voterEmail;

  const sheets = await getSheetsClient();
  clearSheetCache(POLL_SHEET_NAME);
  const data = await getParentSheet(POLL_SHEET_NAME);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === pollId && data[i][6] === 'active') {
      const votes = JSON.parse(data[i][3] || '{}');
      votes[voterName] = ranking;

      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${POLL_SHEET_NAME}'!D${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[JSON.stringify(votes)]] },
      });

      clearSheetCache(POLL_SHEET_NAME);
      try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
      return true;
    }
  }

  throw new Error('Poll not found or closed');
}

async function closeRankedChoicePoll(pollId) {
  const sheets = await getSheetsClient();
  clearSheetCache(POLL_SHEET_NAME);
  const data = await getParentSheet(POLL_SHEET_NAME);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === pollId) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${POLL_SHEET_NAME}'!G${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['closed']] },
      });
      clearSheetCache(POLL_SHEET_NAME);
      try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
      return true;
    }
  }
  throw new Error('Poll not found');
}

async function deleteRankedChoicePoll(pollId, userEmail) {
  const sigmaData = await getParentSheet('Sigma');
  const userName = getName(sigmaData, userEmail) || userEmail;

  const sheets = await getSheetsClient();
  clearSheetCache(POLL_SHEET_NAME);
  const data = await getParentSheet(POLL_SHEET_NAME);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === pollId) {
      if (data[i][6] !== 'closed') throw new Error('Only closed polls can be deleted');
      if (!config.isDev && data[i][4] !== userName) throw new Error('Only the poll creator can delete this poll');

      const meta = await sheets.spreadsheets.get({
        spreadsheetId: config.spreadsheetId,
        fields: 'sheets(properties(sheetId,title))',
      });
      const pollSheet = meta.data.sheets.find((s) => s.properties.title === POLL_SHEET_NAME);
      if (pollSheet) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: config.spreadsheetId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: pollSheet.properties.sheetId,
                  dimension: 'ROWS',
                  startIndex: i,
                  endIndex: i + 1,
                },
              },
            }],
          },
        });
      }
      clearSheetCache(POLL_SHEET_NAME);
      try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
      return true;
    }
  }
  throw new Error('Poll not found');
}

async function resetPollVotes(pollId, userEmail) {
  const sigmaData = await getParentSheet('Sigma');
  const userName = getName(sigmaData, userEmail) || userEmail;

  const sheets = await getSheetsClient();
  clearSheetCache(POLL_SHEET_NAME);
  const data = await getParentSheet(POLL_SHEET_NAME);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === pollId) {
      if (data[i][6] !== 'active') throw new Error('Only active polls can be reset');
      if (!config.isDev && data[i][4] !== userName) throw new Error('Only the poll creator can reset votes');

      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${POLL_SHEET_NAME}'!D${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[JSON.stringify({})]] },
      });
      clearSheetCache(POLL_SHEET_NAME);
      try { const { notifySSE } = require('./server'); notifySSE('refresh'); } catch (_) {}
      return true;
    }
  }
  throw new Error('Poll not found');
}

module.exports = {
  createRankedChoicePoll,
  getAllActiveRankedChoicePolls,
  submitRankedChoiceVote,
  closeRankedChoicePoll,
  deleteRankedChoicePoll,
  resetPollVotes,
};
