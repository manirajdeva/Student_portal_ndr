/* ==========================================================
   script.js — Interview Slot Booking Portal (client-side)
   Static frontend, hosted outside Apps Script (e.g. GitHub Pages).
   Talks to the Apps Script backend purely via fetch()+POST as a
   JSON API (see Code.gs doPost) — no google.script.run, no
   sandboxed iframe, so it works identically on every browser,
   including iOS Safari (which blocks storage/postMessage inside
   Apps Script's HtmlService iframe and broke login there).
   ========================================================== */

// Your deployed Apps Script Web App URL (ends in /exec). If you ever
// create a NEW deployment (rather than a new version of this one),
// update this to match its URL.
const API_URL = 'https://script.google.com/macros/s/AKfycbwGEEoKKOVS72lWZ1J1V0MbgpU-3suDkET4cKUY7TvcniEhvwO5kp_NFhfp4LGOu5of/exec';

// Required for PWA/TWA installability (Android "Add to Home Screen"
// and the installable APK both need an active service worker).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

// ---------------------------------------------------------
// Session helpers. localStorage on purpose (not sessionStorage) — the
// Android app (a Trusted Web Activity) can have its underlying process
// killed by Android between opens, which clears sessionStorage;
// localStorage survives that, matching "stay logged in until I log
// out" instead of silently signing the user out on every app restart.
// (Trade-off: a brand-new browser tab will now also start already
// logged in, since localStorage is shared across tabs of the same site.)
// ---------------------------------------------------------
const Session = {
  get token() { return localStorage.getItem('ispb_token') || ''; },
  set token(v) { v ? localStorage.setItem('ispb_token', v) : localStorage.removeItem('ispb_token'); },
  get role() { return localStorage.getItem('ispb_role') || ''; },
  set role(v) { v ? localStorage.setItem('ispb_role', v) : localStorage.removeItem('ispb_role'); },
  get fullName() { return localStorage.getItem('ispb_fullname') || ''; },
  set fullName(v) { v ? localStorage.setItem('ispb_fullname', v) : localStorage.removeItem('ispb_fullname'); },
  clear() {
    localStorage.removeItem('ispb_token');
    localStorage.removeItem('ispb_role');
    localStorage.removeItem('ispb_fullname');
  }
};

// ---------------------------------------------------------
// JSON API call. Sent as text/plain (fetch's default for a string
// body) rather than application/json — an application/json request
// would trigger a CORS preflight (OPTIONS) request, which Apps
// Script web apps cannot answer. text/plain keeps this a "simple
// request" per the CORS spec, so the browser skips preflight, while
// doPost() still parses the body as JSON regardless of the header.
// ---------------------------------------------------------
function api(fnName, ...args) {
  return fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ fn: fnName, args: args })
  })
    .then((r) => r.json())
    .then((json) => {
      if (json.error) throw new Error(json.error);
      return json.result;
    });
}

// ---------------------------------------------------------
// Toasts + loading overlay
// ---------------------------------------------------------
function toast(message, type) {
  const container = document.getElementById('toast-container');
  if (!container) { alert(message); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'success');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function showLoader(msg) {
  const loader = document.getElementById('page-loader');
  if (!loader) return;
  loader.querySelector('p').textContent = msg || 'Loading...';
  loader.classList.remove('hidden');
}
function hideLoader() {
  const loader = document.getElementById('page-loader');
  if (loader) loader.classList.add('hidden');
}

function setButtonLoading(btn, loading, label) {
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spinner"></span> Please wait...' : label;
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function to12h(t) {
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return String(hh).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ' ' + period;
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Wires up every .toggle-password button to show/hide its preceding password input. */
function initPasswordToggles() {
  document.querySelectorAll('.toggle-password').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '👁' : '🙈';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });
}

// ===========================================================
// PAGE DISPATCH
// ===========================================================
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.getAttribute('data-page');
  if (page === 'login') initLogin();
  if (page === 'admin') initAdmin();
  if (page === 'student') initStudent();
});

function goHome() {
  window.location.href = Session.role === 'Admin' ? 'admin.html' : 'student.html';
}

function doLogout() {
  api('logout', Session.token).finally(() => {
    Session.clear();
    window.location.href = 'login.html';
  });
}

