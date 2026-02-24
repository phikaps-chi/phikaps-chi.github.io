const { getAuthClient } = require('./sheets');
const config = require('./config');

const MIME_TYPE_MAP = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/**
 * Mirrors uploadFileWithDynamicName() from Utilities.gs.
 * Uploads a base64-encoded file to GCS, auto-detecting the MIME type.
 *
 * @param {string} bucketName
 * @param {string} baseFileName  File name without extension.
 * @param {string} base64Data    Full data-URL string (e.g. "data:image/png;base64,...")
 * @returns {string|null}        Public URL on success, null on failure.
 */
async function uploadFileWithDynamicName(bucketName, baseFileName, base64Data) {
  try {
    const authClient = await getAuthClient();
    const tokenRes = await authClient.getAccessToken();
    const token = tokenRes.token || tokenRes;

    let mimeType = 'application/octet-stream';
    let cleanBase64 = base64Data;
    const match = base64Data.match(/^data:(.*?);base64,/);

    if (match) {
      mimeType = match[1];
      cleanBase64 = base64Data.substring(match[0].length);
    } else {
      console.error('Could not determine MIME type from base64 string.');
      return null;
    }

    const extension = MIME_TYPE_MAP[mimeType] || '.bin';
    const finalFileName = baseFileName + extension;

    const bodyBuffer = Buffer.from(cleanBase64, 'base64');
    const uploadUrl =
      `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o` +
      `?uploadType=media&name=${encodeURIComponent(finalFileName)}`;

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': mimeType,
      },
      body: bodyBuffer,
    });

    if (res.ok) {
      console.log(`GCS upload success: ${finalFileName}`);
      return `https://storage.googleapis.com/${bucketName}/${encodeURIComponent(finalFileName)}`;
    }

    console.error('GCS upload error:', await res.text());
    return null;
  } catch (err) {
    console.error('GCS upload exception:', err.message);
    return null;
  }
}

/**
 * Mirrors uploadHtmlToGCS() from ButtonManager.gs.
 * Uploads an HTML string to GCS with cache-busting metadata.
 */
async function uploadHtmlToGCS(bucketName, fileName, htmlContent) {
  try {
    const authClient = await getAuthClient();
    const tokenRes = await authClient.getAccessToken();
    const token = tokenRes.token || tokenRes;

    const timestamp = Date.now();
    const boundary = 'pks_multipart_boundary';
    const metadata = JSON.stringify({
      name: fileName,
      contentType: 'text/html',
      cacheControl: 'no-cache, no-store, must-revalidate',
      metadata: { updated: String(timestamp) },
    });

    const body =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      metadata + '\r\n' +
      `--${boundary}\r\n` +
      'Content-Type: text/html\r\n\r\n' +
      htmlContent + '\r\n' +
      `--${boundary}--`;

    const uploadUrl =
      `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=multipart`;

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (res.ok) {
      console.log(`HTML upload success: ${fileName}`);
      return `https://storage.googleapis.com/${bucketName}/${encodeURIComponent(fileName)}?v=${timestamp}`;
    }

    console.error('HTML upload error:', await res.text());
    return null;
  } catch (err) {
    console.error('HTML upload exception:', err.message);
    return null;
  }
}

/**
 * Mirrors deleteFromGCS() in Utilities.gs.
 */
async function deleteFromGCS(bucketName, fileName) {
  try {
    const authClient = await getAuthClient();
    const tokenRes = await authClient.getAccessToken();
    const token = tokenRes.token || tokenRes;

    const deleteUrl =
      `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(fileName)}`;

    const res = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 204) {
      console.log(`GCS delete success: ${fileName}`);
      return true;
    }

    console.error('GCS delete error:', res.status, await res.text());
    return false;
  } catch (err) {
    console.error('GCS delete exception:', err.message);
    return false;
  }
}

/**
 * Fetch HTML content from a GCS URL.
 * Mirrors fetchHtmlFromGCS() in ButtonManager.gs.
 */
async function fetchHtmlFromGCS(gcsUrl) {
  try {
    const res = await fetch(gcsUrl);
    if (res.ok) return await res.text();
    console.error('GCS fetch error:', res.status);
    return null;
  } catch (err) {
    console.error('GCS fetch exception:', err.message);
    return null;
  }
}

module.exports = {
  uploadFileWithDynamicName,
  uploadHtmlToGCS,
  deleteFromGCS,
  fetchHtmlFromGCS,
};
