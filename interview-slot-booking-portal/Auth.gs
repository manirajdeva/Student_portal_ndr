/**
 * Auth.gs
 * ------------------------------------------------------------------
 * Username/password authentication and session handling.
 * Sessions are stored server-side in CacheService, keyed by a random
 * token. The idle timeout is a *sliding* window: every validated
 * request refreshes the token's expiry, so an active user is never
 * cut off mid-use. Students get a short 120-second window (so a
 * shared/public device logs itself out quickly); Admins get
 * CacheService's maximum of 6 hours, sliding on every request, which
 * in practice means an admin session outlives the browser tab rather
 * than timing out mid-session — script.js also keeps the Admin token
 * in sessionStorage (cleared when the tab closes) instead of
 * localStorage, so closing the tab is what actually ends it, not idle
 * time.
 *
 * NOTE ON SECURITY: this is a lightweight scheme suitable for an
 * internal tool. Passwords are SHA-256 hashed with a per-deployment
 * salt (see getSalt()) rather than stored in plain text, but this is
 * NOT a substitute for a real identity provider for sensitive data.
 * ------------------------------------------------------------------
 */

/** Returns (and lazily creates) a per-deployment salt stored in Script Properties. */
function getSalt() {
  const props = PropertiesService.getScriptProperties();
  let salt = props.getProperty('PWD_SALT');
  if (!salt) {
    salt = Utilities.getUuid();
    props.setProperty('PWD_SALT', salt);
  }
  return salt;
}

function hashPassword(password) {
  const raw = password + '::' + getSalt();
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw);
  return bytes.map((b) => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, '0')).join('');
}

// Session is invalidated after this many seconds with no requests at all.
// Every successful validateSession() call slides this window forward.
// Admin uses CacheService's hard maximum (21600s / 6h) — there is no
// "never expire" option on Apps Script's cache, so this is as close as
// it gets to "stays logged in until the tab closes."
const IDLE_TIMEOUT_SEC = { Student: 120, Admin: 21600 };
function idleTimeoutFor(role) {
  return IDLE_TIMEOUT_SEC[role] || IDLE_TIMEOUT_SEC.Student;
}

/**
 * Validates username/password and creates a session.
 * Called from login.html via google.script.run.
 * @returns {success, token, role, username, fullName} or {success:false, message}
 */
function login(username, password) {
  username = (username || '').trim();
  password = password || '';
  if (!username || !password) {
    return { success: false, message: 'Username and password are required.' };
  }

  const sheet = getSheet(CONFIG.SHEET_USERS);
  const users = sheetToObjects(sheet);
  const user = users.find((u) => u.Username === username);

  if (!user) return { success: false, message: 'Invalid username or password.' };
  if (user.Status !== 'Active') return { success: false, message: 'This account is deactivated. Contact your admin.' };
  if (user.PasswordHash !== hashPassword(password)) {
    return { success: false, message: 'Invalid username or password.' };
  }

  const token = Utilities.getUuid();
  const sessionData = { username: user.Username, role: user.Role, fullName: user.FullName };
  CacheService.getScriptCache().put(token, JSON.stringify(sessionData), idleTimeoutFor(user.Role));

  return {
    success: true,
    token: token,
    role: user.Role,
    username: user.Username,
    fullName: user.FullName
  };
}

/**
 * Returns session object {username, role, fullName} or null if invalid/idle
 * -expired. Refreshes the token's expiry on every successful call (sliding
 * window), so continued activity never gets cut off mid-use.
 */
function validateSession(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(token);
  if (!cached) return null;
  let session;
  try {
    session = JSON.parse(cached);
  } catch (e) {
    return null;
  }
  cache.put(token, cached, idleTimeoutFor(session.role)); // slide the idle window forward
  return session;
}

/** Invalidates a session token (logout). */
function logout(token) {
  if (token) CacheService.getScriptCache().remove(token);
  return { success: true };
}

/**
 * Throws if the token is invalid or the session's role doesn't match.
 * Use at the top of every privileged server function.
 * @returns the valid session object
 */
function requireRole(token, role) {
  const session = validateSession(token);
  if (!session) throw new Error('Your session has expired. Please log in again.');
  if (role && session.role !== role) throw new Error('You do not have permission to perform this action.');
  return session;
}

/**
 * Called by the client on every admin/student page load to confirm the
 * stored token is still valid and fetch the current {username, role,
 * fullName} — the static frontend has no server-rendered session data,
 * so it must ask for this explicitly instead.
 */
function whoAmI(token) {
  return requireRole(token, null);
}
