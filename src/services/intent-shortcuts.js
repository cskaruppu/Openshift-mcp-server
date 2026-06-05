/**
 * Intent Shortcuts — fast-path formatters for common queries.
 *
 * When the NLU parse result matches a well-known intent+resource pair whose
 * answer is purely data-formatting (no LLM reasoning required), this module
 * produces the markdown reply directly. This saves an LLM round-trip and
 * gives the user an instant, deterministic response.
 *
 * Every handler receives:
 *   - parsed   {intent, resource, namespace, name, filter}  — NLU output
 *   - context  — the gathered cluster context object (pods, nodes, etc.)
 *   - platform — detected platform string ("openshift", "eks", "gke", etc.)
 *
 * Returns { handled: true, reply: "..." } or { handled: false }.
 */

// ---------------------------------------------------------------------------
// Utility formatters
// ---------------------------------------------------------------------------

/**
 * Format a Kubernetes timestamp to a human-readable relative age.
 * @param {string|Date} timestamp
 * @returns {string} e.g. "5m", "2h", "3d"
 */
export function formatAge(timestamp) {
  if (!timestamp) return "—";
  const then = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  if (isNaN(then.getTime())) return "—";
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Format CPU value (e.g. "250m", "1", "2000m") to readable form.
 * @param {string|number} value
 * @returns {string}
 */
export function formatCPU(value) {
  if (value === null || value === undefined) return "—";
  const s = String(value).trim();
  if (!s) return "—";
  if (s.endsWith("n")) {
    const nano = parseInt(s, 10);
    if (isNaN(nano)) return s;
    if (nano < 1_000_000) return `${Math.round(nano / 1000)}u`;
    return `${Math.round(nano / 1_000_000)}m`;
  }
  if (s.endsWith("u")) {
    const micro = parseInt(s, 10);
    if (isNaN(micro)) return s;
    return `${Math.round(micro / 1000)}m`;
  }
  if (s.endsWith("m")) return s;
  // Plain number = whole cores
  const cores = parseFloat(s);
  if (isNaN(cores)) return s;
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return `${cores}`;
}

/**
 * Format memory value (e.g. "128Mi", "1Gi", "1073741824") to readable form.
 * @param {string|number} value
 * @returns {string}
 */
export function formatMemory(value) {
  if (value === null || value === undefined) return "—";
  const s = String(value).trim();
  if (!s) return "—";

  // Already has a suffix — normalise to Gi if large enough
  if (s.endsWith("Ki")) {
    const ki = parseFloat(s);
    if (isNaN(ki)) return s;
    if (ki >= 1_048_576) return `${(ki / 1_048_576).toFixed(1)}Gi`;
    if (ki >= 1024) return `${Math.round(ki / 1024)}Mi`;
    return `${Math.round(ki)}Ki`;
  }
  if (s.endsWith("Mi")) {
    const mi = parseFloat(s);
    if (isNaN(mi)) return s;
    if (mi >= 1024) return `${(mi / 1024).toFixed(1)}Gi`;
    return `${Math.round(mi)}Mi`;
  }
  if (s.endsWith("Gi") || s.endsWith("Ti") || s.endsWith("Pi")) return s;

  // Plain bytes (no suffix)
  const bytes = parseInt(s, 10);
  if (isNaN(bytes)) return s;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)}Gi`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)}Mi`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}Ki`;
  return `${bytes}B`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pick the right CLI name for command suggestions. */
function cli(platform) {
  return /openshift|rosa|aro|ocp/i.test(platform || "") ? "oc" : "kubectl";
}

/** Pad a string to a minimum width (for table alignment isn't needed in md
 *  but we keep columns consistent). */
function esc(v) {
  return String(v ?? "—").replace(/\|/g, "\\|");
}

/** Derive pod status from container statuses or phase. */
function podStatus(pod) {
  if (!pod) return "Unknown";
  // Check container-level issues first
  const containers = pod.containers || pod.containerStatuses || [];
  for (const c of containers) {
    const state = c.state || c.status;
    if (typeof state === "string" && state !== "Running" && state !== "Completed") return state;
    if (state?.waiting?.reason) return state.waiting.reason;
    if (state?.terminated?.reason && state.terminated.reason !== "Completed") return state.terminated.reason;
  }
  return pod.phase || pod.status || "Unknown";
}

/** Total restarts across all containers. */
function podRestarts(pod) {
  const containers = pod.containers || pod.containerStatuses || [];
  return containers.reduce((sum, c) => sum + (c.restarts || c.restartCount || 0), 0);
}

/** Check whether a pod matches a filter string (CrashLoopBackOff, etc.). */
function matchesFilter(pod, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase();
  const status = podStatus(pod).toLowerCase();
  if (status.includes(f)) return true;
  const phase = (pod.phase || "").toLowerCase();
  if (phase.includes(f)) return true;
  // Check individual containers
  const containers = pod.containers || pod.containerStatuses || [];
  for (const c of containers) {
    const s = (c.state || c.status || "").toString().toLowerCase();
    if (s.includes(f)) return true;
    const lastState = (c.lastState || c.lastReason || "").toString().toLowerCase();
    if (lastState.includes(f)) return true;
  }
  return false;
}

/** Check if a pod is "failing" (not Running/Succeeded). */
function isFailing(pod) {
  const phase = (pod.phase || "").toLowerCase();
  if (phase === "failed" || phase === "unknown") return true;
  const status = podStatus(pod).toLowerCase();
  return ["crashloopbackoff", "imagepullbackoff", "errimagepull",
    "createcontainerconfigerror", "oomkilled", "error", "runcontainererror",
  ].some((bad) => status.includes(bad));
}

// ---------------------------------------------------------------------------
// Shortcut handlers — one per intent+resource combination
// ---------------------------------------------------------------------------

/**
 * (a) list + pods
 */
function listPods(parsed, context, platform) {
  const rawPods = context.allPods || context.namespacePods || context.pods || [];
  if (rawPods.length === 0 && !context.podsByPhase) return null;

  // If we only have aggregate counts (podsByPhase) without individual pods, defer
  if (rawPods.length === 0) return null;

  let pods = [...rawPods];

  // Filter by namespace
  if (parsed.namespace) {
    pods = pods.filter((p) => (p.namespace || p.metadata?.namespace) === parsed.namespace);
  }

  // Filter by status keyword
  if (parsed.filter) {
    pods = pods.filter((p) => matchesFilter(p, parsed.filter));
  }

  const running = pods.filter((p) => (p.phase || "").toLowerCase() === "running").length;
  const failing = pods.filter((p) => isFailing(p)).length;
  const nsLabel = parsed.namespace ? `namespace \`${parsed.namespace}\`` : "all namespaces";

  const parts = [];
  parts.push(`### Pods`);
  parts.push("");
  parts.push(`Showing **${pods.length}** pods (${running} running, ${failing} failing) in ${nsLabel}`);
  if (parsed.filter) parts.push(`Filtered by: **${parsed.filter}**`);
  parts.push("");

  if (pods.length === 0) {
    parts.push("No pods match the specified criteria.");
    return parts.join("\n");
  }

  parts.push("| Name | Namespace | Status | Restarts | Age | Node |");
  parts.push("| --- | --- | --- | ---: | --- | --- |");

  const display = pods.slice(0, 100);
  for (const p of display) {
    const name = esc(p.name || p.metadata?.name);
    const ns = esc(p.namespace || p.metadata?.namespace);
    const status = esc(podStatus(p));
    const restarts = podRestarts(p);
    const age = formatAge(p.startTime || p.creationTimestamp || p.metadata?.creationTimestamp);
    const node = esc(p.node || p.nodeName || p.spec?.nodeName);
    parts.push(`| ${name} | ${ns} | ${status} | ${restarts} | ${age} | ${node} |`);
  }

  if (pods.length > 100) {
    parts.push("");
    parts.push(`> Showing first 100 of ${pods.length} pods. Use \`${cli(platform)} get pods -A\` to see all.`);
  }

  return parts.join("\n");
}

