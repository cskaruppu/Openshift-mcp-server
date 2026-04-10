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

  // Detect what specific issue type the user is asking about
  context.queryFilter = null;
  if (lower.match(/crashloop|crash.?loop|crash.?back/)) context.queryFilter = "CrashLoopBackOff";
  else if (lower.match(/imagepull|image.?pull|errimagepull/)) context.queryFilter = "ImagePullBackOff";
  else if (lower.match(/oom|out.?of.?memory|oomkill/)) context.queryFilter = "OOMKilled";
  else if (lower.match(/pending/)) context.queryFilter = "Pending";
  else if (lower.match(/fail|failed/)) context.queryFilter = "Failed";
  else if (lower.match(/not.?ready|notready/)) context.queryFilter = "NotReady";

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
  if (lower.match(/pod|crash|oom|restart|issue|problem|error|fail|diagnos|image.?pull|pending|not.?ready/)) {
    tasks.push(
      ocpGet("/api/v1/pods").then((d) => {
        const allPods = d.items || [];
        context.totalPods = allPods.length;
        context.podsByPhase = {};
        allPods.forEach((p) => {
          const phase = p.status?.phase || "Unknown";
          context.podsByPhase[phase] = (context.podsByPhase[phase] || 0) + 1;
        });
        // Find problem pods — only truly broken ones, not healthy pods with historical restarts
        context.problemPods = allPods
          .filter((p) => {
            if (p.status?.phase === "Failed" || p.status?.phase === "Unknown") return true;
            // Only flag pods where a container is currently NOT running
            return (p.status?.containerStatuses || []).some(
              (c) =>
                c.state?.waiting?.reason === "CrashLoopBackOff" ||
                c.state?.waiting?.reason === "ImagePullBackOff" ||
                c.state?.waiting?.reason === "ErrImagePull" ||
                c.state?.waiting?.reason === "CreateContainerConfigError" ||
                c.state?.waiting?.reason === "RunContainerError" ||
                c.state?.terminated?.reason === "OOMKilled" ||
                c.state?.terminated?.reason === "Error" ||
                (!c.ready && !c.state?.running)
            );
          })
          .slice(0, 20)
          .map((p) => ({
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            phase: p.status?.phase,
            node: p.spec?.nodeName,
            containers: (p.status?.containerStatuses || [])
              .filter((c) => !c.ready || !c.state?.running)
              .map((c) => ({
                name: c.name,
                ready: c.ready,
                restarts: c.restartCount,
                state: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? "Running" : "Unknown"),
              })),
          }))
          .filter((p) => p.containers.length > 0);
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
async function callLLM(userMessage, clusterContext, opts = {}) {
  const provider = opts.provider || LLM_PROVIDER;
  const apiUrl = opts.apiUrl || LLM_API_URL;
  const apiKey = opts.apiKey || LLM_API_KEY;
  const model = opts.model || LLM_MODEL;

  const contextStr = JSON.stringify(clusterContext, null, 2);
  const userContent = `${userMessage}\n\n--- Live Cluster Data ---\n${contextStr}`;

  if (provider === "openai") {
    const resp = await fetch(`${apiUrl || "https://api.openai.com"}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "gpt-4",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });
    const data = await resp.json();
    if (data.error) return `LLM Error: ${data.error.message || JSON.stringify(data.error)}`;
    return data.choices?.[0]?.message?.content || "No response from LLM.";
  }

  if (provider === "anthropic") {
    const resp = await fetch(`${apiUrl || "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        max_tokens: 2000,
      }),
    });
    const data = await resp.json();
    if (data.error) return `LLM Error: ${data.error.message || JSON.stringify(data.error)}`;
    return data.content?.[0]?.text || "No response from LLM.";
  }

  if (provider === "ollama") {
    const resp = await fetch(`${apiUrl || "http://localhost:11434"}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || "llama3",
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
  const filter = ctx.queryFilter; // Specific issue type the user asked about

  // -------------------------------------------------------------------------
  // Helper: render a group of pods with issue cards + fix commands
  // -------------------------------------------------------------------------
  function renderPodGroup(label, severity, pods, fixTitle, fixCmds) {
    if (pods.length === 0) return;
    parts.push(`\n${severity} **${label}** (${pods.length} pod${pods.length > 1 ? "s" : ""})`);
    pods.forEach((p) => {
      const detail = p.containers
        .map((c) => `${c.name}: ${c.state}${c.restarts ? ` (${c.restarts} restarts)` : ""}`)
        .join(", ");
      parts.push(`@@POD_ISSUE|${p.name}|${p.namespace}|${detail}@@`);
    });
    if (fixTitle && fixCmds) {
      parts.push(`\n**${fixTitle}**`);
      parts.push("```" + fixCmds + "```");
    }
  }

  // -------------------------------------------------------------------------
  // SPECIFIC QUERY: user asked about a particular issue type
  // -------------------------------------------------------------------------
  if (filter && ctx.problemPods) {
    const filterMap = {
      CrashLoopBackOff: (p) => p.containers.some((c) => c.state === "CrashLoopBackOff"),
      ImagePullBackOff: (p) => p.containers.some((c) => c.state === "ImagePullBackOff" || c.state === "ErrImagePull"),
      OOMKilled:        (p) => p.containers.some((c) => c.state === "OOMKilled"),
      Failed:           (p) => p.phase === "Failed",
      Pending:          (p) => p.phase === "Pending",
      NotReady:         (p) => p.containers.some((c) => !c.ready),
    };
    const matchFn = filterMap[filter] || (() => false);
    const matched = ctx.problemPods.filter(matchFn);

    parts.push(`### ${filter} Pods`);

    if (matched.length === 0) {
      parts.push(`[OK] **No ${filter} pods found.** Your cluster has no pods in this state.`);
      // Show what IS found instead
      if (ctx.problemPods.length > 0) {
        const states = {};
        ctx.problemPods.forEach((p) =>
          p.containers.forEach((c) => { states[c.state] = (states[c.state] || 0) + 1; })
        );
        parts.push(`\nHowever, there are **${ctx.problemPods.length}** pods with other issues:`);
        Object.entries(states).forEach(([state, count]) => {
          parts.push(`  - **${state}**: ${count}`);
        });
      }
    } else {
      parts.push(`@@SUMMARY|red:${matched.length} ${filter}@@`);

      if (filter === "CrashLoopBackOff") {
        renderPodGroup("CrashLoopBackOff", "[CRITICAL]", matched,
          "Fix — Check logs and restart:",
          `# Check logs of the crashing container\noc logs ${matched[0].name} -n ${matched[0].namespace} --previous\n\n# Describe pod events\noc describe pod ${matched[0].name} -n ${matched[0].namespace}\n\n# Delete pod to let controller recreate\noc delete pod ${matched[0].name} -n ${matched[0].namespace}`
        );
      } else if (filter === "ImagePullBackOff") {
        renderPodGroup("ImagePullBackOff / ErrImagePull", "[CRITICAL]", matched,
          "Fix — Verify image and pull secret:",
          `# Check image reference\noc get pod ${matched[0].name} -n ${matched[0].namespace} -o jsonpath='{.spec.containers[*].image}'\n\n# Check pull secrets\noc get pod ${matched[0].name} -n ${matched[0].namespace} -o jsonpath='{.spec.imagePullSecrets}'\n\n# Check events for pull errors\noc describe pod ${matched[0].name} -n ${matched[0].namespace} | grep -A5 Events`
        );
      } else if (filter === "OOMKilled") {
        renderPodGroup("OOMKilled", "[CRITICAL]", matched,
          "Fix — Increase memory limits:",
          `# Check current resource limits\noc get pod ${matched[0].name} -n ${matched[0].namespace} -o jsonpath='{.spec.containers[*].resources}'\n\n# Increase memory on the deployment\noc set resources deployment/<deployment-name> -n ${matched[0].namespace} --limits=memory=512Mi --requests=memory=256Mi`
        );
      } else {
        renderPodGroup(filter, "[WARNING]", matched,
          "Diagnose:",
          `oc describe pod ${matched[0].name} -n ${matched[0].namespace}\noc logs ${matched[0].name} -n ${matched[0].namespace}`
        );
      }
    }
    return parts.join("\n");
  }

  // -------------------------------------------------------------------------
  // GENERAL QUERY: show relevant sections based on keywords
  // -------------------------------------------------------------------------

  if (ctx.clusterVersion) {
    parts.push(`### Cluster Overview`);
    parts.push(`**OpenShift** ${ctx.clusterVersion} (${ctx.channel || "unknown channel"})`);
  }

  if (ctx.nodes) {
    const ready = ctx.nodes.filter((n) => n.ready).length;
    const notReady = ctx.nodes.filter((n) => !n.ready);
    parts.push(`\n### Node Status`);
    parts.push(`@@SUMMARY|green:${ready} Ready${notReady.length > 0 ? `|red:${notReady.length} NotReady` : ""}@@`);
    ctx.nodes.forEach((n) => {
      const status = n.ready ? "[OK]" : "[CRITICAL]";
      parts.push(`  - ${status} **${n.name}** (${n.roles.join(", ")}) — CPU: ${n.cpu}, Mem: ${n.memory}`);
    });
    if (notReady.length > 0) {
      parts.push(`\n[CRITICAL] **${notReady.length} node(s) are NotReady:**`);
      parts.push("```" + `oc describe node ${notReady[0].name}\noc get node ${notReady[0].name} -o yaml` + "```");
    }
  }

  if (ctx.problemPods && ctx.problemPods.length > 0) {
    // Group by issue type
    const crashPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "CrashLoopBackOff"));
    const oomPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "OOMKilled"));
    const imgPods = ctx.problemPods.filter((p) => p.containers.some((c) => c.state === "ImagePullBackOff" || c.state === "ErrImagePull"));
    const otherPods = ctx.problemPods.filter((p) =>
      !crashPods.includes(p) && !oomPods.includes(p) && !imgPods.includes(p)
    );

    parts.push(`\n### Failed Pods — ${ctx.problemPods.length} Issues Found`);
    const summaryParts = [];
    if (crashPods.length > 0) summaryParts.push(`red:${crashPods.length} CrashLoop`);
    if (oomPods.length > 0)   summaryParts.push(`amber:${oomPods.length} OOMKilled`);
    if (imgPods.length > 0)   summaryParts.push(`red:${imgPods.length} ImagePull`);
    if (otherPods.length > 0) summaryParts.push(`amber:${otherPods.length} Other`);
    if (summaryParts.length > 0) parts.push(`@@SUMMARY|${summaryParts.join("|")}@@`);

    renderPodGroup("CrashLoopBackOff", "[CRITICAL]", crashPods,
      crashPods.length > 0 ? "Fix — Check logs and restart:" : null,
      crashPods.length > 0 ? `# Check logs\noc logs ${crashPods[0].name} -n ${crashPods[0].namespace} --previous\n\n# Describe pod\noc describe pod ${crashPods[0].name} -n ${crashPods[0].namespace}\n\n# Delete to recreate\noc delete pod ${crashPods[0].name} -n ${crashPods[0].namespace}` : null
    );
    renderPodGroup("OOMKilled", "[WARNING]", oomPods,
      oomPods.length > 0 ? "Fix — Increase memory limits:" : null,
      oomPods.length > 0 ? `# Check limits\noc get pod ${oomPods[0].name} -n ${oomPods[0].namespace} -o jsonpath='{.spec.containers[*].resources}'\n\n# Increase memory\noc set resources deployment/<name> -n ${oomPods[0].namespace} --limits=memory=512Mi` : null
    );
    renderPodGroup("ImagePullBackOff", "[CRITICAL]", imgPods,
      imgPods.length > 0 ? "Fix — Verify image and pull secret:" : null,
      imgPods.length > 0 ? `# Check image\noc get pod ${imgPods[0].name} -n ${imgPods[0].namespace} -o jsonpath='{.spec.containers[*].image}'\n\n# Check pull secrets\noc get pod ${imgPods[0].name} -n ${imgPods[0].namespace} -o jsonpath='{.spec.imagePullSecrets}'` : null
    );
    renderPodGroup("Other Issues", "[WARNING]", otherPods,
      otherPods.length > 0 ? "Diagnose:" : null,
      otherPods.length > 0 ? `oc describe pod ${otherPods[0].name} -n ${otherPods[0].namespace}\noc logs ${otherPods[0].name} -n ${otherPods[0].namespace}` : null
    );
  } else if (lower.match(/pod|issue|problem|fail|error/)) {
    parts.push(`\n### Pod Status`);
    parts.push(`[OK] **No pod issues detected.** All pods are running normally.`);
  }

  if (ctx.totalPods && !lower.match(/crash|oom|image|fail|error|issue|problem/)) {
    parts.push(`\n### Pod Summary`);
    parts.push(`**Total:** ${ctx.totalPods} pods`);
    if (ctx.podsByPhase) {
      const running = ctx.podsByPhase["Running"] || 0;
      const failed = (ctx.podsByPhase["Failed"] || 0) + (ctx.podsByPhase["Unknown"] || 0);
      const pending = ctx.podsByPhase["Pending"] || 0;
      const succeeded = ctx.podsByPhase["Succeeded"] || 0;
      const summaryParts = [`green:${running} Running`];
      if (succeeded > 0) summaryParts.push(`green:${succeeded} Succeeded`);
      if (failed > 0) summaryParts.push(`red:${failed} Failed`);
      if (pending > 0) summaryParts.push(`amber:${pending} Pending`);
      parts.push(`@@SUMMARY|${summaryParts.join("|")}@@`);
    }
  }

  if (ctx.namespaces) {
    parts.push(`\n### User Namespaces (${ctx.namespaces.length})`);
    ctx.namespaces.forEach((ns) => {
      const icon = ns.status === "Active" ? "[OK]" : "[WARNING]";
      parts.push(`  - ${icon} **${ns.name}** — ${ns.status}`);
    });
  }

  if (ctx.namespacePods) {
    parts.push(`\n### Pods in \`${ctx.targetNamespace}\` (${ctx.namespacePods.length})`);
    ctx.namespacePods.forEach((p) => {
      const isOk = p.phase === "Running" && p.restarts < 5;
      if (!isOk) {
        const containerInfo = p.containers.map((c) => c.state).join(", ");
        parts.push(`@@POD_ISSUE|${p.name}|${ctx.targetNamespace}|Phase: ${p.phase} — Restarts: ${p.restarts} — [${containerInfo}]@@`);
      } else {
        parts.push(`  - [OK] **${p.name}** — ${p.phase} — restarts: ${p.restarts}`);
      }
    });
  }

  if (ctx.namespaceDeployments) {
    parts.push(`\n### Deployments in \`${ctx.targetNamespace}\``);
    ctx.namespaceDeployments.forEach((d) => {
      const icon = d.ready === d.replicas ? "[OK]" : "[CRITICAL]";
      parts.push(`  - ${icon} **${d.name}** — ${d.ready}/${d.replicas} ready`);
    });
    const unhealthy = ctx.namespaceDeployments.filter((d) => d.ready !== d.replicas);
    if (unhealthy.length > 0) {
      parts.push(`\n**Fix — Rollout restart:**`);
      parts.push("```" + `oc rollout restart deployment/${unhealthy[0].name} -n ${ctx.targetNamespace}\noc rollout status deployment/${unhealthy[0].name} -n ${ctx.targetNamespace}` + "```");
    }
  }

  if (ctx.warningEvents && ctx.warningEvents.length > 0) {
    parts.push(`\n### Recent Warning Events`);
    ctx.warningEvents.slice(0, 10).forEach((e) => {
      const severity = (e.reason === "BackOff" || e.reason === "Failed" || e.reason === "OOMKilling")
        ? "[CRITICAL]" : "[WARNING]";
      parts.push(`  - ${severity} **${e.reason}** — ${e.object} in \`${e.namespace}\`: ${e.message?.substring(0, 100)}${e.count > 1 ? ` (x${e.count})` : ""}`);
    });
  }

  if (ctx.operators) {
    const degraded = ctx.operators.filter((o) => o.degraded === "True");
    parts.push(`\n### Cluster Operators`);
    if (degraded.length > 0) {
      parts.push(`[CRITICAL] **${degraded.length} degraded operator(s):**`);
      degraded.forEach((o) => parts.push(`@@POD_ISSUE|${o.name}|cluster-operator|Status: Degraded@@`));
      parts.push(`\n**Diagnose:**`);
      parts.push("```" + `oc describe clusteroperator ${degraded[0].name}\noc get clusteroperator ${degraded[0].name} -o yaml` + "```");
    } else {
      parts.push(`[OK] All **${ctx.operators.length}** operators are available and healthy.`);
    }
  }

  if (ctx.services) {
    parts.push(`\n### Services in \`${ctx.targetNamespace}\``);
    ctx.services.forEach((s) => parts.push(`  - **${s.name}** (${s.type}) — ${s.clusterIP} — ${(s.ports || []).join(", ")}`));
  }

  if (ctx.routes) {
    parts.push(`\n### Routes in \`${ctx.targetNamespace}\``);
    ctx.routes.forEach((r) => parts.push(`  - **${r.name}** — https://${r.host} -> ${r.service}`));
  }

  if (parts.length === 0 || (parts.length === 1 && parts[0].includes("Cluster"))) {
    parts.push(`### Welcome to MCP AI Assistant`);
    parts.push(`\nI can help you explore your cluster. Try asking:`);
    parts.push(`  - "Show me CrashLoopBackOff pods"`);
    parts.push(`  - "Show me ImagePullBackOff pods"`);
    parts.push(`  - "Show me OOMKilled pods"`);
    parts.push(`  - "List all pod issues"`);
    parts.push(`  - "Show pods in namespace my-app"`);
    parts.push(`  - "Show warning events"`);
    parts.push(`  - "Check cluster health"`);
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

    // Override LLM settings from request (for UI provider selector)
    const llmOpts = {};
    if (body.provider) llmOpts.provider = body.provider;
    if (body.apiKey) llmOpts.apiKey = body.apiKey;
    if (body.apiUrl) llmOpts.apiUrl = body.apiUrl;
    if (body.model) llmOpts.model = body.model;

    const activeProvider = llmOpts.provider || LLM_PROVIDER;

    // 1. Gather cluster context
    const context = await gatherClusterContext(userMessage);

    // 2. Call LLM (or built-in analysis)
    const reply = await callLLM(userMessage, context, llmOpts);

    // 3. Return response
    json(res, 200, {
      reply,
      provider: activeProvider,
      contextKeys: Object.keys(context),
    });
  } catch (err) {
    console.error("Chat API error:", err);
    json(res, 500, { error: err.message });
  }
}
