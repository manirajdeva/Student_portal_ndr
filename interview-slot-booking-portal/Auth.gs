/**
 * Auth.gs
 * ------------------------------------------------------------------
 * Username/password authentication and session handling.
 * Sessions are stored server-side in CacheService, keyed by a random
 * token. The client stores the token (localStorage) and passes it as
 * a parameter on every google.script.run call and on page reloads
 * (?token=...). This avoids needing real cookies inside the
 * Apps Script HTML sandbox.
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
  const sessionData = { username: user.Username, role: user.Role, fullName: user.FullName };
  CacheService.getScriptCache().put(token, JSON.stringify(sessionData), CONFIG.SESSION_DURATION_SEC);

  return {
    success: true,
    token: token,
    role: user.Role,
    username: user.Username,
    fullName: user.FullName
  };
}

/** Returns session object {username, role, fullName} or null if invalid/expired. */
function validateSession(token) {
  if (!token) return null;
  const cached = CacheService.getScriptCache().get(token);
  if (!cached) return null;
  try {
    return JSON.parse(cached);
  } catch (e) {
    return null;
  }
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
