const { getSheetsClient, cache } = require('./sheets');
const config = require('./config');
const { v4: uuidv4 } = require('uuid');

const LEDGER_SHEET = 'Game Ledger';
const STATS_SHEET = 'Player Stats';
const DISPUTES_SHEET = 'Disputes';

// Helper to get die spreadsheet data
async function getDieSheetData(sheetName) {
  const cacheKey = `dieSheetData_${sheetName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.dieSpreadsheetId,
      range: sheetName,
    });
    const data = res.data.values || [];
    cache.set(cacheKey, data);
    return data;
  } catch (err) {
    console.error(`Error fetching Die ELO sheet "${sheetName}":`, err.message);
    return [];
  }
}

function clearDieSheetCache() {
  cache.del(`dieSheetData_${LEDGER_SHEET}`);
  cache.del(`dieSheetData_${STATS_SHEET}`);
  cache.del(`dieSheetData_${DISPUTES_SHEET}`);
}

async function getStats() {
  const data = await getDieSheetData(STATS_SHEET);
  if (!data || data.length <= 1) return [];
  
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
}

async function getGameHistory(userName) {
  const data = await getDieSheetData(LEDGER_SHEET);
  if (!data || data.length <= 1) return [];
  
  const headers = data[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const games = data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });

  // Replay ELO history to attach per-player deltas
  const sorted = [...games].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const elos = {};
  const getElo = (name) => {
    if (!name || name.trim() === '' || name === 'FOH' || name === 'Alumn') return null;
    if (elos[name] === undefined) elos[name] = 1000;
    return elos[name];
  };

  for (const g of sorted) {
    if (!g.winning_team || (g.winning_team !== 'A' && g.winning_team !== 'B')) continue;

    const eA1 = getElo(g.team_a_player_1);
    const eA2 = getElo(g.team_a_player_2);
    const eB1 = getElo(g.team_b_player_1);
    const eB2 = getElo(g.team_b_player_2);

    const cntA = (eA1 !== null ? 1 : 0) + (eA2 !== null ? 1 : 0);
    const cntB = (eB1 !== null ? 1 : 0) + (eB2 !== null ? 1 : 0);
    const teamAElo = ((eA1 || 1000) + (eA2 || 1000)) / (cntA || 1);
    const teamBElo = ((eB1 || 1000) + (eB2 || 1000)) / (cntB || 1);

    const remaining = parseInt(g.winner_remaining) || 1;
    const { deltaA, deltaB } = calculateElo(teamAElo, teamBElo, g.winning_team, g.score_type, remaining, g.drink_type);

    g.elo_deltas = {};
    const apply = (name, delta) => {
      if (!name || name.trim() === '' || name === 'FOH' || name === 'Alumn') return;
      g.elo_deltas[name] = Math.round(delta);
      elos[name] = (elos[name] || 1000) + delta;
    };
    apply(g.team_a_player_1, deltaA);
    apply(g.team_a_player_2, deltaA);
    apply(g.team_b_player_1, deltaB);
    apply(g.team_b_player_2, deltaB);
  }

  return sorted.filter(g => 
    g.team_a_player_1 === userName ||
    g.team_a_player_2 === userName ||
    g.team_b_player_1 === userName ||
    g.team_b_player_2 === userName
  );
}

// ELO Calculation
function calculateElo(teamAElo, teamBElo, winner, scoreType, winnerRemaining, drinkType) {
  const K_BASE = 48;
  let K = scoreType && scoreType.toLowerCase() === 'halves' ? K_BASE * 1.5 : K_BASE;
  
  // Margin of Victory Multiplier (+20% for each extra point beyond 1)
  const remaining = Math.max(1, Number(winnerRemaining) || 1);
  const movMultiplier = 1 + (remaining - 1) * 0.2;
  K = K * movMultiplier;
  
  // Drink Modifier (Water = 85% penalty)
  if (drinkType && drinkType.toLowerCase().includes('water')) {
    K = K * 0.15;
  }
  
  const expectedA = 1 / (1 + Math.pow(10, (teamBElo - teamAElo) / 400));
  const expectedB = 1 / (1 + Math.pow(10, (teamAElo - teamBElo) / 400));
  
  const actualA = winner === 'A' ? 1 : 0;
  const actualB = winner === 'B' ? 1 : 0;
  
  const deltaA = K * (actualA - expectedA);
  const deltaB = K * (actualB - expectedB);
  
  return { deltaA, deltaB };
}

async function recalculateAllStats() {
  clearDieSheetCache();
  const ledger = await getDieSheetData(LEDGER_SHEET);
  if (!ledger || ledger.length <= 1) {
    // Clear stats if no games
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.dieSpreadsheetId,
      range: `${STATS_SHEET}!A2:H`,
    });
    clearDieSheetCache();
    return;
  }
  
  const headers = ledger[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const games = ledger.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
  
  // Sort games by timestamp ascending to replay history
  games.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  const players = {}; // name -> { elo, wins, losses, games_played, win_streak, max_win_streak }
  
  const UNTRACKED_ELO = { 'Alumn': 1100, 'FOH': 900 };

  const getPlayer = (name) => {
    if (!name || name.trim() === '' || name in UNTRACKED_ELO) return null;
    if (!players[name]) {
      players[name] = { name, elo: 1000, wins: 0, losses: 0, games_played: 0, win_streak: 0, max_win_streak: 0 };
    }
    return players[name];
  };

  const effectiveElo = (player, name) => {
    if (player) return player.elo;
    return UNTRACKED_ELO[name] ?? 1000;
  };
  
  for (const g of games) {
    if (!g.winning_team || (g.winning_team !== 'A' && g.winning_team !== 'B')) continue;

    const pA1 = getPlayer(g.team_a_player_1);
    const pA2 = getPlayer(g.team_a_player_2);
    const pB1 = getPlayer(g.team_b_player_1);
    const pB2 = getPlayer(g.team_b_player_2);
    
    const teamAElo = (effectiveElo(pA1, g.team_a_player_1) + effectiveElo(pA2, g.team_a_player_2)) / ( (pA1?1:0) + (pA2?1:0) || 1 );
    const teamBElo = (effectiveElo(pB1, g.team_b_player_1) + effectiveElo(pB2, g.team_b_player_2)) / ( (pB1?1:0) + (pB2?1:0) || 1 );
    
    const remaining = parseInt(g.winner_remaining) || 1;
    const { deltaA, deltaB } = calculateElo(teamAElo, teamBElo, g.winning_team, g.score_type, remaining, g.drink_type);
    
    const updatePlayer = (p, isTeamA) => {
      if (!p) return;
      p.games_played++;
      const won = (g.winning_team === 'A' && isTeamA) || (g.winning_team === 'B' && !isTeamA);
      if (won) {
        p.wins++;
        p.win_streak++;
        p.max_win_streak = Math.max(p.max_win_streak, p.win_streak);
      } else {
        p.losses++;
        p.win_streak = 0;
      }
      p.elo += isTeamA ? deltaA : deltaB;
    };
    
    updatePlayer(pA1, true);
    updatePlayer(pA2, true);
    updatePlayer(pB1, false);
    updatePlayer(pB2, false);
  }
  
  // Zero out ELO for players involved in pending disputes
  const pendingDisputes = await getPendingDisputes();
  const disputedPlayerNames = new Set();
  for (const d of pendingDisputes) {
    const gameRow = games.find(g => g.game_id === d.game_id);
    if (gameRow) {
      [gameRow.team_a_player_1, gameRow.team_a_player_2, gameRow.team_b_player_1, gameRow.team_b_player_2]
        .filter(n => n && n.trim() !== '' && n !== 'FOH' && n !== 'Alumn')
        .forEach(n => disputedPlayerNames.add(n));
    }
  }
  for (const name of disputedPlayerNames) {
    if (players[name]) players[name].elo = 0;
  }

  // Convert players to array and sort by ELO descending to assign ranks
  const playersArray = Object.values(players).sort((a, b) => b.elo - a.elo);
  playersArray.forEach((p, i) => {
    p.rank = disputedPlayerNames.has(p.name) ? '-' : i + 1;
  });
  
  // Write back to STATS_SHEET
  const sheets = await getSheetsClient();
  const statsData = [
    ['player_name', 'ELO', 'rank', 'wins', 'losses', 'games_played', 'win_streak', 'max_win_streak']
  ];
  
  for (const p of playersArray) {
    statsData.push([
      p.name,
      Math.round(p.elo),
      p.rank,
      p.wins,
      p.losses,
      p.games_played,
      p.win_streak || 0,
      p.max_win_streak || 0
    ]);
  }
  
  // Only clear and update if we actually have stats to write
  if (statsData.length > 1) {
    // Clear old stats first
    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.dieSpreadsheetId,
      range: `${STATS_SHEET}!A1:H`,
    });
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.dieSpreadsheetId,
      range: STATS_SHEET,
      valueInputOption: 'USER_ENTERED',
      resource: { values: statsData },
    });
  }
  
  clearDieSheetCache();
}

async function checkDuplicate(gameData) {
  const data = await getDieSheetData(LEDGER_SHEET);
  if (!data || data.length <= 1) return null;
  
  const headers = data[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const games = data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
  
  const now = new Date();
  const recentGames = games.filter(g => {
    const gTime = new Date(g.timestamp);
    // Check within last 2 hours
    return (now - gTime) < 2 * 60 * 60 * 1000;
  });
  
  for (const g of recentGames) {
    // Create sets for the teams in the existing game
    const gTeamA = new Set([g.team_a_player_1, g.team_a_player_2].filter(Boolean));
    const gTeamB = new Set([g.team_b_player_1, g.team_b_player_2].filter(Boolean));
    
    // Create sets for the teams in the new game
    const newTeamA = new Set([gameData.team_a_player_1, gameData.team_a_player_2].filter(Boolean));
    const newTeamB = new Set([gameData.team_b_player_1, gameData.team_b_player_2].filter(Boolean));
    
    const eqSet = (xs, ys) => xs.size === ys.size && [...xs].every((x) => ys.has(x));
    
    // Check if the teams are exactly the same (regardless of A/B assignment or player 1/2 order)
    const teamsMatchDirectly = eqSet(gTeamA, newTeamA) && eqSet(gTeamB, newTeamB);
    const teamsMatchSwapped = eqSet(gTeamA, newTeamB) && eqSet(gTeamB, newTeamA);
    
    if (teamsMatchDirectly || teamsMatchSwapped) {
      // If teams are swapped, the winner must also be swapped to be considered a duplicate outcome
      const gWinnerSet = g.winning_team === 'A' ? gTeamA : gTeamB;
      const newWinnerSet = gameData.winning_team === 'A' ? newTeamA : newTeamB;
      
      const winnerMatches = eqSet(gWinnerSet, newWinnerSet);
      
      if (winnerMatches && 
          g.score_type === gameData.score_type && 
          g.winner_remaining === gameData.winner_remaining) {
        return g;
      }
    }
  }
  
  return null;
}

async function addGame(gameData, userEmail) {
  if (!gameData.force_submit) {
    const dup = await checkDuplicate(gameData);
    if (dup) {
      return { duplicate: true, game: dup };
    }
  }
  
  const sheets = await getSheetsClient();
  const gameId = uuidv4();
  const timestamp = new Date().toISOString();
  
  const row = [
    gameId,
    timestamp,
    gameData.team_a_player_1 || '',
    gameData.team_a_player_2 || '',
    gameData.team_b_player_1 || '',
    gameData.team_b_player_2 || '',
    gameData.winning_team || '',
    gameData.score_type || 'halves',
    gameData.winner_remaining || '',
    gameData.drink_type || 'beer',
    userEmail
  ];
  
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.dieSpreadsheetId,
      range: LEDGER_SHEET,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] },
    });
  } catch (err) {
    console.error('Error appending game to ledger:', err.message);
    throw new Error('Failed to save game to ledger');
  }
  
  clearDieSheetCache();
  
  try {
    await recalculateAllStats();
  } catch (err) {
    console.error('Error recalculating stats:', err.message);
    // Even if stats fail, the game was logged
  }
  
  return { success: true, gameId };
}

async function editGame(gameId, gameData, userName) {
  clearDieSheetCache();
  const data = await getDieSheetData(LEDGER_SHEET);
  if (!data || data.length <= 1) throw new Error('No games found');

  const headers = data[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const rowIndex = data.findIndex((row, i) => i > 0 && row[0] === gameId);
  if (rowIndex === -1) throw new Error('Game not found');

  const game = {};
  headers.forEach((h, i) => { game[h] = data[rowIndex][i] || ''; });

  const players = [game.team_a_player_1, game.team_a_player_2, game.team_b_player_1, game.team_b_player_2];
  if (!players.includes(userName)) {
    throw new Error('Only players involved in this game can edit it');
  }

  const elapsed = Date.now() - new Date(game.timestamp).getTime();
  if (elapsed > 120000) {
    throw new Error('Edit window has expired (2 minutes)');
  }

  const row = data[rowIndex];
  const winIdx = headers.indexOf('winning_team');
  const scoreIdx = headers.indexOf('score_type');
  const remIdx = headers.indexOf('winner_remaining');
  const drinkIdx = headers.indexOf('drink_type');

  if (gameData.winning_team !== undefined) row[winIdx] = gameData.winning_team;
  if (gameData.score_type !== undefined) row[scoreIdx] = gameData.score_type;
  if (gameData.winner_remaining !== undefined) row[remIdx] = gameData.winner_remaining;
  if (gameData.drink_type !== undefined) row[drinkIdx] = gameData.drink_type;

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.dieSpreadsheetId,
    range: `${LEDGER_SHEET}!A${rowIndex + 1}:K${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });

  clearDieSheetCache();
  try { await recalculateAllStats(); } catch (e) { console.error('Error recalculating after edit:', e.message); }

  return { success: true };
}

