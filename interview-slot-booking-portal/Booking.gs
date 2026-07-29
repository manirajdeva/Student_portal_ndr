/**
 * Booking.gs
 * ------------------------------------------------------------------
 * Slot generation and the student-facing booking flow: viewing
 * availability, booking, cancelling and rescheduling — with
 * server-side validation to prevent double-booking and past-date
 * bookings, protected by LockService against race conditions.
 * ------------------------------------------------------------------
 */

/**
 * Ensures slot rows exist for a given date (7:00 AM - 10:00 PM, 30-min
 * steps). Safe to call repeatedly — never duplicates existing rows.
 * Only called from the admin's explicit "Generate Slots" action
 * (bulkGenerateSlots) — student-facing reads/bookings never call this,
 * so a date the admin hasn't generated slots for simply has none.
 */
function ensureSlotsForDate(dateStr) {
  const sheet = getSheet(CONFIG.SHEET_SLOTS);
  const existing = sheetToObjects(sheet).filter((s) => s.Date === dateStr);
  const existingTimes = new Set(existing.map((s) => s.Time));

  const times = generateTimeSlots();
  const rowsToAdd = [];
  times.forEach((t) => {
    if (!existingTimes.has(t)) {
      rowsToAdd.push([generateSlotId(dateStr, t), dateStr, t, 'Available', nowString()]);
    }
  });
  if (rowsToAdd.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, rowsToAdd[0].length).setValues(rowsToAdd);
  }
  return rowsToAdd.length;
}

/**
 * Admin action: bulk-generate slots across a date range (inclusive).
 */
function bulkGenerateSlots(token, startDate, endDate) {
  requireRole(token, 'Admin');
  if (!startDate || !endDate || startDate > endDate) {
    throw new Error('Please provide a valid date range.');
  }
  let created = 0;
  let cursor = startDate;
  let guard = 0;
  while (cursor <= endDate && guard < 366) { // safety cap: max 1 year
    created += ensureSlotsForDate(cursor);
    cursor = addDaysStr(cursor, 1);
    guard++;
  }
  return { success: true, message: created + ' new slot(s) created from ' + startDate + ' to ' + endDate + '.' };
}

/**
 * Counts CONFIRMED bookings per "date|time" key across the whole
 * Bookings sheet. Capacity (CONFIG.MAX_BOOKINGS_PER_SLOT) is enforced
 * against this count rather than a single Slots.Status flag, since up
 * to MAX_BOOKINGS_PER_SLOT students can now hold the same date+time.
 */
