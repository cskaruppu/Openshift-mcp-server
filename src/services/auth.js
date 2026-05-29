/**
 * Authentication & Session Management
 *
 * Supports two modes:
 *   1. OpenShift OAuth — uses the cluster's OAuth server for SSO
 *   2. Token-based — validates a static API token (for headless/MCP clients)
 *
 * Sessions stored in-memory with Redis fallback for HA.
 */

import { randomBytes, createHash, timingSafeEqual, scryptSync } from "node:crypto";
import { cacheGet, cacheSet } from "../utils/cache.js";
import { query as dbQuery } from "../utils/db.js";

const SESSION_TTL = parseInt(process.env.SESSION_TTL || "86400", 10); // 24 hours
const PASSWORD_MAX_AGE_DAYS = parseInt(process.env.PASSWORD_MAX_AGE_DAYS || "90", 10);
const API_TOKEN = process.env.MCP_API_TOKEN || "";
const AUTH_MODE = process.env.AUTH_MODE || (API_TOKEN ? "token" : "none");
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "openshift-mcp";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "";
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || "";
const OPENSHIFT_OAUTH_URL = process.env.OPENSHIFT_OAUTH_URL || "https://oauth-openshift.apps.cluster.local";

const sessions = new Map();

const ROLES = {
  admin: { level: 3, label: "Admin", permissions: ["read", "write", "manage", "configure", "export"] },
  operator: { level: 2, label: "Operator", permissions: ["read", "write", "export"] },
  viewer: { level: 1, label: "Viewer", permissions: ["read", "export"] },
};

const _userRoles = new Map();
const _userNamespaces = new Map();
let _rolesLoaded = false;

export async function loadUserRoles() {
  if (_rolesLoaded) return;
  _rolesLoaded = true;
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", ["user_roles"]);
    if (result?.rows?.length > 0) {
      const roles = typeof result.rows[0].value === "string" ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      if (roles && typeof roles === "object") {
        for (const [user, role] of Object.entries(roles)) _userRoles.set(user, role);
      }
    }
  } catch {}
  try {
    const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", ["user_namespaces"]);
    if (result?.rows?.length > 0) {
      const nsMap = typeof result.rows[0].value === "string" ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      if (nsMap && typeof nsMap === "object") {
        for (const [user, nsList] of Object.entries(nsMap)) _userNamespaces.set(user, nsList);
      }
    }
  } catch {}
  await _loadUsersFromDB();
  await ensureDefaultAdmin();
}

async function persistUserRoles() {
  const roles = Object.fromEntries(_userRoles);
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ["user_roles", JSON.stringify(roles)]
    );
  } catch {}
}

async function persistUserNamespaces() {
  const nsMap = Object.fromEntries(_userNamespaces);
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ["user_namespaces", JSON.stringify(nsMap)]
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt-based)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64).toString("hex");
  return derived.length === hash.length && timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
}

// ---------------------------------------------------------------------------
// Persistent user CRUD — in-memory primary, DB write-through
// ---------------------------------------------------------------------------
const _users = new Map(); // username -> { passwordHash, role, namespaces, displayName, createdAt, passwordChangedAt, lastLogin, active }

function _persistUsersToDB() {
  const snapshot = {};
  for (const [u, data] of _users) snapshot[u] = data;
  dbQuery(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    ["managed_users", JSON.stringify(snapshot)]
  ).catch(() => {});
}

async function _loadUsersFromDB() {
  // Try the users table first (PostgreSQL)
  try {
    const r = await dbQuery("SELECT username, password_hash, role, namespaces, display_name, created_at, password_changed_at, last_login, active, force_password_change FROM users ORDER BY created_at");
    if (r?.rows?.length > 0) {
      for (const row of r.rows) {
        _users.set(row.username, {
          passwordHash: row.password_hash,
          role: row.role,
          namespaces: row.namespaces || [],
          displayName: row.display_name || row.username,
          createdAt: row.created_at,
          passwordChangedAt: row.password_changed_at,
          lastLogin: row.last_login,
          active: row.active !== false,
          forcePasswordChange: row.force_password_change || false,
        });
        _userRoles.set(row.username, row.role);
        if (row.namespaces?.length > 0) _userNamespaces.set(row.username, row.namespaces);
      }
      return;
    }
  } catch {}
  // Fallback: load from kv_store (works even when users table doesn't exist)
  try {
    const r = await dbQuery("SELECT value FROM kv_store WHERE key = $1", ["managed_users"]);
    if (r?.rows?.length > 0) {
      const data = typeof r.rows[0].value === "string" ? JSON.parse(r.rows[0].value) : r.rows[0].value;
      if (data && typeof data === "object") {
        for (const [username, u] of Object.entries(data)) {
          _users.set(username, u);
          _userRoles.set(username, u.role);
          if (u.namespaces?.length > 0) _userNamespaces.set(username, u.namespaces);
        }
      }
    }
  } catch {}
}

