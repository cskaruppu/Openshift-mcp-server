/**
 * TCS Agentic AI — Agent Catalog, as a workbook.
 * Generates: docs/TCS-Agentic-AI-Agent-Catalog.xlsx
 *
 * Same source of truth as the Markdown catalog — src/agents/manifests/ — so the
 * two cannot disagree. Re-run both after adding or changing an agent.
 *
 * Run: node docs/generate-agent-catalog-excel.cjs [--base https://your-host]
 */
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const MANIFESTS = path.resolve(__dirname, "../src/agents/manifests");
const OUT = path.join(__dirname, "TCS-Agentic-AI-Agent-Catalog.xlsx");

// Base URL precedence: --base flag, then PUBLIC_BASE_URL, then the placeholder.
// Without the env fallback a regeneration silently reverts every URL in the
// workbook to <your-host>, which is worse than not regenerating at all.
const argv = process.argv.slice(2);
const bi = argv.indexOf("--base");
const BASE = (bi !== -1 ? argv[bi + 1] : (process.env.PUBLIC_BASE_URL || "https://<your-host>"))
  .replace(/\/+$/, "");

const agents = fs.readdirSync(MANIFESTS)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(MANIFESTS, f), "utf8")))
  .sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));

const totalTools = agents.reduce((n, a) => n + (a.tools || []).length, 0);
const sseUrl = (id) => `${BASE}/mcp/${id}/sse`;
const msgUrl = (id) => `${BASE}/mcp/${id}/message`;

const wb = new ExcelJS.Workbook();
wb.creator = "TCS Agentic AI Platform";
wb.created = new Date();
wb.title = "TCS Agentic AI — Agent Catalog";
wb.company = "Tata Consultancy Services";
wb.subject = `Integration reference — ${agents.length} agents, ${totalTools} tools, MCP over SSE`;

const C = {
  darkNavy: "0F172A", navy: "1E293B", tcsBlue: "2563EB", lightBlue: "DBEAFE", paleBlue: "EFF6FF",
  aiPurple: "7C3AED", lightPurple: "EDE9FE",
  autoGreen: "059669", lightGreen: "D1FAE5", darkGreen: "065F46",
  userAmber: "D97706", lightAmber: "FEF3C7", darkAmber: "92400E",
  valCyan: "0891B2", lightCyan: "CFFAFE",
  secRed: "DC2626", lightRed: "FEE2E2", darkRed: "991B1B",
  white: "FFFFFF", bgLight: "F8FAFC", border: "CBD5E1",
  textDark: "1E293B", textMed: "475569", slate: "64748B", lightSlate: "F1F5F9",
};

const thin = { style: "thin", color: { argb: "FF" + C.border } };
const bd = { top: thin, bottom: thin, left: thin, right: thin };
const F = "Calibri";
const MONO = "Consolas";
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + argb } });

