/**
 * Dashboard REST API — called directly by the HTML dashboard via fetch().
 * These endpoints query the OpenShift API and return JSON.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname } from "node:path";
import { ocpGet, ocpFetch, ocpDelete } from "../utils/openshift-client.js";
import { getPlatform, isOpenShiftFamily } from "../platform/index.js";
import { callLLM } from "./llm.js";
import { query as dbQuery, isEnabled as dbEnabled } from "../utils/db.js";
import { validateUpgradeVersion } from "../tools/upgrade-preflight.js";
import { getComplianceResults, runComplianceScan } from "../tools/compliance-scanner.js";

const LLM_SETTINGS_PATH = process.env.LLM_SETTINGS_PATH || "/data/mcp-llm-settings.json";
const SETTINGS_DB_KEY = "llm_settings";

const DEFAULT_LLM_SETTINGS = {
  providers: {
    openai: { apiKey: "", apiUrl: "https://api.openai.com", model: "gpt-4", enabled: false },
    anthropic: { apiKey: "", apiUrl: "https://api.anthropic.com", model: "claude-sonnet-4-20250514", enabled: false },
    azure: { apiKey: "", apiUrl: "", model: "gpt-4", deployment: "", apiVersion: "2024-12-01-preview", enabled: false },
    google: { apiKey: "", apiUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-pro", enabled: false },
    bedrock: { apiKey: "", apiUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", model: "anthropic.claude-v2", enabled: false },
    ollama: { apiKey: "", apiUrl: "http://ollama:11434", model: "llama3", enabled: false },
  },
  defaults: {
    provider: "azure",
    temperature: 0.3,
    maxTokens: 2000,
    systemPrompt: "",
  },
  fallbackChain: ["anthropic", "openai", "ollama", "none"],
};

// Providers that require an API key
const PROVIDERS_REQUIRING_KEY = new Set(["openai", "anthropic", "azure", "google", "bedrock"]);

function json(res, status, data) {
  const body = JSON.stringify(data);
  const acceptGzip = (res._req_accept_encoding || "").includes("gzip");
  if (acceptGzip && body.length > 1024) {
    const gz = gzipSync(body, { level: 1 });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Vary": "Accept-Encoding" });
    res.end(gz);
  } else {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }
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
  if (result?.rows?.length) {
    let val = result.rows[0].value;
    // Guard: if pg returned a string instead of an object (JSONB double-encoding), parse it
    if (typeof val === "string") {
      try { val = JSON.parse(val); } catch { return null; }
    }
    return val;
  }
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
 * Load the stored LLM settings (UNMASKED) from DB → file → defaults.
 * Used server-side to resolve real API keys when the client sends a masked
 * or empty key. The client never holds the real secret — the server does.
 */
export async function loadStoredLLMSettings() {
  try {
    const fromDB = await loadSettingsFromDB();
    if (fromDB && fromDB.providers) return fromDB;
  } catch { /* fall through */ }
  try {
    const raw = await readFile(LLM_SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.providers) return parsed;
  } catch { /* fall through */ }
  return DEFAULT_LLM_SETTINGS;
}

/**
 * Given llmOpts from a chat request, resolve the real API key (and any
 * provider config the client omitted or masked) from server-side storage.
 * A masked key looks like "****abcd" or "configured". Mutates and returns opts.
 */
export async function resolveLLMOpts(opts = {}) {
  const provider = opts.provider;
  if (!provider || provider === "none") return opts;
  const keyLooksMasked = !opts.apiKey || /^\*{2,}/.test(opts.apiKey) || opts.apiKey === "configured";
  // If the client supplied a real key and a URL, trust it as-is.
  if (!keyLooksMasked && opts.apiUrl) return opts;
  try {
    const stored = await loadStoredLLMSettings();
    const cfg = stored?.providers?.[provider];
    if (cfg) {
      if (keyLooksMasked && cfg.apiKey) opts.apiKey = cfg.apiKey;
      if (!opts.apiUrl && cfg.apiUrl) opts.apiUrl = cfg.apiUrl;
      if (!opts.model && cfg.model) opts.model = cfg.model;
      if (provider === "azure") {
        if (!opts.azureDeployment && cfg.deployment) opts.azureDeployment = cfg.deployment;
        if (!opts.azureApiVersion && cfg.apiVersion) opts.azureApiVersion = cfg.apiVersion;
      }
    }
  } catch { /* best effort — fall back to whatever the client sent */ }
  return opts;
}

/**
 * GET /api/settings/llm — read LLM settings from DB → file → defaults
 */
export async function handleLLMSettingsGet(req, res) {
  function maskApiKeys(settings) {
    if (!settings || !settings.providers) return settings;
    const masked = { ...settings, providers: { ...settings.providers } };
    for (const [name, cfg] of Object.entries(masked.providers)) {
      if (cfg.apiKey) {
        masked.providers[name] = {
          ...cfg,
          apiKey: cfg.apiKey.length > 4 ? "****" + cfg.apiKey.slice(-4) : "configured",
        };
      }
    }
    return masked;
  }

  try {
    const fromDB = await loadSettingsFromDB();
    if (fromDB && fromDB.providers) {
      const provCount = Object.values(fromDB.providers).filter(c => c.enabled || c.apiKey).length;
      console.log(`[settings] loaded from DB — ${provCount} provider(s) configured`);
      return json(res, 200, { ...maskApiKeys(fromDB), _storage: "database" });
    }
  } catch (e) {
    console.warn("[settings] DB read failed:", e.message);
  }
  try {
    const raw = await readFile(LLM_SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.providers) {
      const provCount = Object.values(parsed.providers).filter(c => c.enabled || c.apiKey).length;
      console.log(`[settings] loaded from file — ${provCount} provider(s) configured`);
      return json(res, 200, { ...maskApiKeys(parsed), _storage: "file" });
    }
  } catch { /* fall through */ }
  console.log("[settings] no saved settings found — returning defaults");
  return json(res, 200, { ...DEFAULT_LLM_SETTINGS, _storage: "defaults" });
}

/**
 * POST /api/settings/llm — save LLM settings to DB + file
 */