/**
 * (b) list + nodes
 */
function listNodes(parsed, context, platform) {
  const nodes = context.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const readyCount = nodes.filter((n) => n.ready).length;
  let totalCPU = 0;
  let totalMemGi = 0;
  for (const n of nodes) {
    const cpu = parseCPUToMillicores(n.cpu);
    totalCPU += cpu;
    const mem = parseMemoryToGi(n.memory);
    totalMemGi += mem;
  }

  const parts = [];
  parts.push("### Nodes");
  parts.push("");
  parts.push(`**${nodes.length}** nodes (**${readyCount}** ready), total capacity: **${Math.round(totalCPU / 1000)}** CPU, **${totalMemGi.toFixed(1)}** GiB memory`);
  parts.push("");
  parts.push("| Name | Status | Roles | Version | CPU (used/alloc) | Memory (used/alloc) | Pods |");
  parts.push("| --- | --- | --- | --- | --- | --- | ---: |");

  // Try to merge metrics if available
  const metricsMap = new Map();
  if (Array.isArray(context.nodeMetrics)) {
    for (const m of context.nodeMetrics) {
      const key = m.name || m.node;
      if (key) metricsMap.set(key, m);
    }
  }

  for (const n of nodes) {
    const name = esc(n.name);
    const status = n.ready ? "Ready" : "**NotReady**";
    const roles = esc((n.roles || []).join(", ") || "—");
    const version = esc(n.kubeletVersion || n.version || "—");
    const m = metricsMap.get(n.name);
    const cpuUsed = m ? formatCPU(m.cpuUsage || m.cpu) : "—";
    const cpuAlloc = formatCPU(n.cpu);
    const memUsed = m ? formatMemory(m.memoryUsage || m.memory) : "—";
    const memAlloc = formatMemory(n.memory);
    const podCount = n.pods ?? n.podCount ?? "—";
    parts.push(`| ${name} | ${status} | ${roles} | ${version} | ${cpuUsed}/${cpuAlloc} | ${memUsed}/${memAlloc} | ${podCount} |`);
  }

  const notReady = nodes.filter((n) => !n.ready);
  if (notReady.length > 0) {
    parts.push("");
    parts.push(`> **${notReady.length}** node(s) are NotReady. Investigate with \`${cli(platform)} describe node ${notReady[0].name}\``);
  }

  return parts.join("\n");
}

