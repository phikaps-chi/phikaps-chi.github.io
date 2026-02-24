const { getParentSheet, searchByEmail, searchByDoc } = require('./sheets');
const { getName } = require('./auth');
const config = require('./config');

/**
 * Mirrors Sigma.gs getListOfBrothers(sigmaData).
 * Returns a de-duped list of names from column F (index 5).
 */
function getListOfBrothers(sigmaData) {
  if (!sigmaData || sigmaData.length < 2) return [];

  const contacts = sigmaData.slice(1)
    .map((row) => {
      if (row && row.length > 5 && row[5]) {
        return row[5].toString().trim();
      }
      return null;
    })
    .filter(Boolean);

  return [...new Set(contacts)];
}

/**
 * Mirrors Sigma.gs getFullRoster(sigmaData).
 * Returns array of { email, name, position } objects.
 */
function getFullRoster(sigmaData) {
  if (!sigmaData || sigmaData.length < 2) return [];

  const roster = [];
  for (let i = 1; i < sigmaData.length; i++) {
    const row = sigmaData[i];
    if (row && row.length > 5 && row[4]) {
      const email = (row[4] || '').toString().trim();
      const name = (row[5] || '').toString().trim();
      const position = (row[6] || '').toString().trim();
      if (email) {
        roster.push({
          email,
          name: name || 'Unknown',
          position: position || 'None',
        });
      }
    }
  }
  return roster;
}

function getBylaws(sigmaData) {
  return searchByDoc(sigmaData, 'Bylaws', 1);
}

function getMeetingMinutes(sigmaData) {
  return searchByDoc(sigmaData, 'Meeting Minutes', 1);
}

function getRMP(thetaData) {
  return searchByDoc(thetaData, 'Risk Policy', 1);
}

function getPKSFolder(sigmaData) {
  return searchByDoc(sigmaData, 'PKS', 1);
}

/**
 * Mirrors Code.gs getWelcomeMessage().
 */
function getWelcomeMessage(sigmaData, email, position) {
  if (config.isDev) return 'Welcome Admin';
  const fullName = getName(sigmaData, email);
  const lastName = fullName ? fullName.split(' ')[1] : '';
  if (position && position.includes('Pledge')) {
    return `Welcome Pledge ${lastName}!`;
  }
  return `Welcome brother ${lastName}!`;
}

module.exports = {
  getListOfBrothers,
  getFullRoster,
  getBylaws,
  getMeetingMinutes,
  getRMP,
  getPKSFolder,
  getWelcomeMessage,
};