// ===========================================================
// LOGIN PAGE
// ===========================================================
function initLogin() {
  // Already logged in? Skip straight to the right page.
  if (Session.token) { goHome(); return; }

  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  initPasswordToggles();

  const roleCopy = {
    Student: { heading: 'Student Sign In', sub: 'Sign in to view and book your interview slots.' },
    Admin: { heading: 'Admin Sign In', sub: 'Sign in to manage students, bookings and slots.' }
  };
  document.querySelectorAll('.role-toggle-btn').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.role-toggle-btn').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      const copy = roleCopy[tabBtn.getAttribute('data-role')];
      document.getElementById('login-heading').textContent = copy.heading;
      document.getElementById('login-subtext').textContent = copy.sub;
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    setButtonLoading(btn, true);

    const selectedRole = document.querySelector('.role-toggle-btn.active').getAttribute('data-role');

    api('login', username, password)
      .then((res) => {
        setButtonLoading(btn, false, 'Sign In');
        if (!res.success) { errorEl.textContent = res.message; return; }
        if (res.role !== selectedRole) {
          api('logout', res.token); // don't leave an unused session behind
          errorEl.textContent = 'That account is not a ' + selectedRole + ' account. Switch to ' +
            res.role + ' above and try again.';
          return;
        }
        Session.token = res.token;
        Session.role = res.role;
        Session.fullName = res.fullName;
        goHome();
      })
      .catch((err) => {
        setButtonLoading(btn, false, 'Sign In');
        errorEl.textContent = err.message || 'Something went wrong. Please try again.';
      });
  });
}

// ===========================================================
// CALENDAR (shared component — used by student booking view
// and admin holiday manager)
// ===========================================================
/**
 * Renders a month calendar into containerEl.
 * options: { onSelectDate(dateStr), selectedDate, summaryFetcher: async (start,end) => {date: state} }
 */
function renderCalendar(containerEl, viewDate, options) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = firstDay.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const startStr = toISO(new Date(year, month, 1));
  const endStr = toISO(new Date(year, month, daysInMonth));

  containerEl.innerHTML = `
    <div class="calendar-header">
      <button type="button" data-nav="-1">&larr;</button>
      <strong>${monthLabel}</strong>
      <button type="button" data-nav="1">&rarr;</button>
    </div>
    <div class="calendar-grid">
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d) => `<div class="dow">${d}</div>`).join('')}
    </div>
    <div class="cal-legend">
      <span><span class="dot green"></span> Open slots</span>
      <span><span class="dot red"></span> Fully booked</span>
      <span><span class="dot grey"></span> Blocked / past</span>
    </div>
  `;

  // preloadedSummary only applies to this exact render call (the initial
  // one) — navigating months must always fetch fresh data, so it's
  // stripped before wiring up the nav buttons' recursive calls.
  const { preloadedSummary, ...navOptions } = options;

  containerEl.querySelector('[data-nav="-1"]').onclick = () => {
    renderCalendar(containerEl, new Date(year, month - 1, 1), navOptions);
  };
  containerEl.querySelector('[data-nav="1"]').onclick = () => {
    renderCalendar(containerEl, new Date(year, month + 1, 1), navOptions);
  };

  const grid = containerEl.querySelector('.calendar-grid');

  const paint = (summary) => {
    for (let i = 0; i < startOffset; i++) {
      grid.insertAdjacentHTML('beforeend', '<div class="cal-day empty"></div>');
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = toISO(new Date(year, month, day));
      const isPast = dateStr < todayISO();
      const state = (summary && summary[dateStr]) || (isPast ? 'past' : 'none');
      const selectable = !isPast && state !== 'blocked';
      const isSelected = options.selectedDate === dateStr;
      const cell = document.createElement('div');
      cell.className = 'cal-day' + (selectable ? ' selectable' : '') + (isSelected ? ' selected' : '') + ' state-' + state;
      cell.textContent = day;
      if (selectable) cell.onclick = () => options.onSelectDate(dateStr);
      grid.appendChild(cell);
    }
  };

  if (preloadedSummary) {
    paint(preloadedSummary);
  } else if (options.summaryFetcher) {
    options.summaryFetcher(startStr, endStr).then(paint).catch(() => paint({}));
  } else {
    paint({});
  }
}

function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ===========================================================
// STUDENT PAGE
// ===========================================================
let studentSelectedDate = null;