/**
 * (c) list + deployments
 */
function listDeployments(parsed, context, platform) {
  let deps = context.deployments || context.namespaceDeployments || [];
  if (!Array.isArray(deps) || deps.length === 0) return null;

  if (parsed.namespace) {
    deps = deps.filter((d) => (d.namespace || d.metadata?.namespace) === parsed.namespace);
  }

  const parts = [];
  parts.push("### Deployments");
  parts.push("");
  parts.push(`**${deps.length}** deployment(s)${parsed.namespace ? ` in namespace \`${parsed.namespace}\`` : ""}`);
  parts.push("");
  parts.push("| Name | Namespace | Ready | Up-to-date | Available | Age |");
  parts.push("| --- | --- | --- | ---: | ---: | --- |");

  for (const d of deps.slice(0, 80)) {
    const name = esc(d.name || d.metadata?.name);
    const ns = esc(d.namespace || d.metadata?.namespace);
    const replicas = d.replicas ?? d.spec?.replicas ?? 0;
    const ready = d.ready ?? d.readyReplicas ?? d.status?.readyReplicas ?? 0;
    const upToDate = d.upToDate ?? d.updatedReplicas ?? d.status?.updatedReplicas ?? 0;
    const available = d.available ?? d.availableReplicas ?? d.status?.availableReplicas ?? 0;
    const age = formatAge(d.creationTimestamp || d.metadata?.creationTimestamp);
    const healthy = ready >= replicas && replicas > 0;
    const readyStr = healthy ? `${ready}/${replicas}` : `**${ready}/${replicas}**`;
    parts.push(`| ${name} | ${ns} | ${readyStr} | ${upToDate} | ${available} | ${age} |`);
  }

  const unhealthy = deps.filter((d) => {
    const replicas = d.replicas ?? d.spec?.replicas ?? 0;
    const ready = d.ready ?? d.readyReplicas ?? d.status?.readyReplicas ?? 0;
    return replicas > 0 && ready < replicas;
  });

  if (unhealthy.length > 0) {
    parts.push("");
    parts.push(`> **${unhealthy.length}** deployment(s) are not fully available. Check with \`${cli(platform)} get deploy ${unhealthy[0].name || unhealthy[0].metadata?.name} -o yaml\``);
  }

  if (deps.length > 80) {
    parts.push("");
    parts.push(`> Showing first 80 of ${deps.length} deployments.`);
  }

  return parts.join("\n");
}

/**
 * (d) list + namespaces
 */
