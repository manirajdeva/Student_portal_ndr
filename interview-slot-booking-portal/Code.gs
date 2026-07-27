/**
 * Code.gs
 * ------------------------------------------------------------------
 * Entry point for the Interview Slot Booking Portal web app.
 * Handles routing (doGet), HTML template includes, Google Sheet
 * bootstrap/schema management, and shared utility helpers used
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

  SESSION_DURATION_SEC: 6 * 60 * 60, // 6 hours — CacheService max is 6h
  ONE_ACTIVE_BOOKING_PER_STUDENT: false, // toggle the "one active booking" rule

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

/**
 * Columns whose values LOOK like dates/times to Google Sheets
 * ("2026-07-28", "07:30", "2026-07-28 14:33:02"). Sheets silently
 * auto-converts such strings into real Date values on write, which
 * breaks every strict string comparison in this file (e.g. checking
 * whether a slot's Date matches the date a student asked for).
 * getSheet() forces these columns to plain-text format so future
 * writes are stored verbatim, and normalizeDateCell() defensively
 * converts any value back to the expected string on read, so already
 * -written rows keep working even if they were auto-converted before
 * this fix existed.
 */
const DATE_TIME_COLUMNS = {
  Users: { CreatedOn: 'datetime' },
  Slots: { Date: 'date', Time: 'time', UpdatedOn: 'datetime' },
  Bookings: { 'Interview Date': 'date', 'Time Slot': 'time', 'Booked On': 'datetime' }
};

/** Converts value back to its canonical string form if Sheets stored it as a real Date. */
function normalizeDateCell(value, sheetName, header) {
  const kind = (DATE_TIME_COLUMNS[sheetName] || {})[header];
  if (!kind || !(value instanceof Date)) return value;
  const tz = Session.getScriptTimeZone();
  if (kind === 'date') return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  if (kind === 'time') return Utilities.formatDate(value, tz, 'HH:mm');
  return Utilities.formatDate(value, tz, 'yyyy-MM-dd HH:mm:ss');
}

/** Converts a 1-based column index (1, 2, 3...) to its A1 letter (A, B, C...). */
function columnToLetter(column) {
  let letter = '';
  while (column > 0) {
    const rem = (column - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    column = Math.floor((column - 1) / 26);
  }
  return letter;
}

// ==================== JSON API ====================
// The frontend is a plain static site (hosted outside Apps Script —
// see docs/) that talks to this project purely over fetch()+POST as
// a JSON API. This deliberately avoids HtmlService's sandboxed iframe
// and google.script.run entirely: both depend on storage/postMessage
// plumbing that Safari's Intelligent Tracking Prevention blocks
// inside that sandbox, which previously broke login on iOS.
//
// Every callable server function is explicitly whitelisted below —
// nothing is reachable from the client unless it's listed here.

const API_FUNCTIONS = {
  login: login,
  logout: logout,
  whoAmI: whoAmI,
  getAvailableSlots: getAvailableSlots,
  getCalendarSummary: getCalendarSummary,
  bookSlot: bookSlot,
  getMyBookings: getMyBookings,
  cancelMyBooking: cancelMyBooking,
  rescheduleMyBooking: rescheduleMyBooking,
  getDashboardStats: getDashboardStats,
  listStudents: listStudents,
  addStudent: addStudent,
  editStudent: editStudent,
  deleteStudent: deleteStudent,
  setStudentStatus: setStudentStatus,
  listAllBookings: listAllBookings,
  searchBookings: searchBookings,
  adminCancelBooking: adminCancelBooking,
  adminEditBooking: adminEditBooking,
  blockDate: blockDate,
  unblockDate: unblockDate,
  listBlockedDates: listBlockedDates,
  bulkGenerateSlots: bulkGenerateSlots
};

/**
 * Single JSON entry point for every client action.
 * Expects a POST body of {"fn": "functionName", "args": [...]}.
 * Sent as text/plain (not application/json) on purpose — a JSON
 * Content-Type would trigger a CORS preflight (OPTIONS) request,
 * which Apps Script web apps cannot answer. text/plain keeps it a
 * "simple request" per the CORS spec, so the browser skips preflight.
 */
function doPost(e) {
  initSheets(); // idempotent — creates sheets/headers if missing

  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOutput({ error: 'Invalid request body.' });
  }

  const fn = API_FUNCTIONS[body.fn];
  if (!fn) {
    return jsonOutput({ error: 'Unknown function: ' + body.fn });
  }

  try {
    const result = fn.apply(null, body.args || []);
    return jsonOutput({ result: result });
  } catch (err) {
    return jsonOutput({ error: err.message || String(err) });
  }
}

/** Simple health check — hitting the deployed URL directly in a browser shows this. */
function doGet(e) {
  initSheets();
  return jsonOutput({ status: 'ok', message: CONFIG.APP_TITLE + ' API is running.' });
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
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

  // Force date/time-look-alike columns to plain-text format so Sheets
  // never auto-converts future writes into real Date values (see
  // DATE_TIME_COLUMNS above).
  Object.keys(DATE_TIME_COLUMNS[sheetName] || {}).forEach((header) => {
    const colIdx = headers.indexOf(header) + 1;
    if (colIdx > 0) {
      const colLetter = columnToLetter(colIdx);
      sheet.getRange(colLetter + ':' + colLetter).setNumberFormat('@');
    }
  });

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
  Logger.log('Admin account created: ' + username);
  return { success: true, message: 'Admin account created for ' + username };
}

// ==================== GENERIC SHEET HELPERS ====================

/** Reads all data rows of a sheet as an array of plain objects keyed by header. */
function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = values.slice(1);
  const sheetName = sheet.getName();
  return rows
    .map((row, idx) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = normalizeDateCell(row[i], sheetName, h); });
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

function stripRowMeta(obj) {
  const copy = Object.assign({}, obj);
  delete copy.__row;
  return copy;
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
  return dateStr < todayStr();
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
