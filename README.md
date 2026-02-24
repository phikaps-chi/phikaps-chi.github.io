# PKS Internal — Phi Kappa Sigma Alpha Mu Chapter

Internal web application for the Alpha Mu chapter of Phi Kappa Sigma at MIT. Manages member rosters, rush events, ranked-choice voting, custom dashboard buttons, and administrative functions.

## Architecture

The app has two layers:

- **Frontend shell** (`app.html`) — static HTML hosted on GitHub Pages. Handles Google Sign-In and loads the backend inside an iframe.
- **Backend** (`backend/`) — Node.js/Express server hosted on Render. Authenticates users, reads/writes Google Sheets, manages GCS file uploads, and serves EJS-rendered pages.

```
User → app.html (GitHub Pages)
         │
         │ Google Sign-In → ID token
         │
         └─► iframe → Express backend (Render)
                         │
                         ├─► Google Sheets (data store)
                         ├─► Google Cloud Storage (images, button HTML)
                         └─► SSE push (real-time updates)
```

### Auth Flow

1. User visits `https://phikaps-chi.github.io/app.html`
2. `app.html` triggers Google Sign-In (GSI), gets an ID token
3. The iframe loads `https://phikaps-chi-github-io.onrender.com?id_token=<token>`
4. The backend validates the token, checks the user exists in the Sigma sheet, creates a session
5. The backend renders `home.ejs` and injects an `AUTH_SUCCESS` postMessage with a session ID
6. `app.html` receives the message, stores the session, and shows the iframe
7. Subsequent page loads use the session ID instead of re-authenticating

## Project Structure

```
├── app.html                  # Entry point — Google Sign-In + iframe shell
├── index.html                # GitHub Pages landing/redirect
├── manifest.json             # PWA manifest
├── service-worker.js         # PWA service worker
├── render.yaml               # Render deployment blueprint
├── PKS Internal.json         # Original Apps Script source (reference only)
│
└── backend/
    ├── server.js             # Express app, SSE, middleware, startup
    ├── config.js             # Environment-aware configuration
    ├── package.json
    │
    ├── auth.js               # ID token validation, session management
    ├── sheets.js             # Google Sheets API wrapper with caching
    ├── gcs.js                # Google Cloud Storage operations
    ├── sigma.js              # Member data: roster, bylaws, welcome message
    ├── buttons.js            # Custom button CRUD + GCS HTML storage
    ├── roster.js             # Roster management with mutex locking
    ├── rush.js               # Rush events, recruits, comments, admin settings
    ├── polls.js              # Ranked-choice voting system
    ├── admin.js              # Admin dashboard: brothers CRUD, audit log, cache
    │
    ├── routes/
    │   ├── index.js          # GET /  — auth + home page (mirrors doGet)
    │   ├── api.js            # /api  — home data, button order, dev password
    │   ├── roster.js         # /api/roster  — save roster changes
    │   ├── buttons.js        # /api/buttons — button CRUD
    │   ├── rush.js           # /api/rush    — events, recruits, comments
    │   ├── admin.js          # /api/admin   — brothers, audit, system
    │   ├── polls.js          # /api/polls   — ranked-choice poll CRUD
    │   └── views.js          # /api/views   — rendered HTML sub-pages
    │
    └── views/
        ├── home.ejs              # Main application shell
        ├── records.ejs           # Chapter records
        ├── accessdenied.ejs      # Unauthorized access page
        ├── rostermanagement.ejs  # Roster editor
        ├── buttonmanager.ejs     # Custom button manager
        ├── rusharchives.ejs      # Rush event archives
        ├── rushpage.ejs          # Live rush page (recruits, comments, tiers)
        ├── rankChoice.ejs        # Ranked-choice voting
        └── admindashboard.ejs    # Admin panel
```

## API Reference

All `/api` routes require authentication (ID token or session ID). Rate-limited to 120 requests/minute.

### Core (`/api`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/home-data` | Home page data: nav cards, custom buttons, welcome message |
| POST | `/api/verify-dev-password` | Verify developer mode password |
| POST | `/api/save-button-order` | Save user's custom button ordering |
| POST | `/api/load-button-order` | Load user's saved button order |

