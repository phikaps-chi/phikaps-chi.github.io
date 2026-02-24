const crypto = require('crypto');
const { getParentSheet, getSheetsClient, clearSheetCache, cache } = require('./sheets');
const { fetchHtmlFromGCS, uploadHtmlToGCS, deleteFromGCS } = require('./gcs');
const config = require('./config');

const BUTTON_SHEET_NAME = 'Buttons';

/**
 * Mirrors ButtonManager.gs getCustomButtons().
 * Reads the Buttons sheet and returns parsed button objects.
 * Handles both legacy (8 col) and new (12 col) row formats.
 */
async function getCustomButtons() {
  try {
    const cacheKey = 'customButtons';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const data = await getParentSheet(BUTTON_SHEET_NAME);
    if (!data || data.length <= 1) return [];

    const buttons = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[0]) continue;

      const hasNewFormatAccessType = row[5] && (row[5] === 'All' || String(row[5]).includes('Specific'));
      const hasLegacyFormatAccessType = row[2] && (row[2] === 'All' || String(row[2]).includes('Specific'));
      const isLegacy = !hasNewFormatAccessType && hasLegacyFormatAccessType;

      if (isLegacy) {
        buttons.push({
          buttonId: row[0],
          buttonName: row[1],
          description: '',
          icon: '',
          color: '#ffd700',
          accessType: row[2],
          accessList: row[3] ? JSON.parse(row[3]) : [],
          content: row[4],
          createdBy: row[5],
          ownerPosition: row[6] || '',
          lastModified: row[7],
        });
      } else {
        buttons.push({
          buttonId: row[0],
          buttonName: row[1],
          description: row[2] || '',
          icon: row[3] || '',
          color: row[4] || '#ffd700',
          accessType: row[5],
          accessList: row[6] ? JSON.parse(row[6]) : [],
          content: row[7],
          createdBy: row[8],
          ownerPosition: row[9] || '',
          excludePledges: row[10] || false,
          lastModified: row[11],
        });
      }
    }

    cache.set(cacheKey, buttons, 300);
    return buttons;
  } catch (err) {
    console.error('Error getting custom buttons:', err.message);
    return [];
  }
}

/**
 * Mirrors ButtonManager.gs getButtonsForDisplay(userEmail).
 * Filters buttons by access rules and fetches GCS content where needed.
 */
async function getButtonsForDisplay(userEmail) {
  try {
    const buttons = await getCustomButtons();
    const sigmaData = await getParentSheet('Sigma');

    let userName = '';
    let userPositions = [];

    if (config.isDev) {
      userName = 'Admin';
      userPositions = [
        'Alpha', 'Beta', 'Sigma', 'Chi', 'Iota', 'Tau', 'Gamma', 'Rho', 'Theta',
        'Associate Tau', 'Associate Gamma', 'Associate Iota', 'Associate Rho',
        'Pi', 'Delta', 'Associate Delta', 'Psi', 'Upsilon', "Gamma's Theta",
        'Phi', 'Omicron', 'Mu',
      ];
    } else {
      for (let i = 1; i < sigmaData.length; i++) {
        if (sigmaData[i][4] && sigmaData[i][4].toLowerCase() === userEmail.toLowerCase()) {
          userName = sigmaData[i][5] || '';
          const positions = sigmaData[i][6] || '';
          userPositions = positions.split(',').map((p) => p.trim()).filter(Boolean);
          break;
        }
      }
    }

    const userIsPledge = userPositions.some((pos) => pos.toLowerCase().includes('pledge'));
    const isAdmin = config.isDev;
    const displayButtons = [];

    for (const button of buttons) {
      if (button.excludePledges && userIsPledge && !isAdmin) continue;

      let shouldDisplay = false;
      if (isAdmin) {
        shouldDisplay = true;
      } else if (button.accessType === 'All') {
        shouldDisplay = true;
      } else if (button.accessType === 'Specific Bros') {
        shouldDisplay = button.accessList.some(
          (name) => name.toLowerCase() === userName.toLowerCase(),
        );
      } else if (button.accessType === 'Specific Officers') {
        shouldDisplay = button.accessList.some((position) => userPositions.includes(position));
      }

      if (!shouldDisplay) continue;

      let content = button.content;
      if (content && content.includes('storage.googleapis.com')) {
        content = await fetchHtmlFromGCS(content);
      }

      displayButtons.push({
        id: button.buttonId,
        name: button.buttonName,
        description: button.description || '',
        icon: button.icon || '',
        color: button.color || '#ffd700',
        content,
        isHtml: content && content.includes('<'),
      });
    }

    return displayButtons;
  } catch (err) {
    console.error('Error getting buttons for display:', err.message);
    return [];
  }
}

