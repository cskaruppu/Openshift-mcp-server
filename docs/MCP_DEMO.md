# MCP Client Demo — "Same brain, any client"

The strongest, most unique part of this project: it is a **real MCP server**, not
a dashboard with a chatbot bolted on. Any MCP client (Claude Desktop, Cursor,
Claude Code, VS Code) can connect to the *same* server that powers the dashboard
and drive a live OpenShift/Kubernetes cluster.

## Verified facts (run the proof yourself)

```bash
npm install
node scripts/mcp-smoke-test.mjs
```

Expected output:

```
  ✅ MCP server responded over stdio

  Server:  tcs-agentic-ai v1.0.0
  Tools:   171
  Sample:  get_cluster_info, get_cluster_events, get_cluster_resource_usage, list_nodes …
```

- **Transport:** stdio (local) and SSE (in-cluster). stdio needs no auth.
- **Tools:** 171, across cluster / pods / nodes / security / GitOps / Velero /
  Tekton / KubeVirt / ServiceNow / Ansible / diagnostics / remediation.
- **SDK:** official `@modelcontextprotocol/sdk` ^1.12.1.
- **Node:** ≥ 20.

## Client configuration

Replace `/ABSOLUTE/PATH/TO/openshift-mcp-server` with the real path
(`pwd` in the repo). Provide cluster credentials via env (`KUBECONFIG` or
`OPENSHIFT_API_URL` + `OPENSHIFT_TOKEN`).

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "openshift": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/openshift-mcp-server/src/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "KUBECONFIG": "/ABSOLUTE/PATH/TO/.kube/config"
      }
    }
  }
}
```

Restart Claude Desktop → the tools appear under the 🔌 (plug) icon.

### Claude Code (CLI)

```bash
claude mcp add openshift -- node /ABSOLUTE/PATH/TO/openshift-mcp-server/src/index.js
```

### Cursor

`~/.cursor/mcp.json` (or Settings → MCP → Add):

```json
{
  "mcpServers": {
    "openshift": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/openshift-mcp-server/src/index.js"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

### VS Code (GitHub Copilot / MCP)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "openshift": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/openshift-mcp-server/src/index.js"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

## The 3-minute demo script

1. **Hook (15s):** "This is a self-healing Kubernetes control plane — and the AI
   driving it speaks MCP, so you can run it from *any* client."
2. **Dashboard → Capacity (30s):** Show the overcommit + a CrashLoop/OOM pod.
   Click **Triage →** (or ⌘K → "Triage failing pods").
3. **Agentic loop (45s):** The card recommends a fix → **Dry Run** (server-side)
   → **Apply** (guardrailed) → **Verified** badge.
4. **Governance (15s):** Open **Audit → Audit Trail** — the remediation is logged
   (command, risk classification, actor).
5. **Mic-drop (45s):** Switch to **Claude Desktop**. It's connected to the *same*
   MCP server. Type: *"List the nodes and tell me which are under memory
   pressure."* It calls `list_nodes` live. Then: *"Restart the deployment X in
   namespace Y."* — same tools, same governance, a different client.
6. **Close (15s):** "One MCP server. 171 tools. The dashboard and Claude Desktop
   are just two clients of the same agentic control plane."

### Backup plan
Record a screen capture of steps 2–5 the night before. If live cluster access
flaps on stage, play the clip. Always lead with **Dry Run** for a guaranteed-safe
moment.

## Optional credibility boost (stretch)
The server is currently **tools-only** (no MCP *resources* or *prompts*). Adding a
couple of resources (e.g. `cluster://summary`) and a prompt
(e.g. `triage-incident`) would let you say "we implement all three MCP
primitives" — a detail protocol-savvy judges notice. Not required to win, but a
nice differentiator if time allows.