### Roster (`/api/roster`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/roster/save` | Batch save roster changes (add/update/remove) |

### Buttons (`/api/buttons`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/buttons/manager` | Get all buttons for the manager UI |
| GET | `/api/buttons/brothers` | List of brothers (for access rules) |
| GET | `/api/buttons/positions` | All officer positions |
| POST | `/api/buttons/save` | Create a new button |
| POST | `/api/buttons/bulk-save` | Bulk import buttons |
| PUT | `/api/buttons/update` | Update an existing button |
| DELETE | `/api/buttons/:id` | Delete a button |
| POST | `/api/buttons/fetch-html` | Fetch GCS-hosted button HTML |

### Rush (`/api/rush`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rush/events` | List all rush events |
| POST | `/api/rush/events` | Create a new rush event |
| DELETE | `/api/rush/events/:id` | Delete a rush event |
| POST | `/api/rush/events/:id/lock` | Toggle rush event lock |
| GET | `/api/rush/events/:id/engagement` | Calculate rush engagement stats |
| GET | `/api/rush/page/:rushId/details` | Rush page metadata and tab info |
| GET | `/api/rush/page/:rushId/recruits` | All recruits for a rush event |
| GET | `/api/rush/page/:rushId/comments` | All comments for a rush event |
| POST | `/api/rush/recruits/save` | Add or update a recruit (with photo upload) |
| DELETE | `/api/rush/recruits/:tabId/:recruitId` | Delete a recruit |
| POST | `/api/rush/recruits/tier` | Update a recruit's tier |
| POST | `/api/rush/recruits/like` | Toggle like on a recruit |
| POST | `/api/rush/recruits/dislike` | Toggle dislike on a recruit |
| POST | `/api/rush/recruits/met` | Toggle "met" on a recruit |
| POST | `/api/rush/comments/save` | Add or update a comment |
| POST | `/api/rush/comments/delete` | Delete a comment |
| GET | `/api/rush/admin-settings` | Get rush admin settings |
| POST | `/api/rush/admin-settings/global` | Set a global rush setting |
| POST | `/api/rush/admin-settings/brother` | Set per-brother rush settings |
| GET | `/api/rush/brothers` | List brothers (for admin dropdown) |

### Polls (`/api/polls`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/polls` | List all active ranked-choice polls |
| POST | `/api/polls` | Create a new poll |
| POST | `/api/polls/:id/vote` | Submit a ranked-choice vote |
| POST | `/api/polls/:id/close` | Close a poll |
| DELETE | `/api/polls/:id` | Delete a poll |
| POST | `/api/polls/:id/reset` | Reset all votes on a poll |

### Admin (`/api/admin`)

Restricted to users with the `Chi` position.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/brothers` | List all brothers |
| POST | `/api/admin/brothers` | Add a brother |
| DELETE | `/api/admin/brothers/:email` | Remove a brother |
| POST | `/api/admin/deactivate-alumni` | Deactivate alumni accounts |
| POST | `/api/admin/announcement` | Send a global announcement |
| GET | `/api/admin/stats` | System statistics |
| GET | `/api/admin/export-brothers` | Export brothers as CSV |
| GET | `/api/admin/audit-log` | View audit log |
| GET | `/api/admin/export-audit-log` | Export audit log |
| POST | `/api/admin/force-logout` | Force logout all users |
| POST | `/api/admin/reset-passwords` | Reset passwords (stub) |
| POST | `/api/admin/clear-cache` | Clear all server caches |

### Views (`/api/views`)

These return rendered HTML fragments loaded into the home page shell via `fetch()`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/views/records` | Chapter records page |
| GET | `/api/views/accessdenied` | Access denied page |
| GET | `/api/views/rostermanagement` | Roster management page |
| GET | `/api/views/buttonmanager` | Button manager page |
| GET | `/api/views/rusharchives` | Rush event archives page |
| GET | `/api/views/admindashboard` | Admin dashboard page |
| GET | `/api/views/rankchoice` | Ranked-choice voting page |
| GET | `/api/views/rushpage` | Live rush page |