function _persistUserToDBTable(username, data) {
  dbQuery(
    `INSERT INTO users (username, password_hash, role, namespaces, display_name, created_at, password_changed_at, active, force_password_change)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = $2, role = $3, namespaces = $4, display_name = $5,
       password_changed_at = $7, active = $8, force_password_change = $9, updated_at = NOW()`,
    [username, data.passwordHash, data.role, data.namespaces || [], data.displayName || username,
     data.createdAt || new Date().toISOString(), data.passwordChangedAt || new Date().toISOString(),
     data.active !== false, data.forcePasswordChange || false]
  ).catch(() => {});
}

export async function createUser(username, password, role = "viewer", displayName = "", namespaces = []) {
  if (!ROLES[role]) return { error: "Invalid role" };
  if (!username || username.length < 2) return { error: "Username too short" };
  if (!password || password.length < 8) return { error: "Password must be at least 8 characters" };
  if (_users.has(username)) return { error: "User already exists" };
  const passwordHash = hashPassword(password);
  const now = new Date().toISOString();
  const userData = {
    passwordHash, role, namespaces,
    displayName: displayName || username,
    createdAt: now, passwordChangedAt: now,
    lastLogin: null, active: true, forcePasswordChange: false,
  };
  _users.set(username, userData);
  _userRoles.set(username, role);
  if (namespaces.length > 0) _userNamespaces.set(username, namespaces);
  _persistUserToDBTable(username, userData);
  _persistUsersToDB();
  return { ok: true, username, role };
}

export async function updateUser(username, updates) {
  const userData = _users.get(username);
  if (!userData) return { error: "User not found" };
  if (updates.password) {
    if (updates.password.length < 8) return { error: "Password must be at least 8 characters" };
    userData.passwordHash = hashPassword(updates.password);
    userData.passwordChangedAt = new Date().toISOString();
    userData.forcePasswordChange = false;
  }
  if (updates.role && ROLES[updates.role]) {
    userData.role = updates.role;
    _userRoles.set(username, updates.role);
  }
  if (updates.namespaces !== undefined) {
    userData.namespaces = Array.isArray(updates.namespaces) ? updates.namespaces : [];
    if (userData.namespaces.length > 0) _userNamespaces.set(username, userData.namespaces);
    else _userNamespaces.delete(username);
  }
  if (updates.displayName !== undefined) userData.displayName = updates.displayName;
  if (updates.active !== undefined) userData.active = !!updates.active;
  _persistUserToDBTable(username, userData);
  _persistUsersToDB();
  return { ok: true };
}

export async function deleteUser(username) {
  if (!_users.has(username)) return { error: "User not found" };
  _users.delete(username);
  _userRoles.delete(username);
  _userNamespaces.delete(username);
  dbQuery("DELETE FROM users WHERE username = $1", [username]).catch(() => {});
  _persistUsersToDB();
  return { ok: true };
}

export async function listUsers() {
  const result = [];
  for (const [username, u] of _users) {
    const daysAge = u.passwordChangedAt ? Math.floor((Date.now() - new Date(u.passwordChangedAt).getTime()) / 86400000) : null;
    result.push({
      username,
      role: u.role,
      namespaces: u.namespaces || [],
      display_name: u.displayName || username,
      created_at: u.createdAt,
      last_login: u.lastLogin,
      active: u.active !== false,
      password_changed_at: u.passwordChangedAt,
      passwordAgeDays: daysAge,
      passwordExpired: daysAge !== null && daysAge >= PASSWORD_MAX_AGE_DAYS,
      force_password_change: u.forcePasswordChange || false,
    });
  }
  return result;
}

