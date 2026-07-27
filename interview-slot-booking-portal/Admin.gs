/**
 * Admin.gs
 * ------------------------------------------------------------------
 * Everything gated to the Admin role: dashboard statistics, student
 * account management, viewing/searching/editing/cancelling any
 * booking, and blocking holidays / unavailable dates.
 * Every function starts with requireRole(token, 'Admin').
 * ------------------------------------------------------------------
 */

// ==================== DASHBOARD ====================

function getDashboardStats(token) {
  requireRole(token, 'Admin');

  const users = sheetToObjects(getSheet(CONFIG.SHEET_USERS));
  const bookings = sheetToObjects(getSheet(CONFIG.SHEET_BOOKINGS));
  const slots = sheetToObjects(getSheet(CONFIG.SHEET_SLOTS));
  const today = todayStr();

  const totalStudents = users.filter((u) => u.Role === 'Student').length;
  const activeStudents = users.filter((u) => u.Role === 'Student' && u.Status === 'Active').length;

  const confirmed = bookings.filter((b) => b.Status === 'Confirmed');
  const todaysBookings = confirmed.filter((b) => b['Interview Date'] === today);
  const upcoming = confirmed.filter((b) => b['Interview Date'] >= today)
    .sort((a, b) => (a['Interview Date'] + a['Time Slot']).localeCompare(b['Interview Date'] + b['Time Slot']));

  const availableSlots = slots.filter((s) => s.Date >= today && s.Status === 'Available' && !isPastDateTime(s.Date, s.Time));

  return {
    totalStudents: totalStudents,
    activeStudents: activeStudents,
    todaysBookingsCount: todaysBookings.length,
    upcomingCount: upcoming.length,
    availableSlotsCount: availableSlots.length,
    upcomingPreview: upcoming.slice(0, 8).map(stripRowMeta)
  };
}

// ==================== STUDENT MANAGEMENT ====================

function listStudents(token) {
  requireRole(token, 'Admin');
  return sheetToObjects(getSheet(CONFIG.SHEET_USERS))
    .filter((u) => u.Role === 'Student')
    .map(stripRowMeta);
}

function addStudent(token, student) {
  requireRole(token, 'Admin');
  const username = (student.username || '').trim();
  const password = student.password || '';
  const fullName = (student.fullName || '').trim();

  if (!username || !password || !fullName) {
    throw new Error('Username, password and full name are required.');
  }

  const sheet = getSheet(CONFIG.SHEET_USERS);
  if (findRowIndexByColumnValue(sheet, 'Username', username) !== -1) {
    throw new Error('That username is already taken.');
  }

  sheet.appendRow([username, hashPassword(password), 'Student', fullName, student.email || '', 'Active', nowString()]);
  return { success: true, message: 'Student added.' };
}

function editStudent(token, username, updates) {
  requireRole(token, 'Admin');
  const sheet = getSheet(CONFIG.SHEET_USERS);
  const row = findRowIndexByColumnValue(sheet, 'Username', username);
  if (row === -1) throw new Error('Student not found.');

  const patch = {};
  if (updates.fullName) patch.FullName = updates.fullName;
  if (updates.email !== undefined) patch.Email = updates.email;
  if (updates.password) patch.PasswordHash = hashPassword(updates.password);

  updateRowByHeaders(sheet, row, SCHEMA.Users, patch);
  return { success: true, message: 'Student updated.' };
}

function deleteStudent(token, username) {
  requireRole(token, 'Admin');
  const sheet = getSheet(CONFIG.SHEET_USERS);
  const row = findRowIndexByColumnValue(sheet, 'Username', username);
  if (row === -1) throw new Error('Student not found.');
  sheet.deleteRow(row);
  return { success: true, message: 'Student deleted.' };
}

function setStudentStatus(token, username, status) {
  requireRole(token, 'Admin');
  if (status !== 'Active' && status !== 'Inactive') throw new Error('Invalid status.');
  const sheet = getSheet(CONFIG.SHEET_USERS);
  const row = findRowIndexByColumnValue(sheet, 'Username', username);
  if (row === -1) throw new Error('Student not found.');
  updateRowByHeaders(sheet, row, SCHEMA.Users, { Status: status });
  return { success: true, message: 'Student is now ' + status + '.' };
}

// ==================== BOOKING MANAGEMENT ====================

function listAllBookings(token) {
  requireRole(token, 'Admin');
  return sheetToObjects(getSheet(CONFIG.SHEET_BOOKINGS))
    .sort((a, b) => (b['Interview Date'] + b['Time Slot']).localeCompare(a['Interview Date'] + a['Time Slot']))
    .map(stripRowMeta);
}

/**
 * Search/filter bookings by any combination of student name, company,
 * interview level, and/or exact date. All filters are optional and
 * case-insensitive substring matches (except date, which is exact).
 */
