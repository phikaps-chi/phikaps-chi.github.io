const path = require('path');

const isDev = process.env.NODE_ENV !== 'production';

const config = {
  spreadsheetId: process.env.SPREADSHEET_ID || '1VbBlG81sdXFI3zyxZp-g_GQ1RwVH7ZHeKS6YIg6qZzg',
  rushSpreadsheetId: process.env.RUSH_SPREADSHEET_ID || '1vDvwUS9Feu4iQKnoFuz2_tj369_T-mreGS6DVnkPLFk',
  dieSpreadsheetId: process.env.DIE_SPREADSHEET_ID || '1do4lJRRvJSRx8qTW0NAMJTWJjM4u0-uVJP8K3D3oJis',
  clientId: process.env.GOOGLE_CLIENT_ID || '598065229000-t98hc486hi7aek8km359vho06i299828.apps.googleusercontent.com',

  port: process.env.PORT || 3000,
  isDev,

  productionUrl: 'https://phikaps-chi-github-io.onrender.com',

  allowedOrigins: isDev
    ? ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:8080', 'http://127.0.0.1:8080', 'https://phikaps-chi.github.io']
    : ['https://phikaps-chi.github.io', 'https://phikaps-chi-github-io.onrender.com'],

  cache: {
    sheetTTL: 60,              // seconds — mirrors Apps Script CacheService TTL for sheet data
    sessionTTL: 3600,          // 1 hour — matches SESSION_CACHE_EXPIRATION_SECONDS
    emailValidationTTL: 3600,  // 1 hour — matches isValidEmail cache
  },

  session: {
    keyPrefix: 'user_session_',
  },

  gcs: {
    rushImagesBucket: 'rush-images-pks-alphamu',
    buttonHtmlBucket: 'button-htmls-pksalphamu',
  },

  // Path to the GCP service account JSON key.
  // In production (Render), set GOOGLE_APPLICATION_CREDENTIALS env var
  // or GOOGLE_SERVICE_ACCOUNT_JSON with the raw JSON string.
  serviceAccountPath: process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(__dirname, 'service-account.json'),
};

module.exports = config;