export async function changePassword(username, oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) return { error: "Password must be at least 8 characters" };
  const userData = _users.get(username);
  if (!userData) return { error: "User not found" };
  if (oldPassword && !verifyPassword(oldPassword, userData.passwordHash)) return { error: "Current password is incorrect" };
  userData.passwordHash = hashPassword(newPassword);
  userData.passwordChangedAt = new Date().toISOString();
  userData.forcePasswordChange = false;
  _persistUserToDBTable(username, userData);
  _persistUsersToDB();
  return { ok: true };
}

async function authenticateUser(username, password) {
  const userData = _users.get(username);
  if (!userData) return null;
  if (!userData.active) return null;
  if (!verifyPassword(password, userData.passwordHash)) return null;
  const passwordAge = userData.passwordChangedAt ? (Date.now() - new Date(userData.passwordChangedAt).getTime()) / 86400000 : Infinity;
  const expired = passwordAge >= PASSWORD_MAX_AGE_DAYS || userData.forcePasswordChange;
  userData.lastLogin = new Date().toISOString();
  dbQuery("UPDATE users SET last_login = NOW() WHERE username = $1", [username]).catch(() => {});
  _persistUsersToDB();
  return { name: username, displayName: userData.displayName, role: userData.role, method: "password", passwordExpired: expired };
}

async function ensureDefaultAdmin() {
  if (_users.size > 0) {
    for (const [, u] of _users) { if (u.role === "admin") return; }
  }
  const adminPass = process.env.MCP_ADMIN_PASSWORD || API_TOKEN;
  if (!adminPass || adminPass === "CHANGEME") return;
  await createUser("admin", adminPass, "admin", "Admin");
  console.log("[auth] default admin user created");
}

export function getUserRole(username) {
  return _userRoles.get(username) || "viewer";
}

export async function setUserRole(username, role, namespaces) {
  if (!ROLES[role]) return false;
  _userRoles.set(username, role);
  if (namespaces !== undefined) {
    if (Array.isArray(namespaces) && namespaces.length > 0) {
      _userNamespaces.set(username, namespaces);
    } else {
      _userNamespaces.delete(username);
    }
    await persistUserNamespaces();
  }
  await persistUserRoles();
  return true;
}

export function getUserNamespaces(username) {
  return _userNamespaces.get(username) || [];
}

export function canAccessNamespace(username, namespace) {
  const role = getUserRole(username);
  if (ROLES[role]?.level >= 3) return true;
  const allowed = _userNamespaces.get(username);
  if (!allowed || allowed.length === 0 || allowed.includes("*")) return true;
  return allowed.includes(namespace);
}

export function filterByNamespace(username, items, nsExtractor) {
  const role = getUserRole(username);
  if (ROLES[role]?.level >= 3) return items;
  const allowed = _userNamespaces.get(username);
  if (!allowed || allowed.length === 0 || allowed.includes("*")) return items;
  const nsSet = new Set(allowed);
  return items.filter((item) => nsSet.has(nsExtractor(item)));
}

export function getAllUserRoles() {
  const result = {};
  for (const [user, role] of _userRoles) {
    result[user] = { role, namespaces: _userNamespaces.get(user) || [] };
  }
  return result;
}

export function hasPermission(username, permission) {
  const role = getUserRole(username);
  const roleDef = ROLES[role];
  return roleDef ? roleDef.permissions.includes(permission) : false;
}

export function checkPermission(req, permission) {
  if (AUTH_MODE === "none") return true;
  const username = req.user?.name || "anonymous";
  return hasPermission(username, permission);
}

export function getRoles() {
  return ROLES;
}

const PUBLIC_PATHS = new Set([
  "/healthz", "/readyz", "/metrics",
  "/api/auth/login", "/api/auth/callback", "/api/auth/status",
]);

const STATIC_EXT = new Set([".html", ".css", ".js", ".png", ".svg", ".ico", ".json", ".woff", ".woff2"]);

function isPublicPath(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/assets/") || pathname === "/favicon.ico") return true;
  const dot = pathname.lastIndexOf(".");
  if (dot > 0 && !pathname.startsWith("/api/") && STATIC_EXT.has(pathname.slice(dot))) return true;
  return false;
}