function initStudent() {
  if (!Session.token) { window.location.href = 'login.html'; return; }

  const now = new Date();
  const calStart = toISO(new Date(now.getFullYear(), now.getMonth(), 1));
  const calEnd = toISO(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  api('studentBootstrap', Session.token, calStart, calEnd).then((data) => {
    if (data.redirect) { window.location.href = data.redirect; return; }
    applySession(data.session);

    bindSidebarNav();
    document.getElementById('logout-btn').addEventListener('click', doLogout);

    renderCalendar(document.getElementById('student-calendar'), now, {
      selectedDate: studentSelectedDate,
      onSelectDate: (dateStr) => { studentSelectedDate = dateStr; loadSlotsForDate(dateStr); },
      summaryFetcher: (start, end) => api('getCalendarSummary', Session.token, start, end),
      preloadedSummary: data.calendarSummary
    });

    document.getElementById('booking-form').addEventListener('submit', submitBooking);
    document.getElementById('confirm-close-btn').addEventListener('click', closeConfirmModal);
    renderMyBookings(data.myBookings);
  }).catch(handleBootstrapError);
}

/**
 * Shared by adminBootstrap/studentBootstrap catch blocks. Only treats
 * this as "you're logged out" when the server explicitly says the
 * session is invalid/expired — a transient network blip or a slow
 * Apps Script cold start can also make this call fail, and those
 * shouldn't wipe a perfectly valid token and boot the user out.
 */
function handleBootstrapError(err) {
  const isAuthError = /session has expired|log in again|not logged in/i.test(err.message || '');
  if (isAuthError) {
    Session.clear();
    window.location.href = 'login.html';
  } else {
    toast(err.message || 'Could not reach the server. Please check your connection and try again.', 'error');
  }
}

function applySession(session) {
  Session.fullName = session.fullName;
  Session.role = session.role;
  document.querySelectorAll('[data-user-fullname]').forEach((el) => { el.textContent = session.fullName; });
}

function loadSlotsForDate(dateStr) {
  const wrap = document.getElementById('slot-grid-wrap');
  wrap.innerHTML = '<p class="empty-state"><span class="spinner"></span> Loading slots...</p>';
  document.getElementById('selected-date-label').textContent = fmtDateLabel(dateStr);

  api('getAvailableSlots', Session.token, dateStr).then((res) => {
    if (!res.slots.length) {
      wrap.innerHTML = '<p class="empty-state">No slots for this date.</p>';
      return;
    }
    wrap.innerHTML = '<div class="slot-grid">' + res.slots.map((s) => {
      const clickable = s.status === 'Available';
      return `<div class="slot-cell ${s.status.toLowerCase()}" ${clickable ? `data-time="${s.time}"` : ''}>
        ${to12h(s.time)}<span class="tag">${s.status === 'Available' ? 'OPEN' : s.status.toUpperCase()}</span>
      </div>`;
    }).join('') + '</div>';

    wrap.querySelectorAll('.slot-cell[data-time]').forEach((cell) => {
      cell.addEventListener('click', () => openBookingModal(dateStr, cell.getAttribute('data-time')));
    });
  }).catch((err) => {
    wrap.innerHTML = '<p class="empty-state">' + (err.message || 'Could not load slots.') + '</p>';
  });
}

function openBookingModal(dateStr, time) {
  document.getElementById('booking-modal-subtitle').textContent = fmtDateLabel(dateStr) + ' · ' + to12h(time);
  document.getElementById('bk-date').value = dateStr;
  document.getElementById('bk-time').value = time;
  document.getElementById('booking-modal').classList.add('open');
}
function closeBookingModal() {
  document.getElementById('booking-modal').classList.remove('open');
  document.getElementById('booking-form').reset();
}

function submitBooking(e) {
  e.preventDefault();
  const btn = document.getElementById('bk-submit-btn');
  const payload = {
    studentName: document.getElementById('bk-name').value.trim(),
    companyName: document.getElementById('bk-company').value.trim(),
    interviewLevel: document.getElementById('bk-level').value,
    date: document.getElementById('bk-date').value,
    time: document.getElementById('bk-time').value,
    mode: document.getElementById('bk-mode').value,
    notes: document.getElementById('bk-notes').value.trim()
  };
  setButtonLoading(btn, true);
  api('bookSlot', Session.token, payload).then((res) => {
    setButtonLoading(btn, false, 'Confirm Booking');
    closeBookingModal();
    showConfirmModal(res.booking);
    loadSlotsForDate(payload.date);
    loadMyBookings();
  }).catch((err) => {
    setButtonLoading(btn, false, 'Confirm Booking');
    toast(err.message || 'Could not book that slot.', 'error');
  });
}

/** Booking confirmation modal — shown right after a successful booking. */
function showConfirmModal(booking) {
  const list = document.getElementById('confirm-list');
  list.innerHTML = [
    ['Booking ID', booking.bookingId],
    ['Company', booking.companyName],
    ['Interview Level', booking.interviewLevel],
    ['Date', fmtDateLabel(booking.date)],
    ['Time', to12h(booking.time)],
    ['Mode', booking.mode],
    ['Status', booking.status]
  ].map(([label, value]) => `<li><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></li>`).join('');
  document.getElementById('confirm-modal').classList.add('open');
}
function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('open');
  switchTab('my-bookings');
}

