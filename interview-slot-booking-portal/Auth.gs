/**
 * Auth.gs
 * ------------------------------------------------------------------
 * Username/password authentication and session handling.
 * Sessions are rows in the Sessions sheet, keyed by a random token —
 * NOT CacheService, which caps out at 6 hours with no way to extend
 * it. Storing sessions in the Sheet means a login stays valid
 * indefinitely until an explicit logout() deletes the row, which is
 * what "stay logged in until I log out" (the Android app, browsers)
 * requires. The client keeps the token in localStorage (see
 * script.js) and passes it as a parameter on every API call.
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
  const sessionSheet = getSheet(CONFIG.SHEET_SESSIONS);
  sessionSheet.appendRow([token, user.Username, user.Role, user.FullName, nowString()]);

  return {
    success: true,
    token: token,
    role: user.Role,
    username: user.Username,
    fullName: user.FullName
  };
}

/** Returns session object {username, role, fullName} or null if invalid/nonexistent. */
function validateSession(token) {
  if (!token) return null;
  const sheet = getSheet(CONFIG.SHEET_SESSIONS);
  const session = sheetToObjects(sheet).find((s) => s.Token === token);
  if (!session) return null;
  return { username: session.Username, role: session.Role, fullName: session.FullName };
}

/** Invalidates a session token (logout) by deleting its row. */
function logout(token) {
  if (token) {
    const sheet = getSheet(CONFIG.SHEET_SESSIONS);
    const row = findRowIndexByColumnValue(sheet, 'Token', token);
    if (row !== -1) sheet.deleteRow(row);
  }
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
