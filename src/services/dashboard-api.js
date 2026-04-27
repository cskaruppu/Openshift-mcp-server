/**
 * Dashboard REST API — called directly by the HTML dashboard via fetch().
 * These endpoints query the OpenShift API and return JSON.
 */

import { readFile, writeFile } from "node:fs/promises";
import { ocpGet } from "../utils/openshift-client.js";
import { callLLM } from "./llm.js";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";

const LLM_SETTINGS_PATH = process.env.LLM_SETTINGS_PATH || "/data/mcp-llm-settings.json";
const SETTINGS_DB_KEY = "llm_settings";

const DEFAULT_LLM_SETTINGS = {
  providers: {
    openai: { apiKey: "", apiUrl: "https://api.openai.com", model: "gpt-4", enabled: false },
    anthropic: { apiKey: "", apiUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514", enabled: false },
    azure: { apiKey: "", apiUrl: "", model: "gpt-4", deployment: "", apiVersion: "2024-12-01-preview", enabled: false },
    ollama: { apiKey: "", apiUrl: "http://ollama:11434", model: "llama3", enabled: false },
  },
  defaults: {
    provider: "none",
    temperature: 0.3,
    maxTokens: 2000,
    systemPrompt: "",
  },
  fallbackChain: ["anthropic", "openai", "ollama", "none"],
};

// Providers that require an API key
const PROVIDERS_REQUIRING_KEY = new Set(["openai", "anthropic", "azure"]);

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function loadSettingsFromDB() {
  if (!await dbEnabled()) return null;
  const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [SETTINGS_DB_KEY]);
  if (result?.rows?.length) return result.rows[0].value;
  return null;
}

async function saveSettingsToDB(settings) {
  if (!await dbEnabled()) return false;
  const result = await dbQuery(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [SETTINGS_DB_KEY, JSON.stringify(settings)]
  );
  return result !== null;
}

/**
 * GET /api/settings/llm — read LLM settings from DB → file → defaults
 */
export async function handleLLMSettingsGet(req, res) {
  try {
    const fromDB = await loadSettingsFromDB();
    if (fromDB) return json(res, 200, fromDB);
  } catch { /* fall through */ }
  try {
    const raw = await readFile(LLM_SETTINGS_PATH, "utf8");
    return json(res, 200, JSON.parse(raw));
  } catch { /* fall through */ }
  return json(res, 200, DEFAULT_LLM_SETTINGS);
}

/**
 * POST /api/settings/llm — save LLM settings to DB + file
 */
