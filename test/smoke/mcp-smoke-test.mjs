#!/usr/bin/env node
/**
 * MCP smoke test — proves the server speaks MCP over stdio.
 *
 * Spawns the server in stdio mode, performs the JSON-RPC `initialize`
 * handshake and a `tools/list` call, then prints the server identity and the
 * number of tools exposed. Great as a live "it's a real MCP server" proof.
 *
 *   node scripts/mcp-smoke-test.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const child = spawn("node", [join(root, "src/index.js")], {
  env: { ...process.env, MCP_TRANSPORT: "stdio", LOG_LEVEL: "error" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let serverInfo = null;

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && msg.result) {
      serverInfo = msg.result.serverInfo;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    }
    if (msg.id === 2 && msg.result) {
      const tools = msg.result.tools || [];
      console.log("\n  ✅ MCP server responded over stdio\n");
      console.log("  Server:  " + (serverInfo?.name || "?") + " v" + (serverInfo?.version || "?"));
      console.log("  Tools:   " + tools.length);
      console.log("  Sample:  " + tools.slice(0, 8).map((t) => t.name).join(", ") + " …\n");
      child.kill();
      process.exit(0);
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1.0" } },
}) + "\n");

setTimeout(() => { console.error("  ❌ TIMEOUT — no tools/list response"); child.kill(); process.exit(1); }, 15000);