// --- Dispute System ---

async function getDisputes() {
  const data = await getDieSheetData(DISPUTES_SHEET);
  if (!data || data.length <= 1) return [];

  const headers = data[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
}

async function getPendingDisputes() {
  const all = await getDisputes();
  return all.filter(d => d.status === 'pending');
}

async function createDispute(gameId, proposedData, disputedByName) {
  clearDieSheetCache();
  const ledger = await getDieSheetData(LEDGER_SHEET);
  if (!ledger || ledger.length <= 1) throw new Error('No games found');

  const headers = ledger[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const gameRow = ledger.slice(1).find(row => row[0] === gameId);
  if (!gameRow) throw new Error('Game not found');

  const game = {};
  headers.forEach((h, i) => { game[h] = gameRow[i] || ''; });

  let disputerTeam = '';
  if (game.team_a_player_1 === disputedByName || game.team_a_player_2 === disputedByName) {
    disputerTeam = 'A';
  } else if (game.team_b_player_1 === disputedByName || game.team_b_player_2 === disputedByName) {
    disputerTeam = 'B';
  } else {
    throw new Error('You are not a player in this game');
  }

  const pending = await getPendingDisputes();
  if (pending.some(d => d.game_id === gameId)) {
    throw new Error('A dispute is already pending for this game');
  }

  const sheets = await getSheetsClient();
  const disputeId = uuidv4();
  const timestamp = new Date().toISOString();
  const disputeType = proposedData.dispute_type || 'edit';

  const row = [
    disputeId,
    gameId,
    timestamp,
    disputedByName,
    disputeType,
    disputeType === 'edit' ? (proposedData.winning_team || '') : '',
    disputeType === 'edit' ? (proposedData.score_type || '') : '',
    disputeType === 'edit' ? (proposedData.winner_remaining || '') : '',
    disputeType === 'edit' ? (proposedData.drink_type || '') : '',
    'pending',
    disputerTeam
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.dieSpreadsheetId,
    range: DISPUTES_SHEET,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] },
  });

  clearDieSheetCache();
  try { await recalculateAllStats(); } catch (e) { console.error('Error recalculating after dispute creation:', e.message); }

  return { success: true, disputeId };
}