export function getAuthMode() {
  return AUTH_MODE;
}

export async function authMiddleware(req, res, url) {
  if (AUTH_MODE === "none") return true;
  if (isPublicPath(url.pathname)) return true;
  if (url.pathname === "/") return true;

  const sessionId = extractSessionId(req);
  if (sessionId) {
    const session = await getSession(sessionId);
    if (session && session.expiresAt > Date.now()) {
      req.user = session.user;
      return true;
    }
  }

  // Check Authorization header (for API/MCP clients)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    if (AUTH_MODE === "token" && API_TOKEN) {
      const provided = authHeader.replace(/^Bearer\s+/i, "");
      const providedBuf = Buffer.from(provided);
      const expectedBuf = Buffer.from(API_TOKEN);
      if (providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)) {
        req.user = { name: "api-client", method: "token" };
        return true;
      }
    }
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const user = await validateOAuthToken(token);
      if (user) {
        req.user = user;
        return true;
      }
    }
  }

  // Unauthenticated
  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 401, { error: "Authentication required", loginUrl: "/api/auth/login" });
  } else {
    res.writeHead(302, { Location: "/api/auth/login?redirect=" + encodeURIComponent(url.pathname) });
    res.end();
  }
  return false;
}

export function registerAuthRoutes(req, res, url) {
  // GET /api/auth/status
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const sessionId = extractSessionId(req);
    if (!sessionId) return sendJson(res, 200, { authenticated: false, mode: AUTH_MODE });
    getSession(sessionId).then((session) => {
      if (session && session.expiresAt > Date.now()) {
        const role = getUserRole(session.user.name);
        const roleDef = ROLES[role] || ROLES.viewer;
        sendJson(res, 200, { authenticated: true, user: { ...session.user, role, permissions: roleDef.permissions }, mode: AUTH_MODE });
      } else {
        sendJson(res, 200, { authenticated: false, mode: AUTH_MODE });
      }
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/roles") {
    sendJson(res, 200, { roles: ROLES, userRoles: getAllUserRoles() });
    return true;
  }

  // GET /api/auth/login
  if (req.method === "GET" && url.pathname === "/api/auth/login") {
    const redirect = url.searchParams.get("redirect") || "/";
    if (AUTH_MODE === "oauth") {
      const state = randomBytes(16).toString("hex");
      const oauthUrl = `${OPENSHIFT_OAUTH_URL}/oauth/authorize?client_id=${OAUTH_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&state=${state}&scope=user:info`;
      res.writeHead(302, { Location: oauthUrl });
      res.end();
    } else {
      const accept = req.headers.accept || "";
      if (accept.includes("text/html")) {
        res.writeHead(302, { Location: "/" });
        res.end();
      } else {
        sendJson(res, 200, {
          mode: AUTH_MODE,
          message: AUTH_MODE === "none" ? "Authentication disabled" : "Provide token via POST /api/auth/token or use username/password",
          redirect,
        });
      }
    }
    return true;
  }

  // GET /api/auth/callback (OAuth callback)
  if (req.method === "GET" && url.pathname === "/api/auth/callback") {
    const code = url.searchParams.get("code");
    if (!code) {
      sendJson(res, 400, { error: "Missing authorization code" });
      return true;
    }
    handleOAuthCallback(code, res);
    return true;
  }

  // POST /api/auth/token (token login for dashboard)
  if (req.method === "POST" && url.pathname === "/api/auth/token") {
    return false; // handled by caller with readJsonBody
  }

  // POST /api/auth/logout
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const sessionId = extractSessionId(req);
    if (sessionId) {
      sessions.delete(sessionId);
      cacheSet(`session:${sessionId}`, null, 1).catch(() => {});
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "mcp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

export async function handleTokenLogin(body, res) {
  const { token, username, password } = body;

  // Username + password login (persistent DB users)
  if (username && password) {
    const user = await authenticateUser(username, password);
    if (user) {
      const session = await createSession(user);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `mcp_session=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`,
      });
      res.end(JSON.stringify({ ok: true, user: session.user }));
      return;
    }
    sendJson(res, 401, { error: "Invalid username or password" });
    return;
  }

  // Token-based login
  if (!token) {
    sendJson(res, 400, { error: "Missing token or credentials" });
    return;
  }
  if (AUTH_MODE === "token" && API_TOKEN && token.length === API_TOKEN.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN))) {
    if (!_userRoles.has("admin")) { _userRoles.set("admin", "admin"); persistUserRoles().catch(() => {}); }
    const session = await createSession({ name: "admin", method: "token" });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `mcp_session=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`,
    });
    res.end(JSON.stringify({ ok: true, user: session.user }));
    return;
  }
  // Try as OpenShift token
  const user = await validateOAuthToken(token);
  if (user) {
    const session = await createSession(user);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `mcp_session=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`,
    });
    res.end(JSON.stringify({ ok: true, user: session.user }));
    return;
  }
  sendJson(res, 401, { error: "Invalid token" });
}

