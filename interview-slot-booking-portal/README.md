# Interview Slot Booking Portal

Google Apps Script + Google Sheets **backend** (pure JSON API), plain static HTML/CSS/JS **frontend** hosted separately (e.g. GitHub Pages). Split into two pieces on purpose — see "Why two pieces?" below.

## Architecture

```
docs/                              ← static frontend (deploy to GitHub Pages, free)
  login.html, admin.html, student.html
  style.css, script.js             ← script.js calls the Apps Script URL via fetch()

interview-slot-booking-portal/     ← Apps Script backend (push via clasp)
  Code.gs    — config, JSON API router (doPost), sheet bootstrap, date/time utilities
  Auth.gs    — login, session (CacheService-based), password hashing, whoAmI
  Booking.gs — slot generation, availability, booking/cancel/reschedule, race-safe with LockService
  Admin.gs   — dashboard stats, student CRUD, booking search/edit/cancel, holiday blocking
  appsscript.json — web app manifest
```

## Why two pieces?

Apps Script's `HtmlService` (serving HTML directly from Apps Script, with `google.script.run` for calls) renders every page inside a cross-origin **sandboxed iframe**. iOS Safari's Intelligent Tracking Prevention blocks storage/postMessage access inside that sandbox, which broke login outright (`SecurityError: The operation is insecure.`) — not fixable from application code, since the sandboxing is imposed by the platform itself.

The fix: host the frontend as an ordinary static site (no iframe, no `google.script.run`) and have it call Apps Script purely as a JSON backend over `fetch()`. This works identically on every browser, including iOS Safari, and is still 100% free.

## Google Sheet schema

Create one Google Sheet (any name) — the script creates these tabs automatically on first load, but here's the structure for reference:

**Users**: Username, PasswordHash, Role, FullName, Email, Status, CreatedOn
**Slots**: SlotID, Date, Time, Status, UpdatedOn
**Bookings**: Booking ID, Username, Student Name, Company Name, Interview Level, Interview Date, Time Slot, Interview Mode, Notes, Status, Booked On

`Status` values — Users: `Active` / `Inactive`. Slots: `Available` / `Booked` / `Blocked`. Bookings: `Confirmed` / `Cancelled`.

## The JSON API

`Code.gs` exposes a single endpoint, `doPost`, which dispatches by name against an explicit whitelist (`API_FUNCTIONS`) — nothing is callable that isn't listed there. Request/response shape:

```
POST https://script.google.com/macros/s/AKfycb.../exec
Body: {"fn": "login", "args": ["username", "password"]}
→ {"result": {...}}        on success
→ {"error": "message"}     on failure
```