function listNamespaces(parsed, context) {
  const nsList = context.namespaces;
  if (!Array.isArray(nsList) || nsList.length === 0) return null;

  const parts = [];
  parts.push("### Namespaces");
  parts.push("");
  parts.push(`**${nsList.length}** namespace(s)`);
  parts.push("");
  parts.push("| Name | Status | Age | Pod Count |");
  parts.push("| --- | --- | --- | ---: |");

  for (const ns of nsList.slice(0, 100)) {
    const name = esc(ns.name || ns.metadata?.name);
    const status = esc(ns.status || ns.phase || "Active");
    const age = formatAge(ns.creationTimestamp || ns.metadata?.creationTimestamp);
    const podCount = ns.podCount ?? ns.pods ?? "—";
    parts.push(`| ${name} | ${status} | ${age} | ${podCount} |`);
  }

  if (nsList.length > 100) {
    parts.push("");
    parts.push(`> Showing first 100 of ${nsList.length} namespaces.`);
  }

  return parts.join("\n");
}

/**
 * (e) list + services
 */
function listServices(parsed, context) {
  let svcs = context.services || [];
  if (!Array.isArray(svcs) || svcs.length === 0) return null;

  if (parsed.namespace) {
    svcs = svcs.filter((s) => (s.namespace || s.metadata?.namespace) === parsed.namespace);
  }

  const parts = [];
  parts.push("### Services");
  parts.push("");
  parts.push(`**${svcs.length}** service(s)${parsed.namespace ? ` in namespace \`${parsed.namespace}\`` : ""}`);
  parts.push("");
  parts.push("| Name | Namespace | Type | Cluster-IP | Ports |");
  parts.push("| --- | --- | --- | --- | --- |");

  for (const s of svcs.slice(0, 100)) {
    const name = esc(s.name || s.metadata?.name);
    const ns = esc(s.namespace || s.metadata?.namespace);
    const type = esc(s.type || s.spec?.type || "ClusterIP");
    const clusterIP = esc(s.clusterIP || s.spec?.clusterIP);
    const ports = esc(
      (s.ports || s.spec?.ports || [])
        .map((p) => (typeof p === "string" ? p : `${p.port}/${p.protocol || "TCP"}`))
        .join(", ")
    );
    parts.push(`| ${name} | ${ns} | ${type} | ${clusterIP} | ${ports} |`);
  }

  return parts.join("\n");
}

/**
 * (f) get + pod (specific pod detail)
 */
function getPodDetail(parsed, context, platform) {
  const pod = context.targetPod;
  if (!pod) return null;

  const parts = [];
  parts.push(`### Pod: \`${pod.name}\``);
  parts.push("");

  // Basic info table
  parts.push("| Property | Value |");
  parts.push("| --- | --- |");
  parts.push(`| **Namespace** | ${esc(pod.namespace)} |`);
  parts.push(`| **Node** | ${esc(pod.node)} |`);
  parts.push(`| **Phase** | ${esc(pod.phase)} |`);
  if (pod.ip || pod.podIP) parts.push(`| **Pod IP** | ${esc(pod.ip || pod.podIP)} |`);
  if (pod.startTime) parts.push(`| **Age** | ${formatAge(pod.startTime)} |`);
  if (pod.ownerKind) parts.push(`| **Owner** | ${esc(pod.ownerKind)}/${esc(pod.ownerName)} |`);
  parts.push("");

  // Containers
  const containers = pod.containers || [];
  if (containers.length > 0) {
    parts.push("#### Containers");
    parts.push("");
    parts.push("| Name | Status | Restarts | Image |");
    parts.push("| --- | --- | ---: | --- |");
    for (const c of containers) {
      const cName = esc(c.name);
      const cState = esc(c.state || (c.ready ? "Running" : "Unknown"));
      const cRestarts = c.restarts ?? c.restartCount ?? 0;
      const cImage = esc(c.image || "—");
      parts.push(`| ${cName} | ${cState} | ${cRestarts} | ${cImage} |`);

      // Show last termination state if relevant
      if (c.lastState) {
        const lr = c.lastState;
        parts.push(`| | _Last: ${esc(lr.reason)}${lr.exitCode !== undefined ? ` (exit ${lr.exitCode})` : ""}${lr.finishedAt ? ` at ${lr.finishedAt}` : ""}_ | | |`);
      }
    }
    parts.push("");
  }

  // Images (from spec — may differ from container status)
  if (pod.images && pod.images.length > 0) {
    parts.push("**Images:** " + pod.images.map((i) => `\`${i}\``).join(", "));
    parts.push("");
  }

  // Resource limits
  if (pod.resourceLimits && pod.resourceLimits.length > 0) {
    const hasResources = pod.resourceLimits.some(
      (r) => r.cpuRequest || r.cpuLimit || r.memRequest || r.memLimit
    );
    if (hasResources) {
      parts.push("#### Resource Requests/Limits");
      parts.push("");
      parts.push("| Container | CPU Req | CPU Limit | Mem Req | Mem Limit |");
      parts.push("| --- | --- | --- | --- | --- |");
      for (const r of pod.resourceLimits) {
        parts.push(`| ${esc(r.name)} | ${formatCPU(r.cpuRequest)} | ${formatCPU(r.cpuLimit)} | ${formatMemory(r.memRequest)} | ${formatMemory(r.memLimit)} |`);
      }
      parts.push("");
    }
  }

  // Conditions
  if (pod.conditions && pod.conditions.length > 0) {
    parts.push("#### Conditions");
    parts.push("");
    parts.push("| Type | Status | Reason | Message |");
    parts.push("| --- | --- | --- | --- |");
    for (const cond of pod.conditions) {
      parts.push(`| ${esc(cond.type)} | ${esc(cond.status)} | ${esc(cond.reason)} | ${esc((cond.message || "").slice(0, 120))} |`);
    }
    parts.push("");
  }

  // Events
  const events = context.targetPodEvents || [];
  if (events.length > 0) {
    parts.push("#### Recent Events");
    parts.push("");
    parts.push("| Type | Reason | Message | Count | Last Seen |");
    parts.push("| --- | --- | --- | ---: | --- |");
    for (const e of events.slice(0, 15)) {
      parts.push(`| ${esc(e.type)} | ${esc(e.reason)} | ${esc((e.message || "").slice(0, 100))} | ${e.count ?? 1} | ${formatAge(e.lastSeen || e.lastTimestamp)} |`);
    }
    parts.push("");
  }

  // Command hints
  parts.push(`> Dig deeper: \`${cli(platform)} logs ${pod.name} -n ${pod.namespace}\` | \`${cli(platform)} describe pod ${pod.name} -n ${pod.namespace}\``);

  return parts.join("\n");
}