function searchBookings(token, filters) {
  requireRole(token, 'Admin');
  filters = filters || {};
  const name = (filters.studentName || '').toLowerCase().trim();
  const company = (filters.companyName || '').toLowerCase().trim();
  const level = (filters.interviewLevel || '').toLowerCase().trim();
  const date = (filters.date || '').trim();

  return sheetToObjects(getSheet(CONFIG.SHEET_BOOKINGS))
    .filter((b) => {
      if (name && !String(b['Student Name']).toLowerCase().includes(name)) return false;
      if (company && !String(b['Company Name']).toLowerCase().includes(company)) return false;
      if (level && !String(b['Interview Level']).toLowerCase().includes(level)) return false;
      if (date && b['Interview Date'] !== date) return false;
      return true;
    })
    .sort((a, b) => (b['Interview Date'] + b['Time Slot']).localeCompare(a['Interview Date'] + a['Time Slot']))
    .map(stripRowMeta);
}

function adminCancelBooking(token, bookingId) {
  requireRole(token, 'Admin');
  return cancelBookingInternal(bookingId, null, true);
}

/** Admin can edit any editable field on a booking (does not move the slot — use reschedule pattern for that). */
function adminEditBooking(token, bookingId, updates) {
  requireRole(token, 'Admin');
  const sheet = getSheet(CONFIG.SHEET_BOOKINGS);
  const row = findRowIndexByColumnValue(sheet, 'Booking ID', bookingId);
  if (row === -1) throw new Error('Booking not found.');

  const patch = {};
  ['Student Name', 'Company Name', 'Interview Level', 'Interview Mode', 'Notes'].forEach((field) => {
    const key = toCamel(field);
    if (updates[key] !== undefined) patch[field] = updates[key];
  });
  updateRowByHeaders(sheet, row, SCHEMA.Bookings, patch);
  return { success: true, message: 'Booking updated.' };
}

function toCamel(header) {
  const map = {
    'Student Name': 'studentName', 'Company Name': 'companyName', 'Interview Level': 'interviewLevel',
    'Interview Mode': 'mode', 'Notes': 'notes'
  };
  return map[header] || header;
}

// ==================== HOLIDAYS / BLOCKED DATES ====================

/**
 * Blocks a date: ensures slots exist for it, then marks every
 * non-booked slot as Blocked. Already-booked slots are left alone
 * (and reported back) so the admin can decide whether to cancel them.
 */
function blockDate(token, dateStr) {
  requireRole(token, 'Admin');
  if (!dateStr) throw new Error('A date is required.');
  ensureSlotsForDate(dateStr);

  const sheet = getSheet(CONFIG.SHEET_SLOTS);
  const values = sheet.getDataRange().getValues();
  const dateIdx = SCHEMA.Slots.indexOf('Date');
  const statusIdx = SCHEMA.Slots.indexOf('Status');
  const updatedIdx = SCHEMA.Slots.indexOf('UpdatedOn');

  let blockedCount = 0, alreadyBookedCount = 0;
  for (let r = 1; r < values.length; r++) {
    if (values[r][dateIdx] !== dateStr) continue;
    const status = values[r][statusIdx];
    if (status === 'Booked') {
      alreadyBookedCount++;
      continue;
    }
    sheet.getRange(r + 1, statusIdx + 1).setValue('Blocked');
    sheet.getRange(r + 1, updatedIdx + 1).setValue(nowString());
    blockedCount++;
  }

  return {
    success: true,
    message: 'Blocked ' + blockedCount + ' slot(s) on ' + dateStr +
      (alreadyBookedCount ? ('. Note: ' + alreadyBookedCount + ' slot(s) already booked were left untouched.') : '.')
  };
}

/** Reverts a previously blocked date back to Available (does not touch Booked slots). */
function unblockDate(token, dateStr) {
  requireRole(token, 'Admin');
  const sheet = getSheet(CONFIG.SHEET_SLOTS);
  const values = sheet.getDataRange().getValues();
  const dateIdx = SCHEMA.Slots.indexOf('Date');
  const statusIdx = SCHEMA.Slots.indexOf('Status');
  const updatedIdx = SCHEMA.Slots.indexOf('UpdatedOn');

  let count = 0;
  for (let r = 1; r < values.length; r++) {
    if (values[r][dateIdx] !== dateStr) continue;
    if (values[r][statusIdx] === 'Blocked') {
      sheet.getRange(r + 1, statusIdx + 1).setValue('Available');
      sheet.getRange(r + 1, updatedIdx + 1).setValue(nowString());
      count++;
    }
  }
  return { success: true, message: 'Unblocked ' + count + ' slot(s) on ' + dateStr + '.' };
}

/** Lists distinct dates that are fully (or partially) blocked, for the admin holiday manager UI. */
function listBlockedDates(token) {
  requireRole(token, 'Admin');
  const slots = sheetToObjects(getSheet(CONFIG.SHEET_SLOTS));
  const byDate = {};
  slots.forEach((s) => {
    byDate[s.Date] = byDate[s.Date] || { total: 0, blocked: 0 };
    byDate[s.Date].total++;
    if (s.Status === 'Blocked') byDate[s.Date].blocked++;
  });
  return Object.keys(byDate)
    .filter((d) => byDate[d].blocked > 0 && d >= todayStr())
    .sort()
    .map((d) => ({ date: d, blockedCount: byDate[d].blocked, totalCount: byDate[d].total }));
}