function loadMyBookings() {
  const wrap = document.getElementById('my-bookings-wrap');
  wrap.innerHTML = '<p class="empty-state"><span class="spinner"></span> Loading...</p>';
  api('getMyBookings', Session.token).then(renderMyBookings);
}

function renderMyBookings(rows) {
  const wrap = document.getElementById('my-bookings-wrap');
  if (!rows.length) { wrap.innerHTML = '<p class="empty-state">No bookings yet.</p>'; return; }
  wrap.innerHTML = rows.map((b) => `
      <div class="panel" style="margin-bottom:10px;">
        <div class="flex" style="justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
          <div>
            <strong>${escapeHtml(b['Company Name'])}</strong> · ${escapeHtml(b['Interview Level'])}
            <div class="text-sm muted">${fmtDateLabel(b['Interview Date'])} · ${to12h(b['Time Slot'])} · ${escapeHtml(b['Interview Mode'])}</div>
            ${b.Notes ? `<div class="text-sm muted">Note: ${escapeHtml(b.Notes)}</div>` : ''}
          </div>
          <span class="pill ${b.Status.toLowerCase()}">${b.Status}</span>
        </div>
        ${b.Status === 'Confirmed' && b['Interview Date'] >= todayISO() ? `
        <div class="flex gap-8 mt-16">
          <button class="btn btn-outline btn-sm" onclick="promptReschedule('${b['Booking ID']}')">Reschedule</button>
          <button class="btn btn-danger btn-sm" onclick="cancelBooking('${b['Booking ID']}')">Cancel</button>
        </div>` : ''}
      </div>
    `).join('');
}

function cancelBooking(bookingId) {
  if (!confirm('Cancel this booking?')) return;
  api('cancelMyBooking', Session.token, bookingId).then(() => {
    toast('Booking cancelled.', 'success');
    loadMyBookings();
  }).catch((err) => toast(err.message || 'Could not cancel.', 'error'));
}

function promptReschedule(bookingId) {
  window.__rescheduleId = bookingId;
  document.getElementById('reschedule-modal').classList.add('open');
  renderCalendar(document.getElementById('reschedule-calendar'), new Date(), {
    onSelectDate: (dateStr) => {
      window.__rescheduleDate = dateStr;
      loadRescheduleSlots(dateStr);
    },
    summaryFetcher: (start, end) => api('getCalendarSummary', Session.token, start, end)
  });
  document.getElementById('reschedule-slots').innerHTML = '<p class="empty-state">Pick a date above.</p>';
}
function closeRescheduleModal() {
  document.getElementById('reschedule-modal').classList.remove('open');
}
function loadRescheduleSlots(dateStr) {
  const wrap = document.getElementById('reschedule-slots');
  wrap.innerHTML = '<p class="empty-state"><span class="spinner"></span> Loading...</p>';
  api('getAvailableSlots', Session.token, dateStr).then((res) => {
    wrap.innerHTML = '<div class="slot-grid">' + res.slots.map((s) => `
      <div class="slot-cell ${s.status.toLowerCase()}" ${s.status === 'Available' ? `data-time="${s.time}"` : ''}>
        ${to12h(s.time)}<span class="tag">${s.status === 'Available' ? 'OPEN' : s.status.toUpperCase()}</span>
      </div>`).join('') + '</div>';
    wrap.querySelectorAll('.slot-cell[data-time]').forEach((cell) => {
      cell.addEventListener('click', () => {
        api('rescheduleMyBooking', Session.token, window.__rescheduleId, dateStr, cell.getAttribute('data-time'))
          .then((res) => {
            toast(res.message, 'success');
            closeRescheduleModal();
            loadMyBookings();
          }).catch((err) => toast(err.message || 'Could not reschedule.', 'error'));
      });
    });
  });
}

