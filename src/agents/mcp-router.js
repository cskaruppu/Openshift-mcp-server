/**
 * Per-agent MCP endpoint router.
 *
 * Exposes /mcp/<agent-id>/sse and /mcp/<agent-id>/message endpoints, each
 * serving an MCP server that contains ONLY the tools listed in that agent's
 * manifest.
 *
 * Implementation: monkey-patches `server.tool()` during registration so
 * that the existing `register*Tools()` functions in src/tools/*.js are
 * called unchanged — non-allowed tools are silently dropped at register
 * time. Existing tool code is never modified.
 *
 * The full /sse and /message endpoints continue to expose all tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { registerClusterTools } from "../tools/cluster.js";
import { registerNodeTools } from "../tools/nodes.js";
import { registerPodTools } from "../tools/pods.js";
import { registerNamespaceTools } from "../tools/namespaces.js";
import { registerDiagnosticTools } from "../tools/diagnostics.js";
import { registerServiceNowTools } from "../tools/servicenow.js";
import { registerAnsibleTools } from "../tools/ansible.js";
import { registerEmergencyTools } from "../tools/emergency.js";
import { registerACMTools } from "../tools/acm.js";
import { registerDashboardTools } from "../tools/dashboard.js";
import { registerWorkloadTools } from "../tools/workloads.js";
import { registerHelmTools } from "../tools/helm.js";
import { registerTektonTools } from "../tools/tekton.js";
import { registerKubeVirtTools } from "../tools/kubevirt.js";
import { registerNetworkTools } from "../tools/network.js";
import { registerGenericTools } from "../tools/generic.js";
import { registerMustGatherTools } from "../tools/mustgather.js";
import { registerMetricsTopTools } from "../tools/metrics-top.js";
import { registerPrometheusTools } from "../tools/prometheus-query.js";
import { registerOSSMTools } from "../tools/ossm.js";
import { registerGitOpsTools } from "../tools/gitops.js";
import { registerSecurityTools } from "../tools/security.js";
import { registerRecommendationTools } from "../tools/recommendations.js";
import { registerNotificationTools } from "../tools/notifications.js";
import { registerVeleroTools } from "../tools/velero.js";
import { registerComplianceTools } from "../tools/compliance.js";
import { registerDriftTools } from "../tools/drift.js";
import { registerImpactTools } from "../tools/impact.js";
import { registerOperatorDiagTools } from "../tools/operator-diag.js";
import { registerPolicyGenTools } from "../tools/policy-gen.js";
import { registerSCCAdvisorTools } from "../tools/scc-advisor.js";
import { registerTimelineTools } from "../tools/timeline.js";
import { registerUpgradeAdvisorTools } from "../tools/upgrade-advisor.js";
import { registerBenchmarkTools } from "../tools/benchmarks.js";
import { registerProvisioningTools } from "../tools/provisioning.js";
import { registerPreflightTools } from "../tools/upgrade-preflight.js";
import { registerMultiClusterTools } from "../services/multi-cluster.js";

import { getAgentById } from "./registry.js";

const REGISTRARS = [
  registerClusterTools, registerNodeTools, registerPodTools, registerNamespaceTools,
  registerDiagnosticTools, registerServiceNowTools, registerAnsibleTools, registerEmergencyTools,
  registerACMTools, registerDashboardTools, registerWorkloadTools, registerHelmTools,
  registerTektonTools, registerKubeVirtTools, registerNetworkTools, registerGenericTools,
  registerMustGatherTools, registerMultiClusterTools, registerMetricsTopTools, registerPrometheusTools,
  registerOSSMTools, registerGitOpsTools, registerSecurityTools, registerRecommendationTools,
  registerNotificationTools, registerVeleroTools, registerComplianceTools, registerDriftTools,
  registerImpactTools, registerOperatorDiagTools, registerPolicyGenTools, registerSCCAdvisorTools,
  registerTimelineTools, registerUpgradeAdvisorTools, registerBenchmarkTools, registerProvisioningTools,
  registerPreflightTools,
];

/**
 * Create an MCP server containing only the tools allowed for `agentId`.
 *
 * Existing register*Tools() functions are called unchanged. We monkey-patch
 * server.tool() and server.registerTool() so calls for tools outside the
 * manifest are dropped silently.
 */
export async function createAgentMcpServer(agentId) {
  const agent = await getAgentById(agentId);
  if (!agent) return null;

  const allowed = new Set(agent.tools || []);

  const server = new McpServer({
    name: `tcs-${agent.id}`,
    version: agent.version || "1.0.0",
    description: agent.description,
  });

  // Wrap server.tool() — McpServer exposes this for tool registration.
  const origTool = typeof server.tool === "function" ? server.tool.bind(server) : null;
  if (origTool) {
    server.tool = (name, ...rest) => {
      if (allowed.has(name)) return origTool(name, ...rest);
      return undefined;
    };
  }

  // Some SDK versions also expose server.registerTool — wrap it too.
  const origRegisterTool = typeof server.registerTool === "function"
    ? server.registerTool.bind(server)
    : null;
  if (origRegisterTool) {
    server.registerTool = (name, ...rest) => {
      if (allowed.has(name)) return origRegisterTool(name, ...rest);
      return undefined;
    };
  }

  // Run all registrars — only allowed tools survive the wrapper.
  for (const fn of REGISTRARS) {
    try { fn(server); } catch (e) { /* tool group failed to register — continue */ }
  }

  return server;
}

const _agentSessions = new Map();

/**
 * Match /mcp/<agent-id>/sse and /mcp/<agent-id>/message routes.
 * Returns true when handled, false to fall through.
 */
export async function handleAgentMcpRoutes(req, res, url) {
  const sseMatch = url.pathname.match(/^\/mcp\/([a-z0-9-]+)\/sse$/);
  if (sseMatch && req.method === "GET") {
    const agentId = sseMatch[1];
    const server = await createAgentMcpServer(agentId);
    if (!server) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent not found", id: agentId }));
      return true;
    }
    const transport = new SSEServerTransport(`/mcp/${agentId}/message`, res);
    _agentSessions.set(transport.sessionId, { server, transport, agentId });
    res.on("close", () => _agentSessions.delete(transport.sessionId));
    await server.connect(transport);
    return true;
  }

  const msgMatch = url.pathname.match(/^\/mcp\/([a-z0-9-]+)\/message$/);
  if (msgMatch && req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId");
    const session = _agentSessions.get(sessionId);
    if (!session) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired session" }));
      return true;
    }
    await session.transport.handlePostMessage(req, res);
    return true;
  }

  return false;
}