function getBookingCountMap() {
  const bookings = sheetToObjects(getSheet(CONFIG.SHEET_BOOKINGS));
  const counts = {};
  bookings.forEach((b) => {
    if (b.Status !== 'Confirmed') return;
    const key = b['Interview Date'] + '|' + b['Time Slot'];
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

/**
 * Returns the list of slots for a date. Slots only exist for a date once
 * the admin has explicitly generated them (Generate Slots tab / bulk
 * range) — this deliberately does NOT auto-create them just because a
 * student picked the date, so a date with no admin-generated slots
 * simply comes back empty ("No slots for this date.").
 * Each item: { time, status, bookedCount, capacity } where status is
 * Available/Booked(=full)/Blocked/Past, bookedCount is how many
 * confirmed bookings currently hold that date+time, and capacity is
 * CONFIG.MAX_BOOKINGS_PER_SLOT (how many bookings fit before it's full).
 */
function getAvailableSlots(token, dateStr) {
  requireRole(token, null); // any logged-in user (student or admin)
  if (!dateStr) throw new Error('A date is required.');

  const sheet = getSheet(CONFIG.SHEET_SLOTS);
  const bookingCounts = getBookingCountMap();
  const capacity = CONFIG.MAX_BOOKINGS_PER_SLOT;

  const slots = sheetToObjects(sheet)
    .filter((s) => s.Date === dateStr)
    .sort((a, b) => a.Time.localeCompare(b.Time))
    .map((s) => {
      const bookedCount = bookingCounts[s.Date + '|' + s.Time] || 0;
      let status;
      if (s.Status === 'Blocked') status = 'Blocked';
      else if (isPastDateTime(dateStr, s.Time)) status = 'Past';
      else if (bookedCount >= capacity) status = 'Booked';
      else status = 'Available';
      return { time: s.Time, status: status, bookedCount: bookedCount, capacity: capacity };
    });

  return { date: dateStr, slots: slots, isPast: isPastDate(dateStr) };
}

/**
 * Returns an available/full/blocked/past summary per date for a range,
 * used to color the calendar month view without loading every slot.
 */
function getCalendarSummary(token, startDate, endDate) {
  requireRole(token, null);
  const sheet = getSheet(CONFIG.SHEET_SLOTS);
  const bookingCounts = getBookingCountMap();
  const capacity = CONFIG.MAX_BOOKINGS_PER_SLOT;
  const all = sheetToObjects(sheet).filter((s) => s.Date >= startDate && s.Date <= endDate);
  const byDate = {};
  all.forEach((s) => {
    byDate[s.Date] = byDate[s.Date] || { available: 0, full: 0, blocked: 0, total: 0 };
    byDate[s.Date].total++;
    if (s.Status === 'Blocked') {
      byDate[s.Date].blocked++;
    } else if (!isPastDateTime(s.Date, s.Time)) {
      const bookedCount = bookingCounts[s.Date + '|' + s.Time] || 0;
      if (bookedCount >= capacity) byDate[s.Date].full++;
      else byDate[s.Date].available++;
    }
  });

  const summary = {};
  Object.keys(byDate).forEach((date) => {
    const d = byDate[date];
    let state;
    if (isPastDate(date)) state = 'past';
    else if (d.blocked === d.total) state = 'blocked';
    else if (d.available > 0) state = 'available';
    else state = 'full';
    summary[date] = state;
  });
  return summary;
}

/**
 * Books a slot for the logged-in student. Fully server-side validated:
 *  - session must be a Student
 *  - date/time must not be in the past
 *  - slot must not be Blocked, and must have fewer than
 *    CONFIG.MAX_BOOKINGS_PER_SLOT confirmed bookings already (re-checked
 *    inside a lock to prevent a race letting in one booking too many)
 *  - a student can't hold two bookings for the exact same date+time
 *  - optionally enforces one-active-booking-per-student
 */
function bookSlot(token, booking) {
  const session = requireRole(token, 'Student');

  const required = ['studentName', 'companyName', 'interviewLevel', 'date', 'time', 'mode'];
  required.forEach((f) => {
    if (!booking || !booking[f]) throw new Error('Missing required field: ' + f);
  });

  if (isPastDate(booking.date) || isPastDateTime(booking.date, booking.time)) {
    throw new Error('You cannot book a past date or time slot.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000); // wait up to 15s for exclusive access
  try {
    const slotSheet = getSheet(CONFIG.SHEET_SLOTS);
    const slotRow = findSlotRow(slotSheet, booking.date, booking.time);
    if (slotRow === -1) throw new Error('That slot no longer exists.');

    const slotValues = slotSheet.getRange(slotRow, 1, 1, SCHEMA.Slots.length).getValues()[0];
    const currentStatus = slotValues[SCHEMA.Slots.indexOf('Status')];
    if (currentStatus === 'Blocked') throw new Error('That date/time is blocked and not available for booking.');

    const bookingSheet = getSheet(CONFIG.SHEET_BOOKINGS);
    const confirmedForSlot = sheetToObjects(bookingSheet).filter(
      (b) => b.Status === 'Confirmed' && b['Interview Date'] === booking.date && b['Time Slot'] === booking.time
    );
    if (confirmedForSlot.length >= CONFIG.MAX_BOOKINGS_PER_SLOT) {
      throw new Error('Sorry — that slot is fully booked (max ' + CONFIG.MAX_BOOKINGS_PER_SLOT + '). Please choose another.');
    }
    if (confirmedForSlot.some((b) => b.Username === session.username)) {
      throw new Error('You already have a booking at that date and time.');
    }

    if (CONFIG.ONE_ACTIVE_BOOKING_PER_STUDENT) {
      const activeExisting = sheetToObjects(bookingSheet).find(
        (b) => b.Username === session.username && b.Status === 'Confirmed' && b['Interview Date'] >= todayStr()
      );
      if (activeExisting) {
        throw new Error('You already have an active upcoming booking (' + activeExisting['Interview Date'] + ' ' + activeExisting['Time Slot'] + '). Cancel or reschedule it first.');
      }
    }

    // Append booking record
    const bookingId = generateBookingId();
    bookingSheet.appendRow([
      bookingId,
      session.username,
      booking.studentName,
      booking.companyName,
      booking.interviewLevel,
      booking.date,
      booking.time,
      booking.mode,
      booking.notes || '',
      'Confirmed',
      nowString()
    ]);

    return {
      success: true,
      booking: {
        bookingId: bookingId, studentName: booking.studentName, companyName: booking.companyName,
        interviewLevel: booking.interviewLevel, date: booking.date, time: booking.time,
        mode: booking.mode, notes: booking.notes || '', status: 'Confirmed'
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function findSlotRow(slotSheet, date, time) {
  const values = slotSheet.getDataRange().getValues();
  const dateIdx = SCHEMA.Slots.indexOf('Date');
  const timeIdx = SCHEMA.Slots.indexOf('Time');
  for (let r = 1; r < values.length; r++) {
    const rowDate = normalizeDateCell(values[r][dateIdx], 'Slots', 'Date');
    const rowTime = normalizeDateCell(values[r][timeIdx], 'Slots', 'Time');
    if (rowDate === date && rowTime === time) return r + 1;
  }
  return -1;
}

/**
 * Combines the session check (normally a separate whoAmI call) with the
 * student page's initial data (their bookings + the current month's
 * calendar summary) into a single round trip — see adminBootstrap in
 * Admin.gs for why this matters on Apps Script specifically.
 */
function studentBootstrap(token, calStart, calEnd) {
  const session = requireRole(token, null);
  if (session.role !== 'Student') {
    return { redirect: 'admin.html' };
  }
  return {
    session: session,
    myBookings: getMyBookings(token),
    calendarSummary: getCalendarSummary(token, calStart, calEnd)
  };
}

/** Returns all bookings (past + upcoming) belonging to the logged-in student. */
function getMyBookings(token) {
  const session = requireRole(token, 'Student');
  const sheet = getSheet(CONFIG.SHEET_BOOKINGS);
  return sheetToObjects(sheet)
    .filter((b) => b.Username === session.username)
    .sort((a, b) => (b['Interview Date'] + b['Time Slot']).localeCompare(a['Interview Date'] + a['Time Slot']))
    .map(stripRowMeta);
}

/** Student cancels their own upcoming booking, freeing up a seat at that date+time. */
function cancelMyBooking(token, bookingId) {
  const session = requireRole(token, 'Student');
  return cancelBookingInternal(bookingId, session.username, false);
}

/**
 * Student reschedules: frees the old slot and books a new one,
 * keeping the same Booking ID and student-supplied details.
 */
function rescheduleMyBooking(token, bookingId, newDate, newTime) {
  const session = requireRole(token, 'Student');
  const bookingSheet = getSheet(CONFIG.SHEET_BOOKINGS);
  const row = findRowIndexByColumnValue(bookingSheet, 'Booking ID', bookingId);
  if (row === -1) throw new Error('Booking not found.');

  const values = bookingSheet.getRange(row, 1, 1, SCHEMA.Bookings.length).getValues()[0];
  const record = {};
  SCHEMA.Bookings.forEach((h, i) => { record[h] = normalizeDateCell(values[i], 'Bookings', h); });

  if (record.Username !== session.username) throw new Error('You can only reschedule your own bookings.');
  if (record.Status !== 'Confirmed') throw new Error('Only confirmed bookings can be rescheduled.');
  if (isPastDate(newDate) || isPastDateTime(newDate, newTime)) throw new Error('Cannot reschedule into a past date/time.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const slotSheet = getSheet(CONFIG.SHEET_SLOTS);
    const newSlotRow = findSlotRow(slotSheet, newDate, newTime);
    if (newSlotRow === -1) throw new Error('That slot no longer exists.');
    const newSlotValues = slotSheet.getRange(newSlotRow, 1, 1, SCHEMA.Slots.length).getValues()[0];
    const newStatus = newSlotValues[SCHEMA.Slots.indexOf('Status')];
    if (newStatus === 'Blocked') throw new Error('That date/time is blocked.');

    const confirmedForNewSlot = sheetToObjects(bookingSheet).filter(
      (b) => b.Status === 'Confirmed' && b['Interview Date'] === newDate && b['Time Slot'] === newTime
    );
    if (confirmedForNewSlot.length >= CONFIG.MAX_BOOKINGS_PER_SLOT) {
      throw new Error('That slot is fully booked (max ' + CONFIG.MAX_BOOKINGS_PER_SLOT + '). Please choose another.');
    }
    if (confirmedForNewSlot.some((b) => b.Username === session.username && b['Booking ID'] !== bookingId)) {
      throw new Error('You already have a booking at that date and time.');
    }

    // Update the booking record in place
    updateRowByHeaders(bookingSheet, row, SCHEMA.Bookings, {
      'Interview Date': newDate,
      'Time Slot': newTime,
      'Status': 'Confirmed'
    });

    return { success: true, message: 'Booking rescheduled to ' + newDate + ' ' + newTime + '.' };
  } finally {
    lock.releaseLock();
  }
}

/** Shared cancel logic used by both student and admin cancel actions. */
function cancelBookingInternal(bookingId, restrictToUsername, isAdmin) {
  const bookingSheet = getSheet(CONFIG.SHEET_BOOKINGS);
  const row = findRowIndexByColumnValue(bookingSheet, 'Booking ID', bookingId);
  if (row === -1) throw new Error('Booking not found.');

  const values = bookingSheet.getRange(row, 1, 1, SCHEMA.Bookings.length).getValues()[0];
  const record = {};
  SCHEMA.Bookings.forEach((h, i) => { record[h] = normalizeDateCell(values[i], 'Bookings', h); });

  if (!isAdmin && record.Username !== restrictToUsername) {
    throw new Error('You can only cancel your own bookings.');
  }
  if (record.Status === 'Cancelled') {
    return { success: true, message: 'Booking was already cancelled.' };
  }

  // Slots.Status only tracks Available/Blocked now — availability is derived
  // from counting Confirmed bookings (see getBookingCountMap), so cancelling
  // just needs to flip the booking record; no Slots row to touch.
  updateRowByHeaders(bookingSheet, row, SCHEMA.Bookings, { Status: 'Cancelled' });

  return { success: true, message: 'Booking cancelled.' };
}