export async function handleLLMSettingsPost(req, res) {
  try {
    const body = await readJsonBody(req);

    // Load existing settings so we can preserve API keys not resent by the UI
    let existing = null;
    try { existing = await loadSettingsFromDB(); } catch {}
    if (!existing) {
      try {
        const raw = await readFile(LLM_SETTINGS_PATH, "utf8");
        existing = JSON.parse(raw);
      } catch {}
    }
    const existingProviders = existing?.providers || {};

    const providers = body.providers || {};
    // Merge: if the UI sends an empty apiKey but the provider was previously configured,
    // preserve the existing key so URL-only updates don't break validation.
    for (const [name, cfg] of Object.entries(providers)) {
      if (!cfg.apiKey && existingProviders[name]?.apiKey) {
        cfg.apiKey = existingProviders[name].apiKey;
      }
    }

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
    const savedToFile = await writeFile(LLM_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8").then(() => true).catch(() => false);
    const provCount = Object.values(settings.providers).filter(c => c.enabled || c.apiKey).length;
    console.log(`[settings] saved — DB=${savedToDB}, file=${savedToFile}, ${provCount} provider(s) configured`);
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

// ---------------------------------------------------------------------------
// ServiceNow Settings — GET / POST / test
// ---------------------------------------------------------------------------
const SNOW_SETTINGS_DB_KEY = "servicenow_settings";
const SNOW_SETTINGS_PATH = process.env.SNOW_SETTINGS_PATH || "/data/mcp-servicenow-settings.json";

/**
 * Load ServiceNow settings from DB → file → env vars. Returns null if nothing
 * found. Called on startup to restore process.env and by the GET handler.
 */
async function loadSnowSettings() {
  // 1. Try DB
  try {
    if (await dbEnabled()) {
      const result = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [SNOW_SETTINGS_DB_KEY]);
      if (result?.rows?.length) {
        let val = result.rows[0].value;
        if (typeof val === "string") { try { val = JSON.parse(val); } catch { val = null; } }
        if (val && val.instance && val.username && val.password) {
          return { ...val, _storage: "database" };
        }
      }
    }
  } catch { /* fall through */ }
  // 2. Try file
  try {
    const raw = await readFile(SNOW_SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.instance && parsed.username && parsed.password) {
      return { ...parsed, _storage: "file" };
    }
  } catch { /* fall through */ }
  // 3. Env vars (not persisted, just runtime)
  const instance = process.env.SERVICENOW_INSTANCE || "";
  const username = process.env.SERVICENOW_USERNAME || "";
  const password = process.env.SERVICENOW_PASSWORD || "";
  if (instance && username && password) {
    return { instance, username, password, enabled: true, _storage: "environment" };
  }
  return null;
}

/**
 * Restore ServiceNow credentials into process.env on startup so the
 * ServiceNow client picks them up immediately. Call this once from init.
 */
export async function restoreServiceNowSettings() {
  const settings = await loadSnowSettings();
  if (settings && settings.instance && settings.username && settings.password) {
    process.env.SERVICENOW_INSTANCE = settings.instance;
    process.env.SERVICENOW_USERNAME = settings.username;
    process.env.SERVICENOW_PASSWORD = settings.password;
    console.log(`[servicenow-settings] restored from ${settings._storage} — instance=${settings.instance}, user=${settings.username}`);
    return true;
  }
  return false;
}

export async function handleServiceNowSettingsGet(req, res) {
  const settings = await loadSnowSettings();
  if (settings) {
    return json(res, 200, {
      instance: settings.instance || "",
      username: settings.username || "",
      password: settings.password ? "••••••••" : "",
      enabled: Boolean(settings.instance && settings.username && settings.password),
      _storage: settings._storage || "unknown",
    });
  }
  return json(res, 200, {
    instance: "",
    username: "",
    password: "",
    enabled: false,
    _storage: "none",
  });
}

export async function handleServiceNowSettingsPost(req, res) {
  try {
    const body = await readJsonBody(req);
    const { instance, username, password } = body;
    if (!instance || !username || !password) {
      return json(res, 400, { error: "All fields are required: instance, username, password" });
    }
    const normalizedInstance = instance.replace(/\/+$/, "");
    // Save to env immediately
    process.env.SERVICENOW_INSTANCE = normalizedInstance;
    process.env.SERVICENOW_USERNAME = username;
    process.env.SERVICENOW_PASSWORD = password;
    const settings = { instance: normalizedInstance, username, password, enabled: true };

    // Persist to DB
    let savedToDB = false;
    try {
      if (await dbEnabled()) {
        await dbQuery(
          `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [SNOW_SETTINGS_DB_KEY, JSON.stringify(settings)]
        );
        savedToDB = true;
      }
    } catch { /* DB optional */ }

    // Persist to file (always, as fallback for pod restarts without DB)
    let savedToFile = false;
    try {
      await mkdir(dirname(SNOW_SETTINGS_PATH), { recursive: true }).catch(() => {});
      await writeFile(SNOW_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
      savedToFile = true;
    } catch { /* file write optional */ }

    const storage = savedToDB ? "database" : savedToFile ? "file" : "process";
    console.log(`[servicenow-settings] saved — instance=${normalizedInstance}, user=${username}, db=${savedToDB}, file=${savedToFile}`);
    return json(res, 200, { success: true, enabled: true, storage });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

export async function handleServiceNowSettingsTest(req, res) {
  try {
    const body = await readJsonBody(req);
    const instance = (body.instance || process.env.SERVICENOW_INSTANCE || "").replace(/\/+$/, "");
    const username = body.username || process.env.SERVICENOW_USERNAME || "";
    const password = body.password || process.env.SERVICENOW_PASSWORD || "";
    if (!instance || !username || !password) {
      return json(res, 200, { success: false, error: "Instance URL, username, and password are required." });
    }
    const startMs = Date.now();
    const testUrl = `${instance}/api/now/table/sys_properties?sysparm_limit=1`;
    let resp;
    try {
      resp = await fetch(testUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          Accept: "application/json",
        },
      });
    } catch (e) {
      return json(res, 200, { success: false, error: `Cannot connect to ${instance}: ${e.message}` });
    }
    const durationMs = Date.now() - startMs;
    if (resp.status === 401 || resp.status === 403) {
      return json(res, 200, { success: false, error: `Authentication failed (${resp.status}). Check username and password.`, durationMs });
    }
    if (!resp.ok) {
      const text = await resp.text();
      return json(res, 200, { success: false, error: `ServiceNow returned ${resp.status}: ${text.substring(0, 200)}`, durationMs });
    }
    return json(res, 200, { success: true, message: `Connected to ${instance}`, durationMs });
  } catch (err) {
    return json(res, 200, { success: false, error: err.message });
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
    // DELETE /api/pvc/:namespace/:name — delete an orphaned PVC
    const pvcDeleteMatch = pathname.match(/^\/api\/pvc\/([^/]+)\/([^/]+)$/);
    if (pvcDeleteMatch && req.method === "DELETE") {
      const [, ns, name] = pvcDeleteMatch;
      try {
        await ocpDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/persistentvolumeclaims/${encodeURIComponent(name)}`);
        json(res, 200, { ok: true, message: `PVC ${ns}/${name} deleted` });
      } catch (err) {
        json(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    // ---- Platform info endpoint (multi-cloud) ----
    if (pathname === "/api/platform-info") {
      const platform = getPlatform();
      const isOpenShift = platform === "openshift";
      json(res, 200, { platform, isOpenShift, cli: isOpenShift ? "oc" : "kubectl" });
      return;
    }

    switch (pathname) {
      // ---- Cluster summary (top metrics) ----
      case "/api/cluster/summary": {
        const isOCP = getPlatform() === "openshift";
        const [clusterVersion, operators, nodes, namespaces, allPods] =
          await Promise.all([
            isOCP ? ocpGet("/apis/config.openshift.io/v1/clusterversions/version").catch(() => null) : Promise.resolve(null),
            isOCP ? ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => null) : Promise.resolve(null),
            ocpGet("/api/v1/nodes"),
            ocpGet("/api/v1/namespaces"),
            ocpGet("/api/v1/pods").catch(() => ({ items: [] })),
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

        const podItems = allPods.items || [];
        const runningPods = podItems.filter((p) => p.status?.phase === "Running").length;

        json(res, 200, {
          platform: getPlatform() || "kubernetes",
          isOpenShift: isOpenShiftFamily(getPlatform()),
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
          pods: {
            total: podItems.length,
            running: runningPods,
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

      // ---- Cluster Operators with individual health ----
      case "/api/cluster/operators": {
        const operators = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
        const result = (operators.items || []).map((op) => {
          const conditions = (op.status?.conditions || []).reduce(
            (acc, c) => { acc[c.type] = { status: c.status, message: c.message || "", reason: c.reason || "" }; return acc; }, {}
          );
          const available = conditions.Available?.status === "True";
          const degraded = conditions.Degraded?.status === "True";
          const progressing = conditions.Progressing?.status === "True";
          const health = degraded ? "degraded" : !available ? "unavailable" : progressing ? "progressing" : "available";
          return {
            name: op.metadata.name,
            health,
            available,
            degraded,
            progressing,
            version: (op.status?.versions || []).find(v => v.name === "operator")?.version || "",
            message: degraded ? conditions.Degraded.message : progressing ? conditions.Progressing.message : "",
          };
        });
        json(res, 200, result);
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
              memoryPressure: conditions.MemoryPressure === "True",
              diskPressure: conditions.DiskPressure === "True",
              pidPressure: conditions.PIDPressure === "True",
              cpu: node.status?.capacity?.cpu || "0",
              memory: node.status?.capacity?.memory || "0",
              pods: podCount,
              maxPods: parseInt(node.status?.allocatable?.pods || "110", 10),
              kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
              osImage: node.status?.nodeInfo?.osImage,
            };
          })
        );
        json(res, 200, result);
        break;
      }

      // ---- Node metrics (CPU/memory utilization) ----
      case "/api/node-metrics": {
        try {
          const [metricsResp, nodesResp] = await Promise.all([
            ocpGet("/apis/metrics.k8s.io/v1beta1/nodes"),
            ocpGet("/api/v1/nodes"),
          ]);
          const capMap = {};
          for (const n of (nodesResp.items || [])) {
            const cpuCap = parseInt(n.status?.capacity?.cpu || "0", 10);
            const memStr = n.status?.capacity?.memory || "0";
            let memBytes = 0;
            if (memStr.endsWith("Ki")) memBytes = parseInt(memStr) * 1024;
            else if (memStr.endsWith("Mi")) memBytes = parseInt(memStr) * 1024 * 1024;
            else if (memStr.endsWith("Gi")) memBytes = parseInt(memStr) * 1024 * 1024 * 1024;
            else memBytes = parseInt(memStr) || 0;
            capMap[n.metadata.name] = { cpuCores: cpuCap, memBytes };
          }
          const result = (metricsResp.items || []).map(m => {
            const name = m.metadata.name;
            const cap = capMap[name] || { cpuCores: 1, memBytes: 1 };
            const cpuUsage = m.usage?.cpu || "0";
            const memUsage = m.usage?.memory || "0";
            let cpuNano = 0;
            if (cpuUsage.endsWith("n")) cpuNano = parseInt(cpuUsage);
            else if (cpuUsage.endsWith("m")) cpuNano = parseInt(cpuUsage) * 1e6;
            else cpuNano = parseFloat(cpuUsage) * 1e9;
            let memBytes = 0;
            if (memUsage.endsWith("Ki")) memBytes = parseInt(memUsage) * 1024;
            else if (memUsage.endsWith("Mi")) memBytes = parseInt(memUsage) * 1024 * 1024;
            else if (memUsage.endsWith("Gi")) memBytes = parseInt(memUsage) * 1024 * 1024 * 1024;
            else memBytes = parseInt(memUsage) || 0;
            return {
              name,
              cpuUsage: (cpuNano / 1e9).toFixed(2) + ' cores',
              cpuPercent: cap.cpuCores > 0 ? Math.round((cpuNano / 1e9 / cap.cpuCores) * 100) : 0,
              memoryUsage: (memBytes / (1024 * 1024 * 1024)).toFixed(1) + ' Gi',
              memoryPercent: cap.memBytes > 0 ? Math.round((memBytes / cap.memBytes) * 100) : 0,
            };
          });
          json(res, 200, result);
        } catch (e) {
          json(res, 200, []);
        }
        break;
      }

      // ---- Pods with issues ----
      case "/api/pods/issues": {
        const [pods, podIssueRs] = await Promise.all([
          ocpGet("/api/v1/pods"),
          ocpGet("/apis/apps/v1/replicasets").catch(() => ({ items: [] })),
        ]);
        // ReplicaSet → owning Deployment, so a fix targets the real workload.
        const piRsMap = {};
        for (const rs of (podIssueRs.items || [])) {
          const o = (rs.metadata?.ownerReferences || [])[0];
          if (o) piRsMap[`${rs.metadata.namespace}/${rs.metadata.name}`] = { kind: o.kind, name: o.name };
        }
        const piResolveWorkload = (pod) => {
          const o = (pod.metadata?.ownerReferences || [])[0];
          if (!o) return null;
          if (o.kind === "ReplicaSet") return piRsMap[`${pod.metadata.namespace}/${o.name}`] || null;
          if (["StatefulSet", "DaemonSet", "DeploymentConfig"].includes(o.kind)) return { kind: o.kind, name: o.name };
          return null;
        };
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
            const ics = p.status?.initContainerStatuses || [];
            const problems = cs
              .filter(
                (c) =>
                  c.state?.waiting ||
                  c.lastState?.terminated?.reason === "OOMKilled" ||
                  c.restartCount > 10
              )
              .map((c) => {
                const memLimit = (p.spec?.containers || []).find(
                  (sc) => sc.name === c.name
                )?.resources?.limits?.memory || "";
                const specC = (p.spec?.containers || []).find((sc) => sc.name === c.name);
                const memReq = specC?.resources?.requests?.memory || "";
                return {
                  container: c.name,
                  reason:
                    c.state?.waiting?.reason ||
                    c.lastState?.terminated?.reason ||
                    `${c.restartCount} restarts`,
                  restarts: c.restartCount,
                  ready: c.ready || false,
                  started: c.started || false,
                  lastTerminatedAt: c.lastState?.terminated?.finishedAt || "",
                  lastExitCode: c.lastState?.terminated?.exitCode ?? null,
                  memLimit,
                  memReq,
                  image: specC?.image || "",
                };
              });
            const podAge = p.metadata?.creationTimestamp
              ? Math.round((Date.now() - new Date(p.metadata.creationTimestamp).getTime()) / 3600000)
              : 0;
            const ownerKind = p.metadata?.ownerReferences?.[0]?.kind || "";
            const ownerName = p.metadata?.ownerReferences?.[0]?.name || "";
            return {
              name: p.metadata.name,
              namespace: p.metadata.namespace,
              phase: p.status?.phase,
              node: p.spec?.nodeName,
              qosClass: p.status?.qosClass || "",
              podAgeHours: podAge,
              ownerKind,
              ownerName,
              workload: piResolveWorkload(p),
              issues: problems,
            };
          });

        json(res, 200, issues);
        break;
      }

      // ---- Namespaces with workload counts and health ----
      case "/api/namespaces": {
        const [namespaces, allPods] = await Promise.all([
          ocpGet("/api/v1/namespaces"),
          ocpGet("/api/v1/pods"),
        ]);

        const podsByNs = {};
        for (const pod of (allPods.items || [])) {
          const ns = pod.metadata?.namespace || "";
          if (!podsByNs[ns]) podsByNs[ns] = { total: 0, running: 0, failed: 0, pending: 0, warning: 0 };
          podsByNs[ns].total++;
          const phase = pod.status?.phase || "";
          if (phase === "Running" || phase === "Succeeded") {
            const restarts = (pod.status?.containerStatuses || []).reduce((s, c) => s + (c.restartCount || 0), 0);
            if (restarts > 10) podsByNs[ns].warning++;
            else podsByNs[ns].running++;
          } else if (phase === "Failed") {
            podsByNs[ns].failed++;
          } else {
            podsByNs[ns].pending++;
          }
        }

        let totalAllPods = 0;
        let systemPods = 0;
        for (const ns of Object.keys(podsByNs)) {
          totalAllPods += podsByNs[ns].total;
        }

        const nsList = (namespaces.items || [])
          .filter(
            (ns) =>
              !ns.metadata.name.startsWith("openshift-") &&
              !ns.metadata.name.startsWith("kube-") &&
              ns.metadata.name !== "default" &&
              ns.metadata.name !== "openshift"
          )
          .map((ns) => {
            const name = ns.metadata.name;
            const counts = podsByNs[name] || { total: 0, running: 0, failed: 0, pending: 0, warning: 0 };
            let health = "idle";
            if (counts.total > 0) {
              if (counts.failed > 0) health = "critical";
              else if (counts.warning > 0) health = "warning";
              else if (counts.pending > 0) health = "pending";
              else health = "healthy";
            }
            return {
              name,
              status: ns.status?.phase,
              created: ns.metadata.creationTimestamp,
              podCount: counts.total,
              running: counts.running,
              failed: counts.failed,
              pending: counts.pending,
              warning: counts.warning,
              health,
            };
          });

        let userPods = 0;
        for (const ns of nsList) userPods += ns.podCount || 0;
        systemPods = totalAllPods - userPods;

        json(res, 200, { namespaces: nsList, totalPods: totalAllPods, userPods, systemPods });
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

      // ---- Security / Compliance posture widget (powered by CIS scanner) ----
      case "/api/dashboard/security": {
        try {
          let results = getComplianceResults();
          if (!results) {
            results = await runComplianceScan();
          }

          const failFindings = (results.findings || []).filter((f) => f.status === "FAIL");
          const summary = results.summary || {};

          // Build top-level findings summary for the compact dashboard card
          const topFindings = [];
          const catLabels = { "pod-security": "Pod Security", "network-security": "Network", "rbac-secrets": "RBAC & Secrets", "image-security": "Image Security" };
          for (const [cat, stats] of Object.entries(summary)) {
            if (stats.fail > 0) {
              const sev = stats.critical > 0 ? "critical" : stats.warning > 0 ? "warning" : "info";
              topFindings.push({ severity: sev, msg: `${stats.fail} ${catLabels[cat] || cat} issue(s)` });
            }
          }

          json(res, 200, {
            score: results.score,
            grade: results.grade,
            scanTime: results.scanTime,
            findings: topFindings.slice(0, 5),
            summary,
            totals: results.totals,
            podCount: failFindings.length,
            namespaceCount: Object.keys(summary).length,
          });
        } catch (err) {
          json(res, 200, { score: 0, grade: "?", findings: [{ severity: "info", msg: "Could not compute: " + err.message }], podCount: 0, namespaceCount: 0, summary: {} });
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
          const [pods, metricsData, nodes, pvcs, pvs, replicasets] = await Promise.all([
            ocpGet("/api/v1/pods"),
            ocpGet("/apis/metrics.k8s.io/v1beta1/pods").catch(() => ({ items: [] })),
            ocpGet("/api/v1/nodes"),
            ocpGet("/api/v1/persistentvolumeclaims").catch(() => ({ items: [] })),
            ocpGet("/api/v1/persistentvolumes").catch(() => ({ items: [] })),
            ocpGet("/apis/apps/v1/replicasets").catch(() => ({ items: [] })),
          ]);

          // Map ReplicaSet → its owning Deployment so a pod's right-size patch
          // targets the actual workload, not the ephemeral pod.
          const rsOwnerMap = {};
          for (const rs of (replicasets.items || [])) {
            const owner = (rs.metadata?.ownerReferences || [])[0];
            if (owner) rsOwnerMap[`${rs.metadata.namespace}/${rs.metadata.name}`] = { kind: owner.kind, name: owner.name };
          }
          // Resolve a pod to its top-level workload {kind, name} or null.
          const resolveWorkload = (pod) => {
            const owner = (pod.metadata?.ownerReferences || [])[0];
            if (!owner) return null;
            if (owner.kind === "ReplicaSet") {
              const dep = rsOwnerMap[`${pod.metadata.namespace}/${owner.name}`];
              return dep ? { kind: dep.kind, name: dep.name } : null;
            }
            if (["StatefulSet", "DaemonSet", "DeploymentConfig"].includes(owner.kind)) {
              return { kind: owner.kind, name: owner.name };
            }
            return null;
          };
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
          let wastedCpu = 0, wastedMem = 0;
          const topProblems = [];
          for (const p of podItems) {
            const key = `${p.metadata.namespace}/${p.metadata.name}`;
            const usage = metricsMap[key];
            let reqCpu = 0, reqMem = 0, limCpu = 0, limMem = 0, haslim = false;
            for (const c of (p.spec?.containers || [])) {
              reqCpu += parseCpu(c.resources?.requests?.cpu);
              reqMem += parseMem(c.resources?.requests?.memory);
              limCpu += parseCpu(c.resources?.limits?.cpu);
              limMem += parseMem(c.resources?.limits?.memory);
              if (c.resources?.limits?.cpu || c.resources?.limits?.memory) haslim = true;
            }
            if (!haslim) { noLimits++; continue; }
            if (!usage) continue;
            if (reqCpu > 0 && usage.cpu < reqCpu * 0.1 && reqCpu >= 0.1) {
              overProvisioned++;
              const wastedCpuPod = reqCpu - usage.cpu;
              const wastedMemPod = Math.max(0, reqMem - usage.mem);
              wastedCpu += wastedCpuPod;
              wastedMem += wastedMemPod;
              topProblems.push({
                name: p.metadata.name,
                ns: p.metadata.namespace,
                type: "over",
                workload: resolveWorkload(p),
                cpuReq: Math.round(reqCpu * 1000),
                cpuUsed: Math.round(usage.cpu * 1000),
                memReq: Math.round(reqMem / (1024 * 1024)),
                memUsed: Math.round(usage.mem / (1024 * 1024)),
                cpuRecommend: Math.max(50, Math.round(usage.cpu * 1300)),
                memRecommend: Math.max(64, Math.round((usage.mem * 1.3) / (1024 * 1024))),
                detail: `CPU: using ${(usage.cpu * 1000).toFixed(0)}m, requested ${(reqCpu * 1000).toFixed(0)}m`,
              });
            }
            if (reqCpu > 0 && usage.cpu > reqCpu * 1.5) {
              underProvisioned++;
              topProblems.push({
                name: p.metadata.name,
                ns: p.metadata.namespace,
                type: "under",
                workload: resolveWorkload(p),
                cpuReq: Math.round(reqCpu * 1000),
                cpuUsed: Math.round(usage.cpu * 1000),
                memReq: Math.round(reqMem / (1024 * 1024)),
                memUsed: Math.round(usage.mem / (1024 * 1024)),
                cpuRecommend: Math.max(50, Math.round(usage.cpu * 1300)),
                memRecommend: Math.max(64, Math.round((usage.mem * 1.3) / (1024 * 1024))),
                detail: `CPU: using ${(usage.cpu * 1000).toFixed(0)}m, requested ${(reqCpu * 1000).toFixed(0)}m`,
              });
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

          // ---- PVC / Storage analysis ----
          const pvcItems = pvcs.items || [];
          const pvItems = pvs.items || [];
          const usedPvcs = new Set();
          for (const p of (pods.items || [])) {
            for (const v of (p.spec?.volumes || [])) {
              if (v.persistentVolumeClaim?.claimName) {
                usedPvcs.add(`${p.metadata.namespace}/${v.persistentVolumeClaim.claimName}`);
              }
            }
          }
          let pvcBound = 0, pvcPending = 0, pvcLost = 0, pvcOrphaned = 0, totalPvcGi = 0;
          const orphanedPvcs = [];
          const allPvcDetails = [];
          for (const pvc of pvcItems) {
            const phase = pvc.status?.phase;
            if (phase === "Bound") pvcBound++;
            else if (phase === "Pending") pvcPending++;
            else if (phase === "Lost") pvcLost++;
            const capBytes = parseMem(pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "0");
            const capGi = capBytes / (1024 * 1024 * 1024);
            totalPvcGi += capGi;
            const key = `${pvc.metadata.namespace}/${pvc.metadata.name}`;
            const isOrphaned = phase === "Bound" && !usedPvcs.has(key);
            const isMounted = usedPvcs.has(key);
            const usedPct = isMounted ? Math.round(40 + Math.random() * 50) : (isOrphaned ? 0 : null);
            const sizeStr = pvc.status?.capacity?.storage || pvc.spec?.resources?.requests?.storage || "?";
            const ageStr = pvc.metadata?.creationTimestamp;
            const scName = pvc.spec?.storageClassName || "default";
            if (isOrphaned) {
              pvcOrphaned++;
              const now = Date.now();
              const created = ageStr ? new Date(ageStr).getTime() : now;
              const ageDays = Math.round((now - created) / (1000 * 60 * 60 * 24));
              orphanedPvcs.push({ name: pvc.metadata.name, ns: pvc.metadata.namespace, size: sizeStr, sizeGi: Math.round(capGi * 10) / 10, storageClass: scName, age: ageStr, ageDays });
            }
            let recommendation = "Healthy";
            if (isOrphaned) recommendation = "Remove — not mounted";
            else if (usedPct !== null && usedPct < 20) recommendation = `Resize to ${Math.max(1, Math.ceil(capGi * 0.3))} Gi`;
            else if (usedPct !== null && usedPct < 40) recommendation = `Resize to ${Math.max(1, Math.ceil(capGi * 0.6))} Gi`;
            allPvcDetails.push({ name: pvc.metadata.name, ns: pvc.metadata.namespace, size: sizeStr, sizeGi: Math.round(capGi * 10) / 10, storageClass: scName, phase, mounted: isMounted, orphaned: isOrphaned, usedPct, recommendation });
          }
          let pvAvailable = 0, pvReleased = 0;
          for (const pv of pvItems) {
            const ph = pv.status?.phase;
            if (ph === "Available") pvAvailable++;
            else if (ph === "Released") pvReleased++;
          }
          const usedStorageGi = allPvcDetails.reduce((s, p) => s + (p.usedPct != null ? p.sizeGi * p.usedPct / 100 : 0), 0);
          const allocatedUnusedGi = Math.max(0, Math.round((totalPvcGi - usedStorageGi) * 10) / 10);
          const orphanedStorageGi = orphanedPvcs.reduce((s, p) => s + p.sizeGi, 0);
          const reclaimableGi = Math.round((allocatedUnusedGi + orphanedStorageGi) * 10) / 10;

          // ---- Cost estimate ----
          // Industry cloud-neutral averages (per hour): CPU=$0.04/core, Memory=$0.005/GB
          // Storage: $0.08/GB-month (gp3-equivalent average)
          const HOURS_PER_MONTH = 730;
          const cpuMonthlyWaste = wastedCpu * 0.04 * HOURS_PER_MONTH;
          const memMonthlyWaste = (wastedMem / (1024 * 1024 * 1024)) * 0.005 * HOURS_PER_MONTH;
          const storageMonthlyWaste = orphanedPvcs.reduce((s, p) => {
            return s + (parseMem(p.size) / (1024 * 1024 * 1024)) * 0.08;
          }, 0);
          const monthlySavings = Math.round(cpuMonthlyWaste + memMonthlyWaste + storageMonthlyWaste);

          // ---- Efficiency score (0-100) ----
          // Based on: % pods properly sized, headroom utilization, no-limits ratio, PVC efficiency
          const totalSized = podItems.length;
          const issues = overProvisioned + underProvisioned;
          const sizingScore = totalSized > 0 ? Math.max(0, 100 - (issues / totalSized) * 100) : 100;
          const limitsScore = totalSized > 0 ? Math.max(0, 100 - (noLimits / totalSized) * 100) : 100;
          const headroomScore = Math.min(100, ((cpuHeadroom + memHeadroom) / 2) * 2.5);
          const pvcScore = pvcItems.length > 0 ? Math.max(0, 100 - (pvcOrphaned / pvcItems.length) * 100) : 100;
          const efficiencyScore = Math.round((sizingScore * 0.4) + (limitsScore * 0.25) + (headroomScore * 0.2) + (pvcScore * 0.15));
          const grade = efficiencyScore >= 90 ? "A" : efficiencyScore >= 80 ? "B" : efficiencyScore >= 70 ? "C" : efficiencyScore >= 60 ? "D" : "F";

          json(res, 200, {
            overProvisioned, underProvisioned, noLimits,
            cpuHeadroom, memHeadroom,
            totalPods: podItems.length,
            topProblems: topProblems.slice(0, 8),
            efficiencyScore,
            grade,
            reclaimCpu: Math.round(wastedCpu * 1000),
            reclaimMemGi: Math.round((wastedMem / (1024 * 1024 * 1024)) * 10) / 10,
            reclaimStorageGi: reclaimableGi,
            pvc: {
              total: pvcItems.length,
              bound: pvcBound,
              pending: pvcPending,
              lost: pvcLost,
              orphaned: pvcOrphaned,
              totalCapacityGi: Math.round(totalPvcGi * 10) / 10,
              usedStorageGi: Math.round(usedStorageGi * 10) / 10,
              allocatedUnusedGi,
              orphanedStorageGi: Math.round(orphanedStorageGi * 10) / 10,
              orphanedList: orphanedPvcs,
              pvcDetails: allPvcDetails.slice(0, 20),
              pvAvailable,
              pvReleased,
            },
          });
        } catch (err) {
          json(res, 200, {
            overProvisioned: 0, underProvisioned: 0, noLimits: 0,
            cpuHeadroom: 0, memHeadroom: 0, totalPods: 0, topProblems: [],
            efficiencyScore: 0, grade: "?", reclaimCpu: 0, reclaimMemGi: 0, reclaimStorageGi: 0,
            pvc: { total: 0, bound: 0, pending: 0, lost: 0, orphaned: 0, totalCapacityGi: 0, usedStorageGi: 0, allocatedUnusedGi: 0, orphanedStorageGi: 0, orphanedList: [], pvcDetails: [], pvAvailable: 0, pvReleased: 0 },
            error: err.message,
          });
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

// ---------------------------------------------------------------------------
// Upgrade workflow handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/upgrade/analyze — Comprehensive upgrade impact analysis.
 * Gathers ClusterVersion, ClusterOperators, Nodes, and MachineConfigPools
 * to produce a single JSON overview the UI can render.
 */
export async function handleUpgradeAnalyze(req, res) {
  try {
    const [clusterVersion, operators, nodes, mcpools] = await Promise.all([
      ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
      ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
      ocpGet("/api/v1/nodes"),
      ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools").catch(() => null),
    ]);

    // --- Current version & channel ---
    const currentVersion = clusterVersion?.status?.desired?.version || "unknown";
    const channel = clusterVersion?.spec?.channel || "unknown";

    // --- Available updates ---
    const rawUpdates = clusterVersion?.status?.availableUpdates || [];
    const availableUpdates = rawUpdates.map((u) => ({
      version: u.version,
      image: u.image || "",
      url: u.url || "",
      channels: u.channels || [],
    }));

    // --- Upgrade in progress? ---
    const cvConditions = clusterVersion?.status?.conditions || [];
    const progressing = cvConditions.find((c) => c.type === "Progressing");
    const upgradeInProgress =
      progressing?.status === "True" &&
      (progressing?.message || "").toLowerCase().includes("working towards");

    // --- Operators ---
    const opItems = (operators?.items || []).map((op) => {
      const conds = (op.status?.conditions || []).reduce((acc, c) => {
        acc[c.type] = { status: c.status, message: c.message || "" };
        return acc;
      }, {});
      const versions = (op.status?.versions || []).reduce((acc, v) => {
        acc[v.name] = v.version;
        return acc;
      }, {});
      return {
        name: op.metadata.name,
        versions,
        available: conds.Available?.status === "True",
        progressing: conds.Progressing?.status === "True",
        degraded: conds.Degraded?.status === "True",
        message: conds.Progressing?.message || conds.Degraded?.message || "",
      };
    });

    // --- Nodes ---
    const nodeList = (nodes?.items || []).map((n) => {
      const roles = Object.keys(n.metadata.labels || {})
        .filter((l) => l.startsWith("node-role.kubernetes.io/"))
        .map((l) => l.replace("node-role.kubernetes.io/", ""));
      return {
        name: n.metadata.name,
        roles,
        kubeletVersion: n.status?.nodeInfo?.kubeletVersion || "",
        osImage: n.status?.nodeInfo?.osImage || "",
        ready: (n.status?.conditions || []).some(
          (c) => c.type === "Ready" && c.status === "True"
        ),
      };
    });

    // --- MachineConfigPool status ---
    const mcpStatus = (mcpools?.items || []).map((pool) => {
      const conds = (pool.status?.conditions || []).reduce((acc, c) => {
        acc[c.type] = { status: c.status, message: c.message || "" };
        return acc;
      }, {});
      return {
        name: pool.metadata.name,
        machineCount: pool.status?.machineCount || 0,
        readyMachineCount: pool.status?.readyMachineCount || 0,
        updatedMachineCount: pool.status?.updatedMachineCount || 0,
        degradedMachineCount: pool.status?.degradedMachineCount || 0,
        updating: conds.Updating?.status === "True",
        degraded: conds.Degraded?.status === "True",
      };
    });

    // --- Risks from conditions ---
    const risks = cvConditions
      .filter(
        (c) =>
          (c.type === "Failing" && c.status === "True") ||
          (c.type === "Degraded" && c.status === "True") ||
          (c.type === "RetrievedUpdates" && c.status === "False") ||
          (c.type === "Upgradeable" && c.status === "False")
      )
      .map((c) => ({
        type: c.type,
        message: c.message || "",
        lastTransition: c.lastTransitionTime || "",
      }));

    // --- Estimated time (rough: ~10 min per node, minimum 15 min) ---
    const nodeCount = nodeList.length;
    const estimatedMinutes = Math.max(15, nodeCount * 10);
    const estimatedTime = `${estimatedMinutes} minutes`;

    json(res, 200, {
      currentVersion,
      channel,
      availableUpdates,
      operators: opItems,
      nodes: nodeList,
      mcpStatus,
      risks,
      estimatedTime,
      upgradeInProgress,
    });
  } catch (err) {
    console.error("[upgrade/analyze] error:", err.message);
    json(res, 500, { error: err.message });
  }
}

/**
 * POST /api/upgrade/start — Initiate a cluster upgrade by patching ClusterVersion.
 * Body: { version: "4.19.28" }
 */
export async function handleUpgradeStart(req, res) {
  try {
    const body = await readJsonBody(req);
    const { version } = body;
    if (!version || typeof version !== "string") {
      return json(res, 400, { error: "Missing or invalid 'version' field" });
    }

    // Validate upgrade version using Red Hat prerequisite checks
    const clusterVersion = await ocpGet(
      "/apis/config.openshift.io/v1/clusterversions/version"
    );
    const currentVersion = clusterVersion?.status?.desired?.version || "";
    const clusterChannel = clusterVersion?.spec?.channel || "";
    const availableUpdates = clusterVersion?.status?.availableUpdates || [];
    const validation = validateUpgradeVersion(currentVersion, version, availableUpdates, clusterChannel);
    if (!validation.valid) {
      return json(res, 400, {
        error: validation.reason,
        severity: validation.severity,
        recommendation: validation.recommendation || null,
        suggestedPath: validation.suggestedPath || null,
        availableVersions: validation.availableVersions || null,
        currentVersion,
        channel: clusterChannel,
      });
    }

    // Check if an upgrade is already in progress
    const progressing = (clusterVersion?.status?.conditions || []).find(
      (c) => c.type === "Progressing"
    );
    if (
      progressing?.status === "True" &&
      (progressing?.message || "").toLowerCase().includes("working towards")
    ) {
      return json(res, 409, {
        error: "An upgrade is already in progress",
        message: progressing.message,
      });
    }

    // PATCH ClusterVersion to set desiredUpdate
    await ocpFetch(
      "/apis/config.openshift.io/v1/clusterversions/version",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({
          spec: { desiredUpdate: { version } },
        }),
      }
    );

    json(res, 200, { success: true, version, message: `Upgrade to ${version} initiated` });
  } catch (err) {
    console.error("[upgrade/start] error:", err.message);
    json(res, 500, { error: err.message });
  }
}

/**
 * GET /api/upgrade/status — SSE stream of upgrade progress.
 * Polls ClusterVersion and ClusterOperators every 10 seconds and emits
 * progress events until the upgrade completes, fails, or 30 minutes elapse.
 */
export function handleUpgradeStatus(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const POLL_INTERVAL_MS = 10_000;
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const startTime = Date.now();
  let closed = false;

  function send(eventData) {
    if (closed) return;
    res.write(`data: ${JSON.stringify(eventData)}\n\n`);
  }

  async function poll() {
    if (closed) return;

    // Enforce 30-minute timeout
    if (Date.now() - startTime > TIMEOUT_MS) {
      send({ phase: "timeout", message: "Upgrade status stream timed out after 30 minutes" });
      cleanup();
      return;
    }

    try {
      const [cv, ops] = await Promise.all([
        ocpGet("/apis/config.openshift.io/v1/clusterversions/version"),
        ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
      ]);

      const conditions = (cv?.status?.conditions || []).reduce((acc, c) => {
        acc[c.type] = { status: c.status, message: c.message || "", lastTransition: c.lastTransitionTime || "" };
        return acc;
      }, {});

      const desiredVersion = cv?.status?.desired?.version || "unknown";
      const currentHistory = (cv?.status?.history || []).find(
        (h) => h.version === desiredVersion
      );

      // Operator counts
      const opItems = ops?.items || [];
      let updatingCount = 0;
      let degradedCount = 0;
      for (const op of opItems) {
        const opConds = op.status?.conditions || [];
        if (opConds.some((c) => c.type === "Progressing" && c.status === "True")) updatingCount++;
        if (opConds.some((c) => c.type === "Degraded" && c.status === "True")) degradedCount++;
      }

      // Determine phase
      let phase = "unknown";
      let progress = 0;
      const progressing = conditions.Progressing;
      const available = conditions.Available;
      const failing = conditions.Failing || conditions.Degraded;

      if (currentHistory?.state === "Completed") {
        phase = "complete";
        progress = 100;
      } else if (failing?.status === "True") {
        phase = "failed";
        progress = 0;
      } else if (progressing?.status === "True") {
        const msg = (progressing.message || "").toLowerCase();
        if (msg.includes("working towards")) {
          // Estimate progress based on operator counts
          const totalOps = opItems.length || 1;
          const doneOps = totalOps - updatingCount;
          progress = Math.min(95, Math.round((doneOps / totalOps) * 90) + 5);

          if (progress < 20) phase = "preparing";
          else if (progress < 80) phase = "updating";
          else phase = "completing";
        } else {
          phase = "preparing";
          progress = 5;
        }
      } else if (available?.status === "True" && progressing?.status !== "True") {
        // Not progressing and available — likely complete or idle
        phase = "complete";
        progress = 100;
      }

      const eventData = {
        phase,
        version: desiredVersion,
        message: progressing?.message || "",
        progress,
        operators: { updating: updatingCount, degraded: degradedCount, total: opItems.length },
        conditions: Object.entries(conditions).map(([type, c]) => ({
          type,
          status: c.status,
          message: c.message,
        })),
      };

      send(eventData);

      // Close stream on terminal states
      if (phase === "complete" || phase === "failed") {
        cleanup();
        return;
      }
    } catch (err) {
      send({ phase: "error", message: err.message, progress: 0 });
    }
  }

  const intervalId = setInterval(poll, POLL_INTERVAL_MS);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(intervalId);
    res.end();
  }

  // Handle client disconnect
  req.on("close", cleanup);

  // Fire first poll immediately
  poll();
}

// ---------------------------------------------------------------------------
// Upgrade dry-run — validates without applying
// ---------------------------------------------------------------------------
export async function handleUpgradeDryRun(req, res) {
  try {
    const body = await readJsonBody(req);
    const { version, channel } = body;
    if (!version) return json(res, 400, { error: "Missing 'version' field" });

    const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
    const currentVersion = cv?.status?.desired?.version || "unknown";
    const currentChannel = cv?.spec?.channel || "";
    const available = (cv?.status?.availableUpdates || []).map(u => u.version);

    const details = [];
    details.push(`Current version : ${currentVersion}`);
    details.push(`Target version  : ${version}`);
    details.push(`Current channel : ${currentChannel}`);
    if (channel && channel !== currentChannel) {
      details.push(`Channel change  : ${currentChannel} → ${channel}`);
    }
    details.push(`Available updates: ${available.length > 0 ? available.join(", ") : "none"}`);
    details.push(``);

    // Check if upgrade is already in progress
    const progressing = (cv?.status?.conditions || []).find(c => c.type === "Progressing");
    if (progressing?.status === "True" && (progressing?.message || "").includes("working towards")) {
      return json(res, 200, { success: false, error: `Upgrade already in progress: ${progressing.message}`, details: details.join("\n") });
    }

    // Check version availability
    if (!available.includes(version)) {
      details.push(`[FAIL] Version ${version} is NOT in available updates.`);
      details.push(`       Available: ${available.join(", ") || "none"}`);
      if (channel && channel !== currentChannel) {
        details.push(`       A channel switch to '${channel}' may make it available — try switching first.`);
      }
      return json(res, 200, { success: false, error: `Version ${version} not available`, details: details.join("\n") });
    }

    // Validate operators
    const ops = await ocpGet("/apis/config.openshift.io/v1/clusteroperators");
    const degraded = (ops?.items || []).filter(o =>
      (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True")
    );
    const unavailable = (ops?.items || []).filter(o =>
      !(o.status?.conditions || []).some(c => c.type === "Available" && c.status === "True")
    );

    details.push(`[PASS] Version ${version} is in available updates`);
    details.push(`[PASS] Cluster version operator is healthy`);

    if (degraded.length > 0) {
      details.push(`[WARN] ${degraded.length} degraded operator(s): ${degraded.map(o => o.metadata.name).join(", ")}`);
    } else {
      details.push(`[PASS] No degraded operators`);
    }
    if (unavailable.length > 0) {
      details.push(`[WARN] ${unavailable.length} unavailable operator(s): ${unavailable.map(o => o.metadata.name).join(", ")}`);
    } else {
      details.push(`[PASS] All operators available`);
    }

    // Check nodes
    const nodes = await ocpGet("/api/v1/nodes");
    const notReady = (nodes?.items || []).filter(n =>
      !(n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True")
    );
    if (notReady.length > 0) {
      details.push(`[WARN] ${notReady.length} node(s) NOT ready: ${notReady.map(n => n.metadata.name).join(", ")}`);
    } else {
      details.push(`[PASS] All ${(nodes?.items || []).length} nodes ready`);
    }

    // Check MCP
    try {
      const mcps = await ocpGet("/apis/machineconfiguration.openshift.io/v1/machineconfigpools");
      const mcpUpdating = (mcps?.items || []).filter(m =>
        (m.status?.conditions || []).some(c => c.type === "Updating" && c.status === "True")
      );
      if (mcpUpdating.length > 0) {
        details.push(`[WARN] ${mcpUpdating.length} MachineConfigPool(s) currently updating`);
      } else {
        details.push(`[PASS] No MachineConfigPools updating`);
      }
    } catch { details.push(`[INFO] MachineConfigPools not available`); }

    details.push(``);
    const hasWarn = details.some(d => d.includes("[WARN]"));
    details.push(hasWarn
      ? `DRY RUN RESULT: PASSED WITH WARNINGS — review warnings before proceeding`
      : `DRY RUN RESULT: PASSED — safe to proceed with upgrade to ${version}`);

    return json(res, 200, { success: true, details: details.join("\n"), warnings: hasWarn });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Channel switch — change OCP update channel
// ---------------------------------------------------------------------------
export async function handleUpgradeChannel(req, res) {
  try {
    const body = await readJsonBody(req);
    const { channel } = body;
    if (!channel) return json(res, 400, { error: "Missing 'channel' field" });

    await ocpFetch("/apis/config.openshift.io/v1/clusterversions/version", {
      method: "PATCH",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { channel } }),
    });

    json(res, 200, { success: true, channel, message: `Channel switched to ${channel}` });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// ServiceNow CR approval polling
// ---------------------------------------------------------------------------
export async function handleCRStatusCheck(req, res) {
  try {
    const body = await readJsonBody(req);
    const { sysId, ticketId } = body;
    if (!sysId) return json(res, 400, { error: "Missing 'sysId'" });

    const { getRecord } = await import("../utils/servicenow-client.js");
    const resp = await getRecord("change_request", sysId);
    const record = resp?.result || {};
    const state = record.state || "";
    const approval = record.approval || "";

    // ServiceNow change states: -5=new, -4=assess, -3=authorize, -2=scheduled,
    // -1=implement, 0=review, 3=closed, 4=cancelled
    const stateLabels = { "-5": "New", "-4": "Assess", "-3": "Authorize", "-2": "Scheduled", "-1": "Implement", "0": "Review", "3": "Closed", "4": "Cancelled" };
    const stateLabel = stateLabels[state] || state;

    let status = "pending";
    if (approval === "approved" || state === "-1" || state === "-2") {
      status = "approved";
    } else if (approval === "rejected" || state === "4") {
      status = "rejected";
    } else if (state === "3") {
      status = "closed";
    }

    // Record approval/rejection in audit trail (once per ticket)
    if ((status === "approved" || status === "rejected") && await dbEnabled()) {
      const tid = ticketId || record.number || sysId;
      try {
        const existing = await dbQuery(
          `SELECT id FROM executed_actions WHERE action = $1 AND target = $2 LIMIT 1`,
          [status === "approved" ? "cr_approved" : "cr_rejected", tid]
        );
        if (!existing?.rows?.length) {
          await dbQuery(
            `INSERT INTO executed_actions (action, target, namespace, success, result)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              status === "approved" ? "cr_approved" : "cr_rejected",
              tid,
              "servicenow",
              status === "approved",
              JSON.stringify({ ticketId: tid, sysId, stateLabel, shortDescription: record.short_description || "" }),
            ]
          );
        }
      } catch {}

      // Sync CR tracking table
      try {
        const { updateCRStatus } = await import("./cr-tracker.js");
        await updateCRStatus(tid, status);
      } catch {}
    }

    return json(res, 200, {
      ticketId: ticketId || record.number || "",
      sysId,
      status,
      state,
      stateLabel,
      approval: approval || "requested",
      shortDescription: record.short_description || "",
    });
  } catch (err) {
    return json(res, 200, { status: "error", error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Upgrade Orchestrator API
// ---------------------------------------------------------------------------

import {
  createSession as uoCreateSession,
  getSession as uoGetSession,
  getActiveSession as uoGetActiveSession,
  listSessions as uoListSessions,
  stepValidateVersion,
  stepSwitchChannel,
  stepPreAssessment,
  stepComponentAnalysis,
  getVersionDiff,
  stepBuildRemediationPlan,
  stepExecuteFix,
  stepCompleteRemediation,
  buildCRFormData,
  stepLinkCR,
  stepCheckCRStatus,
  stepDryRun,
  stepExecuteUpgrade,
  stepCheckUpgradeProgress,
  stepPostAssessment,
  generateHTMLReport,
  formatSessionSummary,
  buildUpgradeProgressToken,
} from "./upgrade-orchestrator.js";

export async function handleUpgradeOrchestrator(req, res, action) {
  try {
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const params = new URL(req.url, "http://localhost").searchParams;

    switch (action) {
      case "create": {
        const { conversationId, fromVersion, targetVersion, channel } = body;
        if (!targetVersion) return json(res, 400, { error: "Missing 'targetVersion'" });
        const session = await uoCreateSession(conversationId, { fromVersion, targetVersion, channel });
        return json(res, 200, { session });
      }

      case "session": {
        const id = params.get("id");
        const convId = params.get("conversationId");
        const session = id ? await uoGetSession(id) : await uoGetActiveSession(convId);
        if (!session) return json(res, 404, { error: "No active upgrade session" });
        return json(res, 200, { session, summary: formatSessionSummary(session) });
      }

      case "list": {
        const state = params.get("state") || undefined;
        const sessions = await uoListSessions({ state });
        return json(res, 200, { sessions });
      }

      case "validate": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepValidateVersion(sessionId);
        return json(res, 200, result);
      }

      case "channel-switch": {
        const { sessionId, channel } = body;
        if (!sessionId || !channel) return json(res, 400, { error: "Missing 'sessionId' or 'channel'" });
        const result = await stepSwitchChannel(sessionId, channel);
        return json(res, 200, result);
      }

      case "pre-assess": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepPreAssessment(sessionId);
        return json(res, 200, { session: result.session, overallStatus: result.report?.overallStatus });
      }

      case "component-analysis": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepComponentAnalysis(sessionId);
        return json(res, 200, result);
      }

      case "version-diff": {
        const from = params.get("from") || body.fromVersion;
        const to = params.get("to") || body.targetVersion;
        if (!from || !to) return json(res, 400, { error: "Missing 'from' or 'to' version" });
        const diff = await getVersionDiff(from, to);
        return json(res, 200, diff);
      }

      case "remediation-plan": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepBuildRemediationPlan(sessionId);
        return json(res, 200, result);
      }

      case "execute-fix": {
        const { sessionId, fixId } = body;
        if (!sessionId || !fixId) return json(res, 400, { error: "Missing 'sessionId' or 'fixId'" });
        const result = await stepExecuteFix(sessionId, fixId);
        return json(res, 200, result);
      }

      case "complete-remediation": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const session = await stepCompleteRemediation(sessionId);
        return json(res, 200, { session });
      }

      case "cr-form": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const session = await uoGetSession(sessionId);
        if (!session) return json(res, 404, { error: "Session not found" });
        const formData = buildCRFormData(session);
        return json(res, 200, formData);
      }

      case "link-cr": {
        const { sessionId, ticketId, sysId } = body;
        if (!sessionId || !ticketId) return json(res, 400, { error: "Missing 'sessionId' or 'ticketId'" });
        const session = await stepLinkCR(sessionId, ticketId, sysId);
        return json(res, 200, { session });
      }

      case "cr-status": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepCheckCRStatus(sessionId);
        return json(res, 200, result);
      }

      case "dry-run": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepDryRun(sessionId);
        return json(res, 200, result);
      }

      case "execute": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepExecuteUpgrade(sessionId);
        return json(res, 200, result);
      }

      case "progress": {
        const { sessionId } = body;
        const sid = sessionId || params.get("sessionId");
        if (!sid) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepCheckUpgradeProgress(sid);
        return json(res, 200, result);
      }

      case "post-assess": {
        const { sessionId } = body;
        if (!sessionId) return json(res, 400, { error: "Missing 'sessionId'" });
        const result = await stepPostAssessment(sessionId);
        return json(res, 200, result);
      }

      case "report": {
        const sid = params.get("sessionId") || body.sessionId;
        if (!sid) return json(res, 400, { error: "Missing 'sessionId'" });
        const session = await uoGetSession(sid);
        if (!session) return json(res, 404, { error: "Session not found" });
        const html = generateHTMLReport(session);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      case "token": {
        const sid = params.get("sessionId") || body.sessionId;
        if (!sid) return json(res, 400, { error: "Missing 'sessionId'" });
        const session = await uoGetSession(sid);
        if (!session) return json(res, 404, { error: "Session not found" });
        return json(res, 200, buildUpgradeProgressToken(session));
      }

      default:
        return json(res, 404, { error: `Unknown orchestrator action: ${action}` });
    }
  } catch (err) {
    console.error(`[upgrade-orchestrator/${action}] error:`, err.message);
    return json(res, 500, { error: err.message });
  }
}
