#!/usr/bin/env node

/**
 * OpenShift MCP Server
 * Model Context Protocol server for OpenShift Container Platform management
 * with ACM, Ansible Automation Platform, and ServiceNow integration.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerClusterTools } from "./tools/cluster.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerPodTools } from "./tools/pods.js";
import { registerNamespaceTools } from "./tools/namespaces.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerServiceNowTools } from "./tools/servicenow.js";
import { registerAnsibleTools } from "./tools/ansible.js";
import { registerEmergencyTools } from "./tools/emergency.js";
import { registerACMTools } from "./tools/acm.js";
import { registerDashboardTools } from "./tools/dashboard.js";

const server = new McpServer({
  name: "openshift-mcp-server",
  version: "1.0.0",
  description:
    "MCP Server for OpenShift Container Platform — cluster insights, diagnostics, ITSM integration, and automated remediation.",
});

// Register all tool groups
registerClusterTools(server);
registerNodeTools(server);
registerPodTools(server);
registerNamespaceTools(server);
registerDiagnosticTools(server);
registerServiceNowTools(server);
registerAnsibleTools(server);
registerEmergencyTools(server);
registerACMTools(server);
registerDashboardTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenShift MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
