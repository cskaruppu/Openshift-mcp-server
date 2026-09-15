/**
 * Which tools the server actually serves over MCP.
 *
 * A manifest lists the tools an agent exposes. Nothing verified that those
 * tools exist, and 24 of the 189 declared today do not — vm-migration declares
 * twelve that live nowhere, application-change-intelligence all five. Those
 * agents work, through REST and the Automation Hub; what is empty is the
 * surface the registry advertises, so a client connecting to
 * /mcp/vm-migration/sse receives nothing and no error.
 *
 * The only honest way to know is to ask the registrars, which means building a
 * throwaway MCP server and letting them register into it. That costs a couple
 * of hundred milliseconds, so it happens once per process and is cached: the
 * registrars are module-level functions over code that cannot change while the
 * process is running.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTER = resolve(__dirname, "mcp-router.js");
const SRC_ROOT = resolve(__dirname, "..");

let _index = null;      // Promise<Set<string>> | null

async function build() {
  const names = new Set();
  try {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const src = await readFile(ROUTER, "utf8");
    const server = new McpServer({ name: "tool-index-probe", version: "1.0.0" });

    // Read the registrar list from the router rather than duplicating it here:
    // a second copy would drift, and a drifted copy would report tools as
    // missing that are in fact served, which is worse than not checking.
    for (const [, fn, path] of src.matchAll(/import \{ (register\w+) \} from "(.+?)";/g)) {
      try {
        const mod = await import(path.replace(/^\.\./, SRC_ROOT));
        mod[fn]?.(server);
      } catch { /* a tool group that will not load registers nothing */ }
    }
    for (const name of Object.keys(server._registeredTools || {})) names.add(name);
  } catch {
    // The SDK could not be loaded. Returning an empty set would report every
    // tool as missing, so the caller is told the probe failed instead.
    return null;
  }
  // A probe that registered almost nothing is broken, not evidence that the
  // server serves almost nothing.
  return names.size > 20 ? names : null;
}

/** The served tool names, or null when the probe could not run. Cached. */
export function implementedTools() {
  if (!_index) _index = build();
  return _index;
}

/**
 * Which of an agent's declared tools are not served over MCP.
 *
 * Returns null — not an empty array — when the probe failed. An empty array
 * means "checked, none missing"; null means "could not check", and the
 * scorecard reports those very differently.
 */
export async function missingTools(declared = []) {
  const served = await implementedTools();
  if (!served) return null;
  return declared.filter((t) => !served.has(t));
}

export function _reset() { _index = null; }
