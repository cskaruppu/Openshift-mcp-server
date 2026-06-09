/**
 * Anthropic Claude + TCS Agentic AI MCP server.
 *
 * Connects Claude to a TCS specialist agent via MCP, then runs a tool-use
 * loop. Pick which specialist by changing AGENT_ID below — or set to null
 * to connect to the full server (all 162 tools).
 *
 * Run:
 *   npm install @anthropic-ai/sdk @modelcontextprotocol/sdk
 *   export ANTHROPIC_API_KEY=...
 *   export TCS_AGENTIC_URL="https://agentic-ai-server-openshift-mcp.apps.openshift.caaslab.local"
 *   node claude-mcp-client.js
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const TCS_URL = (process.env.TCS_AGENTIC_URL || "http://localhost:8080").replace(/\/$/, "");
const TCS_BEARER = process.env.TCS_AGENTIC_BEARER || "";
const AGENT_ID = process.env.TCS_AGENT_ID || "diagnostics-healing"; // or null for full

const sseUrl = AGENT_ID ? `${TCS_URL}/mcp/${AGENT_ID}/sse` : `${TCS_URL}/sse`;
const headers = TCS_BEARER ? { Authorization: `Bearer ${TCS_BEARER}` } : {};

async function main() {
  // 1. Connect to TCS Agentic AI via MCP
  const transport = new SSEClientTransport(new URL(sseUrl), { requestInit: { headers } });
  const mcp = new Client({ name: "claude-tcs-bridge", version: "1.0.0" }, { capabilities: {} });
  await mcp.connect(transport);

  // 2. List the tools the specialist exposes
  const { tools } = await mcp.listTools();
  console.log(`Connected to TCS agent '${AGENT_ID || "full"}' — ${tools.length} tools available`);

  // 3. Convert MCP tool definitions to Anthropic tool format
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));

  // 4. Run a Claude tool-use loop
  const anthropic = new Anthropic();
  const messages = [
    {
      role: "user",
      content:
        "Diagnose any pods in CrashLoopBackOff in the postgres namespace. " +
        "Explain the root cause and suggest the safest fix.",
    },
  ];

  for (let step = 0; step < 8; step++) {
    const resp = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      tools: anthropicTools,
      messages,
    });

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      // Final answer
      const text = resp.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      console.log("\n=== Claude final answer ===\n" + text);
      break;
    }

    // Execute every tool_use block in parallel via the MCP server
    const toolUses = resp.content.filter((c) => c.type === "tool_use");
    const toolResults = await Promise.all(
      toolUses.map(async (use) => {
        try {
          const result = await mcp.callTool({ name: use.name, arguments: use.input });
          return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result) };
        } catch (e) {
          return {
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `Error: ${e.message}`,
          };
        }
      })
    );
    messages.push({ role: "user", content: toolResults });
  }

  await mcp.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