function banner(ws, title, subtitle, span) {
  ws.mergeCells(1, 1, 1, span);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: F, size: 16, bold: true, color: { argb: "FF" + C.white } };
  t.fill = fill(C.darkNavy);
  t.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(1).height = 32;
  if (subtitle) {
    ws.mergeCells(2, 1, 2, span);
    const s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { name: F, size: 10.5, italic: true, color: { argb: "FF" + C.textMed } };
    s.fill = fill(C.paleBlue);
    s.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
    ws.getRow(2).height = 26;
    return 4;
  }
  return 3;
}
function headerRow(ws, rowIdx, cells) {
  const r = ws.getRow(rowIdx);
  cells.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    cell.value = c;
    cell.font = { name: F, size: 10.5, bold: true, color: { argb: "FF" + C.white } };
    cell.fill = fill(C.navy);
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
    cell.border = bd;
  });
  r.height = 26;
  return rowIdx + 1;
}
function dataRows(ws, startRow, rows, opts = {}) {
  let r = startRow;
  rows.forEach((row, ri) => {
    const xr = ws.getRow(r);
    row.forEach((v, i) => {
      const cell = xr.getCell(i + 1);
      const isObj = v && typeof v === "object" && !Array.isArray(v);
      cell.value = isObj ? v.t : v;
      cell.font = {
        name: isObj && v.mono ? MONO : F,
        size: isObj && v.mono ? 9.5 : 10,
        bold: isObj ? !!v.b : (i === 0 && opts.boldFirst !== false),
        color: { argb: "FF" + (isObj && v.c ? v.c : C.textDark) },
      };
      cell.fill = fill(isObj && v.bg ? v.bg : (ri % 2 === 0 ? C.white : C.bgLight));
      cell.alignment = { vertical: "top", horizontal: "left", wrapText: true, indent: 1 };
      cell.border = bd;
    });
    xr.height = opts.height || 30;
    r++;
  });
  return r;
}
function note(ws, rowIdx, span, text, bg, fg) {
  ws.mergeCells(rowIdx, 1, rowIdx, span);
  const c = ws.getCell(rowIdx, 1);
  c.value = text;
  c.font = { name: F, size: 10.5, bold: true, color: { argb: "FF" + fg } };
  c.fill = fill(bg);
  c.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
  c.border = bd;
  ws.getRow(rowIdx).height = 34;
  return rowIdx + 2;
}
/** A block of literal text (config, code) in a monospace column. */
function codeBlock(ws, rowIdx, span, text) {
  const lines = text.split("\n");
  for (const line of lines) {
    ws.mergeCells(rowIdx, 1, rowIdx, span);
    const c = ws.getCell(rowIdx, 1);
    c.value = line;
    c.font = { name: MONO, size: 9.5, color: { argb: "FF" + C.textDark } };
    c.fill = fill(C.lightSlate);
    c.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(rowIdx).height = 15;
    rowIdx++;
  }
  return rowIdx + 1;
}
/** Live hyperlink, so a reader can click an endpoint straight out of the sheet. */
const link = (url) => ({ t: { text: url, hyperlink: url }, mono: true, c: "1D4ED8" });

const URL_COL = 78;

// ═══ 1. INDEX ═══════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("1. Agent Index", { properties: { tabColor: { argb: "FF" + C.tcsBlue } } });
  ws.columns = [{ width: 34 }, { width: 20 }, { width: 30 }, { width: 9 }, { width: URL_COL }];
  let r = banner(ws, "TCS Agentic AI — Agent Catalog",
    `${agents.length} agents · ${totalTools} tools. Each row is a complete, connectable MCP endpoint — nothing to assemble.`, 5);
  r = headerRow(ws, r, ["Agent", "Category", "Agent ID", "Tools", "MCP endpoint (SSE) — connect here"]);
  r = dataRows(ws, r, agents.map((a) => [
    a.name,
    a.category || "Other",
    { t: a.id, mono: true },
    (a.tools || []).length,
    link(sseUrl(a.id)),
  ]), { height: 24 });
  r++;
  r = note(ws, r, 5,
    "Connect with GET on the URL above. The SSE stream issues a sessionId; replies go to the same path with /message?sessionId=<id>. Connecting to the bare /mcp/<agent-id> returns 404 — the transport lives on /sse.",
    C.lightBlue, "1E40AF");
  note(ws, r, 5,
    `The whole registry is also reachable as one MCP server at ${BASE}/sse, carrying all ${totalTools} tools. Prefer a specific agent — a focused tool list measurably improves tool selection.`,
    C.lightAmber, C.darkAmber);
  ws.views = [{ state: "frozen", ySplit: 4 }];
}

// ═══ 2. ENDPOINTS ═══════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("2. Endpoints", { properties: { tabColor: { argb: "FF" + C.valCyan } } });
  ws.columns = [{ width: 30 }, { width: URL_COL }, { width: URL_COL }, { width: 62 }];
  let r = banner(ws, "Every endpoint, per agent",
    "Copy a whole column straight into a client config or a service catalogue. All three URLs are live links.", 4);
  r = headerRow(ws, r, ["Agent ID", "SSE (GET — connect)", "Message (POST — reply)", "Tool list (GET — REST)"]);
  r = dataRows(ws, r, agents.map((a) => [
    { t: a.id, mono: true, b: true },
    link(sseUrl(a.id)),
    link(msgUrl(a.id)),
    link(`${BASE}/api/agents/${a.id}/tools`),
  ]), { height: 22 });
  r++;
  note(ws, r, 4,
    "The MCP client library performs the SSE handshake for you — you supply the SSE URL only. The message URL is listed because proxy and firewall rules must permit both.",
    C.lightCyan, "155E75");
  ws.views = [{ state: "frozen", ySplit: 4 }];
}

