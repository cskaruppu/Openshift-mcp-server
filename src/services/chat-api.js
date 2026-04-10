/**
 * LLM-powered Chat API for the dashboard.
 *
 * Connects to an external LLM (OpenAI-compatible API, Ollama, or Anthropic)
 * to provide intelligent cluster analysis and fix recommendations.
 *
 * The chat flow:
 *   1. User sends a message via the dashboard
 *   2. This service gathers relevant cluster context (nodes, pods, events, etc.)
 *   3. Sends the user message + cluster context to the LLM
 *   4. Returns the LLM's analysis to the dashboard
 *
 * Supported LLM backends (set via LLM_PROVIDER env var):
 *   - "openai"    — OpenAI / Azure OpenAI / any OpenAI-compatible API
 *   - "anthropic"  — Anthropic Claude API
 *   - "ollama"     — Local Ollama instance
 *   - "none"       — Built-in rule-based analysis (no external LLM)
 */

import { ocpGet } from "../utils/openshift-client.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LLM_PROVIDER = process.env.LLM_PROVIDER || "none";
const LLM_API_URL = process.env.LLM_API_URL || "http://localhost:11434";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Gather cluster context based on user query
// ---------------------------------------------------------------------------
async function gatherClusterContext(userMessage) {
  const lower = userMessage.toLowerCase();
  const context = {};
  const tasks = [];

  // Always get summary
  tasks.push(
    ocpGet("/apis/config.openshift.io/v1/clusterversions/version")
      .then((d) => { context.clusterVersion = d.status?.desired?.version; context.channel = d.spec?.channel; })
      .catch(() => {})
  );

  // Nodes
  if (lower.match(/node|cluster|health|overview|status|capacity|resource/)) {
    tasks.push(
      ocpGet("/api/v1/nodes").then((d) => {
        context.nodes = (d.items || []).map((n) => ({
          name: n.metadata.name,
          roles: Object.keys(n.metadata.labels || {})
            .filter((l) => l.startsWith("node-role.kubernetes.io/"))
            .map((l) => l.replace("node-role.kubernetes.io/", "")),
          ready: (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
          cpu: n.status?.capacity?.cpu,
          memory: n.status?.capacity?.memory,
        }));
      }).catch(() => {})
    );
  }

  // Pods
  if (lower.match(/pod|crash|oom|restart|issue|problem|error|fail|diagnos/)) {
    tasks.push(
      ocpGet("/api/v1/pods").then((d) => {
        const allPods = d.items || [];
        context.totalPods = allPods.length;
        context.podsByPhase = {};
        allPods.forEach((p) => {
          const phase = p.status?.phase || "Unknown";
          context.podsByPhase[phase] = (context.podsByPhase[phase] || 0) + 1;
        });
        // Find problem pods
        context.problemPods = allPods
          .filter((p) => {
            if (p.status?.phase === "Failed" || p.status?.phase === "Unknown") return true;
            return (p.status?.containerStatuses || []).some(
              (c) =>
                c.state?.waiting?.reason === "CrashLoopBackOff" ||
                c.state?.waiting?.reason === "ImagePullBackOff" ||
                c.state?.waiting?.reason === "ErrImagePull" ||
                c.lastState?.terminated?.reason === "OOMKilled" ||
                c.restartCount > 10
            );
          })
          .slice(0, 20)
          .map((p) => ({
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            phase: p.status?.phase,
            node: p.spec?.nodeName,
            containers: (p.status?.containerStatuses || []).map((c) => ({
              name: c.name,
              ready: c.ready,
              restarts: c.restartCount,
              state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
            })),
          }));
      }).catch(() => {})
    );
  }

  // Namespaces
  if (lower.match(/namespace|project|ns /)) {
    tasks.push(
      ocpGet("/api/v1/namespaces").then((d) => {
        context.namespaces = (d.items || [])
          .filter((ns) =>
            !ns.metadata.name.startsWith("openshift-") &&
            !ns.metadata.name.startsWith("kube-") &&
            ns.metadata.name !== "default" &&
            ns.metadata.name !== "openshift"
          )
          .map((ns) => ({ name: ns.metadata.name, status: ns.status?.phase }));
      }).catch(() => {})
    );
  }

  // Specific namespace pods/deployments
  const nsMatch = lower.match(/(?:in|namespace|ns)\s+["']?([a-z0-9-]+)["']?/);
  if (nsMatch) {
    const ns = nsMatch[1];
    tasks.push(
      ocpGet(`/api/v1/namespaces/${ns}/pods`).then((d) => {
        context.namespacePods = (d.items || []).map((p) => ({
          name: p.metadata.name,
          phase: p.status?.phase,
          restarts: (p.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0),
          containers: (p.status?.containerStatuses || []).map((c) => ({
            name: c.name,
            ready: c.ready,
            state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
          })),
        }));
        context.targetNamespace = ns;
      }).catch(() => {})
    );
    tasks.push(
      ocpGet(`/apis/apps/v1/namespaces/${ns}/deployments`).then((d) => {
        context.namespaceDeployments = (d.items || []).map((dep) => ({
          name: dep.metadata.name,
          replicas: dep.spec?.replicas,
          ready: dep.status?.readyReplicas || 0,
          available: dep.status?.availableReplicas || 0,
          image: dep.spec?.template?.spec?.containers?.[0]?.image,
        }));
      }).catch(() => {})
    );
  }

  // Deployments
  if (lower.match(/deploy|scale|replica|rollout|redeploy|restart/)) {
    tasks.push(
      ocpGet("/apis/apps/v1/deployments").then((d) => {
        context.deployments = (d.items || []).slice(0, 30).map((dep) => ({
          name: dep.metadata.name,
          namespace: dep.metadata.namespace,
          replicas: dep.spec?.replicas,
          ready: dep.status?.readyReplicas || 0,
          available: dep.status?.availableReplicas || 0,
        }));
      }).catch(() => {})
    );
  }

  // Events (warnings)
  if (lower.match(/event|alert|warn|issue|problem|error|what.*wrong/)) {
    tasks.push(
      ocpGet("/api/v1/events").then((d) => {
        context.warningEvents = (d.items || [])
          .filter((e) => e.type === "Warning")
          .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0))
          .slice(0, 15)
          .map((e) => ({
            reason: e.reason,
            message: e.message,
            object: `${e.involvedObject.kind}/${e.involvedObject.name}`,
            namespace: e.metadata.namespace,
            count: e.count,
            lastSeen: e.lastTimestamp,
          }));
      }).catch(() => {})
    );
  }

  // Operators
  if (lower.match(/operator|degrad|cluster.*health/)) {
    tasks.push(
      ocpGet("/apis/config.openshift.io/v1/clusteroperators").then((d) => {
        context.operators = (d.items || []).map((op) => {
          const conds = (op.status?.conditions || []).reduce((a, c) => { a[c.type] = c.status; return a; }, {});
          return {
            name: op.metadata.name,
            available: conds.Available,
            degraded: conds.Degraded,
            progressing: conds.Progressing,
          };
        });
      }).catch(() => {})
    );
  }

  // Services, routes
  if (lower.match(/service|route|endpoint|ingress|url/)) {
    const ns = nsMatch?.[1];
    if (ns) {
      tasks.push(
        ocpGet(`/api/v1/namespaces/${ns}/services`).then((d) => {
          context.services = (d.items || []).map((s) => ({
            name: s.metadata.name, type: s.spec?.type, clusterIP: s.spec?.clusterIP,
            ports: s.spec?.ports?.map((p) => `${p.port}/${p.protocol}`),
          }));
        }).catch(() => {})
      );
      tasks.push(
        ocpGet(`/apis/route.openshift.io/v1/namespaces/${ns}/routes`).then((d) => {
          context.routes = (d.items || []).map((r) => ({
            name: r.metadata.name, host: r.spec?.host, service: r.spec?.to?.name,
          }));
        }).catch(() => {})
      );
    }
  }

  await Promise.all(tasks);
  return context;
}

// ---------------------------------------------------------------------------
// LLM System Prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an OpenShift Cluster AI Assistant. You help users understand their OpenShift cluster status, diagnose issues, and recommend fixes.

You have access to live cluster data provided as JSON context. Use this data to give accurate, specific answers.

When diagnosing issues:
- Identify the root cause from events, pod status, and container states
- Provide specific fix commands (oc commands or YAML patches)
- Explain the impact and risk of the fix
- For critical issues, mention the emergency_fix MCP tool
- For changes that need approval, mention the ServiceNow change request flow

When listing resources:
- Format data clearly with tables or bullet points
- Highlight any unhealthy or unusual items
- Include relevant details like restart counts, status, and resource usage

Always be concise but thorough. Use markdown formatting.`;

// ---------------------------------------------------------------------------
// Call external LLM
// ---------------------------------------------------------------------------
async function callLLM(userMessage, clusterContext) {
  const contextStr = JSON.stringify(clusterContext, null, 2);
  const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;

  if (LLM_PROVIDER === "openai") {
    const resp = await fetch(`${LLM_API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "No response from LLM.";
  }

  if (LLM_PROVIDER === "anthropic") {
    const resp = await fetch(`${LLM_API_URL || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": LLM_API_KEY,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODEL || "claude-sonnet-4-20250514",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        max_tokens: 2000,
      }),
    });
    const data = await resp.json();
    return data.content?.[0]?.text || "No response from LLM.";
  }

  if (LLM_PROVIDER === "ollama") {
    const resp = await fetch(`${LLM_API_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL || "llama3",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
      }),
    });
    const data = await resp.json();
    return data.message?.content || "No response from Ollama.";
  }

  // Fallback: built-in analysis (no external LLM)
  return builtInAnalysis(userMessage, clusterContext);
}