// ===========================================================
// ADMIN PAGE
// ===========================================================
function initAdmin() {
  if (!Session.token) { window.location.href = 'login.html'; return; }

  api('adminBootstrap', Session.token).then((data) => {
    if (data.redirect) { window.location.href = data.redirect; return; }
    applySession(data.session);

    bindSidebarNav();
    document.getElementById('logout-btn').addEventListener('click', doLogout);

    renderDashboard(data.stats);
    renderStudentsTable(data.students);
    renderBookingsTable(data.bookings);
    renderBlockedDates(data.blockedDates);

    document.getElementById('add-student-form').addEventListener('submit', handleAddStudent);
    document.getElementById('add-admin-form').addEventListener('submit', handleAddAdmin);
    document.getElementById('edit-student-form').addEventListener('submit', handleEditStudentSubmit);
    document.getElementById('edit-booking-form').addEventListener('submit', handleEditBookingSubmit);
    document.getElementById('search-bookings-form').addEventListener('submit', handleSearchBookings);
    document.getElementById('block-date-form').addEventListener('submit', handleBlockDate);
    document.getElementById('generate-slots-form').addEventListener('submit', handleGenerateSlots);
  }).catch(handleBootstrapError);
}

function loadDashboard() {
  api('getDashboardStats', Session.token).then(renderDashboard);
}

function renderDashboard(s) {
  document.getElementById('stat-total-students').textContent = s.totalStudents;
  document.getElementById('stat-today-bookings').textContent = s.todaysBookingsCount;
  document.getElementById('stat-upcoming').textContent = s.upcomingCount;
  document.getElementById('stat-available-slots').textContent = s.availableSlotsCount;

  const list = document.getElementById('upcoming-preview');
  if (!s.upcomingPreview.length) {
    list.innerHTML = '<p class="empty-state">No upcoming interviews.</p>';
  } else {
    list.innerHTML = s.upcomingPreview.map((b) => `
      <div class="flex" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
        <span>${escapeHtml(b['Student Name'])} · ${escapeHtml(b['Company Name'])}</span>
        <span class="muted text-sm">${fmtDateLabel(b['Interview Date'])} ${to12h(b['Time Slot'])}</span>
      </div>
    `).join('');
  }
}

let studentsCache = [];

function loadStudentsTable() {
  api('listStudents', Session.token).then(renderStudentsTable);
}

