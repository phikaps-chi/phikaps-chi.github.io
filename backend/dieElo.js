const { getSheetsClient, cache } = require('./sheets');
const config = require('./config');
const { v4: uuidv4 } = require('uuid');

const LEDGER_SHEET = 'Game Ledger';
const STATS_SHEET = 'Player Stats';

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
  
  // Filter for games involving the user
  return games.filter(g => 
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
      range: `${STATS_SHEET}!A2:F`,
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
  
  const players = {}; // name -> { elo, wins, losses, games_played }
  
  const getPlayer = (name) => {
    // Treat empty strings as null
    if (!name || name.trim() === '' || name === 'FOH' || name === 'Alumn') return null;
    if (!players[name]) {
      players[name] = { name, elo: 1000, wins: 0, losses: 0, games_played: 0 };
    }
    return players[name];
  };
  
  for (const g of games) {
    // Skip games with invalid structure
    if (!g.winning_team || (g.winning_team !== 'A' && g.winning_team !== 'B')) continue;

    const pA1 = getPlayer(g.team_a_player_1);
    const pA2 = getPlayer(g.team_a_player_2);
    const pB1 = getPlayer(g.team_b_player_1);
    const pB2 = getPlayer(g.team_b_player_2);
    
    const teamAElo = ((pA1 ? pA1.elo : 1000) + (pA2 ? pA2.elo : 1000)) / ( (pA1?1:0) + (pA2?1:0) || 1 );
    const teamBElo = ((pB1 ? pB1.elo : 1000) + (pB2 ? pB2.elo : 1000)) / ( (pB1?1:0) + (pB2?1:0) || 1 );
    
    const remaining = parseInt(g.winner_remaining) || 1;
    const { deltaA, deltaB } = calculateElo(teamAElo, teamBElo, g.winning_team, g.score_type, remaining, g.drink_type);
    
    const updatePlayer = (p, isTeamA) => {
      if (!p) return;
      p.games_played++;
      if (g.winning_team === 'A') {
        if (isTeamA) p.wins++; else p.losses++;
      } else if (g.winning_team === 'B') {
        if (!isTeamA) p.wins++; else p.losses++;
      }
      p.elo += isTeamA ? deltaA : deltaB;
    };
    
    updatePlayer(pA1, true);
    updatePlayer(pA2, true);
    updatePlayer(pB1, false);
    updatePlayer(pB2, false);
  }
  
  // Convert players to array and sort by ELO descending to assign ranks
  const playersArray = Object.values(players).sort((a, b) => b.elo - a.elo);
  playersArray.forEach((p, i) => {
    p.rank = i + 1;
  });
  
  // Write back to STATS_SHEET
  const sheets = await getSheetsClient();
  const statsData = [
    ['player_name', 'ELO', 'rank', 'wins', 'losses', 'games_played']
  ];
  
  for (const p of playersArray) {
    statsData.push([
      p.name,
      Math.round(p.elo),
      p.rank,
      p.wins,
      p.losses,
      p.games_played
    ]);
  }
  
  // Only clear and update if we actually have stats to write
  if (statsData.length > 1) {
    // Clear old stats first
    await sheets.spreadsheets.values.clear({
      spreadsheetId: config.dieSpreadsheetId,
      range: `${STATS_SHEET}!A1:F`,
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

async function editGame(gameId, gameData, userEmail) {
  const data = await getDieSheetData(LEDGER_SHEET);
  if (!data || data.length <= 1) throw new Error('No games found');
  
  const rowIndex = data.findIndex(row => row[0] === gameId);
  if (rowIndex === -1) throw new Error('Game not found');
  
  const sheets = await getSheetsClient();
  const row = data[rowIndex];
  
  // Update fields
  row[2] = gameData.team_a_player_1 !== undefined ? gameData.team_a_player_1 : row[2];
  row[3] = gameData.team_a_player_2 !== undefined ? gameData.team_a_player_2 : row[3];
  row[4] = gameData.team_b_player_1 !== undefined ? gameData.team_b_player_1 : row[4];
  row[5] = gameData.team_b_player_2 !== undefined ? gameData.team_b_player_2 : row[5];
  row[6] = gameData.winning_team !== undefined ? gameData.winning_team : row[6];
  row[7] = gameData.score_type !== undefined ? gameData.score_type : row[7];
  row[8] = gameData.winner_remaining !== undefined ? gameData.winner_remaining : row[8];
  row[9] = gameData.drink_type !== undefined ? gameData.drink_type : row[9];
  
  const range = `${LEDGER_SHEET}!A${rowIndex + 1}:K${rowIndex + 1}`;
  
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.dieSpreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });
  } catch (err) {
    console.error('Error updating game in ledger:', err.message);
    throw new Error('Failed to update game in ledger');
  }
  
  clearDieSheetCache();
  
  try {
    await recalculateAllStats();
  } catch (err) {
    console.error('Error recalculating stats after edit:', err.message);
  }
  
  return { success: true };
}

async function deleteGame(gameId, userEmail) {
  const data = await getDieSheetData(LEDGER_SHEET);
  if (!data || data.length <= 1) throw new Error('No games found');
  
  const rowIndex = data.findIndex(row => row[0] === gameId);
  if (rowIndex === -1) throw new Error('Game not found');
  
  const sheets = await getSheetsClient();
  
  // Get sheetId for LEDGER_SHEET
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.dieSpreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const sheetInfo = meta.data.sheets.find(s => s.properties.title === LEDGER_SHEET);
  
  if (sheetInfo) {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.dieSpreadsheetId,
        resource: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: sheetInfo.properties.sheetId,
                  dimension: 'ROWS',
                  startIndex: rowIndex,
                  endIndex: rowIndex + 1
                }
              }
            }
          ]
        }
      });
    } catch (err) {
      console.error('Error deleting game from ledger:', err.message);
      throw new Error('Failed to delete game from ledger');
    }
  }
  
  clearDieSheetCache();
  
  try {
    await recalculateAllStats();
  } catch (err) {
    console.error('Error recalculating stats after delete:', err.message);
  }
  
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
          range: `${STATS_SHEET}!A1:F1`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['player_name', 'ELO', 'rank', 'wins', 'losses', 'games_played']] }
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
  deleteGame,
  recalculateAllStats,
};
