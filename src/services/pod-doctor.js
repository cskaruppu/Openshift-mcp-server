/**
 * Pod Doctor — automated root-cause diagnosis engine.
 *
 * Analyzes pod container states, events, logs, and metrics to determine
 * WHY a pod is failing, then generates specific executable fix proposals.
 * Results are injected into the LLM context so the AI can provide
 * intelligent commentary and present actionable @@FIX_PROPOSAL@@ cards.
 */

const EXIT_CODE_MAP = {
  0: "success",
  1: "application error",
  2: "misconfiguration (bad usage/args)",
  126: "permission denied (cannot execute)",
  127: "command not found",
  128: "invalid exit argument",
  130: "SIGINT (Ctrl+C)",
  134: "SIGABRT (abort/assert failure)",
  137: "SIGKILL (OOMKilled or forced kill)",
  139: "SIGSEGV (segmentation fault)",
  143: "SIGTERM (graceful shutdown)",
};

function exitCodeMeaning(code) {
  if (code === null || code === undefined) return null;
  return EXIT_CODE_MAP[code] || (code > 128 ? `signal ${code - 128}` : `unknown (code ${code})`);
}

/**
 * Diagnose a specific pod and generate structured findings + fix proposals.
 *
 * @param {object} pod - targetPod from gatherClusterContext
 * @param {object} opts
 * @param {Array} opts.events - targetPodEvents
 * @param {string} opts.logs - targetPodLogs
 * @param {string} opts.logsPrevious - targetPodLogsPrevious
 * @param {object} opts.metrics - targetPodMetrics
 * @returns {object} { diagnosis, fixes[], evidence[], severity }
 */
export function diagnosePod(pod, opts = {}) {
  const { events = [], logs = "", logsPrevious = "", metrics = null } = opts;

  const result = {
    podName: pod.name,
    namespace: pod.namespace,
    severity: "info",
    diagnosis: null,
    rootCause: null,
    evidence: [],
    fixes: [],
    logSnippet: null,
  };

  if (!pod.containers || pod.containers.length === 0) {
    result.diagnosis = "No container status available for this pod.";
    return result;
  }

  const totalRestarts = pod.containers.reduce((s, c) => s + (c.restarts || 0), 0);
  const crashingContainers = pod.containers.filter(
    (c) => c.restarts > 0 || /CrashLoopBackOff|Error|OOMKilled|Terminated/.test(c.state)
  );

  if (totalRestarts === 0 && pod.phase === "Running" && pod.containers.every((c) => c.ready)) {
    result.diagnosis = "Pod is healthy — all containers running and ready with zero restarts.";
    return result;
  }

  for (const container of crashingContainers.length > 0 ? crashingContainers : pod.containers) {
    const diag = diagnoseContainer(container, pod, events, logs, logsPrevious, metrics);
    if (diag.severity === "critical") result.severity = "critical";
    else if (diag.severity === "warning" && result.severity !== "critical") result.severity = "warning";

    if (diag.rootCause && !result.rootCause) {
      result.rootCause = diag.rootCause;
      result.diagnosis = diag.diagnosis;
    }
    result.evidence.push(...diag.evidence);
    result.fixes.push(...diag.fixes);
    if (diag.logSnippet) result.logSnippet = diag.logSnippet;
  }

  if (!result.diagnosis) {
    result.diagnosis = `Pod ${pod.name} has ${totalRestarts} restart(s) but no clear crash signal in the available data.`;
    result.rootCause = "unknown";
    result.fixes.push({
      title: "Restart the pod to clear transient state",
      action: "delete_pod",
      resource: pod.name,
      namespace: pod.namespace,
      command: `oc delete pod ${pod.name} -n ${pod.namespace}`,
      risk: "low",
      description: "Deletes the pod so its controller recreates it. Safe for managed pods.",
    });
  }

  return result;
}

