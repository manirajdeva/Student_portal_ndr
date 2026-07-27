# Interview Slot Booking Portal

A live student interview slot booking system for NDR EdTech, running at **[ndrstudent.in](https://ndrstudent.in)**.

Architecture: a static frontend (hosted on GitHub Pages) that talks to a Google Apps Script backend as a JSON API, with Google Sheets as the datastore.

## Architecture

- **Frontend** — `docs/` — plain HTML/CSS/JS, hosted directly by GitHub Pages (`main` branch, `/docs` folder), served over the custom domain `ndrstudent.in` with HTTPS enforced.
- **Backend** — `interview-slot-booking-portal/` — a Google Apps Script project deployed as a Web App. It's a pure JSON API: `doPost(e)` reads `{fn, args}` from the request body and dispatches to a whitelisted function in `API_FUNCTIONS`. There is no server-rendered HTML — the Apps Script HtmlService UI was retired in favor of the static frontend because it broke logins under Safari's Intelligent Tracking Prevention.
- **Data** — a single Google Sheet with `Users`, `Slots`, and `Bookings` tabs (auto-created on first run by `initSheets()`).

The frontend calls the API with `fetch()` using a `text/plain` request body (not `application/json`) specifically to avoid a CORS preflight, since Apps Script web apps can't respond to `OPTIONS` requests.

## Frontend (`docs/`)

- `index.html` — redirects to `login.html`.
- `login.html` — sign-in page with a cosmetic Student/Admin toggle, show/hide password, and the Contact Us footer.
- `admin.html` — admin dashboard: Dashboard stats, Students (add/edit/deactivate/delete + Add Admin), Bookings (search/edit/cancel, sorted ascending by date+time), Holidays (block/unblock dates), Generate Slots.
- `student.html` — student portal: calendar + slot grid booking, My Bookings (view/cancel/reschedule). Multiple simultaneous bookings per student are allowed.
- `style.css`, `script.js` — shared styles and client logic (API calls, session handling, modals, calendar rendering). Mobile-responsive.
- `manifest.json`, `service-worker.js`, `icon-192.png`, `icon-512.png` — PWA support (installable/add-to-home-screen), also used as the base for the packaged Android app.
- `CNAME` — `ndrstudent.in`, for GitHub Pages custom domain.

## Backend (`interview-slot-booking-portal/`)

- `Code.gs` — `CONFIG`, `SCHEMA`, the `API_FUNCTIONS` whitelist, `doPost`/`doGet`, sheet helpers (including date-cell normalization — see note below).
- `Auth.gs` — login, session validation, logout, password hashing (SHA-256 + per-deployment salt).
- `Booking.gs` — slot generation, availability, booking/cancel/reschedule, race-safe via `LockService`.
- `Admin.gs` — dashboard stats, student CRUD, add-admin, booking search/edit, holiday blocking.
- `appsscript.json` — web app manifest (`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`).

### Deploying the backend

The backend is deployed with [`clasp`](https://github.com/google/clasp), not by copy-pasting into the Apps Script editor:

```bash
cd interview-slot-booking-portal
clasp push --force
clasp deploy -i <deploymentId> -d "description of this deploy"
```

`.clasp.json` (contains the script ID) and `.clasprc.json` are gitignored — you need your own `clasp login` and `.clasp.json` pointing at the target script. `.claspignore` restricts what gets pushed to just the `.gs` files and `appsscript.json`.

### Sessions

Sessions are stored server-side in `CacheService`, keyed by a random token returned from `login()`. `IDLE_TIMEOUT_SEC` (`Auth.gs`) is **120 seconds** and slides forward on every validated call — a logged-in user is only signed out after 2 minutes of no activity, not on a fixed schedule. The frontend keeps the token in `localStorage` and sends it with every API call.

### Google Sheet schema

- **Users**: `Username, PasswordHash, Role, FullName, Email, Status, CreatedOn` — `Role` is `Admin` or `Student`, `Status` is `Active`/`Inactive`.
- **Slots**: `SlotID, Date, Time, Status, UpdatedOn` — `Status` is `Available`/`Booked`/`Blocked`.
- **Bookings**: `Booking ID, Username, Student Name, Company Name, Interview Level, Interview Date, Time Slot, Interview Mode, Notes, Status, Booked On` — `Status` is `Confirmed`/`Cancelled`.

New admins can be added either through the **Add an admin** panel on the Students tab of the admin dashboard, or directly as a new row in the Users sheet — but a directly-added row needs `PasswordHash` computed the same way `Auth.gs` does (SHA-256 of `password + salt`), so use the dashboard form unless you're comfortable generating that hash by hand.

### Business rules

- Slots run 7:00 AM–10:00 PM in 30-minute steps (`SLOT_START_HOUR`/`SLOT_END_HOUR`/`SLOT_INTERVAL_MIN` in `Code.gs`), generated lazily per-date or in bulk via the admin's Generate Slots tab.
- `CONFIG.ONE_ACTIVE_BOOKING_PER_STUDENT` is `false` — students may hold multiple simultaneous upcoming bookings.
- Booking a slot is wrapped in `LockService.getScriptLock()` to prevent two students winning the same slot in a race.
- Past dates/times are always rejected server-side regardless of client input.
- Blocking a holiday marks every *unbooked* slot on that date as `Blocked`; already-booked slots are left alone and reported back to the admin.

### A note on dates

Google Sheets silently converts date/time-like strings (e.g. `"2026-07-28"`) into real `Date` objects, which breaks naive string comparisons. `Code.gs`'s `getSheet()` forces the relevant columns to plain-text format, and `normalizeDateCell()` is used everywhere a date is read back out, to keep comparisons string-safe.

## Android app

`android-twa/` (gitignored) holds a Bubblewrap-generated Trusted Web Activity project that wraps the PWA into an installable APK/AAB. It is not part of the deployed web app and needs its own signing keystore (kept outside the repo) to produce updates.

## Domain & hosting

- Custom domain `ndrstudent.in` (registered via BigRock) points at GitHub Pages via `A` records; HTTPS is provided by GitHub's automatic Let's Encrypt certificate and is enforced.
- Managed with the `gh` CLI, e.g. `gh api repos/<owner>/<repo>/pages` to check build/HTTPS/cert status.