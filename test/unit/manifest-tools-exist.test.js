import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgents } from "../../src/agents/registry.js";

/**
 * A manifest lists the tools an agent exposes over MCP. Nothing checked that
 * those tools exist, so a manifest could advertise a surface the server does
 * not serve — and an external client connecting to /mcp/<agent>/sse would get
 * an empty tool list with no error anywhere.
 *
 * NOT the same as "the agent is broken": vm-migration does its work through
 * /api/migration/* and the Automation Hub, which is why nobody noticed. What is
 * broken is its ADVERTISED MCP surface, and the registry is where people go to
 * find out what an agent can do.
 *
 * KNOWN lists the gaps that exist today so the suite is honest about them while
 * failing on any NEW one.
 */
const KNOWN = new Set([
  // vm-migration — implemented as REST under /api/migration/*, driven by the
  // Automation Hub, and never registered as MCP tools. The agent works; its
  // advertised MCP surface is empty.
  "mtv_readiness_check", "mtv_list_providers", "mtv_list_maps", "mtv_discover_vms",
  "mtv_plan_preview", "mtv_create_plans", "mtv_plan_status", "mtv_start_migration",
  "mtv_migration_progress", "mtv_rollback_preview", "mtv_rollback_migration",
  "mtv_verify_migration",
  // application-change-intelligence — declared, never implemented anywhere.
  "app_watch_namespaces", "app_change_scan", "app_change_history",
  "app_gitops_drift", "app_change_rollback",
  // Declared on agents whose other tools do exist.
  "gpu_inventory", "gpu_overview", "gpu_stack_check",
  "image_vuln_scan", "image_vuln_report", "image_compliance_check",
  "deploy_from_document",
]);

async function registeredToolNames() {
  const src = await readFile("src/agents/mcp-router.js", "utf8");
  const imports = [...src.matchAll(/import \{ (register\w+) \} from "(.+?)";/g)];
  const server = new McpServer({ name: "probe", version: "1.0.0" });
  for (const [, fn, path] of imports) {
    try {
      const mod = await import(path.replace(/^\.\./, "/home/user/Openshift-mcp-server/src"));
      mod[fn]?.(server);
    } catch { /* a tool group that will not load registers nothing */ }
  }
  return new Set(Object.keys(server._registeredTools || {}));
}

test("no NEW manifest tool is advertised without an implementation", async () => {
  const real = await registeredToolNames();
  assert.ok(real.size > 100, `the probe registered only ${real.size} tools — it is not working`);

  const surprises = [];
  for (const a of await getAgents()) {
    for (const t of a.tools || []) {
      if (!real.has(t) && !KNOWN.has(t)) surprises.push(`${a.id} → ${t}`);
    }
  }
  assert.deepEqual(surprises, [],
    "these manifest tools have no implementation and are not in the known-gap list");
});

test("the known-gap list does not outlive the gaps", async () => {
  const real = await registeredToolNames();
  const fixed = [...KNOWN].filter((t) => real.has(t));
  assert.deepEqual(fixed, [],
    "these tools now exist — remove them from KNOWN so the guard stays meaningful");
});

test("a profile never advertises a tool its agent does not declare", async () => {
  for (const a of await getAgents()) {
    const declared = new Set(a.tools || []);
    for (const [name, p] of Object.entries(a.profiles || {})) {
      for (const t of p.tools || []) {
        assert.ok(declared.has(t), `${a.id}:${name} names "${t}", which the agent does not declare`);
      }
    }
  }
});