function diagnoseContainer(container, pod, events, logs, logsPrevious, metrics) {
  const diag = {
    containerName: container.name,
    severity: "info",
    rootCause: null,
    diagnosis: null,
    evidence: [],
    fixes: [],
    logSnippet: null,
  };

  const exitCode = container.exitCode ?? container.lastState?.exitCode;
  const terminationReason = container.lastState?.reason || container.state;
  const restarts = container.restarts || 0;
  const limits = (pod.resourceLimits || []).find((r) => r.name === container.name) || {};
  const ownerKind = pod.ownerKind || "unknown";
  const ownerName = pod.ownerName || pod.name;

  // OOMKilled
  if (exitCode === 137 || terminationReason === "OOMKilled" || container.state === "OOMKilled") {
    diag.severity = "critical";
    diag.rootCause = "OOMKilled";
    diag.diagnosis = `Container "${container.name}" is being killed by the OOM Killer (exit code 137). ` +
      `The process exceeds its memory limit${limits.memLimit ? " of " + limits.memLimit : ""} and the kernel terminates it.`;

    diag.evidence.push(`Exit code: 137 (SIGKILL — OOM Killer)`);
    if (limits.memLimit) diag.evidence.push(`Memory limit: ${limits.memLimit}`);
    if (limits.memRequest) diag.evidence.push(`Memory request: ${limits.memRequest}`);
    if (restarts > 0) diag.evidence.push(`Restart count: ${restarts}`);
    if (metrics) {
      const mc = (metrics.containers || []).find((c) => c.name === container.name);
      if (mc?.memory) diag.evidence.push(`Current memory usage: ${mc.memory}`);
    }

    const currentLimit = parseMemory(limits.memLimit);
    let currentUsage = null;
    if (metrics) {
      const mc = (metrics.containers || []).find((c) => c.name === container.name);
      if (mc?.memory) currentUsage = parseMemory(mc.memory);
    }
    const smart = calculateSmartMemoryLimit(currentLimit, currentUsage, restarts);
    const deployRes = resolveDeploymentResource(ownerKind, ownerName, pod.namespace);
    diag.evidence.push(`Recommendation: ${smart.reasoning}`);

    diag.fixes.push({
      title: `Increase memory limits for ${container.name}`,
      action: "set_resources",
      resource: deployRes.name,
      resourceType: deployRes.kind,
      namespace: pod.namespace,
      command: `oc -n ${pod.namespace} set resources ${deployRes.kind}/${deployRes.name} --containers=${container.name} --limits=memory=${smart.limit} --requests=memory=${smart.request}`,
      risk: "low",
      description: `Increases memory limit from ${limits.memLimit || "default"} to ${smart.limit} (request: ${smart.request}). ${smart.reasoning}. This triggers a rolling restart of the pods.`,
      patchBody: buildResourcePatch(container.name, { memLimit: smart.limit, memRequest: smart.request }),
      deploymentName: deployRes.name,
    });

    return diag;
  }

  // CrashLoopBackOff with known exit code
  if (container.state === "CrashLoopBackOff" || (restarts > 5 && exitCode !== undefined && exitCode !== 0)) {
    diag.severity = "critical";
    diag.rootCause = "CrashLoopBackOff";
    const meaning = exitCodeMeaning(exitCode);

    diag.diagnosis = `Container "${container.name}" is crash-looping with ${restarts} restarts. ` +
      `Exit code: ${exitCode}${meaning ? " (" + meaning + ")" : ""}.`;

    diag.evidence.push(`State: CrashLoopBackOff`);
    diag.evidence.push(`Restarts: ${restarts}`);
    if (exitCode !== undefined) diag.evidence.push(`Exit code: ${exitCode} — ${meaning || "unknown"}`);
    if (terminationReason) diag.evidence.push(`Last termination: ${terminationReason}`);

    const backoffEvents = events.filter((e) => e.reason === "BackOff");
    if (backoffEvents.length > 0) {
      diag.evidence.push(`BackOff events: ${backoffEvents.length} occurrences`);
    }

    const errorLines = extractErrorLines(logsPrevious || logs);
    if (errorLines.length > 0) {
      diag.logSnippet = errorLines.join("\n");
      diag.evidence.push(`Error in logs: ${errorLines[0].substring(0, 150)}`);

      if (exitCode === 1 || exitCode === 2 || exitCode === 126 || exitCode === 127) {
        diag.diagnosis += exitCode === 2
          ? ` The process is rejecting its command-line arguments or configuration. `
          : exitCode === 127
            ? ` The container entrypoint command was not found. `
            : ` The application is crashing on startup. `;
        const configIssue = detectConfigIssue(errorLines, events);
        if (configIssue) {
          diag.diagnosis += configIssue.description;
          diag.rootCause = configIssue.type;
          if (configIssue.fix) diag.fixes.push(configIssue.fix);
        } else if (exitCode === 2) {
          diag.diagnosis += `Relevant log lines: "${errorLines[0].substring(0, 200)}". ` +
            `Check the container args, command, and config files — restarting alone will not resolve a misconfiguration.`;
          diag.rootCause = "BadArgs";
        }
      }
    } else if (exitCode === 2) {
      diag.diagnosis += ` Exit code 2 indicates bad arguments or misconfiguration, but no error lines were found in the available logs. ` +
        `Check the container command/args in the deployment spec and verify that all required config (ConfigMaps, Secrets, volumes) is mounted correctly.`;
      diag.rootCause = "BadArgs";
    }

    // Liveness probe failure causing restarts
    const probeEvents = events.filter((e) =>
      e.reason === "Unhealthy" && e.message && /liveness/i.test(e.message)
    );
    if (probeEvents.length > 0) {
      diag.rootCause = "LivenessProbeFailure";
      diag.diagnosis = `Container "${container.name}" is being killed because its liveness probe is failing. ` +
        `The kubelet restarts the container after ${probeEvents.length} consecutive probe failures.`;
      diag.evidence.push(`Liveness probe failures: ${probeEvents.length}`);
      if (probeEvents[0]?.message) diag.evidence.push(`Probe error: ${probeEvents[0].message.substring(0, 200)}`);

      const deployRes = resolveDeploymentResource(ownerKind, ownerName, pod.namespace);
      diag.fixes.push({
        title: "Increase liveness probe timing to allow slower startup",
        action: "patch_deployment",
        resource: deployRes.name,
        resourceType: deployRes.kind,
        namespace: pod.namespace,
        command: `oc -n ${pod.namespace} patch ${deployRes.kind}/${deployRes.name} --type=json -p='[{"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/initialDelaySeconds","value":60},{"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/timeoutSeconds","value":10}]'`,
        risk: "low",
        description: "Increases the liveness probe initial delay to 60s and timeout to 10s, giving the application more time to become ready.",
        patchBody: {
          spec: { template: { spec: { containers: [{ name: container.name, livenessProbe: { initialDelaySeconds: 60, timeoutSeconds: 10 } }] } } }
        },
        deploymentName: deployRes.name,
      });
    }

    const deployRes = resolveDeploymentResource(ownerKind, ownerName, pod.namespace);

    // For config-related exit codes, add an inspect fix BEFORE restart
    if (exitCode === 2 || exitCode === 126 || exitCode === 127 || diag.rootCause === "BadArgs" || diag.rootCause === "BadFlag" || diag.rootCause === "MissingRequiredArg" || diag.rootCause === "ConfigParseError") {
      diag.fixes.push({
        title: `Inspect ${deployRes.kind}/${deployRes.name} spec (args, env, mounts)`,
        action: "describe",
        resource: deployRes.name,
        namespace: pod.namespace,
        command: `oc get ${deployRes.kind}/${deployRes.name} -n ${pod.namespace} -o yaml`,
        risk: "none",
        description: "View the deployment spec to check container command, args, environment variables, and volume mounts. Fix the misconfiguration before restarting.",
      });
      diag.fixes.push({
        title: `View previous container logs for ${container.name}`,
        action: "logs",
        resource: pod.name,
        namespace: pod.namespace,
        command: `oc logs ${pod.name} -c ${container.name} -n ${pod.namespace} --previous`,
        risk: "none",
        description: "Fetch the full previous-container logs to identify the exact startup error.",
      });
    }

    diag.fixes.push({
      title: "Restart the pod to clear crash state",
      action: "delete_pod",
      resource: pod.name,
      namespace: pod.namespace,
      command: `oc delete pod ${pod.name} -n ${pod.namespace}`,
      risk: "low",
      description: exitCode === 2
        ? "Deletes and recreates the pod. Note: restart alone will NOT fix a misconfiguration — fix the args/config first."
        : "Deletes and recreates the pod. Useful after fixing the underlying issue.",
    });

    if (ownerKind === "ReplicaSet" || ownerKind === "Deployment") {
      diag.fixes.push({
        title: `Rollout restart ${deployRes.kind}/${deployRes.name}`,
        action: "restart_deployment",
        resource: deployRes.name,
        namespace: pod.namespace,
        command: `oc -n ${pod.namespace} rollout restart ${deployRes.kind}/${deployRes.name}`,
        risk: "low",
        description: "Triggers a rolling restart of all pods in the deployment. Applies any pending config changes.",
      });
    }

    return diag;
  }

  // Readiness probe failures (pod running but not ready)
  const readinessEvents = events.filter((e) =>
    e.reason === "Unhealthy" && e.message && /readiness/i.test(e.message)
  );
  if (readinessEvents.length > 0 && !container.ready) {
    diag.severity = "warning";
    diag.rootCause = "ReadinessProbeFailure";
    diag.diagnosis = `Container "${container.name}" is running but not ready. Its readiness probe is failing, so it receives no traffic.`;
    diag.evidence.push(`Readiness probe failures: ${readinessEvents.length}`);
    if (readinessEvents[0]?.message) diag.evidence.push(`Probe: ${readinessEvents[0].message.substring(0, 200)}`);
    return diag;
  }

  // ImagePullBackOff
  if (container.state === "ImagePullBackOff" || container.state === "ErrImagePull") {
    diag.severity = "critical";
    diag.rootCause = "ImagePullFailure";
    const img = (pod.images || []).find((_, i) => i === pod.containers.indexOf(container)) || "unknown";
    diag.diagnosis = `Container "${container.name}" cannot pull its image: ${img}`;
    const pullEvent = events.find((e) => e.reason === "Failed" && e.message?.toLowerCase().includes("pull"));
    if (pullEvent) diag.evidence.push(`Pull error: ${pullEvent.message.substring(0, 200)}`);
    diag.evidence.push(`Image: ${img}`);
    return diag;
  }

  // CreateContainerConfigError
  if (container.state === "CreateContainerConfigError") {
    diag.severity = "critical";
    diag.rootCause = "ConfigError";
    const cfgEvent = events.find((e) => e.reason === "Failed" && (e.message?.includes("configmap") || e.message?.includes("secret")));
    if (cfgEvent) {
      diag.diagnosis = `Container "${container.name}" cannot start due to missing configuration: ${cfgEvent.message.substring(0, 200)}`;
      diag.evidence.push(cfgEvent.message.substring(0, 200));
    } else {
      diag.diagnosis = `Container "${container.name}" has a configuration error — a referenced ConfigMap, Secret, or volume mount may not exist.`;
    }
    return diag;
  }

  // High restarts but running (intermittent crashes)
  if (restarts > 10 && container.ready) {
    diag.severity = "warning";
    diag.rootCause = "IntermittentCrash";
    const meaning = exitCodeMeaning(exitCode);
    diag.diagnosis = `Container "${container.name}" is currently running but has ${restarts} restarts, indicating intermittent crashes.` +
      (exitCode !== undefined ? ` Last exit: code ${exitCode} (${meaning}).` : "");
    diag.evidence.push(`Restarts: ${restarts}`);
    if (exitCode !== undefined) diag.evidence.push(`Last exit code: ${exitCode} — ${meaning}`);

    if (exitCode === 137) {
      const currentLimit = parseMemory(limits.memLimit);
      let currentUsage = null;
      if (metrics) {
        const mc = (metrics.containers || []).find((c) => c.name === container.name);
        if (mc?.memory) currentUsage = parseMemory(mc.memory);
      }
      const smart = calculateSmartMemoryLimit(currentLimit, currentUsage, restarts);
      const deployRes = resolveDeploymentResource(ownerKind, ownerName, pod.namespace);
      diag.rootCause = "OOMKilled";
      diag.diagnosis = `Container "${container.name}" has been OOM-killed ${restarts} times. The process periodically exceeds its memory limit${limits.memLimit ? " of " + limits.memLimit : ""}.`;
      diag.evidence.push(`Recommendation: ${smart.reasoning}`);

      diag.fixes.push({
        title: `Increase memory limits for ${container.name}`,
        action: "set_resources",
        resource: deployRes.name,
        resourceType: deployRes.kind,
        namespace: pod.namespace,
        command: `oc -n ${pod.namespace} set resources ${deployRes.kind}/${deployRes.name} --containers=${container.name} --limits=memory=${smart.limit} --requests=memory=${smart.request}`,
        risk: "low",
        description: `Increases memory limit from ${limits.memLimit || "default"} to ${smart.limit} (request: ${smart.request}). ${smart.reasoning}.`,
        patchBody: buildResourcePatch(container.name, { memLimit: smart.limit, memRequest: smart.request }),
        deploymentName: deployRes.name,
      });
    }

    const deployRes = resolveDeploymentResource(ownerKind, ownerName, pod.namespace);
    diag.fixes.push({
      title: "Restart the pod",
      action: "delete_pod",
      resource: pod.name,
      namespace: pod.namespace,
      command: `oc delete pod ${pod.name} -n ${pod.namespace}`,
      risk: "low",
      description: "Recreates the pod to clear accumulated state.",
    });

    return diag;
  }

  return diag;
}