### Infrastructure

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check — returns `{"status":"ok"}` |
| GET | `/sse` | Server-Sent Events stream for real-time updates |
| GET | `/rush-update` | Trigger SSE refresh broadcast |
| GET | `/roster-update` | Trigger SSE roster update broadcast |

## Data Storage

### Google Sheets

Two spreadsheets serve as the database:

**Main spreadsheet** (`SPREADSHEET_ID`):
- **Sigma** — member roster (email, name, position, status)
- **Theta** — bylaws, meeting minutes, resources, welcome message
- **CustomButtons** — custom dashboard button definitions
- **RankedChoicePolls** — poll data (auto-created if missing)

**Rush spreadsheet** (`RUSH_SPREADSHEET_ID`):
- **RushEvents** — rush event metadata
- Per-event tabs for recruits and comments (created dynamically)

### Google Cloud Storage

Two buckets:
- `rush-images-pks-alphamu` — recruit profile photos
- `button-htmls-pksalphamu` — custom button HTML content

### Server-Side Caching (`node-cache`)

| Cache | TTL | Purpose |
|-------|-----|---------|
| Sheet data | 60s | Avoids redundant Sheets API reads |
| User sessions | 1 hour | Authenticated session tokens |
| Email validation | 1 hour | Whether an email exists in the Sigma sheet |
| Audit log | In-memory | Admin action log (lost on restart) |
| Rush admin settings | In-memory | Per-brother rush visibility settings (lost on restart) |

## Local Development

### Prerequisites

- Node.js v18+
- A Google Cloud service account key with access to Google Sheets API and Cloud Storage
- The service account's email must be added as an Editor on both Google Sheets

### Setup

```bash
# Install dependencies
cd backend
npm install

# Add your service account key
cp /path/to/your-key.json backend/service-account.json

# Start the dev server (auto-restarts on file changes)
npm run dev
```

The server starts at `http://localhost:3000`. For full auth flow testing, you'll need to load it through `app.html` (update the `WEB_APP` constant temporarily to `http://localhost:3000`).

### Environment Variables

All optional for local development (defaults are provided in `config.js`):

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: `3000`) |
| `NODE_ENV` | Set to `production` on Render |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Raw JSON string of service account key (production) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account key file (alternative) |
| `SPREADSHEET_ID` | Main Google Sheet ID |
| `RUSH_SPREADSHEET_ID` | Rush Google Sheet ID |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |

## Deployment

Hosted on [Render](https://render.com) as a single web service.

### Render Configuration

- **Build command**: `cd backend && npm install`
- **Start command**: `cd backend && node server.js`
- **Plan**: Free

### Required Render Environment Variables

Set these in the Render dashboard under **Environment**:

- `NODE_ENV` = `production`
- `GOOGLE_SERVICE_ACCOUNT_JSON` = *(paste full JSON content of service account key)*
- `SPREADSHEET_ID` = your main spreadsheet ID
- `RUSH_SPREADSHEET_ID` = your rush spreadsheet ID
- `GOOGLE_CLIENT_ID` = your Google OAuth client ID

### Deploying

1. Push to the `main` branch on GitHub
2. Render auto-deploys (or use **Manual Deploy** in the dashboard)
3. Verify: `https://phikaps-chi-github-io.onrender.com/health`

### Production Security

- **Rate limiting**: 120 requests/minute on all `/api` routes
- **CORS**: Restricted to `phikaps-chi.github.io` and the Render domain
- **Trust proxy**: Enabled for correct client IP detection behind Render's load balancer
- **Graceful shutdown**: Closes SSE connections on SIGTERM/SIGINT

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | Web framework |
| `ejs` | Server-side HTML templates |
| `googleapis` | Google Sheets API and Cloud Storage |
| `node-cache` | In-memory caching (sessions, sheet data) |
| `cors` | Cross-origin resource sharing |
| `express-rate-limit` | API rate limiting |
| `async-mutex` | Concurrency control for sheet writes |