export async function handleLLMSettingsPost(req, res) {
  try {
    const body = await readJsonBody(req);

    const providers = body.providers || {};
    const errors = [];
    for (const [name, cfg] of Object.entries(providers)) {
      if (cfg.enabled && PROVIDERS_REQUIRING_KEY.has(name) && !cfg.apiKey) {
        errors.push(`Provider "${name}" is enabled but has no apiKey`);
      }
    }
    if (errors.length > 0) {
      return json(res, 400, { error: "Validation failed", details: errors });
    }

    const settings = {
      providers: { ...DEFAULT_LLM_SETTINGS.providers, ...providers },
      defaults: { ...DEFAULT_LLM_SETTINGS.defaults, ...(body.defaults || {}) },
      fallbackChain: body.fallbackChain || DEFAULT_LLM_SETTINGS.fallbackChain,
    };

    const savedToDB = await saveSettingsToDB(settings);
    await writeFile(LLM_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8").catch(() => {});
    return json(res, 200, { success: true, settings, storage: savedToDB ? "database" : "file" });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

/**
 * POST /api/settings/llm/test — test a provider connection
 */
export async function handleLLMSettingsTest(req, res) {
  let provider = "unknown";
  try {
    const body = await readJsonBody(req);
    ({ provider } = body);
    const { apiKey, apiUrl, model, deployment, apiVersion } = body;

    if (!provider || provider === "none") {
      return json(res, 400, { error: "No provider specified" });
    }
    if (PROVIDERS_REQUIRING_KEY.has(provider) && !apiKey) {
      return json(res, 400, { error: `API key required for provider "${provider}"` });
    }

    const startMs = Date.now();
    const llmOpts = {
      messages: [{ role: "user", content: "Hello. Respond with just: OK" }],
      provider,
      apiKey,
      apiUrl,
      model,
      maxTokens: 50,
      temperature: 0,
    };
    if (provider === "azure") {
      llmOpts.azureDeployment = deployment || model;
      llmOpts.azureApiVersion = apiVersion || "2024-12-01-preview";
    }
    llmOpts.maxRetries = 1;
    const result = await callLLM(llmOpts);
    const durationMs = Date.now() - startMs;

    return json(res, 200, {
      success: true,
      provider,
      model,
      reply: (result.text || "").substring(0, 200),
      durationMs,
    });
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : "";
    console.error(`[llm-test] ${provider} failed: ${err.message}${cause}`);
    return json(res, 200, {
      success: false,
      error: `${err.message}${cause}`,
    });
  }
}

function parseCpu(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  if (s.endsWith("n")) return parseInt(s) / 1e9;
  if (s.endsWith("u")) return parseInt(s) / 1e6;
  if (s.endsWith("m")) return parseInt(s) / 1e3;
  return parseFloat(s) || 0;
}

function parseMem(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  if (s.endsWith("Ki")) return parseInt(s) * 1024;
  if (s.endsWith("Mi")) return parseInt(s) * 1024 * 1024;
  if (s.endsWith("Gi")) return parseInt(s) * 1024 * 1024 * 1024;
  if (s.endsWith("Ti")) return parseInt(s) * 1024 * 1024 * 1024 * 1024;
  return parseInt(s) || 0;
}

export async function handleDashboardAPI(pathname, req, res) {
  try {
    switch (pathname) {
      // ---- Cluster summary (top metrics) ----
      case "/api/cluster/summary": {
        const [clusterVersion, operators, nodes, namespaces] =
          await Promise.all([
            ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null),
            ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => null),
            ocpGet("/api/v1/nodes"),
            ocpGet("/api/v1/namespaces"),
          ]);

        const nodeList = nodes.items || [];
        const readyNodes = nodeList.filter((n) =>
          (n.status?.conditions || []).some(
            (c) => c.type === "Ready" && c.status === "True"
          )
        );

        let totalCPU = 0;
        let totalMemBytes = 0;
        for (const n of nodeList) {
          totalCPU += parseInt(n.status?.capacity?.cpu || "0", 10);
          const mem = n.status?.capacity?.memory || "0";
          if (mem.endsWith("Ki"))
            totalMemBytes += parseInt(mem) * 1024;
          else if (mem.endsWith("Mi"))
            totalMemBytes += parseInt(mem) * 1024 * 1024;
          else if (mem.endsWith("Gi"))
            totalMemBytes += parseInt(mem) * 1024 * 1024 * 1024;
          else totalMemBytes += parseInt(mem) || 0;
        }
        const totalMemGi = Math.round(totalMemBytes / (1024 * 1024 * 1024));

        const opItems = operators?.items || [];
        const degradedOps = opItems.filter((op) =>
          (op.status?.conditions || []).some(
            (c) => c.type === "Degraded" && c.status === "True"
          )
        );

        const nsList = namespaces.items || [];
        const userNS = nsList.filter(
          (ns) =>
            !ns.metadata.name.startsWith("openshift-") &&
            !ns.metadata.name.startsWith("kube-") &&
            ns.metadata.name !== "default" &&
            ns.metadata.name !== "openshift"
        );

        json(res, 200, {
          cluster: {
            version: clusterVersion?.status?.desired?.version || "unknown",
            channel: clusterVersion?.spec?.channel || "unknown",
            health:
              degradedOps.length > 0
                ? "degraded"
                : readyNodes.length < nodeList.length
                  ? "warning"
                  : "healthy",
          },
          nodes: {
            total: nodeList.length,
            ready: readyNodes.length,
            totalCPU,
            totalMemGi,
          },
          namespaces: {
            total: nsList.length,
            user: userNS.length,
            system: nsList.length - userNS.length,
          },
          operators: {
            total: opItems.length,
            healthy: opItems.length - degradedOps.length,
            degraded: degradedOps.length,
            degradedNames: degradedOps.map((o) => o.metadata.name),
          },
        });
        break;
      }

      // ---- Node list ----
      case "/api/nodes": {
        const nodes = await ocpGet("/api/v1/nodes");
        const result = await Promise.all(
          (nodes.items || []).map(async (node) => {
            const name = node.metadata.name;
            const conditions = (node.status?.conditions || []).reduce(
              (acc, c) => { acc[c.type] = c.status; return acc; }, {}
            );
            const roles = Object.keys(node.metadata.labels || {})
              .filter((l) => l.startsWith("node-role.kubernetes.io/"))
              .map((l) => l.replace("node-role.kubernetes.io/", ""));

            // Count pods on this node
            let podCount = 0;
            try {
              const pods = await ocpGet(
                `/api/v1/pods?fieldSelector=spec.nodeName=${name},status.phase=Running`
              );
              podCount = pods.items?.length || 0;
            } catch { /* ignore */ }

            return {
              name,
              roles,
              ready: conditions.Ready === "True",
              cpu: node.status?.capacity?.cpu || "0",
              memory: node.status?.capacity?.memory || "0",
              pods: podCount,
              kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
              osImage: node.status?.nodeInfo?.osImage,
            };
          })
        );
        json(res, 200, result);
        break;
      }

      // ---- Pods with issues ----
      case "/api/pods/issues": {
        const pods = await ocpGet("/api/v1/pods");
        const issues = (pods.items || [])
          .filter((p) => {
            const phase = p.status?.phase;
            if (phase === "Failed" || phase === "Unknown") return true;
            return (p.status?.containerStatuses || []).some(
              (c) =>
                c.state?.waiting?.reason === "CrashLoopBackOff" ||
                c.state?.waiting?.reason === "ImagePullBackOff" ||
                c.state?.waiting?.reason === "ErrImagePull" ||
                c.lastState?.terminated?.reason === "OOMKilled" ||
                c.restartCount > 10
            );
          })
          .map((p) => {
            const cs = p.status?.containerStatuses || [];
            const problems = cs
              .filter(
                (c) =>
                  c.state?.waiting ||
                  c.lastState?.terminated?.reason === "OOMKilled" ||
                  c.restartCount > 10
              )
              .map((c) => ({
                container: c.name,
                reason:
                  c.state?.waiting?.reason ||
                  c.lastState?.terminated?.reason ||
                  `${c.restartCount} restarts`,
                restarts: c.restartCount,
              }));
            return {
              name: p.metadata.name,
              namespace: p.metadata.namespace,
              phase: p.status?.phase,
              node: p.spec?.nodeName,
              issues: problems,
            };
          });

        json(res, 200, issues);
        break;
      }

      // ---- Namespaces with workload counts ----
      case "/api/namespaces": {
        const namespaces = await ocpGet("/api/v1/namespaces");
        const nsList = (namespaces.items || [])
          .filter(
            (ns) =>
              !ns.metadata.name.startsWith("openshift-") &&
              !ns.metadata.name.startsWith("kube-") &&
              ns.metadata.name !== "default" &&
              ns.metadata.name !== "openshift"
          )
          .map((ns) => ({
            name: ns.metadata.name,
            status: ns.status?.phase,
            created: ns.metadata.creationTimestamp,
          }));

        json(res, 200, nsList);
        break;
      }

      // ---- ACM managed clusters ----
      case "/api/acm/clusters": {
        try {
          const data = await ocpGet(
            "/apis/cluster.open-cluster-management.io/v1/managedclusters"
          );
          const clusters = (data.items || []).map((c) => {
            const conditions = (c.status?.conditions || []).reduce(
              (acc, cond) => { acc[cond.type] = cond.status; return acc; }, {}
            );
            return {
              name: c.metadata.name,
              available:
                conditions.ManagedClusterConditionAvailable === "True",
              kubernetesVersion: c.status?.version?.kubernetes,
              capacity: c.status?.capacity,
              allocatable: c.status?.allocatable,
            };
          });
          json(res, 200, clusters);
        } catch {
          json(res, 200, []);
        }
        break;
      }

      // ---- Security posture widget ----
      case "/api/dashboard/security": {
        const findings = [];
        let score = 100;
        try {
          const pods = await ocpGet("/api/v1/pods");
          const items = (pods.items || []).filter(
            (p) => !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-")
          );
          let privileged = 0;
          let runAsRoot = 0;
          let noLimits = 0;
          let latestTag = 0;
          let hostNet = 0;
          for (const p of items) {
            if (p.spec?.hostNetwork) hostNet++;
            for (const c of (p.spec?.containers || [])) {
              const sc = c.securityContext || {};
              if (sc.privileged) privileged++;
              if (sc.runAsUser === 0 || (!sc.runAsNonRoot && !p.spec?.securityContext?.runAsNonRoot)) runAsRoot++;
              if (!c.resources?.limits?.cpu && !c.resources?.limits?.memory) noLimits++;
              const img = c.image || "";
              if (img.endsWith(":latest") || !img.includes(":")) latestTag++;
            }
          }
          if (privileged > 0) { score -= Math.min(25, privileged * 5); findings.push({ severity: "critical", msg: `${privileged} privileged container(s)` }); }
          if (hostNet > 0) { score -= Math.min(10, hostNet * 3); findings.push({ severity: "critical", msg: `${hostNet} pod(s) using hostNetwork` }); }
          if (runAsRoot > 0) { score -= Math.min(15, runAsRoot * 2); findings.push({ severity: "high", msg: `${runAsRoot} container(s) may run as root` }); }
          if (noLimits > 0) { score -= Math.min(15, Math.ceil(noLimits / 2)); findings.push({ severity: "warning", msg: `${noLimits} container(s) without resource limits` }); }
          if (latestTag > 0) { score -= Math.min(10, latestTag); findings.push({ severity: "warning", msg: `${latestTag} image(s) using :latest or untagged` }); }

          const nsList = items.map((p) => p.metadata.namespace).filter((v, i, a) => a.indexOf(v) === i);
          let uncovered = 0;
          for (const ns of nsList) {
            try {
              const np = await ocpGet(`/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`);
              if (!np.items || np.items.length === 0) uncovered++;
            } catch { uncovered++; }
          }
          if (uncovered > 0) { score -= Math.min(15, uncovered * 3); findings.push({ severity: "high", msg: `${uncovered} namespace(s) without NetworkPolicy` }); }

          score = Math.max(0, Math.round(score));
          const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
          json(res, 200, { score, grade, findings: findings.slice(0, 5), podCount: items.length, namespaceCount: nsList.length });
        } catch (err) {
          json(res, 200, { score: 0, grade: "?", findings: [{ severity: "info", msg: "Could not compute: " + err.message }], podCount: 0, namespaceCount: 0 });
        }
        break;
      }

      // ---- GitOps sync status widget ----
      case "/api/dashboard/gitops": {
        try {
          const ns = "openshift-gitops";
          const data = await ocpGet(`/apis/argoproj.io/v1alpha1/namespaces/${ns}/applications`);
          const apps = (data.items || []).map((a) => ({
            name: a.metadata.name,
            sync: a.status?.sync?.status || "Unknown",
            health: a.status?.health?.status || "Unknown",
            repo: a.spec?.source?.repoURL || a.spec?.sources?.[0]?.repoURL || "",
          }));
          const synced = apps.filter((a) => a.sync === "Synced").length;
          const outOfSync = apps.filter((a) => a.sync === "OutOfSync").length;
          const degraded = apps.filter((a) => a.health === "Degraded").length;
          const healthy = apps.filter((a) => a.health === "Healthy").length;
          json(res, 200, { total: apps.length, synced, outOfSync, degraded, healthy, apps: apps.slice(0, 10) });
        } catch {
          json(res, 200, { total: 0, synced: 0, outOfSync: 0, degraded: 0, healthy: 0, apps: [], unavailable: true });
        }
        break;
      }

      // ---- DR readiness widget ----
      case "/api/dashboard/dr": {
        const veleroNs = "openshift-adp";
        try {
          const [backups, schedules, locations] = await Promise.all([
            ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/backups`).catch(() => ({ items: [] })),
            ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/schedules`).catch(() => ({ items: [] })),
            ocpGet(`/apis/velero.io/v1/namespaces/${veleroNs}/backupstoragelocations`).catch(() => ({ items: [] })),
          ]);
          const bkpItems = backups.items || [];
          const completed = bkpItems.filter((b) => b.status?.phase === "Completed");
          const failed = bkpItems.filter((b) => ["Failed", "PartiallyFailed"].includes(b.status?.phase));
          const schItems = schedules.items || [];
          const activeSchedules = schItems.filter((s) => !s.spec?.paused);
          const locItems = locations.items || [];
          const availLocs = locItems.filter((l) => l.status?.phase === "Available");

          completed.sort((a, b) => (b.status?.completionTimestamp || "").localeCompare(a.status?.completionTimestamp || ""));
          const lastGood = completed[0];
          let lastBackupAge = null;
          if (lastGood?.status?.completionTimestamp) {
            lastBackupAge = Math.floor((Date.now() - new Date(lastGood.status.completionTimestamp).getTime()) / 86400000);
          }

          let score = 100;
          if (locItems.length === 0) score -= 30;
          else if (availLocs.length === 0) score -= 25;
          if (schItems.length === 0) score -= 25;
          else if (activeSchedules.length === 0) score -= 20;
          if (completed.length === 0) score -= 25;
          else if (lastBackupAge != null && lastBackupAge > 7) score -= 15;
          if (failed.length > 0) score -= Math.min(15, failed.length * 5);
          score = Math.max(0, Math.round(score));
          const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

          json(res, 200, {
            installed: true, score, grade,
            backups: bkpItems.length, completed: completed.length, failed: failed.length,
            schedules: schItems.length, activeSchedules: activeSchedules.length,
            storageLocations: locItems.length, availableLocations: availLocs.length,
            lastBackup: lastGood?.metadata?.name || null, lastBackupAge,
          });
        } catch {
          json(res, 200, { installed: false, score: 0, grade: "?", backups: 0, completed: 0, failed: 0, schedules: 0, activeSchedules: 0, storageLocations: 0, availableLocations: 0, lastBackup: null, lastBackupAge: null });
        }
        break;
      }

      // ---- Resource optimization widget ----
      case "/api/dashboard/optimization": {
        try {
          const [pods, metricsData, nodes] = await Promise.all([
            ocpGet("/api/v1/pods"),
            ocpGet("/apis/metrics.k8s.io/v1beta1/pods").catch(() => ({ items: [] })),
            ocpGet("/api/v1/nodes"),
          ]);
          const podItems = (pods.items || []).filter(
            (p) => p.status?.phase === "Running" && !p.metadata.namespace?.startsWith("openshift-") && !p.metadata.namespace?.startsWith("kube-")
          );

          const metricsMap = {};
          for (const m of (metricsData.items || [])) {
            const key = `${m.metadata.namespace}/${m.metadata.name}`;
            let cpu = 0, mem = 0;
            for (const c of (m.containers || [])) {
              cpu += parseCpu(c.usage?.cpu);
              mem += parseMem(c.usage?.memory);
            }
            metricsMap[key] = { cpu, mem };
          }

          let overProvisioned = 0, underProvisioned = 0, noLimits = 0;
          const topProblems = [];
          for (const p of podItems) {
            const key = `${p.metadata.namespace}/${p.metadata.name}`;
            const usage = metricsMap[key];
            let reqCpu = 0, reqMem = 0, haslim = false;
            for (const c of (p.spec?.containers || [])) {
              reqCpu += parseCpu(c.resources?.requests?.cpu);
              reqMem += parseMem(c.resources?.requests?.memory);
              if (c.resources?.limits?.cpu || c.resources?.limits?.memory) haslim = true;
            }
            if (!haslim) { noLimits++; continue; }
            if (!usage) continue;
            if (reqCpu > 0 && usage.cpu < reqCpu * 0.1 && reqCpu >= 0.1) {
              overProvisioned++;
              topProblems.push({ name: p.metadata.name, ns: p.metadata.namespace, type: "over", detail: `CPU: using ${(usage.cpu * 1000).toFixed(0)}m, requested ${(reqCpu * 1000).toFixed(0)}m` });
            }
            if (reqCpu > 0 && usage.cpu > reqCpu * 1.5) {
              underProvisioned++;
              topProblems.push({ name: p.metadata.name, ns: p.metadata.namespace, type: "under", detail: `CPU: using ${(usage.cpu * 1000).toFixed(0)}m, requested ${(reqCpu * 1000).toFixed(0)}m` });
            }
          }

          const nodeItems = nodes.items || [];
          let totalAllocCpu = 0, totalAllocMem = 0, totalReqCpu = 0, totalReqMem = 0;
          for (const n of nodeItems) {
            totalAllocCpu += parseCpu(n.status?.allocatable?.cpu);
            totalAllocMem += parseMem(n.status?.allocatable?.memory);
          }
          for (const p of (pods.items || []).filter((p) => p.status?.phase === "Running")) {
            for (const c of (p.spec?.containers || [])) {
              totalReqCpu += parseCpu(c.resources?.requests?.cpu);
              totalReqMem += parseMem(c.resources?.requests?.memory);
            }
          }
          const cpuHeadroom = totalAllocCpu > 0 ? Math.round(((totalAllocCpu - totalReqCpu) / totalAllocCpu) * 100) : 0;
          const memHeadroom = totalAllocMem > 0 ? Math.round(((totalAllocMem - totalReqMem) / totalAllocMem) * 100) : 0;

          json(res, 200, {
            overProvisioned, underProvisioned, noLimits,
            cpuHeadroom, memHeadroom,
            totalPods: podItems.length,
            topProblems: topProblems.slice(0, 5),
          });
        } catch (err) {
          json(res, 200, { overProvisioned: 0, underProvisioned: 0, noLimits: 0, cpuHeadroom: 0, memHeadroom: 0, totalPods: 0, topProblems: [], error: err.message });
        }
        break;
      }

      default:
        json(res, 404, { error: "Unknown API endpoint" });
    }
  } catch (err) {
    console.error(`Dashboard API error [${pathname}]:`, err.message);
    json(res, 500, { error: err.message });
  }
}