/**
 * (g) pod_summary
 */
function podSummary(parsed, context) {
  const total = context.totalPods;
  const byPhase = context.podsByPhase;
  if (!total && !byPhase) return null;

  const running = byPhase?.Running || 0;
  const pending = byPhase?.Pending || 0;
  const failed = (byPhase?.Failed || 0) + (byPhase?.Unknown || 0);
  const succeeded = byPhase?.Succeeded || 0;

  // Count CrashLoopBackOff pods from problem pods
  const crashLoop = (context.problemPods || []).filter((p) =>
    (p.containers || []).some((c) => (c.state || "").includes("CrashLoopBackOff"))
  ).length;

  const parts = [];
  parts.push(`**Pod Summary**: ${total ?? "?"} total — ${running} Running, ${pending} Pending, ${failed} Failed, ${succeeded} Completed${crashLoop > 0 ? `, ${crashLoop} CrashLoopBackOff` : ""}`);
  parts.push("");

  // Phase breakdown
  if (byPhase) {
    const phases = Object.entries(byPhase).sort((a, b) => b[1] - a[1]);
    for (const [phase, count] of phases) {
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
      parts.push(`- **${phase}**: ${count} (${pct}%)`);
    }
    parts.push("");
  }

  // Namespace breakdown if we have per-namespace data
  if (Array.isArray(context.namespaces) && context.namespaces.length > 0) {
    const nsWithPods = context.namespaces
      .filter((n) => (n.podCount || n.running || n.failed || n.pending) && n.podCount > 0)
      .sort((a, b) => (b.podCount || 0) - (a.podCount || 0))
      .slice(0, 15);

    if (nsWithPods.length > 0) {
      parts.push("**By Namespace** (top 15):");
      parts.push("");
      parts.push("| Namespace | Pods | Running | Failed | Pending |");
      parts.push("| --- | ---: | ---: | ---: | ---: |");
      for (const ns of nsWithPods) {
        parts.push(`| ${esc(ns.name)} | ${ns.podCount || 0} | ${ns.running || "—"} | ${ns.failed || 0} | ${ns.pending || 0} |`);
      }
      parts.push("");
    }
  }

  // Mention problem pods briefly
  if (context.problemPods && context.problemPods.length > 0) {
    const issueStates = {};
    context.problemPods.forEach((p) =>
      (p.containers || []).forEach((c) => {
        const st = c.state || "Unknown";
        issueStates[st] = (issueStates[st] || 0) + 1;
      })
    );
    parts.push(`**${context.problemPods.length}** pod(s) with issues: ` +
      Object.entries(issueStates).map(([s, n]) => `${n} ${s}`).join(", "));
  }

  return parts.join("\n");
}