export async function handleUserManagement(req, body, res, url) {
  // All user management requires admin role
  const username = req.user?.name || "anonymous";
  const role = getUserRole(username);
  if (ROLES[role]?.level < 3) {
    sendJson(res, 403, { error: "Admin access required" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/users") {
    const users = await listUsers();
    sendJson(res, 200, { users });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/users") {
    const result = await createUser(body.username, body.password, body.role || "viewer", body.displayName, body.namespaces || []);
    sendJson(res, result.ok ? 201 : 400, result);
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/auth/users/")) {
    const targetUser = decodeURIComponent(url.pathname.split("/").pop());
    const result = await updateUser(targetUser, body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/auth/users/")) {
    const targetUser = decodeURIComponent(url.pathname.split("/").pop());
    if (targetUser === username) {
      sendJson(res, 400, { error: "Cannot delete your own account" });
      return;
    }
    const result = await deleteUser(targetUser);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // POST /api/auth/change-password (any authenticated user can change own password)
  if (req.method === "POST" && url.pathname === "/api/auth/change-password") {
    const targetUser = body.username || req.user?.name;
    if (targetUser !== req.user?.name && ROLES[role]?.level < 3) {
      sendJson(res, 403, { error: "Can only change your own password (or be admin)" });
      return;
    }
    const result = await changePassword(targetUser, body.currentPassword, body.newPassword);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // GET /api/auth/password-policy
  if (req.method === "GET" && url.pathname === "/api/auth/password-policy") {
    sendJson(res, 200, {
      maxAgeDays: PASSWORD_MAX_AGE_DAYS,
      minLength: 8,
      sessionTtlHours: Math.round(SESSION_TTL / 3600),
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleOAuthCallback(code, res) {
  try {
    const tokenResp = await fetch(`${OPENSHIFT_OAUTH_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: OAUTH_REDIRECT_URI,
      }),
    });
    if (!tokenResp.ok) throw new Error(`OAuth token exchange failed: ${tokenResp.status}`);
    const tokenData = await tokenResp.json();
    const user = await validateOAuthToken(tokenData.access_token);
    if (!user) throw new Error("Failed to validate OAuth token");

    const session = await createSession(user);
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `mcp_session=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`,
    });
    res.end();
  } catch (err) {
    sendJson(res, 500, { error: `OAuth callback failed: ${err.message}` });
  }
}

async function validateOAuthToken(token) {
  try {
    const resp = await fetch(`${OPENSHIFT_OAUTH_URL}/apis/user.openshift.io/v1/users/~`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    return {
      name: user.metadata?.name || "unknown",
      fullName: user.fullName || "",
      groups: user.groups || [],
      method: "oauth",
    };
  } catch {
    return null;
  }
}

function extractSessionId(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/mcp_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

async function createSession(user) {
  const id = randomBytes(32).toString("hex");
  const session = { id, user, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL * 1000 };
  sessions.set(id, session);
  await cacheSet(`session:${id}`, JSON.stringify(session), SESSION_TTL).catch(() => {});
  return session;
}

async function getSession(id) {
  let session = sessions.get(id);
  if (session) return session;
  try {
    const cached = await cacheGet(`session:${id}`);
    if (cached) {
      session = JSON.parse(cached);
      sessions.set(id, session);
      return session;
    }
  } catch { /* ignore */ }
  return null;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