function generateButtonId() {
  return 'btn_' + crypto.randomUUID().substring(0, 8);
}

function extractFileNameFromUrl(url) {
  const urlWithoutParams = url.split('?')[0];
  const match = urlWithoutParams.match(/\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Saves a new custom button. Mirrors ButtonManager.gs saveCustomButton().
 */
async function saveCustomButton(buttonData, email) {
  try {
    const sheets = await getSheetsClient();
    const buttonId = generateButtonId();
    const now = new Date().toISOString();

    let contentToStore = buttonData.content || '';

    if (contentToStore.includes('<') && contentToStore.length > 1000) {
      const fileName = `button_${buttonId}.html`;
      const gcsUrl = await uploadHtmlToGCS(config.gcs.buttonHtmlBucket, fileName, contentToStore);
      if (gcsUrl) contentToStore = gcsUrl;
    }

    const rowData = [
      buttonId, buttonData.buttonName,
      buttonData.description || '', buttonData.icon || '',
      buttonData.color || '#ffd700', buttonData.accessType || 'All',
      JSON.stringify(buttonData.accessList || []), contentToStore,
      email, buttonData.ownerPosition || '',
      buttonData.excludePledges || false, now,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range: BUTTON_SHEET_NAME,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] },
    });

    cache.del('customButtons');
    return { success: true, buttonId, message: 'Button saved successfully' };
  } catch (err) {
    console.error('Error saving button:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Saves multiple personalized buttons. Mirrors ButtonManager.gs saveBulkButtons().
 */
async function saveBulkButtons(bulkData, email) {
  try {
    const sheets = await getSheetsClient();
    const now = new Date().toISOString();
    const rows = [];

    for (const item of bulkData.items) {
      const buttonId = generateButtonId();
      let contentToStore = item.content || '';

      if (contentToStore.includes('<') && contentToStore.length > 1000) {
        const fileName = `button_${buttonId}.html`;
        const gcsUrl = await uploadHtmlToGCS(config.gcs.buttonHtmlBucket, fileName, contentToStore);
        if (gcsUrl) contentToStore = gcsUrl;
      }

      rows.push([
        buttonId, bulkData.buttonNameTemplate.replace('{{name}}', item.name),
        bulkData.description || '', bulkData.icon || '',
        bulkData.color || '#ffd700', bulkData.accessType,
        JSON.stringify([item.name]), contentToStore,
        email, bulkData.ownerPosition || '',
        false, now,
      ]);
    }

    if (rows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.spreadsheetId,
        range: BUTTON_SHEET_NAME,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows },
      });
    }

    cache.del('customButtons');
    return { success: true, message: `Created ${rows.length} personalized buttons successfully` };
  } catch (err) {
    console.error('Error saving bulk buttons:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Updates an existing custom button. Mirrors ButtonManager.gs updateCustomButton().
 */
async function updateCustomButton(buttonData, email) {
  try {
    const sheets = await getSheetsClient();
    const data = await getParentSheet(BUTTON_SHEET_NAME);
    const buttonId = buttonData.buttonId;

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== buttonId) continue;

      const hasNewAccess = data[i][5] && (data[i][5] === 'All' || String(data[i][5]).includes('Specific'));
      const hasLegacyAccess = data[i][2] && (data[i][2] === 'All' || String(data[i][2]).includes('Specific'));
      const isLegacy = !hasNewAccess && hasLegacyAccess;

      let contentToStore = buttonData.content || '';
      const oldContentIndex = isLegacy ? 4 : 7;
      const oldContent = data[i][oldContentIndex] || '';
      const wasInGCS = oldContent.includes('storage.googleapis.com');

      if (contentToStore.includes('<') && contentToStore.length > 1000) {
        if (wasInGCS) {
          const oldFileName = extractFileNameFromUrl(oldContent);
          if (oldFileName) await deleteFromGCS(config.gcs.buttonHtmlBucket, oldFileName);
        }
        const fileName = `button_${buttonId}.html`;
        const gcsUrl = await uploadHtmlToGCS(config.gcs.buttonHtmlBucket, fileName, contentToStore);
        if (gcsUrl) contentToStore = gcsUrl;
      } else if (wasInGCS) {
        const oldFileName = extractFileNameFromUrl(oldContent);
        if (oldFileName) await deleteFromGCS(config.gcs.buttonHtmlBucket, oldFileName);
      }

      const rowData = [
        buttonId, buttonData.buttonName,
        buttonData.description || '', buttonData.icon || '',
        buttonData.color || '#ffd700', buttonData.accessType || 'All',
        JSON.stringify(buttonData.accessList || []), contentToStore,
        data[i][8] || email, buttonData.ownerPosition || data[i][9] || '',
        buttonData.excludePledges !== undefined ? buttonData.excludePledges : (data[i][10] || false),
        new Date().toISOString(),
      ];

      const rowInSheet = i + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${BUTTON_SHEET_NAME}'!A${rowInSheet}:L${rowInSheet}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [rowData] },
      });

      cache.del('customButtons');
      clearSheetCache(BUTTON_SHEET_NAME);
      return { success: true, message: 'Button updated successfully' };
    }

    return { success: false, message: 'Button not found' };
  } catch (err) {
    console.error('Error updating button:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Deletes a custom button. Mirrors ButtonManager.gs deleteCustomButton().
 */
async function deleteCustomButton(buttonId) {
  try {
    const sheets = await getSheetsClient();
    const data = await getParentSheet(BUTTON_SHEET_NAME);

    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== buttonId) continue;
      rowIndex = i;

      const hasNewAccess = data[i][5] && (data[i][5] === 'All' || String(data[i][5]).includes('Specific'));
      const hasLegacyAccess = data[i][2] && (data[i][2] === 'All' || String(data[i][2]).includes('Specific'));
      const isLegacy = !hasNewAccess && hasLegacyAccess;
      const contentIndex = isLegacy ? 4 : 7;

      if (data[i][contentIndex] && String(data[i][contentIndex]).includes('storage.googleapis.com')) {
        const fileName = extractFileNameFromUrl(data[i][contentIndex]);
        if (fileName) await deleteFromGCS(config.gcs.buttonHtmlBucket, fileName);
      }
      break;
    }

    if (rowIndex === -1) return { success: false, message: 'Button not found' };

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    const btnSheet = meta.data.sheets.find((s) => s.properties.title === BUTTON_SHEET_NAME);
    if (!btnSheet) return { success: false, message: 'Button sheet not found' };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: btnSheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        }],
      },
    });

    cache.del('customButtons');
    clearSheetCache(BUTTON_SHEET_NAME);
    return { success: true, message: 'Button deleted successfully' };
  } catch (err) {
    console.error('Error deleting button:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Returns buttons filtered for the button manager UI.
 * User sees buttons they created or where they hold the owner position.
 */
async function getButtonsForManager(userEmail, userPosition) {
  try {
    const buttons = await getCustomButtons();
    if (config.isDev) return buttons;

    const userPositions = userPosition ? userPosition.split(',').map((p) => p.trim()) : [];
    return buttons.filter((button) => {
      if (button.createdBy && button.createdBy.toLowerCase() === userEmail.toLowerCase()) return true;
      if (button.ownerPosition && userPositions.includes(button.ownerPosition)) return true;
      return false;
    });
  } catch (err) {
    console.error('Error getting buttons for manager:', err.message);
    return [];
  }
}

/**
 * Returns all officer position names.
 */
function getAllOfficerPositions() {
  return [
    'Alpha', 'Beta', 'Sigma', 'Chi', 'Iota', 'Tau', 'Gamma', 'Rho', 'Theta',
    'Associate Tau', 'Associate Gamma', 'Associate Iota', 'Associate Rho',
    'Pi', 'Delta', 'Associate Delta', 'Psi', 'Upsilon', "Gamma's Theta",
    'Phi', 'Omicron', 'Mu',
  ];
}

module.exports = {
  getCustomButtons,
  getButtonsForDisplay,
  saveCustomButton,
  saveBulkButtons,
  updateCustomButton,
  deleteCustomButton,
  getButtonsForManager,
  getAllOfficerPositions,
  fetchHtmlFromGCS,
};
