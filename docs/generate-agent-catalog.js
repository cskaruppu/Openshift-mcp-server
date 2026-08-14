#!/usr/bin/env node
/**
 * Generates docs/AGENT-CATALOG.md — the integration reference for every agent
 * in the registry, with its endpoints and tools.
 *
 * Generated from the manifests themselves, so the document cannot drift from
 * what the server actually serves. Re-run after adding or changing an agent.
 *
 * Run: node docs/generate-agent-catalog.js [--base https://your-host]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS = resolve(__dirname, "../src/agents/manifests");
const OUT = resolve(__dirname, "AGENT-CATALOG.md");

// Base URL precedence: --base flag, then PUBLIC_BASE_URL, then the placeholder.
// Without the env fallback a regeneration silently reverts every URL in the
// document to <your-host>, which is worse than not regenerating at all.
const argv = process.argv.slice(2);
const bi = argv.indexOf("--base");
const BASE = (bi !== -1 ? argv[bi + 1] : (process.env.PUBLIC_BASE_URL || "https://<your-host>"))
  .replace(/\/+$/, "");

const files = (await readdir(MANIFESTS)).filter((f) => f.endsWith(".json"));
const agents = [];
for (const f of files) {
  agents.push(JSON.parse(await readFile(resolve(MANIFESTS, f), "utf8")));
}
agents.sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));

const totalTools = agents.reduce((n, a) => n + (a.tools || []).length, 0);
const byCat = {};
for (const a of agents) (byCat[a.category || "Other"] ||= []).push(a);

const L = [];
const p = (s = "") => L.push(s);

p("# Agent Catalog");
p();
p("Every agent this platform exposes, with the endpoint to reach it and the tools it carries.");
p("**Generated from `src/agents/manifests/` — do not edit by hand.**");
p("Re-run `npm run docs:agents` after adding or changing an agent.");
p();
p(`**${agents.length} agents · ${totalTools} tools.**`);
p();

// ── how to connect ──────────────────────────────────────────────────────────
p("## How to connect");
p();
p("Each agent is a separate MCP server over SSE. Two URLs per agent:");
p();
p("| | |");
p("|---|---|");
p("| **Connect** | `GET  " + BASE + "/mcp/<agent-id>/sse` |");
p("| **Reply** | `POST " + BASE + "/mcp/<agent-id>/message?sessionId=<id>` |");
p();
p("The SSE stream issues the `sessionId`; the MCP client library handles that handshake.");
p("**Connecting to the bare `/mcp/<agent-id>` returns 404** — the transport lives on `/sse`.");
p();
p("### Discovery");
p();
p("| Endpoint | Returns |");
p("|---|---|");
p("| `GET " + BASE + "/.well-known/agent.json` | A2A agent card — every agent with its connectable URLs |");
p("| `GET " + BASE + "/api/agents` | All agents, with tool counts |");
p("| `GET " + BASE + "/api/agents/<id>` | One agent, including `mcpSseUrl` and `mcpMessageUrl` |");
p("| `GET " + BASE + "/api/agents/<id>/tools` | Just that agent's tool names |");
p("| `GET " + BASE + "/api/agents/categories` | Agents grouped by category |");
p("| `GET " + BASE + "/openapi.yaml` | REST surface, for non-MCP clients |");
p();
p("### Authentication");
p();
p("When `AUTH_MODE=token`, pass the bearer token on every request:");
p();
p("```");
p("Authorization: Bearer $MCP_API_TOKEN");
p("```");
p();
p("The whole registry is also reachable as a single MCP server at `" + BASE + "/sse`,");
p("carrying all " + totalTools + " tools. Prefer a **specific agent** — a focused tool list");
p("measurably improves tool selection, and keeps an unrelated agent's tools out of the model's");
p("context.");
p();

// ── index ───────────────────────────────────────────────────────────────────
p("## Index — every agent and its endpoint");
p();
p("Each row is a complete, connectable URL. Nothing to assemble.");
p();
p("| Agent | Tools | MCP endpoint (SSE) |");
p("|---|---|---|");
for (const a of agents) {
  p(`| **${a.name}**<br><sub>${a.category} · \`${a.id}\`</sub> | ${(a.tools || []).length} | \`${BASE}/mcp/${a.id}/sse\` |`);
}
p();
p("<details><summary>All endpoints as a plain list — for bulk copy or config generation</summary>");
p();
p("```");
for (const a of agents) {
  p(`${a.id.padEnd(32)} ${BASE}/mcp/${a.id}/sse`);
}
p("```");
p();
p("</details>");
p();
p("### What another team needs to connect");
p();
p("| | |");
p("|---|---|");
p("| **The URL** | Any row above — used as-is |");
p("| **A bearer token** | `Authorization: Bearer <token>` when `AUTH_MODE=token`. Issue a dedicated token per consuming system rather than sharing one |");
p("| **Network reach** | The route must be resolvable and reachable from wherever the client runs |");
p("| **Un-buffered SSE** | The transport is server-sent events. An ingress or proxy that buffers responses breaks it silently — the connection appears to open and no events arrive |");
p();
p("Verify all four with one command before handing the endpoint to anyone:");
p();
p("```bash");
p(`curl -N -H "Authorization: Bearer $MCP_API_TOKEN" \\`);
p(`  ${BASE}/mcp/vm-lifecycle/sse`);
p("```");
p();
p("It should **hang open** and print an `event:` line. Returning immediately means the token,");
p("the route, or SSE buffering — in that order of likelihood.");
p();

// ── per-agent detail ────────────────────────────────────────────────────────
for (const cat of Object.keys(byCat).sort()) {
  p(`## ${cat}`);
  p();
  for (const a of byCat[cat]) {
    p(`### ${a.name}`);
    p();
    p(`\`${a.id}\` · v${a.version || "1.0.0"} · ${(a.tools || []).length} tools`);
    p();
    p(a.description);
    p();
    p("```");
    p(`SSE      ${BASE}/mcp/${a.id}/sse`);
    p(`MESSAGE  ${BASE}/mcp/${a.id}/message`);
    p("```");
    p();
    if (a.capabilities?.length) {
      p("**Capabilities**");
      p();
      for (const c of a.capabilities) p(`- ${c}`);
      p();
    }
    p("<details><summary>" + (a.tools || []).length + " tools</summary>");
    p();
    for (const t of a.tools || []) p(`- \`${t}\``);
    p();
    p("</details>");
    p();
    if (a.tags?.length) p(`*Tags: ${a.tags.map((t) => `\`${t}\``).join(" · ")}*`);
    p();
  }
}

// ── framework examples ──────────────────────────────────────────────────────
p("## Integrating");
p();
p("Every example below connects to **one** agent. Swap the id to reach another.");
p();

p("### Claude Desktop / Claude Code");
p();
p("One agent:");
p();
p("```json");
p(JSON.stringify({
  mcpServers: {
    "tcs-vm-lifecycle": {
      url: `${BASE}/mcp/vm-lifecycle/sse`,
      headers: { Authorization: "Bearer ${MCP_API_TOKEN}" },
    },
  },
}, null, 2));
p("```");
p();
p("<details><summary>Or all " + agents.length + " — paste straight into a client config</summary>");
p();
p("```json");
p(JSON.stringify({
  mcpServers: Object.fromEntries(agents.map((a) => [
    `tcs-${a.id}`,
    { url: `${BASE}/mcp/${a.id}/sse`, headers: { Authorization: "Bearer ${MCP_API_TOKEN}" } },
  ])),
}, null, 2));
p("```");
p();
p("Registering all fifteen puts " + totalTools + " tool definitions in front of the model at once.");
p("Workable, but selection degrades as the list grows — pick the two or three agents a given");
p("consumer actually needs.");
p();
p("</details>");
p();

p("### Python — MCP SDK");
p();
p("```python");
p("from mcp import ClientSession");
p("from mcp.client.sse import sse_client");
p("");
p(`URL = "${BASE}/mcp/vm-lifecycle/sse"`);
p('HEADERS = {"Authorization": f"Bearer {TOKEN}"}');
p("");
p("async with sse_client(URL, headers=HEADERS) as (read, write):");
p("    async with ClientSession(read, write) as session:");
p("        await session.initialize()");
p("        tools = await session.list_tools()");
p("        print([t.name for t in tools.tools])");
p("");
p('        result = await session.call_tool("kubevirt_list_templates", {})');
p("        print(result.content[0].text)");
p("```");
p();

p("### LangChain / LangGraph");
p();
p("```python");
p("from langchain_mcp_adapters.client import MultiServerMCPClient");
p("");
p("client = MultiServerMCPClient({");
p('    "vm_lifecycle": {');
p(`        "url": "${BASE}/mcp/vm-lifecycle/sse",`);
p('        "transport": "sse",');
p('        "headers": {"Authorization": f"Bearer {TOKEN}"},');
p("    },");
p('    "rca": {');
p(`        "url": "${BASE}/mcp/diagnostics-healing/sse",`);
p('        "transport": "sse",');
p('        "headers": {"Authorization": f"Bearer {TOKEN}"},');
p("    },");
p("})");
p("tools = await client.get_tools()   # both agents, as LangChain tools");
p("```");
p();

p("### Microsoft Agent Framework");
p();
p("See `adapters/microsoft-agent-framework/` for a working multi-agent orchestrator");
p("against these endpoints.");
p();

p("### Plain REST — no MCP client");
p();
p("```bash");
p(`curl -s -H "Authorization: Bearer $MCP_API_TOKEN" \\`);
p(`  ${BASE}/api/agents | jq '.agents[] | {id, name, toolCount}'`);
p("");
p("# what one agent can do");
p(`curl -s -H "Authorization: Bearer $MCP_API_TOKEN" \\`);
p(`  ${BASE}/api/agents/vm-lifecycle/tools | jq`);
p("```");
p();
p("The REST surface in `openapi.yaml` covers the common operations without MCP at all —");
p("useful for a system that only needs to read cluster state.");
p();

p("## Choosing an agent");
p();
p("| If you want to… | Use |");
p("|---|---|");
p("| Diagnose a failing workload | `diagnostics-healing` |");
p("| Provision or own a VM | `vm-lifecycle` |");
p("| Read cluster state and inventory | `cluster-operations` |");
p("| Deploy or scale workloads | `workload-management` |");
p("| Check compliance or image vulnerabilities | `security-compliance` |");
p("| Backup and restore | `backup-dr` |");
p("| Metrics, GPU fleet, SLOs | `observability` |");
p("| Raise or track a change record | `itsm-change-management` |");
p("| Predict risk or spot anomalies | `proactive-intelligence` |");
p();

const now = new Date().toISOString().slice(0, 10);
p("---");
p();
p(`*Generated ${now} from ${agents.length} manifests, against \`${BASE}\`.*`);
p();
p("*Regenerate with* `npm run docs:agents` *— the host comes from `PUBLIC_BASE_URL`,");
p("or pass* `-- --base https://another-host`*.*");

await writeFile(OUT, L.join("\n") + "\n", "utf8");
console.log(`Wrote ${OUT}`);
console.log(`  ${agents.length} agents · ${totalTools} tools · base ${BASE}`);
