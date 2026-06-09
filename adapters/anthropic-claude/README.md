# Anthropic Claude Agent SDK Adapter — TCS Agentic AI

Connect Claude to the full TCS Agentic AI MCP server, or to individual
specialist agents.

```bash
npm install @anthropic-ai/sdk @modelcontextprotocol/sdk
export ANTHROPIC_API_KEY=...
export TCS_AGENTIC_URL="https://agentic-ai-server-openshift-mcp.apps.openshift.caaslab.local"
node claude-mcp-client.js
```

See [`claude-mcp-client.js`](claude-mcp-client.js) for a runnable example.

## Per-agent endpoints

```bash
curl ${TCS_AGENTIC_URL}/.well-known/agent.json   # discover all agents
curl ${TCS_AGENTIC_URL}/api/agents               # full list
curl ${TCS_AGENTIC_URL}/api/agents/diagnostics-healing/tools
```

| Connect to... | URL |
|---|---|
| All 162 tools | `${TCS_AGENTIC_URL}/sse` |
| Just diagnostics | `${TCS_AGENTIC_URL}/mcp/diagnostics-healing/sse` |
| Just upgrade | `${TCS_AGENTIC_URL}/mcp/upgrade-lifecycle/sse` |
| Just ITSM | `${TCS_AGENTIC_URL}/mcp/itsm-change-management/sse` |
| Any other | `${TCS_AGENTIC_URL}/mcp/<agent-id>/sse` |