The body is sent as `text/plain` (fetch's default for a string body) rather than `application/json` **on purpose** — a JSON `Content-Type` triggers a CORS preflight (`OPTIONS`) request, which Apps Script web apps cannot answer. `text/plain` keeps it a "simple request" per the CORS spec, so the browser skips preflight entirely, while `doPost()` still parses the body as JSON regardless of the declared header. See `docs/script.js`'s `api()` function.

`doGet` is just a health check (visiting the URL in a browser shows `{"status":"ok",...}`) — it's not used by the frontend.

## Backend deployment (Apps Script, via clasp)

No manual copy-pasting — push directly from this folder with [clasp](https://github.com/google/clasp), Google's official CLI (free).

**One-time setup:**
1. `npm install -g @google/clasp`
2. Enable the Apps Script API at [script.google.com/home/usersettings](https://script.google.com/home/usersettings) (toggle ON).
3. `clasp login` (opens a browser to sign in).
4. Create a Google Sheet → Extensions → Apps Script → ⚙️ Project Settings → copy the **Script ID**.
5. In this folder, create `.clasp.json` (gitignored — machine-specific):
   ```json
   { "scriptId": "YOUR_SCRIPT_ID", "rootDir": "." }
   ```

**Every time you change the backend:**
```
cd interview-slot-booking-portal
clasp push --force
clasp deploy -i YOUR_DEPLOYMENT_ID -d "describe the change"
```
`clasp deployments` lists existing deployment IDs — always deploy to the same one so your API URL never changes. The first time only, create the deployment via **Deploy → New deployment → Web app** in the Apps Script editor (execute as "Me", access "Anyone"), then use its ID for every subsequent `clasp deploy -i`.

**Create the first admin account** (one-time, from the Apps Script editor — not exposed over the API for security): select `setupInitialAdmin` in the function dropdown and click **Run** (uses defaults `admin` / `ChangeMe123!` if called with no arguments), or temporarily add and run:
```js
function bootstrapAdmin() {
  setupInitialAdmin('admin', 'YourStrongPassword!', 'Portal Admin');
}
```

## Frontend deployment (GitHub Pages)

1. In `docs/script.js`, set `API_URL` to your deployed Apps Script `/exec` URL (from the deploy step above).
2. Commit and push `docs/` to GitHub.
3. GitHub repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: `/docs` → Save.
4. GitHub gives you a URL like `https://yourusername.github.io/reponame/login.html` — that's the live site.

To update the frontend afterward: edit files in `docs/`, commit, push — GitHub Pages redeploys automatically in under a minute.

## How sessions work

- `login()` validates the password and returns a random token, stored server-side in `CacheService` (6 hour expiry) mapped to `{username, role, fullName}`.
- The client stores that token in `localStorage` (see `Session` in `docs/script.js`) — safe here since the frontend is a normal top-level site, not inside Apps Script's sandboxed iframe.
- Every admin/student page calls `whoAmI(token)` on load to confirm the session is still valid and fetch the current user's display name; an invalid/expired token redirects to `login.html`.
- `logout()` removes the cache entry and clears local storage.

This is intentionally lightweight for an internal tool — it is **not** equivalent to a hardened auth system. Passwords are SHA-256 hashed with a per-deployment random salt (stored in Script Properties), not stored in plain text, but there's no rate limiting, password reset flow, or MFA.

## Business rules implemented

- Slots are generated 7:00 AM–10:00 PM in 30-minute steps for any requested date (either explicitly via the admin's "Generate Slots" tab, or lazily the first time a student opens that date).
- Booking a slot is wrapped in `LockService.getScriptLock()` so two students can't win a race on the same slot — the second request is rejected with a clear error once the lock is released and the slot is re-checked.
- Past dates/times are always rejected server-side, regardless of what the client sends.
- `CONFIG.ONE_ACTIVE_BOOKING_PER_STUDENT` (in `Code.gs`) toggles whether a student can hold more than one upcoming confirmed booking at a time. Currently `false` (students may hold multiple).
- Blocking a holiday marks every *unbooked* slot on that date as `Blocked`; already-booked slots are left alone and reported back to the admin so they can be handled manually.
- Every booking, cancel and reschedule action is timestamped (`Booked On` on create; `UpdatedOn` on the affected slot row).
- Date/Time-like Sheet columns are forced to plain-text format and defensively re-normalized on every read (`normalizeDateCell` in `Code.gs`) — Google Sheets otherwise auto-converts strings like `"2026-07-28"` into real Date values, which silently breaks every string-equality check in this codebase.

## Customizing

All the knobs called out in the spec live in `Code.gs`'s `CONFIG` object:
- `SLOT_START_HOUR` / `SLOT_END_HOUR` / `SLOT_INTERVAL_MIN` — slot generation window and granularity.
- `ONE_ACTIVE_BOOKING_PER_STUDENT` — enable/disable the one-active-booking rule.
- `APP_TITLE` — used in the health-check response.

Interview levels and modes are plain `<option>` lists in `docs/student.html`'s booking form — edit them there.

## Notes / things you may want to extend

- There's no email/notification step on booking — add a `MailApp.sendEmail(...)` call in `bookSlot()` (Booking.gs) if you want confirmation emails.
- Admin editing a booking's date/time isn't wired up (only student/company/level/mode/notes) — reuse the reschedule logic in `Booking.gs` if you want admins to move a booking to a new slot directly.
- The calendar only colors a date green/red/grey at a glance (available / fully booked / blocked-or-past) — click a date to see the actual slot grid.