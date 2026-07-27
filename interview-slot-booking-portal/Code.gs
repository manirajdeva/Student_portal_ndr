/**
 * Code.gs
 * ------------------------------------------------------------------
 * Entry point for the Interview Slot Booking Portal web app.
 * Handles routing (doGet), HTML templating includes, Google Sheet
 * bootstrap/schema management, and small shared utility helpers used
 * across Auth.gs, Booking.gs and Admin.gs.
 * ------------------------------------------------------------------
 */

// ==================== CONFIGURATION ====================
const CONFIG = {
  SHEET_USERS: 'Users',
  SHEET_SLOTS: 'Slots',
  SHEET_BOOKINGS: 'Bookings',

  SLOT_START_HOUR: 7,   // 7:00 AM
  SLOT_END_HOUR: 22,    // 10:00 PM
  SLOT_INTERVAL_MIN: 30,

  SESSION_DURATION_SEC: 6 * 60 * 60, // 6 hours, CacheService max is 6h
  ONE_ACTIVE_BOOKING_PER_STUDENT: true, // toggle the "one active booking" rule

  APP_TITLE: 'Interview Slot Booking Portal'
};

// Column headers for each sheet — order matters, code relies on it.
const SCHEMA = {
  Users: ['Username', 'PasswordHash', 'Role', 'FullName', 'Email', 'Status', 'CreatedOn'],
  Slots: ['SlotID', 'Date', 'Time', 'Status', 'UpdatedOn'],
  Bookings: [
    'Booking ID', 'Username', 'Student Name', 'Company Name', 'Interview Level',
    'Interview Date', 'Time Slot', 'Interview Mode', 'Notes', 'Status', 'Booked On'
  ]
};

// ==================== WEB APP ROUTING ====================

/**
 * Main entry point for all GET requests (page loads / navigation).
 * Routes to login / admin / student pages based on the session token.
 * Query params used:
 *   ?token=<sessionToken>   (optional — required to reach admin/student)
 */
function doGet(e) {
  initSheets(); // idempotent — creates sheets/headers if missing

  const params = (e && e.parameter) || {};
  const token = params.token || '';
  const session = token ? validateSession(token) : null;

  let templateName;
  if (!session) {
    templateName = 'login';
  } else if (session.role === 'Admin') {
    templateName = 'admin';
  } else {
    templateName = 'student';
  }

  const template = HtmlService.createTemplateFromFile(templateName);
  template.session = session;              // null if not logged in
  template.scriptUrl = getScriptUrl();      // base URL for client-side redirects

  return template.evaluate()
    .setTitle(CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used inside templates: <?!= include('style'); ?> etc. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Returns the deployed web app URL (used for client-side navigation). */
function getScriptUrl() {
  return ScriptApp.getService().getUrl();
}

// ==================== SHEET BOOTSTRAP ====================

/** Gets (or creates) a sheet with the correct header row. Idempotent. */
function getSheet(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  const headers = SCHEMA[sheetName];
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const hasHeaders = headers.every((h, i) => firstRow[i] === h);
  if (!hasHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#0F1626').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Ensures all three sheets exist with correct headers. Safe to call repeatedly. */
function initSheets() {
  getSheet(CONFIG.SHEET_USERS);
  getSheet(CONFIG.SHEET_SLOTS);
  getSheet(CONFIG.SHEET_BOOKINGS);
}

/**
 * One-time manual setup — run this from the Apps Script editor
 * (select function -> Run) ONCE after deployment to create the
 * first admin account. Not exposed to the web app for security.
 */
function setupInitialAdmin(username, password, fullName) {
  username = username || 'admin';
  password = password || 'ChangeMe123!';
  fullName = fullName || 'Portal Admin';

  const sheet = getSheet(CONFIG.SHEET_USERS);
  const existing = findRowIndexByColumnValue(sheet, 'Username', username);
  if (existing > -1) {
    throw new Error('A user with that username already exists.');
  }
  sheet.appendRow([username, hashPassword(password), 'Admin', fullName, '', 'Active', nowString()]);
  Logger.log('Admin account created: ' + username + ' / ' + password + ' (please change the password after first login if you add that feature, or recreate the user)');
  return { success: true, message: 'Admin account created for ' + username };
}

// ==================== GENERIC SHEET HELPERS ====================

/** Reads all data rows of a sheet as an array of plain objects keyed by header. */
function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = values.slice(1);
  return rows
    .map((row, idx) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      obj.__row = idx + 2; // 1-based sheet row number (accounting for header)
      return obj;
    })
    .filter((obj) => Object.keys(obj).some((k) => k !== '__row' && obj[k] !== '' && obj[k] !== null));
}

/** Returns the 1-based sheet row index for the first match of colName === value, or -1. */
function findRowIndexByColumnValue(sheet, colName, value) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const colIdx = headers.indexOf(colName);
  if (colIdx === -1) return -1;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][colIdx]) === String(value)) return r + 1;
  }
  return -1;
}

/** Updates specific columns (by header name) on a given 1-based row number. */
function updateRowByHeaders(sheet, rowNumber, headers, updates) {
  headers.forEach((h, i) => {
    if (Object.prototype.hasOwnProperty.call(updates, h)) {
      sheet.getRange(rowNumber, i + 1).setValue(updates[h]);
    }
  });
}

// ==================== DATE / TIME UTILITIES ====================

function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function nowString() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/** True if the given date/time (yyyy-MM-dd, HH:mm) is already in the past. */
function isPastDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const target = new Date(y, m - 1, d, hh, mm, 0);
  return target.getTime() < new Date().getTime();
}

function isPastDate(dateStr) {
  const today = todayStr();
  return dateStr < today;
}

/** Generates HH:mm strings from SLOT_START_HOUR to SLOT_END_HOUR at SLOT_INTERVAL_MIN steps. */
function generateTimeSlots() {
  const times = [];
  const startMin = CONFIG.SLOT_START_HOUR * 60;
  const endMin = CONFIG.SLOT_END_HOUR * 60;
  for (let t = startMin; t < endMin; t += CONFIG.SLOT_INTERVAL_MIN) {
    const hh = Math.floor(t / 60);
    const mm = t % 60;
    times.push(Utilities.formatString('%02d:%02d', hh, mm));
  }
  return times;
}

function generateBookingId() {
  return 'BK-' + Utilities.getUuid().split('-')[0].toUpperCase();
}

function generateSlotId(date, time) {
  return 'SLOT-' + date + '-' + time.replace(':', '');
}
