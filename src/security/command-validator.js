/**
 * Command Injection Prevention Layer.
 *
 * Validates any user-supplied command string before it reaches the shell or
 * K8s API. Blocks shell meta-characters, injection patterns, and dangerous
 * constructs. Modelled after Azure AKS MCP security/validator.go but adapted
 * for OpenShift and Node.js.
 *
 * This module is a pure gate — if validation passes, the existing execution
 * flow runs unchanged. If it fails, execution is blocked early with a clear
 * reason. No existing logic is modified.
 */

// ── Dangerous shell patterns ────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  { pattern: /;\s*/,                    reason: "Command separator (;) detected — possible injection" },
  { pattern: /\|\|/,                    reason: "Logical OR (||) detected — possible injection" },
  { pattern: /&&/,                      reason: "Logical AND (&&) detected — possible injection" },
  { pattern: /\|(?!\|)/,               reason: "Pipe (|) detected — possible injection" },
  { pattern: /`[^`]*`/,                reason: "Backtick command substitution detected" },
  { pattern: /\$\(/,                    reason: "Command substitution $() detected" },
  { pattern: /\$\{/,                    reason: "Variable expansion ${} detected" },
  { pattern: />>\s*/,                   reason: "Append redirection (>>) detected" },
  { pattern: /(?<![<])>\s*/,            reason: "Output redirection (>) detected" },
  { pattern: /(?<![<])<(?![<])/,        reason: "Input redirection (<) detected" },
  { pattern: /[\r\n]/,                  reason: "Newline in command — possible injection" },
  { pattern: /\x00/,                    reason: "Null byte detected" },
];

const BLOCKED_COMMANDS = [
  { pattern: /\brm\s+-r/i,                           reason: "Recursive removal is never allowed" },
  { pattern: /:\s*\(\s*\)\s*\{/,                      reason: "Fork bomb pattern detected" },
  { pattern: /\bmkfs\b/i,                             reason: "Filesystem destruction is blocked" },
  { pattern: /\bdd\s+if=/i,                           reason: "Raw disk operations are blocked" },
  { pattern: />\s*\/dev\/sd/i,                         reason: "Direct device writes are blocked" },
  { pattern: /\bcurl\b.*\|\s*(?:sh|bash)\b/i,         reason: "Piping curl to shell is blocked" },
  { pattern: /\bwget\b.*\|\s*(?:sh|bash)\b/i,         reason: "Piping wget to shell is blocked" },
  { pattern: /\beval\s+/i,                            reason: "eval command is blocked" },
  { pattern: /\bsource\s+/i,                          reason: "source command is blocked" },
  { pattern: /\bexec\s+\d*[<>]/i,                     reason: "File descriptor manipulation is blocked" },
];

// ── Access level definitions ────────────────────────────────────────────────

const ACCESS_LEVELS = {
  readonly:  0,
  readwrite: 1,
  admin:     2,
};

const READ_ONLY_VERBS = new Set([
  "get", "describe", "logs", "top", "events", "explain", "config",
  "version", "cluster-info", "status", "whoami", "api-resources",
  "api-versions", "auth", "diff", "wait",
]);

const READWRITE_BLOCKED_VERBS = new Set([
  "adm",
]);

// ── Validation result builder ───────────────────────────────────────────────

function pass() {
  return { valid: true, blocked: false, reason: null };
}

function block(reason) {
  return { valid: false, blocked: true, reason };
}

// ── Core validators ─────────────────────────────────────────────────────────

function validateInjection(command) {
  const cmd = String(command || "");

  for (const { pattern, reason } of BLOCKED_COMMANDS) {
    if (pattern.test(cmd)) return block(reason);
  }

  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(cmd)) return block(reason);
  }

  return pass();
}

function validateAccessLevel(command, accessLevel) {
  const level = ACCESS_LEVELS[accessLevel] ?? ACCESS_LEVELS.admin;

  if (level === ACCESS_LEVELS.admin) return pass();

  const tokens = String(command || "").trim().split(/\s+/).filter(t => !t.startsWith("-"));
  const verb = tokens[1];

  if (!verb) return pass();

  if (level === ACCESS_LEVELS.readonly) {
    if (!READ_ONLY_VERBS.has(verb)) {
      return block(`Access level 'readonly' does not allow '${verb}' operations`);
    }
  }

  if (level === ACCESS_LEVELS.readwrite) {
    if (READWRITE_BLOCKED_VERBS.has(verb)) {
      return block(`Access level 'readwrite' does not allow '${verb}' — requires admin`);
    }
  }

  return pass();
}

function validateNamespaceRestriction(command, allowedNamespaces) {
  if (!allowedNamespaces || allowedNamespaces.length === 0) return pass();

  const nsMatch = String(command).match(/(?:^|\s)(?:-n|--namespace)[=\s]+["']?([a-z0-9][-a-z0-9]*)["']?/i);
  if (!nsMatch) return pass();

  const ns = nsMatch[1];
  if (!allowedNamespaces.includes(ns)) {
    return block(`Namespace '${ns}' is not in the allowed list: ${allowedNamespaces.join(", ")}`);
  }

  return pass();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a command string for injection patterns and access control.
 *
 * @param {string} command           - Raw command string
 * @param {object} [opts]            - Options
 * @param {string} [opts.accessLevel] - "readonly" | "readwrite" | "admin" (default: "admin")
 * @param {string[]} [opts.allowedNamespaces] - Restrict to these namespaces (empty = all)
 * @returns {{ valid: boolean, blocked: boolean, reason: string|null }}
 */
export function validateCommand(command, opts = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return block("Empty command");

  const injectionResult = validateInjection(cmd);
  if (!injectionResult.valid) return injectionResult;

  const accessLevel = opts.accessLevel || process.env.ACCESS_LEVEL || "admin";
  const accessResult = validateAccessLevel(cmd, accessLevel);
  if (!accessResult.valid) return accessResult;

  const allowedNs = opts.allowedNamespaces || (process.env.ALLOWED_NAMESPACES ? process.env.ALLOWED_NAMESPACES.split(",").map(s => s.trim()) : []);
  const nsResult = validateNamespaceRestriction(cmd, allowedNs);
  if (!nsResult.valid) return nsResult;

  return pass();
}

/**
 * Get the current access level from environment.
 * @returns {"readonly"|"readwrite"|"admin"}
 */
export function getAccessLevel() {
  const level = (process.env.ACCESS_LEVEL || "admin").toLowerCase();
  return ACCESS_LEVELS[level] !== undefined ? level : "admin";
}

/**
 * Check if a specific MCP tool is allowed at the current access level.
 * Used by the component toggle system for tool-level gating.
 *
 * @param {string} toolName
 * @param {"readonly"|"readwrite"|"admin"} requiredLevel
 * @returns {boolean}
 */
export function isToolAllowed(toolName, requiredLevel = "readonly") {
  const current = ACCESS_LEVELS[getAccessLevel()] ?? ACCESS_LEVELS.admin;
  const required = ACCESS_LEVELS[requiredLevel] ?? ACCESS_LEVELS.readonly;
  return current >= required;
}