/**
 * (h) list + events
 */
function listEvents(parsed, context) {
  const events = context.warningEvents || context.events || context.recentWarnings || [];
  if (!Array.isArray(events) || events.length === 0) return null;

  const parts = [];
  parts.push("### Warning Events");
  parts.push("");
  parts.push(`**${events.length}** recent warning event(s)`);
  parts.push("");
  parts.push("| Time | Type | Reason | Object | Message |");
  parts.push("| --- | --- | --- | --- | --- |");

  for (const e of events.slice(0, 30)) {
    const time = formatAge(e.lastSeen || e.lastTimestamp);
    const type = esc(e.type || "Warning");
    const reason = esc(e.reason);
    const obj = esc(e.object || e.resource || "—");
    const msg = esc((e.message || "").slice(0, 120));
    parts.push(`| ${time} ago | ${type} | ${reason} | ${obj} | ${msg} |`);
  }

  if (events.length > 30) {
    parts.push("");
    parts.push(`> Showing first 30 of ${events.length} events.`);
  }

  return parts.join("\n");
}

/**
 * (i) cluster_health
 */
function clusterHealth(parsed, context, platform) {
  const parts = [];
  parts.push("### Cluster Health");
  parts.push("");

  if (context.clusterVersion) {
    const version = typeof context.clusterVersion === "object"
      ? context.clusterVersion.version || context.clusterVersion.desired
      : context.clusterVersion;
    const channel = (typeof context.clusterVersion === "object" ? context.clusterVersion.channel : context.channel) || "—";
    parts.push(`**Platform**: ${platform || "Kubernetes"} ${version || "unknown"} (channel: ${channel})`);
    parts.push("");
  }

  // Nodes
  const nodes = context.nodes || [];
  const readyNodes = nodes.filter((n) => n.ready).length;
  const totalNodes = nodes.length || context.totalNodes || 0;
  const nodeStatus = readyNodes === totalNodes && totalNodes > 0 ? "✓" : totalNodes === 0 ? "—" : readyNodes === 0 ? "✗" : "⚠";
  parts.push(`${nodeStatus} **Nodes**: ${readyNodes}/${totalNodes} ready`);

  // Operators
  const operators = context.operators || [];
  const degradedOps = operators.filter((o) =>
    o.degraded === "True" || o.health === "degraded"
  );
  if (operators.length > 0) {
    const opStatus = degradedOps.length === 0 ? "✓" : degradedOps.length <= 2 ? "⚠" : "✗";
    parts.push(`${opStatus} **Operators**: ${operators.length} total, ${degradedOps.length} degraded`);
    if (degradedOps.length > 0) {
      for (const o of degradedOps.slice(0, 5)) {
        parts.push(`  - \`${o.name}\`: degraded${o.message ? " — " + (o.message || "").slice(0, 80) : ""}`);
      }
    }
  }

  // Problem pods
  const problemPods = context.problemPods || [];
  const podStatus = problemPods.length === 0 ? "✓" : problemPods.length <= 5 ? "⚠" : "✗";
  const totalPods = context.totalPods || "?";
  parts.push(`${podStatus} **Pods**: ${problemPods.length} problem pods out of ${totalPods} total`);

  // Alerts (if available)
  const alerts = context.firingAlerts || context.alerts || [];
  if (Array.isArray(alerts) && alerts.length > 0) {
    const critAlerts = alerts.filter((a) => (a.severity || "").toLowerCase() === "critical");
    const alertStatus = critAlerts.length > 0 ? "✗" : alerts.length > 5 ? "⚠" : "⚠";
    parts.push(`${alertStatus} **Alerts**: ${alerts.length} firing (${critAlerts.length} critical)`);
  }

  // Warning events
  const warnEvents = context.warningEvents || context.recentWarnings || [];
  if (warnEvents.length > 0) {
    parts.push(`⚠ **Warning Events**: ${warnEvents.length} recent`);
  }

  parts.push("");

  // Quick command suggestions
  const c = cli(platform);
  parts.push(`> Quick commands: \`${c} get nodes\` | \`${c} get co\` | \`${c} get pods -A --field-selector=status.phase!=Running\``);

  return parts.join("\n");
}