function renderStudentsTable(students) {
  const wrap = document.getElementById('students-table-wrap');
  studentsCache = students;
  if (!students.length) { wrap.innerHTML = '<p class="empty-state">No students yet.</p>'; return; }
  wrap.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>
    <th>Username</th><th>Full Name</th><th>Email</th><th>Status</th><th></th>
  </tr></thead><tbody>` + students.map((st) => `
    <tr>
      <td>${escapeHtml(st.Username)}</td>
      <td>${escapeHtml(st.FullName)}</td>
      <td>${escapeHtml(st.Email || '—')}</td>
      <td><span class="pill ${st.Status.toLowerCase()}">${st.Status}</span></td>
      <td class="flex gap-8">
        <button class="btn btn-outline btn-sm" onclick="openEditStudentModal('${st.Username}')">Edit</button>
        <button class="btn btn-outline btn-sm" onclick="toggleStudentStatus('${st.Username}','${st.Status}')">${st.Status === 'Active' ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteStudentRow('${st.Username}')">Delete</button>
      </td>
    </tr>`).join('') + '</tbody></table></div>';
}

function handleAddStudent(e) {
  e.preventDefault();
  const btn = document.getElementById('add-student-btn');
  const payload = {
    username: document.getElementById('new-username').value.trim(),
    password: document.getElementById('new-password').value,
    fullName: document.getElementById('new-fullname').value.trim(),
    email: document.getElementById('new-email').value.trim()
  };
  setButtonLoading(btn, true);
  api('addStudent', Session.token, payload).then(() => {
    setButtonLoading(btn, false, 'Add Student');
    toast('Student added.', 'success');
    e.target.reset();
    loadStudentsTable();
    loadDashboard();
  }).catch((err) => {
    setButtonLoading(btn, false, 'Add Student');
    toast(err.message || 'Could not add student.', 'error');
  });
}

function handleAddAdmin(e) {
  e.preventDefault();
  const btn = document.getElementById('add-admin-btn');
  const payload = {
    username: document.getElementById('new-admin-username').value.trim(),
    password: document.getElementById('new-admin-password').value,
    fullName: document.getElementById('new-admin-fullname').value.trim(),
    email: document.getElementById('new-admin-email').value.trim()
  };
  setButtonLoading(btn, true);
  api('addAdmin', Session.token, payload).then(() => {
    setButtonLoading(btn, false, 'Add Admin');
    toast('Admin added.', 'success');
    e.target.reset();
  }).catch((err) => {
    setButtonLoading(btn, false, 'Add Admin');
    toast(err.message || 'Could not add admin.', 'error');
  });
}

function openEditStudentModal(username) {
  const st = studentsCache.find((s) => s.Username === username);
  if (!st) return;
  document.getElementById('edit-username').value = st.Username;
  document.getElementById('edit-username-label').textContent = st.Username;
  document.getElementById('edit-fullname').value = st.FullName;
  document.getElementById('edit-email').value = st.Email || '';
  document.getElementById('edit-password').value = '';
  document.getElementById('edit-student-modal').classList.add('open');
}
function closeEditStudentModal() {
  document.getElementById('edit-student-modal').classList.remove('open');
}
function handleEditStudentSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('edit-student-btn');
  const username = document.getElementById('edit-username').value;
  const payload = {
    fullName: document.getElementById('edit-fullname').value.trim(),
    email: document.getElementById('edit-email').value.trim(),
    password: document.getElementById('edit-password').value
  };
  setButtonLoading(btn, true);
  api('editStudent', Session.token, username, payload).then(() => {
    setButtonLoading(btn, false, 'Save Changes');
    toast('Student updated.', 'success');
    closeEditStudentModal();
    loadStudentsTable();
  }).catch((err) => {
    setButtonLoading(btn, false, 'Save Changes');
    toast(err.message || 'Could not update student.', 'error');
  });
}

function toggleStudentStatus(username, currentStatus) {
  const next = currentStatus === 'Active' ? 'Inactive' : 'Active';
  api('setStudentStatus', Session.token, username, next).then(() => {
    toast('Status updated.', 'success');
    loadStudentsTable();
  }).catch((err) => toast(err.message, 'error'));
}
function deleteStudentRow(username) {
  if (!confirm('Delete student "' + username + '"? This cannot be undone.')) return;
  api('deleteStudent', Session.token, username).then(() => {
    toast('Student deleted.', 'success');
    loadStudentsTable();
    loadDashboard();
  }).catch((err) => toast(err.message, 'error'));
}

let bookingsCache = [];

function loadBookingsTable(rows) {
  if (rows) { renderBookingsTable(rows); return; }
  api('listAllBookings', Session.token).then(renderBookingsTable);
}

function renderBookingsTable(rows) {
  bookingsCache = rows;
  const wrap = document.getElementById('bookings-table-wrap');
  if (!rows.length) { wrap.innerHTML = '<p class="empty-state">No bookings found.</p>'; return; }
  wrap.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>
    <th>Student</th><th>Company</th><th>Level</th><th>Date</th><th>Time</th><th>Mode</th><th>Status</th><th></th>
  </tr></thead><tbody>` + rows.map((b) => `
    <tr>
      <td>${escapeHtml(b['Student Name'])}</td>
      <td>${escapeHtml(b['Company Name'])}</td>
      <td>${escapeHtml(b['Interview Level'])}</td>
      <td>${fmtDateLabel(b['Interview Date'])}</td>
      <td>${to12h(b['Time Slot'])}</td>
      <td>${escapeHtml(b['Interview Mode'])}</td>
      <td><span class="pill ${b.Status.toLowerCase()}">${b.Status}</span></td>
      <td class="flex gap-8">${b.Status === 'Confirmed' ? `
        <button class="btn btn-outline btn-sm" onclick="openEditBookingModal('${b['Booking ID']}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="adminCancel('${b['Booking ID']}')">Cancel</button>` : ''}</td>
    </tr>`).join('') + '</tbody></table></div>';
}

function openEditBookingModal(bookingId) {
  const b = bookingsCache.find((x) => x['Booking ID'] === bookingId);
  if (!b) return;
  document.getElementById('edit-booking-id').value = bookingId;
  document.getElementById('edit-booking-label').textContent = fmtDateLabel(b['Interview Date']) + ' · ' + to12h(b['Time Slot']);
  document.getElementById('edit-bk-student').value = b['Student Name'];
  document.getElementById('edit-bk-company').value = b['Company Name'];
  document.getElementById('edit-bk-level').value = b['Interview Level'];
  document.getElementById('edit-bk-mode').value = b['Interview Mode'];
  document.getElementById('edit-bk-notes').value = b.Notes || '';
  document.getElementById('edit-booking-modal').classList.add('open');
}
function closeEditBookingModal() {
  document.getElementById('edit-booking-modal').classList.remove('open');
}
function handleEditBookingSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('edit-booking-btn');
  const bookingId = document.getElementById('edit-booking-id').value;
  const payload = {
    studentName: document.getElementById('edit-bk-student').value.trim(),
    companyName: document.getElementById('edit-bk-company').value.trim(),
    interviewLevel: document.getElementById('edit-bk-level').value.trim(),
    mode: document.getElementById('edit-bk-mode').value,
    notes: document.getElementById('edit-bk-notes').value.trim()
  };
  setButtonLoading(btn, true);
  api('adminEditBooking', Session.token, bookingId, payload).then(() => {
    setButtonLoading(btn, false, 'Save Changes');
    toast('Booking updated.', 'success');
    closeEditBookingModal();
    loadBookingsTable();
  }).catch((err) => {
    setButtonLoading(btn, false, 'Save Changes');
    toast(err.message || 'Could not update booking.', 'error');
  });
}

function handleSearchBookings(e) {
  e.preventDefault();
  const filters = {
    studentName: document.getElementById('f-name').value,
    companyName: document.getElementById('f-company').value,
    interviewLevel: document.getElementById('f-level').value,
    date: document.getElementById('f-date').value,
    status: document.getElementById('f-status').value
  };
  api('searchBookings', Session.token, filters).then((rows) => loadBookingsTable(rows));
}

function adminCancel(bookingId) {
  if (!confirm('Cancel this booking?')) return;
  api('adminCancelBooking', Session.token, bookingId).then(() => {
    toast('Booking cancelled.', 'success');
    loadBookingsTable();
    loadDashboard();
  }).catch((err) => toast(err.message, 'error'));
}

function handleBlockDate(e) {
  e.preventDefault();
  const date = document.getElementById('block-date-input').value;
  if (!date) return;
  api('blockDate', Session.token, date).then((res) => {
    toast(res.message, 'success');
    loadBlockedDates();
    loadDashboard();
  }).catch((err) => toast(err.message, 'error'));
}

function loadBlockedDates() {
  api('listBlockedDates', Session.token).then(renderBlockedDates);
}

function renderBlockedDates(rows) {
  const wrap = document.getElementById('blocked-dates-wrap');
  if (!rows.length) { wrap.innerHTML = '<p class="empty-state">No blocked dates coming up.</p>'; return; }
  wrap.innerHTML = rows.map((r) => `
    <div class="flex" style="justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
      <span>${fmtDateLabel(r.date)} <span class="muted text-sm">(${r.blockedCount}/${r.totalCount} slots blocked)</span></span>
      <button class="btn btn-outline btn-sm" onclick="unblockDateRow('${r.date}')">Unblock</button>
    </div>
  `).join('');
}
function unblockDateRow(date) {
  api('unblockDate', Session.token, date).then((res) => {
    toast(res.message, 'success');
    loadBlockedDates();
    loadDashboard();
  }).catch((err) => toast(err.message, 'error'));
}

function handleGenerateSlots(e) {
  e.preventDefault();
  const btn = document.getElementById('generate-slots-btn');
  const start = document.getElementById('gen-start').value;
  const end = document.getElementById('gen-end').value;
  setButtonLoading(btn, true);
  api('bulkGenerateSlots', Session.token, start, end).then((res) => {
    setButtonLoading(btn, false, 'Generate Slots');
    toast(res.message, 'success');
    loadDashboard();
  }).catch((err) => {
    setButtonLoading(btn, false, 'Generate Slots');
    toast(err.message, 'error');
  });
}

// ===========================================================
// SHARED: sidebar tab switching
// ===========================================================
function bindSidebarNav() {
  document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });
}
function switchTab(tabId) {
  document.querySelectorAll('.tab-section').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-tab]').forEach((el) => el.classList.remove('active'));
  document.getElementById('tab-' + tabId).classList.add('active');
  document.querySelector('.nav-item[data-tab="' + tabId + '"]').classList.add('active');
}