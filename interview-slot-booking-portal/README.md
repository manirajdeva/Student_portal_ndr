# Interview Slot Booking Portal
Google Apps Script + Google Sheets backend, HTML/CSS/JS frontend.

## What's in this folder

**Backend (Apps Script)**
- `Code.gs` — config, routing (`doGet`), sheet bootstrap, shared date/utility helpers
- `Auth.gs` — login, session (CacheService-based), password hashing
- `Booking.gs` — slot generation, availability, booking/cancel/reschedule, race-safe with `LockService`
- `Admin.gs` — dashboard stats, student CRUD, booking search/edit, holiday blocking
- `appsscript.json` — web app manifest (timezone defaults to `Asia/Kolkata` — change if needed)

**Frontend (Apps Script HTML files)**
- `login.html`, `admin.html`, `student.html` — full pages
- `dashboard.html`, `booking.html` — partials included into admin/student pages
- `style.html`, `script.html` — **these are the files to actually import into Apps Script.** Apps Script only supports `.gs` and `.html` file types, so the shared CSS/JS are wrapped in `<style>`/`<script>` tags.
- `style.css`, `script.js` — the same CSS/JS in plain form, kept for readability/editing outside the Apps Script editor. Whenever you edit these, re-wrap them into `style.html` / `script.html` before pasting into Apps Script (or just edit `style.html`/`script.html` directly).

## Google Sheet schema

Create one Google Sheet (any name) — the script creates these tabs automatically on first load, but here's the structure for reference:

**Users**: Username, PasswordHash, Role, FullName, Email, Status, CreatedOn
**Slots**: SlotID, Date, Time, Status, UpdatedOn
**Bookings**: Booking ID, Username, Student Name, Company Name, Interview Level, Interview Date, Time Slot, Interview Mode, Notes, Status, Booked On

`Status` values — Users: `Active` / `Inactive`. Slots: `Available` / `Booked` / `Blocked`. Bookings: `Confirmed` / `Cancelled`.

## Deployment steps

1. Create a new Google Sheet. Extensions → Apps Script.
2. Delete the default `Code.gs` content, then create/paste each file above into the editor:
   - `Code.gs`, `Auth.gs`, `Booking.gs`, `Admin.gs` as **Script** files.
   - `login.html`, `admin.html`, `student.html`, `dashboard.html`, `booking.html`, `style.html`, `script.html` as **HTML** files (name them exactly as listed, without the `.html` extension in the "Create file" dialog — Apps Script adds it automatically).
3. Open `appsscript.json` via **Project Settings → Show "appsscript.json" manifest file**, and replace its contents with the one provided here (sets the web app to run as the deploying user and be accessible to anyone with the link — adjust `access` if you want to restrict it to your organization).
4. In the Apps Script editor, select the `setupInitialAdmin` function from the function dropdown and click **Run** once. Pass your own values, e.g. from the editor's execution log or by temporarily editing the call — the simplest way is to open the built-in **Execution** panel, or just run it with arguments by temporarily calling it from another test function:
   ```js
   function bootstrapAdmin() {
     setupInitialAdmin('admin', 'YourStrongPassword!', 'Portal Admin');
   }
   ```
   Run `bootstrapAdmin`, then delete it (or leave it — it will throw if the username already exists, so it's safe to leave).
5. **Deploy → New deployment → Web app.** Execute as "Me", access "Anyone" (or "Anyone within [organization]"). Copy the deployed URL.
6. Visit the URL, log in with the admin account you just created.

## How sessions work

There's no traditional server session/cookie in Apps Script's sandboxed HTML. Instead:
- `login()` validates the password and returns a random token, stored server-side in `CacheService` (6 hour expiry) mapped to `{username, role, fullName}`.
- The client stores that token in `localStorage` and passes it as a parameter on every `google.script.run` call, and echoes it in the URL (`?token=...`) so a full page reload still routes to the right role via `doGet`.
- `logout()` just removes the cache entry.

This is intentionally lightweight for an internal tool — it is **not** equivalent to a hardened auth system. Passwords are SHA-256 hashed with a per-deployment random salt (stored in Script Properties), not stored in plain text, but there's no rate limiting, password reset flow, or MFA.

## Business rules implemented

- Slots are generated 7:00 AM–10:00 PM in 30-minute steps for any requested date (either explicitly via the admin's "Generate Slots" tab, or lazily the first time a student opens that date).
- Booking a slot is wrapped in `LockService.getScriptLock()` so two students can't win a race on the same slot — the second request is rejected with a clear error once the lock is released and the slot is re-checked.
- Past dates/times are always rejected server-side, regardless of what the client sends.
- `CONFIG.ONE_ACTIVE_BOOKING_PER_STUDENT` (in `Code.gs`) toggles whether a student can hold more than one upcoming confirmed booking at a time. Defaults to `true`.
- Blocking a holiday marks every *unbooked* slot on that date as `Blocked`; already-booked slots are left alone and reported back to the admin so they can be handled manually.

## Notes / things you may want to extend

- Editing a booking's date/time from the admin side currently isn't wired up (only student/company/level/mode/notes) — reuse the reschedule logic in `Booking.gs` if you want admins to move a booking to a new slot directly.
- There's no email/notification step on booking — add a `MailApp.sendEmail(...)` call in `bookSlot()` if you want confirmation emails.
- The calendar only colors a date green/red/grey at a glance (available / fully booked / blocked-or-past) — click a date to see the actual slot grid.