// ---------------------------------------------------------------------------
// Built-in analysis (when no LLM is configured)
// ---------------------------------------------------------------------------
function builtInAnalysis(userMessage, ctx) {
  const lower = userMessage.toLowerCase();
  const parts = [];

  if (ctx.clusterVersion) {
    parts.push(`**Cluster:** OpenShift ${ctx.clusterVersion} (${ctx.channel || "unknown channel"})`);
  }

  if (ctx.nodes) {
    const ready = ctx.nodes.filter((n) => n.ready).length;
    const total = ctx.nodes.length;
    parts.push(`\n**Nodes:** ${ready}/${total} Ready`);
    ctx.nodes.forEach((n) => {
      const status = n.ready ? "Ready" : "**NotReady**";
      parts.push(`  - ${n.name} (${n.roles.join(", ")}) — ${status} — CPU: ${n.cpu}, Mem: ${n.memory}`);
    });
    const notReady = ctx.nodes.filter((n) => !n.ready);
    if (notReady.length > 0) {
      parts.push(`\n**Action needed:** ${notReady.length} node(s) are NotReady. Check with: \`oc describe node ${notReady[0].name}\``);
    }
  }

  if (ctx.problemPods && ctx.problemPods.length > 0) {
    parts.push(`\n**Problem Pods:** ${ctx.problemPods.length} found`);
    ctx.problemPods.forEach((p) => {
      const issues = p.containers.map((c) => `${c.name}: ${c.state} (${c.restarts} restarts)`).join(", ");
      parts.push(`  - **${p.name}** in \`${p.namespace}\` — ${issues}`);
    });
    // Suggest fixes
    const crashPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "CrashLoopBackOff"));
    if (crashPods.length > 0) {
      parts.push(`\n**Suggested fix for CrashLoopBackOff:**`);
      parts.push(`  1. Check logs: \`oc logs ${crashPods[0].name} -n ${crashPods[0].namespace} --previous\``);
      parts.push(`  2. Check events: \`oc describe pod ${crashPods[0].name} -n ${crashPods[0].namespace}\``);
      parts.push(`  3. Restart: \`oc delete pod ${crashPods[0].name} -n ${crashPods[0].namespace}\``);
    }
    const oomPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "OOMKilled"));
    if (oomPods.length > 0) {
      parts.push(`\n**Suggested fix for OOMKilled:**`);
      parts.push(`  1. Increase memory limit in the deployment spec`);
      parts.push(`  2. Check for memory leaks in the application`);
      parts.push(`  3. Use MCP tool: \`scale_deployment\` or \`emergency_fix\``);
    }
  } else if (lower.match(/pod|issue|problem/)) {
    parts.push(`\n**Pods:** No issues detected.`);
  }

  if (ctx.totalPods) {
    parts.push(`\n**Total Pods:** ${ctx.totalPods}`);
    if (ctx.podsByPhase) {
      parts.push(`  Phases: ${Object.entries(ctx.podsByPhase).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    }
  }

  if (ctx.namespaces) {
    parts.push(`\n**User Namespaces:** ${ctx.namespaces.length}`);
    ctx.namespaces.forEach((ns) => {
      parts.push(`  - ${ns.name} (${ns.status})`);
    });
  }

  if (ctx.namespacePods) {
    parts.push(`\n**Pods in \`${ctx.targetNamespace}\`:** ${ctx.namespacePods.length}`);
    ctx.namespacePods.forEach((p) => {
      const containerInfo = p.containers.map((c) => c.state).join(", ");
      parts.push(`  - ${p.name} — ${p.phase} — restarts: ${p.restarts} — [${containerInfo}]`);
    });
  }

  if (ctx.namespaceDeployments) {
    parts.push(`\n**Deployments in \`${ctx.targetNamespace}\`:**`);
    ctx.namespaceDeployments.forEach((d) => {
      const health = d.ready === d.replicas ? "healthy" : "**degraded**";
      parts.push(`  - ${d.name} — ${d.ready}/${d.replicas} ready — ${health}`);
    });
  }

  if (ctx.warningEvents && ctx.warningEvents.length > 0) {
    parts.push(`\n**Recent Warning Events:**`);
    ctx.warningEvents.slice(0, 10).forEach((e) => {
      parts.push(`  - [${e.reason}] ${e.object} in \`${e.namespace}\`: ${e.message?.substring(0, 100)}${e.count > 1 ? ` (x${e.count})` : ""}`);
    });
  }

  if (ctx.operators) {
    const degraded = ctx.operators.filter((o) => o.degraded === "True");
    if (degraded.length > 0) {
      parts.push(`\n**Degraded Operators:** ${degraded.length}`);
      degraded.forEach((o) => parts.push(`  - ${o.name}`));
    } else {
      parts.push(`\n**Operators:** All ${ctx.operators.length} healthy`);
    }
  }

  if (ctx.services) {
    parts.push(`\n**Services in \`${ctx.targetNamespace}\`:**`);
    ctx.services.forEach((s) => parts.push(`  - ${s.name} (${s.type}) — ${s.clusterIP} — ${(s.ports || []).join(", ")}`));
  }

  if (ctx.routes) {
    parts.push(`\n**Routes in \`${ctx.targetNamespace}\`:**`);
    ctx.routes.forEach((r) => parts.push(`  - ${r.name} — https://${r.host} -> ${r.service}`));
  }

  if (parts.length === 0 || (parts.length === 1 && parts[0].includes("Cluster:"))) {
    parts.push(`\nI can help you explore your cluster. Try asking:\n- "Show me all nodes and their status"\n- "Are there any pod issues?"\n- "List namespaces"\n- "Show pods in namespace <name>"\n- "What deployments are running?"\n- "Show warning events"\n- "Check cluster health and operators"`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// POST /api/chat handler
// ---------------------------------------------------------------------------
export async function handleChatAPI(req, res) {
  try {
    const body = await readBody(req);
    const userMessage = body.message;

    if (!userMessage) {
      json(res, 400, { error: "Missing 'message' field" });
      return;
    }

    // 1. Gather cluster context
    const context = await gatherClusterContext(userMessage);

    // 2. Call LLM (or built-in analysis)
    const reply = await callLLM(userMessage, context);

    // 3. Return response
    json(res, 200, {
      reply,
      provider: LLM_PROVIDER,
      contextKeys: Object.keys(context),
    });
  } catch (err) {
    console.error("Chat API error:", err);
    json(res, 500, { error: err.message });
  }
}