// ═══ 3. TOOLS ═══════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("3. Tools", { properties: { tabColor: { argb: "FF" + C.aiPurple } } });
  ws.columns = [{ width: 34 }, { width: 30 }, { width: 20 }, { width: 42 }, { width: URL_COL }];
  let r = banner(ws, `All ${totalTools} tools, and the agent that carries each`,
    "Filter or sort this sheet to find the tool you need, then connect to the agent in the last column.", 5);
  r = headerRow(ws, r, ["Agent", "Agent ID", "Category", "Tool", "MCP endpoint (SSE)"]);
  const rows = [];
  for (const a of agents) {
    for (const t of a.tools || []) {
      rows.push([a.name, { t: a.id, mono: true }, a.category || "Other", { t, mono: true, b: true }, link(sseUrl(a.id))]);
    }
  }
  r = dataRows(ws, r, rows, { height: 20 });
  // AutoFilter so a consumer can narrow to one category or agent.
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: r - 1, column: 5 } };
  ws.views = [{ state: "frozen", ySplit: 4 }];
}

// ═══ 4. CAPABILITIES ════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("4. Capabilities", { properties: { tabColor: { argb: "FF" + C.autoGreen } } });
  ws.columns = [{ width: 34 }, { width: 20 }, { width: 10 }, { width: 100 }];
  let r = banner(ws, "What each agent is for",
    "Description and declared capabilities, straight from the manifest the server loads.", 4);
  r = headerRow(ws, r, ["Agent", "Category", "Version", "Description and capabilities"]);
  const rows = [];
  for (const a of agents) {
    rows.push([
      { t: a.name, b: true },
      a.category || "Other",
      `v${a.version || "1.0.0"}`,
      a.description,
    ]);
    for (const c of a.capabilities || []) {
      rows.push(["", "", "", { t: "•  " + c, c: C.textMed }]);
    }
  }
  r = dataRows(ws, r, rows, { height: 28 });
  ws.views = [{ state: "frozen", ySplit: 4 }];
}

// ═══ 5. HOW TO CONNECT ══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("5. How to Connect", { properties: { tabColor: { argb: "FF" + C.userAmber } } });
  ws.columns = [{ width: 28 }, { width: 108 }];
  let r = banner(ws, "What another team needs to connect",
    "Four things. Get all four right and any MCP-capable framework talks to these agents unmodified.", 2);
  r = headerRow(ws, r, ["Requirement", "Detail"]);
  r = dataRows(ws, r, [
    ["The URL", "Any SSE endpoint from the Agent Index or Endpoints sheet — used as-is, nothing to append."],
    ["A bearer token", "Authorization: Bearer <token> on every request when AUTH_MODE=token. Issue a dedicated token per consuming system rather than sharing one — a shared token cannot be revoked for one consumer."],
    ["Network reach", "The route must be resolvable and reachable from wherever the client runs. A client outside the cluster needs the external route; a client inside can use the in-cluster Service."],
    ["Un-buffered SSE", "The transport is server-sent events. An ingress, proxy or WAF that buffers responses breaks it SILENTLY — the connection appears to open and no events ever arrive. This is the single most common integration failure."],
  ], { height: 46 });
  r++;
  r = note(ws, r, 2, "Verify all four with one command before handing the endpoint to anyone:", C.lightAmber, C.darkAmber);
  r = codeBlock(ws, r, 2,
    `curl -N -H "Authorization: Bearer $MCP_API_TOKEN" \\\n  ${sseUrl("vm-lifecycle")}`);
  r = note(ws, r, 2,
    "It should HANG OPEN and print an event: line. Returning immediately means the token, the route, or SSE buffering — in that order of likelihood.",
    C.lightGreen, C.darkGreen);

  r = headerRow(ws, r, ["Discovery endpoint", "Returns"]);
  r = dataRows(ws, r, [
    [link(`${BASE}/.well-known/agent.json`), "A2A agent card — every agent with its connectable URLs"],
    [link(`${BASE}/api/agents`), "All agents, with tool counts"],
    [link(`${BASE}/api/agents/<id>`), "One agent, including mcpSseUrl and mcpMessageUrl"],
    [link(`${BASE}/api/agents/<id>/tools`), "Just that agent's tool names"],
    [link(`${BASE}/api/agents/categories`), "Agents grouped by category"],
    [link(`${BASE}/openapi.yaml`), "REST surface, for clients that do not speak MCP at all"],
  ], { height: 24, boldFirst: false });
  r++;
  note(ws, r, 2,
    "Point a consumer at /.well-known/agent.json rather than at this workbook where you can — it is generated by the running server, so it cannot go stale.",
    C.lightBlue, "1E40AF");
}