/**
 * (j) list + operators (OpenShift)
 */
function listOperators(parsed, context) {
  const operators = context.operators;
  if (!Array.isArray(operators) || operators.length === 0) return null;

  const degraded = operators.filter((o) => o.degraded === "True" || o.health === "degraded");
  const parts = [];
  parts.push("### Cluster Operators");
  parts.push("");
  parts.push(`**${operators.length}** operator(s) — ${degraded.length} degraded`);
  parts.push("");
  parts.push("| Name | Available | Degraded | Version | Message |");
  parts.push("| --- | --- | --- | --- | --- |");

  for (const o of operators) {
    const name = esc(o.name);
    const avail = (o.available || "—") === "True" ? "✓" : (o.available === "False" ? "✗" : esc(o.available));
    const deg = (o.degraded || "—") === "True" ? "**Yes**" : (o.degraded === "False" ? "No" : esc(o.degraded));
    const version = esc(o.version || "—");
    const msg = esc((o.message || "").slice(0, 100));
    parts.push(`| ${name} | ${avail} | ${deg} | ${version} | ${msg} |`);
  }

  if (degraded.length > 0) {
    parts.push("");
    parts.push(`> **${degraded.length}** operator(s) are degraded. Review with \`oc describe co ${degraded[0].name}\``);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CPU / Memory parsing helpers (for computing totals)
// ---------------------------------------------------------------------------

/** Parse a CPU string to millicores. */
function parseCPUToMillicores(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (s.endsWith("m")) return parseInt(s, 10) || 0;
  if (s.endsWith("n")) return Math.round((parseInt(s, 10) || 0) / 1_000_000);
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 1000);
}

/** Parse a memory string to GiB. */
function parseMemoryToGi(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (s.endsWith("Ki")) return (parseFloat(s) || 0) / 1_048_576;
  if (s.endsWith("Mi")) return (parseFloat(s) || 0) / 1024;
  if (s.endsWith("Gi")) return parseFloat(s) || 0;
  if (s.endsWith("Ti")) return (parseFloat(s) || 0) * 1024;
  const bytes = parseInt(s, 10);
  return isNaN(bytes) ? 0 : bytes / 1_073_741_824;
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

const SHORTCUT_MAP = {
  // intent:resource → handler
  "list:pod":          listPods,
  "list:node":         listNodes,
  "list:deployment":   listDeployments,
  "list:namespace":    listNamespaces,
  "list:project":      listNamespaces,
  "list:service":      listServices,
  "list:event":        listEvents,
  "list:clusteroperator": listOperators,
  "get:pod":           getPodDetail,
  "pod_summary:":      podSummary,
  "pod_summary:pod":   podSummary,
  "cluster_health:":   clusterHealth,
  "cluster_health:node": clusterHealth,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to answer a query using pre-built formatters.
 *
 * @param {{intent: string, resource: string|null, namespace: string|null, name: string|null, filter: string|null}} parsed
 * @param {object} context - Gathered cluster context
 * @param {string} platform - Detected platform string
 * @returns {{ handled: boolean, reply?: string }}
 */
export function tryShortcut(parsed, context, platform) {
  if (!parsed || !context) return { handled: false };

  const intent = parsed.intent || "";
  const resource = parsed.resource || "";

  // For "get + pod" we need a specific pod in context — not a diagnosis
  if (intent === "get" && resource === "pod" && !context.targetPod) {
    return { handled: false };
  }

  // Try exact intent:resource match
  let key = `${intent}:${resource}`;
  let handler = SHORTCUT_MAP[key];

  // Fallback: some intents (pod_summary, cluster_health) don't need a resource
  if (!handler) {
    key = `${intent}:`;
    handler = SHORTCUT_MAP[key];
  }

  if (!handler) return { handled: false };

  try {
    const reply = handler(parsed, context, platform);
    if (reply) {
      return { handled: true, reply };
    }
    // Handler returned null — data wasn't available, fall through to LLM
    return { handled: false };
  } catch (err) {
    // Never let a formatter crash the pipeline — just fall through
    console.error(`[intent-shortcuts] Error in ${key}:`, err.message);
    return { handled: false };
  }
}