async function resolveDispute(disputeId, resolution, resolverName) {
  if (resolution !== 'accepted' && resolution !== 'rejected') {
    throw new Error('Resolution must be "accepted" or "rejected"');
  }

  clearDieSheetCache();
  const disputeData = await getDieSheetData(DISPUTES_SHEET);
  if (!disputeData || disputeData.length <= 1) throw new Error('No disputes found');

  const disputeHeaders = disputeData[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const disputeRowIndex = disputeData.findIndex((row, i) => i > 0 && row[0] === disputeId);
  if (disputeRowIndex === -1) throw new Error('Dispute not found');

  const dispute = {};
  disputeHeaders.forEach((h, i) => { dispute[h] = disputeData[disputeRowIndex][i] || ''; });

  if (dispute.status !== 'pending') throw new Error('This dispute has already been resolved');

  const ledger = await getDieSheetData(LEDGER_SHEET);
  if (!ledger || ledger.length <= 1) throw new Error('No games found');
  const ledgerHeaders = ledger[0].map(h => (h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  const gameRowIndex = ledger.findIndex((row, i) => i > 0 && row[0] === dispute.game_id);
  if (gameRowIndex === -1) throw new Error('Associated game not found');

  const game = {};
  ledgerHeaders.forEach((h, i) => { game[h] = ledger[gameRowIndex][i] || ''; });

  const opposingTeam = dispute.disputer_team === 'A' ? 'B' : 'A';
  const opposingPlayers = opposingTeam === 'A'
    ? [game.team_a_player_1, game.team_a_player_2]
    : [game.team_b_player_1, game.team_b_player_2];

  if (!opposingPlayers.includes(resolverName)) {
    throw new Error('Only a player from the opposing team can resolve this dispute');
  }

  const sheets = await getSheetsClient();

  if (resolution === 'accepted') {
    if (dispute.dispute_type === 'edit') {
      const row = ledger[gameRowIndex];
      const winIdx = ledgerHeaders.indexOf('winning_team');
      const scoreIdx = ledgerHeaders.indexOf('score_type');
      const remIdx = ledgerHeaders.indexOf('winner_remaining');
      const drinkIdx = ledgerHeaders.indexOf('drink_type');

      if (dispute.proposed_winning_team) row[winIdx] = dispute.proposed_winning_team;
      if (dispute.proposed_score_type) row[scoreIdx] = dispute.proposed_score_type;
      if (dispute.proposed_winner_remaining) row[remIdx] = dispute.proposed_winner_remaining;
      if (dispute.proposed_drink_type) row[drinkIdx] = dispute.proposed_drink_type;

      await sheets.spreadsheets.values.update({
        spreadsheetId: config.dieSpreadsheetId,
        range: `${LEDGER_SHEET}!A${gameRowIndex + 1}:K${gameRowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [row] },
      });
    } else if (dispute.dispute_type === 'delete') {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: config.dieSpreadsheetId,
        fields: 'sheets(properties(sheetId,title))',
      });
      const sheetInfo = meta.data.sheets.find(s => s.properties.title === LEDGER_SHEET);
      if (sheetInfo) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: config.dieSpreadsheetId,
          resource: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: sheetInfo.properties.sheetId,
                  dimension: 'ROWS',
                  startIndex: gameRowIndex,
                  endIndex: gameRowIndex + 1
                }
              }
            }]
          }
        });
      }
    }
  }

  const statusColIndex = disputeHeaders.indexOf('status');
  disputeData[disputeRowIndex][statusColIndex] = resolution;
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.dieSpreadsheetId,
    range: `${DISPUTES_SHEET}!A${disputeRowIndex + 1}:K${disputeRowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [disputeData[disputeRowIndex]] },
  });

  clearDieSheetCache();
  try { await recalculateAllStats(); } catch (e) { console.error('Error recalculating after dispute resolution:', e.message); }

  return { success: true };
}

// Ensure sheets exist
async function initDieSheets() {
  try {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.dieSpreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    
    const existingTitles = meta.data.sheets.map(s => s.properties.title);
    const requests = [];
    
    if (!existingTitles.includes(LEDGER_SHEET)) {
      requests.push({
        addSheet: {
          properties: { title: LEDGER_SHEET }
        }
      });
    }
    if (!existingTitles.includes(STATS_SHEET)) {
      requests.push({
        addSheet: {
          properties: { title: STATS_SHEET }
        }
      });
    }
    
    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.dieSpreadsheetId,
        resource: { requests }
      });
      
      // Add headers
      if (!existingTitles.includes(LEDGER_SHEET)) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: config.dieSpreadsheetId,
          range: `${LEDGER_SHEET}!A1:K1`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['game_id', 'timestamp', 'team_a_player_1', 'team_a_player_2', 'team_b_player_1', 'team_b_player_2', 'winning_team', 'score_type', 'winner_remaining', 'drink_type', 'created_by']] }
        });
      }
      if (!existingTitles.includes(STATS_SHEET)) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: config.dieSpreadsheetId,
          range: `${STATS_SHEET}!A1:H1`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['player_name', 'ELO', 'rank', 'wins', 'losses', 'games_played', 'win_streak', 'max_win_streak']] }
        });
      }
    }
  } catch (e) {
    console.error('Error initializing Die ELO sheets:', e.message);
  }
}

// Call init once on load if configured
if (config.dieSpreadsheetId && config.dieSpreadsheetId !== '1_die_elo_spreadsheet_id_placeholder') {
  initDieSheets();
}

module.exports = {
  getStats,
  getGameHistory,
  addGame,
  editGame,
  recalculateAllStats,
  getDisputes,
  createDispute,
  resolveDispute,
};