// ═══ 6. CLIENT CONFIG ═══════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("6. Client Config", { properties: { tabColor: { argb: "FF" + C.navy } } });
  ws.columns = [{ width: 130 }];
  let r = banner(ws, "Paste-ready configuration",
    "Claude Desktop / Claude Code MCP config, and the equivalent in Python. Swap the agent id to reach another.", 1);

  r = note(ws, r, 1, "One agent — mcpServers block", C.lightBlue, "1E40AF");
  r = codeBlock(ws, r, 1, JSON.stringify({
    mcpServers: {
      "tcs-vm-lifecycle": {
        url: sseUrl("vm-lifecycle"),
        headers: { Authorization: "Bearer ${MCP_API_TOKEN}" },
      },
    },
  }, null, 2));

  r = note(ws, r, 1, `All ${agents.length} agents — paste straight into a client config`, C.lightBlue, "1E40AF");
  r = codeBlock(ws, r, 1, JSON.stringify({
    mcpServers: Object.fromEntries(agents.map((a) => [
      `tcs-${a.id}`,
      { url: sseUrl(a.id), headers: { Authorization: "Bearer ${MCP_API_TOKEN}" } },
    ])),
  }, null, 2));

  r = note(ws, r, 1,
    `Registering all ${agents.length} puts ${totalTools} tool definitions in front of the model at once. Workable, but selection degrades as the list grows — pick the two or three agents a given consumer actually needs.`,
    C.lightAmber, C.darkAmber);

  r = note(ws, r, 1, "Python — MCP SDK", C.lightPurple, "5B21B6");
  r = codeBlock(ws, r, 1, [
    "from mcp import ClientSession",
    "from mcp.client.sse import sse_client",
    "",
    `URL = "${sseUrl("vm-lifecycle")}"`,
    'HEADERS = {"Authorization": f"Bearer {TOKEN}"}',
    "",
    "async with sse_client(URL, headers=HEADERS) as (read, write):",
    "    async with ClientSession(read, write) as session:",
    "        await session.initialize()",
    "        tools = await session.list_tools()",
    "        print([t.name for t in tools.tools])",
    "",
    '        result = await session.call_tool("kubevirt_list_templates", {})',
    "        print(result.content[0].text)",
  ].join("\n"));

  r = note(ws, r, 1, "LangChain / LangGraph — two agents at once", C.lightPurple, "5B21B6");
  r = codeBlock(ws, r, 1, [
    "from langchain_mcp_adapters.client import MultiServerMCPClient",
    "",
    "client = MultiServerMCPClient({",
    '    "vm_lifecycle": {',
    `        "url": "${sseUrl("vm-lifecycle")}",`,
    '        "transport": "sse",',
    '        "headers": {"Authorization": f"Bearer {TOKEN}"},',
    "    },",
    '    "rca": {',
    `        "url": "${sseUrl("diagnostics-healing")}",`,
    '        "transport": "sse",',
    '        "headers": {"Authorization": f"Bearer {TOKEN}"},',
    "    },",
    "})",
    "tools = await client.get_tools()   # both agents, as LangChain tools",
  ].join("\n"));

  r = note(ws, r, 1, "Plain REST — no MCP client at all", C.lightCyan, "155E75");
  codeBlock(ws, r, 1, [
    `curl -s -H "Authorization: Bearer $MCP_API_TOKEN" \\`,
    `  ${BASE}/api/agents | jq '.agents[] | {id, name, toolCount}'`,
    "",
    "# what one agent can do",
    `curl -s -H "Authorization: Bearer $MCP_API_TOKEN" \\`,
    `  ${BASE}/api/agents/vm-lifecycle/tools | jq`,
  ].join("\n"));
}