function extractErrorLines(logText) {
  if (!logText) return [];
  const lines = logText.split("\n");
  const errors = [];
  for (const line of lines) {
    if (/\b(error|fatal|panic|exception|traceback|failed|cannot|unable|denied|refused|timeout)\b/i.test(line) &&
        !/\b(no error|error_count=0|errors=0)\b/i.test(line)) {
      errors.push(line.trim());
      if (errors.length >= 10) break;
    }
  }
  return errors;
}

function detectConfigIssue(errorLines, events) {
  const combined = errorLines.join(" ").toLowerCase();

  if (/connection refused|cannot connect|connect timeout|econnrefused/i.test(combined)) {
    const match = combined.match(/(?:to|connecting|connect)\s+(?:to\s+)?['"]?([a-z0-9._:-]+)/i);
    return {
      type: "ConnectionRefused",
      description: `The application cannot connect to a dependency${match ? " (" + match[1] + ")" : ""}. Check if the target service is running and the connection config (env vars, hostname, port) is correct.`,
      fix: null,
    };
  }

  if (/missing.*(?:env|environment|variable|config)|(?:env|environment|variable).*(?:not set|not found|missing|required)/i.test(combined)) {
    return {
      type: "MissingEnvVar",
      description: "The application requires environment variables that are not set. Check the deployment's env/envFrom configuration.",
      fix: null,
    };
  }

  if (/permission denied|access denied|forbidden|unauthorized/i.test(combined)) {
    return {
      type: "PermissionDenied",
      description: "The application is getting permission errors. Check RBAC, SCCs, and filesystem permissions.",
      fix: null,
    };
  }

  if (/no such file|file not found|cannot open|enoent/i.test(combined)) {
    return {
      type: "MissingFile",
      description: "The application cannot find a required file or mount. Check volume mounts, ConfigMap mounts, and Secret mounts.",
      fix: null,
    };
  }

  if (/unknown flag|unknown option|unrecognized|invalid.*(?:flag|option|argument)|bad.*(?:flag|argument)|illegal option/i.test(combined)) {
    const match = combined.match(/unknown (?:flag|option)[:\s]+['"]?([^\s'"]+)/i)
      || combined.match(/invalid (?:flag|option|argument)[:\s]+['"]?([^\s'"]+)/i);
    return {
      type: "BadFlag",
      description: `The container is started with an invalid command-line flag${match ? " (" + match[1] + ")" : ""}. Check the deployment spec 'args' and 'command' fields, and verify they match the expected version of the binary.`,
      fix: null,
    };
  }

  if (/missing required|required flag|must specify|must provide|--\S+ is required/i.test(combined)) {
    const match = combined.match(/(?:required flag|must specify|must provide|missing required)[:\s]+['"]?([^\s'"]+)/i)
      || combined.match(/(--\S+) is required/i);
    return {
      type: "MissingRequiredArg",
      description: `The process requires a flag or argument that is not provided${match ? " (" + match[1] + ")" : ""}. Check the deployment's container args/command and ensure all required parameters are set.`,
      fix: null,
    };
  }

  if (/syntax error|parse error|invalid.*(?:yaml|json|config|toml)|malformed|unmarshal/i.test(combined)) {
    return {
      type: "ConfigParseError",
      description: "The application cannot parse its configuration file. Check ConfigMap/Secret contents for syntax errors (invalid YAML, JSON, or other formats).",
      fix: null,
    };
  }

  if (/port.*(?:already|in use|bind)|address already in use|eaddrinuse/i.test(combined)) {
    return {
      type: "PortConflict",
      description: "The application cannot bind to its port because it is already in use. Check if another container in the same pod uses the same port, or if the pod has stale connections from a previous crash.",
      fix: null,
    };
  }

  return null;
}

function resolveDeploymentResource(ownerKind, ownerName, namespace) {
  if (ownerKind === "ReplicaSet") {
    const depName = ownerName.replace(/-[a-f0-9]+$/, "");
    return { kind: "deployment", name: depName };
  }
  if (ownerKind === "StatefulSet") {
    return { kind: "statefulset", name: ownerName };
  }
  if (ownerKind === "DaemonSet") {
    return { kind: "daemonset", name: ownerName };
  }
  if (ownerKind === "Job") {
    return { kind: "job", name: ownerName };
  }
  return { kind: "deployment", name: ownerName };
}

function parseMemory(memStr) {
  if (!memStr) return null;
  const s = String(memStr).trim();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|k|M|G|T|m)?$/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2] || "";
  if (unit === "Ki") return val * 1024;
  if (unit === "Mi") return val * 1048576;
  if (unit === "Gi") return val * 1073741824;
  if (unit === "Ti") return val * 1099511627776;
  if (unit === "M") return val * 1000000;
  if (unit === "G") return val * 1000000000;
  if (unit === "T") return val * 1000000000000;
  if (unit === "k" || unit === "K") return val * 1000;
  if (unit === "m") return val / 1000;
  return val;
}

function formatMemory(bytes) {
  if (bytes >= 1073741824) {
    const gi = bytes / 1073741824;
    if (Number.isInteger(gi)) return gi + "Gi";
    if (Number.isInteger(gi * 2)) return gi + "Gi";
    return Math.ceil(bytes / 1048576) + "Mi";
  }
  if (bytes >= 1048576) return Math.ceil(bytes / 1048576) + "Mi";
  if (bytes >= 1024) return Math.ceil(bytes / 1024) + "Ki";
  return bytes + "";
}

function roundToNiceMemory(bytes) {
  const Mi = 1048576;
  const Gi = 1073741824;
  const niceMi = [128, 256, 384, 512, 768];
  const niceGi = [1, 1.5, 2, 3, 4, 6, 8];
  if (bytes >= Gi) {
    const gv = bytes / Gi;
    for (const n of niceGi) { if (n >= gv) return n * Gi; }
    return 8 * Gi;
  }
  const mv = bytes / Mi;
  for (const n of niceMi) { if (n >= mv) return n * Mi; }
  return Gi;
}

function calculateSmartMemoryLimit(currentLimitBytes, currentUsageBytes, restartCount) {
  if (!currentLimitBytes) return { limit: "512Mi", request: "256Mi", reasoning: "No current limit found; using safe default" };
  let multiplier;
  if (restartCount <= 2) multiplier = 2;
  else if (restartCount <= 5) multiplier = 3;
  else if (restartCount <= 10) multiplier = 4;
  else multiplier = 5;
  let recommended = currentLimitBytes * multiplier;
  let reasoning = `${multiplier}x current limit based on ${restartCount} OOM restart(s)`;
  if (currentUsageBytes) {
    const usageBased = currentUsageBytes * 2.5;
    if (usageBased > recommended) {
      recommended = usageBased;
      reasoning = `2.5x current usage (${formatMemory(currentUsageBytes)}) which exceeds ${multiplier}x limit`;
    }
    if (currentUsageBytes > currentLimitBytes * 0.5) {
      const highUsage = currentUsageBytes * 3;
      if (highUsage > recommended) {
        recommended = highUsage;
        reasoning = `3x current usage (${formatMemory(currentUsageBytes)}) — already at ${Math.round(currentUsageBytes / currentLimitBytes * 100)}% of limit after restart`;
      }
    }
  }
  recommended = roundToNiceMemory(recommended);
  recommended = Math.max(recommended, 128 * 1048576);
  recommended = Math.min(recommended, 8 * 1073741824);
  const requestBytes = Math.ceil(recommended * 0.75);
  return { limit: formatMemory(recommended), request: formatMemory(requestBytes), reasoning };
}

function buildResourcePatch(containerName, { memLimit, memRequest, cpuLimit, cpuRequest } = {}) {
  const resources = {};
  if (memLimit || cpuLimit) {
    resources.limits = {};
    if (memLimit) resources.limits.memory = memLimit;
    if (cpuLimit) resources.limits.cpu = cpuLimit;
  }
  if (memRequest || cpuRequest) {
    resources.requests = {};
    if (memRequest) resources.requests.memory = memRequest;
    if (cpuRequest) resources.requests.cpu = cpuRequest;
  }
  return {
    spec: {
      template: {
        spec: {
          containers: [{ name: containerName, resources }],
        },
      },
    },
  };
}
