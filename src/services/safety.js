/**
 * Safety flags for --read-only and --disable-destructive modes.
 *
 * When read-only is enabled only GET / LIST operations are permitted.
 * When disable-destructive is enabled, dangerous mutations like delete,
 * drain, and cordon are blocked while still allowing benign writes.
 */

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _readOnly = false;
let _disableDestructive = false;

// ---------------------------------------------------------------------------
// Destructive operations registry
// ---------------------------------------------------------------------------

/**
 * Set of operation:resourceType combinations considered destructive.
 * A wildcard resource ("*") means the operation is destructive for any resource.
 */
export const DESTRUCTIVE_OPS = new Set([
  "delete:*",
  "drain:node",
  "cordon:node",
  "scale:deployment", // specifically scale-to-zero, but we block the op for safety
]);

/**
 * Operations that are inherently read-only and always safe.
 */
const READ_OPS = new Set(["get", "list", "watch"]);

/**
 * Operations that mutate state but are not necessarily destructive.
 */
const WRITE_OPS = new Set(["create", "update", "patch", "delete", "drain", "cordon", "uncordon", "scale"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDestructiveCombo(operation, resourceType) {
  const op = operation.toLowerCase();
  const rt = (resourceType || "*").toLowerCase();

  // Check exact match first
  if (DESTRUCTIVE_OPS.has(`${op}:${rt}`)) return true;

  // Check wildcard match (e.g. "delete:*")
  if (DESTRUCTIVE_OPS.has(`${op}:*`)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize safety settings from CLI args or config.
 *
 * @param {object} opts
 * @param {boolean} [opts.readOnly=false]            Block all write operations.
 * @param {boolean} [opts.disableDestructive=false]   Block destructive operations only.
 */
export function initSafety(opts = {}) {
  _readOnly = Boolean(opts.readOnly);
  _disableDestructive = Boolean(opts.disableDestructive);

  if (_readOnly) {
    console.log("[safety] read-only mode enabled — all write operations are blocked");
  }
  if (_disableDestructive) {
    console.log("[safety] disable-destructive mode enabled — destructive operations are blocked");
  }
}

/**
 * Returns true if read-only mode is currently active.
 *
 * @returns {boolean}
 */
export function isReadOnly() {
  return _readOnly;
}

/**
 * Returns true if destructive operations are currently disabled.
 *
 * @returns {boolean}
 */
export function isDestructiveDisabled() {
  return _disableDestructive;
}

/**
 * Check whether a given operation on a resource type is allowed under the
 * current safety settings. Returns { allowed: true } if permitted, otherwise
 * throws an Error with a descriptive message.
 *
 * @param {string} operation     The verb: "get", "list", "create", "update",
 *                               "patch", "delete", "drain", "cordon", "scale", etc.
 * @param {string} resourceType  The target resource kind: "pod", "node",
 *                               "deployment", etc.  Use "*" or omit for generic.
 * @returns {{ allowed: true }}
 * @throws {Error} If the operation is not allowed.
 */
export function checkSafety(operation, resourceType = "*") {
  const op = operation.toLowerCase();
  const rt = (resourceType || "*").toLowerCase();

  // ---- Read-only mode: only GET / LIST / WATCH allowed ----
  if (_readOnly) {
    if (!READ_OPS.has(op)) {
      throw new Error(
        `[safety] operation "${op}" on "${rt}" is blocked — server is in read-only mode. ` +
          `Only read operations (${[...READ_OPS].join(", ")}) are permitted.`
      );
    }
    return { allowed: true };
  }

  // ---- Disable-destructive mode: block known destructive combos ----
  if (_disableDestructive) {
    if (isDestructiveCombo(op, rt)) {
      throw new Error(
        `[safety] destructive operation "${op}" on "${rt}" is blocked — ` +
          `destructive operations are disabled. ` +
          `Blocked patterns: ${[...DESTRUCTIVE_OPS].join(", ")}.`
      );
    }
  }

  return { allowed: true };
}