// ═══ 7. CHOOSING AN AGENT ═══════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("7. Choosing an Agent", { properties: { tabColor: { argb: "FF" + C.secRed } } });
  ws.columns = [{ width: 52 }, { width: 30 }, { width: URL_COL }];
  let r = banner(ws, "Which agent do I want?",
    "Start here if you know the job but not the agent.", 3);
  r = headerRow(ws, r, ["If you want to…", "Use", "Connect to"]);
  const picks = [
    ["Diagnose a failing workload — RCA, evidence, remediation", "diagnostics-healing"],
    ["Provision or own a virtual machine end to end", "vm-lifecycle"],
    ["Read cluster state, nodes and inventory", "cluster-operations"],
    ["Deploy, scale or roll back workloads", "workload-management"],
    ["Check compliance posture or image vulnerabilities", "security-compliance"],
    ["Back up and restore", "backup-dr"],
    ["Metrics, GPU fleet, SLOs", "observability"],
    ["Raise or track a change record in ServiceNow", "itsm-change-management"],
    ["Predict risk or spot anomalies before they page someone", "proactive-intelligence"],
    ["Plan or execute a cluster upgrade", "upgrade-lifecycle"],
    ["Work across a fleet of clusters via ACM", "multi-cluster-acm"],
    ["Inspect networking, ingress or service mesh", "networking-mesh"],
    ["Drive pipelines and GitOps sync", "cicd-gitops"],
    ["Run Ansible automation", "automation-ansible"],
    ["Understand what changed in an application and why", "application-change-intelligence"],
  ].filter(([, id]) => agents.some((a) => a.id === id));
  r = dataRows(ws, r, picks.map(([want, id]) => [want, { t: id, mono: true, b: true }, link(sseUrl(id))]), { height: 24 });
  r++;
  note(ws, r, 3,
    "Give a consumer the smallest set of agents that does their job. Every extra agent adds tool definitions to the model's context and makes the wrong tool marginally more likely to be picked.",
    C.lightRed, C.darkRed);
  ws.views = [{ state: "frozen", ySplit: 4 }];
}

// ═══ 8. ABOUT ═══════════════════════════════════════════════════════════════
{
  const ws = wb.addWorksheet("8. About", { properties: { tabColor: { argb: "FF" + C.slate } } });
  ws.columns = [{ width: 30 }, { width: 100 }];
  let r = banner(ws, "About this workbook", null, 2);
  r = headerRow(ws, r, ["Attribute", "Detail"]);
  const cats = [...new Set(agents.map((a) => a.category || "Other"))].sort();
  r = dataRows(ws, r, [
    ["Product", "TCS Agentic AI for Hybrid Infrastructure"],
    ["Document", "Agent Catalog — integration reference"],
    ["Agents", String(agents.length)],
    ["Tools", String(totalTools)],
    ["Categories", cats.join(" · ")],
    ["Base URL", { t: BASE, mono: true }],
    ["Protocol", "Model Context Protocol (MCP) over SSE · A2A agent card for discovery"],
    ["Generated", new Date().toISOString().slice(0, 10)],
    ["Source of truth", { t: "src/agents/manifests/*.json", mono: true }],
    ["Regenerate", { t: "npm run docs:agents:xlsx", mono: true }],
    ["Markdown twin", { t: "docs/AGENT-CATALOG.md — npm run docs:agents", mono: true }],
  ], { height: 26 });
  r++;
  note(ws, r, 2,
    "Generated from the manifests the server itself loads — do not edit by hand. Re-run both generators after adding or changing an agent, or the two documents will disagree.",
    C.lightAmber, C.darkAmber);
}

wb.xlsx.writeFile(OUT).then(() => {
  console.log(`Wrote ${OUT}`);
  console.log(`  ${agents.length} agents · ${totalTools} tools · ${wb.worksheets.length} sheets · base ${BASE}`);
  if (BASE.includes("<your-host>")) {
    console.warn("  WARNING: no base URL supplied — every endpoint is a placeholder.");
  }
});
