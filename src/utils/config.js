/**
 * Configuration management module.
 *
 * Loads config from INI/TOML-like files with [section] headers and key=value
 * pairs. Supports a conf.d/ drop-in directory for overrides, and env vars
 * that take highest precedence (e.g. MCP_SERVER_PORT overrides [server] port).
 *
 * No external TOML/INI dependency -- we implement a simple parser inline.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  server: {
    port: 3000,
    transport: "sse",
    read_only: false,
    disable_destructive: false,
  },
  security: {
    redact_secrets: true,
    require_auth: false,
  },
  toolsets: {
    helm: true,
    tekton: true,
    kubevirt: true,
    network: true,
    generic: true,
    mustgather: true,
  },
  llm: {
    provider: "none",
    model: "",
    api_url: "",
  },
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _config = deepClone(DEFAULTS);
let _configPath = null;

// ---------------------------------------------------------------------------
// Simple INI/TOML parser
// ---------------------------------------------------------------------------

/**
 * Parse a simple INI/TOML config string into a nested object.
 *
 * Supported syntax:
 *   [section]
 *   key = value
 *   key = "quoted string"
 *   key = 'single quoted'
 *   key = true | false
 *   key = 42 | 3.14
 *   # comment lines
 *   ; comment lines
 *   blank lines are ignored
 */
function parseConfig(text) {
  const result = {};
  let currentSection = null;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();

    // Skip blanks and comments
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    // Section header
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Key = value
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue; // malformed line, skip

    const key = line.slice(0, eqIdx).trim().toLowerCase();
    let value = line.slice(eqIdx + 1).trim();

    // Strip inline comments (only if not inside quotes)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.search(/\s+[#;]/);
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    value = coerceValue(value);

    if (currentSection) {
      if (!result[currentSection]) result[currentSection] = {};
      result[currentSection][key] = value;
    } else {
      // Top-level key (no section)
      result[key] = value;
    }
  }
  return result;
}

/**
 * Coerce a string value to its proper JS type.
 */
function coerceValue(raw) {
  // Quoted strings -- strip quotes, return as-is
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  // Booleans
  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;

  // Numbers
  if (raw !== "" && !isNaN(raw) && raw.trim() === raw) {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Deep-merge helper
// ---------------------------------------------------------------------------

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Deep merge `source` into `target` (mutates target). Source wins on conflict.
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// Drop-in directory support
// ---------------------------------------------------------------------------

/**
 * Load all *.conf files from a conf.d/ directory next to the main config,
 * sorted alphabetically so later files override earlier ones.
 */
function loadDropIns(configPath) {
  const dir = join(dirname(configPath), "conf.d");
  if (!existsSync(dir)) return {};

  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".conf"))
      .sort();
  } catch {
    return {};
  }

  let merged = {};
  for (const file of files) {
    try {
      const text = readFileSync(join(dir, file), "utf-8");
      const parsed = parseConfig(text);
      merged = deepMerge(merged, parsed);
    } catch (err) {
      console.warn(`[config] failed to load drop-in ${file}: ${err.message}`);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Environment variable overrides
// ---------------------------------------------------------------------------

/**
 * Scan process.env for variables starting with MCP_ and overlay them onto
 * the config object. Mapping: MCP_SECTION_KEY -> config[section][key].
 *
 * Example: MCP_SERVER_PORT=8080 -> config.server.port = 8080
 */
function applyEnvOverrides(config) {
  const PREFIX = "MCP_";

  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith(PREFIX)) continue;

    const rest = envKey.slice(PREFIX.length).toLowerCase();
    // Find the longest matching section name
    let matchedSection = null;
    let remainder = null;

    for (const section of Object.keys(config)) {
      if (rest.startsWith(section + "_")) {
        if (!matchedSection || section.length > matchedSection.length) {
          matchedSection = section;
          remainder = rest.slice(section.length + 1);
        }
      }
    }

    if (matchedSection && remainder) {
      if (!config[matchedSection]) config[matchedSection] = {};
      config[matchedSection][remainder] = coerceValue(envValue);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load configuration from a file path. Merges defaults -> file -> drop-ins -> env.
 *
 * @param {string} configPath  Absolute or relative path to the main config file.
 * @returns {object}           The merged configuration object.
 */
export function loadConfig(configPath) {
  _configPath = configPath;
  _config = deepClone(DEFAULTS);

  // Layer 1: file
  if (configPath && existsSync(configPath)) {
    try {
      const text = readFileSync(configPath, "utf-8");
      const parsed = parseConfig(text);
      deepMerge(_config, parsed);
    } catch (err) {
      console.warn(`[config] failed to load ${configPath}: ${err.message}`);
    }

    // Layer 2: drop-ins
    const dropIns = loadDropIns(configPath);
    deepMerge(_config, dropIns);
  } else if (configPath) {
    console.warn(`[config] config file not found: ${configPath} — using defaults`);
  }

  // Layer 3: env var overrides (highest precedence)
  applyEnvOverrides(_config);

  return _config;
}

/**
 * Return the current merged config object.
 *
 * @returns {object}
 */
export function getConfig() {
  return _config;
}

/**
 * Get a specific config value by section and key, with an optional default.
 *
 * @param {string} section       The config section (e.g. "server").
 * @param {string} key           The key within the section (e.g. "port").
 * @param {*}      defaultValue  Fallback if the key is not set.
 * @returns {*}
 */
export function get(section, key, defaultValue = undefined) {
  const sec = _config[section];
  if (sec == null) return defaultValue;
  const val = sec[key];
  return val !== undefined ? val : defaultValue;
}

/**
 * Re-read config files and env vars, rebuilding the merged config.
 * Intended for use in a SIGHUP handler to pick up changes without restart.
 *
 * @returns {object}  The freshly merged configuration.
 */
export function reloadConfig() {
  if (!_configPath) {
    console.warn("[config] reloadConfig called but no configPath was set — loading defaults only");
    _config = deepClone(DEFAULTS);
    applyEnvOverrides(_config);
    return _config;
  }
  console.log(`[config] reloading configuration from ${_configPath}`);
  return loadConfig(_configPath);
}
