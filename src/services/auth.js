/**
 * Authentication & Session Management
 *
 * Supports two modes:
 *   1. OpenShift OAuth — uses the cluster's OAuth server for SSO
 *   2. Token-based — validates a static API token (for headless/MCP clients)
 *
 * Sessions stored in-memory with Redis fallback for HA.
 */

import { randomBytes, createHash } from "node:crypto";
import { cacheGet, cacheSet } from "../utils/cache.js";
import { query as dbQuery } from "../utils/db.js";

const SESSION_TTL = parseInt(process.env.SESSION_TTL || "28800", 10); // 8 hours
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

export function getUserRole(username) {
  return _userRoles.get(username) || "viewer";
}

export async function setUserRole(username, role) {
  if (!ROLES[role]) return false;
  _userRoles.set(username, role);
  await persistUserRoles();
  return true;
}

export function getAllUserRoles() {
  return Object.fromEntries(_userRoles);
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
  "/healthz", "/readyz", "/metrics", "/sse", "/message",
  "/api/auth/login", "/api/auth/callback", "/api/auth/status",
  "/api/diag",
]);

function isPublicPath(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/assets/") || pathname === "/favicon.ico") return true;
  return false;
}

export function getAuthMode() {
  return AUTH_MODE;
}

export async function authMiddleware(req, res, url) {
  if (AUTH_MODE === "none") return true;
  if (isPublicPath(url.pathname)) return true;

  // Allow login page itself
  if (url.pathname === "/" && !req.headers.cookie?.includes("mcp_session")) {
    // Will be redirected to login by the static file handler
    return true;
  }

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
      if (provided === API_TOKEN) {
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
      sendJson(res, 200, {
        mode: AUTH_MODE,
        message: AUTH_MODE === "none" ? "Authentication disabled" : "Provide token via Authorization: Bearer <token> header",
        redirect,
      });
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
  const { token } = body;
  if (!token) {
    sendJson(res, 400, { error: "Missing token" });
    return;
  }
  if (AUTH_MODE === "token" && token === API_TOKEN) {
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
