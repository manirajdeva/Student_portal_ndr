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

/**
 * Combines the session check (normally a separate whoAmI call) with every
 * data fetch the admin dashboard needs on first load, into a single round
 * trip. Apps Script web apps have no persistent warm server — each
 * request pays its own startup cost — so collapsing 5 separate calls
 * (whoAmI + stats + students + bookings + blockedDates) into 1 is what
 * actually cuts the "login feels slow" wait, not just faster code.
 */
function adminBootstrap(token) {
  const session = requireRole(token, null);
  if (session.role !== 'Admin') {
    return { redirect: 'student.html' };
  }
  return {
    session: session,
    stats: getDashboardStats(token),
    students: listStudents(token),
    bookings: listAllBookings(token),
    blockedDates: listBlockedDates(token)
  };
}

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

  const bookingCounts = getBookingCountMap();
  const availableSlots = slots.filter((s) =>
    s.Date >= today && s.Status !== 'Blocked' && !isPastDateTime(s.Date, s.Time) &&
    (bookingCounts[s.Date + '|' + s.Time] || 0) < CONFIG.MAX_BOOKINGS_PER_SLOT
  );

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

/**
 * Creates a new Admin account. Only reachable by an already-authenticated
 * admin (requireRole below), unlike the unauthenticated bootstrap function
 * setupInitialAdmin (Code.gs), which is deliberately kept off the public
 * API and only runnable from the Apps Script editor.
 */
function addAdmin(token, admin) {
  requireRole(token, 'Admin');
  const username = (admin.username || '').trim();
  const password = admin.password || '';
  const fullName = (admin.fullName || '').trim();

  if (!username || !password || !fullName) {
    throw new Error('Username, password and full name are required.');
  }

  const sheet = getSheet(CONFIG.SHEET_USERS);
  if (findRowIndexByColumnValue(sheet, 'Username', username) !== -1) {
    throw new Error('That username is already taken.');
  }

  sheet.appendRow([username, hashPassword(password), 'Admin', fullName, admin.email || '', 'Active', nowString()]);
  return { success: true, message: 'Admin added.' };
}

/**
 * Resets any user's password, Admin or Student — there's no self-service
 * "forgot password" flow, and editStudent only touches Student rows, so
 * this is the only way to recover/rotate an Admin account's password.
 */
function resetPassword(token, username, newPassword) {
  requireRole(token, 'Admin');
  if (!newPassword || newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }
  const sheet = getSheet(CONFIG.SHEET_USERS);
  const row = findRowIndexByColumnValue(sheet, 'Username', username);
  if (row === -1) throw new Error('User not found.');
  updateRowByHeaders(sheet, row, SCHEMA.Users, { PasswordHash: hashPassword(newPassword) });
  return { success: true, message: 'Password updated for ' + username + '.' };
}

/**
 * Edits a student's full name / email, and optionally resets their
 * password (only when a non-empty new password is supplied).
 * Username and role are immutable via this endpoint.
 */
function editStudent(token, username, updates) {
  requireRole(token, 'Admin');
  updates = updates || {};
  const sheet = getSheet(CONFIG.SHEET_USERS);
  const row = findRowIndexByColumnValue(sheet, 'Username', username);
  if (row === -1) throw new Error('Student not found.');

  const fullName = (updates.fullName || '').trim();
  if (!fullName) throw new Error('Full name is required.');

  const patch = { FullName: fullName, Email: (updates.email || '').trim() };
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
    .sort((a, b) => (a['Interview Date'] + a['Time Slot']).localeCompare(b['Interview Date'] + b['Time Slot']))
    .map(stripRowMeta);
}

/**
 * Search/filter bookings by any combination of student name, company,
 * interview level, status, and/or exact date. All filters are optional
 * and case-insensitive substring matches (except date and status, which
 * are exact).
 */
function searchBookings(token, filters) {
  requireRole(token, 'Admin');
  filters = filters || {};
  const name = (filters.studentName || '').toLowerCase().trim();
  const company = (filters.companyName || '').toLowerCase().trim();
  const level = (filters.interviewLevel || '').toLowerCase().trim();
  const date = (filters.date || '').trim();
  const status = (filters.status || '').trim();

  return sheetToObjects(getSheet(CONFIG.SHEET_BOOKINGS))
    .filter((b) => {
      if (name && !String(b['Student Name']).toLowerCase().includes(name)) return false;
      if (company && !String(b['Company Name']).toLowerCase().includes(company)) return false;
      if (level && !String(b['Interview Level']).toLowerCase().includes(level)) return false;
      if (date && b['Interview Date'] !== date) return false;
      if (status && b.Status !== status) return false;
      return true;
    })
    .sort((a, b) => (a['Interview Date'] + a['Time Slot']).localeCompare(b['Interview Date'] + b['Time Slot']))
    .map(stripRowMeta);
}

function adminCancelBooking(token, bookingId) {
  requireRole(token, 'Admin');
  return cancelBookingInternal(bookingId, null, true);
}

/** Admin can edit any editable field on a booking (does not move the slot — use reschedule pattern for that). */
function adminEditBooking(token, bookingId, updates) {
  requireRole(token, 'Admin');
  updates = updates || {};
  const sheet = getSheet(CONFIG.SHEET_BOOKINGS);
  const row = findRowIndexByColumnValue(sheet, 'Booking ID', bookingId);
  if (row === -1) throw new Error('Booking not found.');

  const patch = {};
  if (updates.studentName !== undefined) patch['Student Name'] = updates.studentName;
  if (updates.companyName !== undefined) patch['Company Name'] = updates.companyName;
  if (updates.interviewLevel !== undefined) patch['Interview Level'] = updates.interviewLevel;
  if (updates.mode !== undefined) patch['Interview Mode'] = updates.mode;
  if (updates.notes !== undefined) patch['Notes'] = updates.notes;

  updateRowByHeaders(sheet, row, SCHEMA.Bookings, patch);
  return { success: true, message: 'Booking updated.' };
}

// ==================== HOLIDAYS / BLOCKED DATES ====================

/**
 * Blocks a date: ensures slots exist for it, then marks every slot as
 * Blocked (which stops any NEW booking regardless of how many bookings
 * it already has — see getBookingCountMap in Booking.gs, which derives
 * availability from the Bookings sheet, independent of Slots.Status).
 * Existing confirmed bookings on that date are left untouched and just
 * reported back, so the admin can decide whether to cancel them.
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

  let blockedCount = 0;
  for (let r = 1; r < values.length; r++) {
    if (normalizeDateCell(values[r][dateIdx], 'Slots', 'Date') !== dateStr) continue;
    if (values[r][statusIdx] === 'Blocked') continue;
    sheet.getRange(r + 1, statusIdx + 1).setValue('Blocked');
    sheet.getRange(r + 1, updatedIdx + 1).setValue(nowString());
    blockedCount++;
  }

  const existingBookings = sheetToObjects(getSheet(CONFIG.SHEET_BOOKINGS))
    .filter((b) => b.Status === 'Confirmed' && b['Interview Date'] === dateStr).length;

  return {
    success: true,
    message: 'Blocked ' + blockedCount + ' slot(s) on ' + dateStr +
      (existingBookings ? ('. Note: ' + existingBookings + ' existing confirmed booking(s) on that date were left untouched.') : '.')
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
    if (normalizeDateCell(values[r][dateIdx], 'Slots', 'Date') !== dateStr) continue;
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
