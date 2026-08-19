/**
 * Application Intent Schema (AIS) Extractor
 * Deterministic parser for structured deployment documents (tables + headings).
 * Falls back to LLM only for freeform/prose documents.
 */

import { callLLM } from "./llm.js";
import { loadConfig } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Main entry point — tries deterministic extraction first, LLM as fallback
// ---------------------------------------------------------------------------
export async function extractAIS(parsedDoc, providerOpts = {}) {
  console.log("[ais-extractor] Attempting deterministic extraction from", parsedDoc.sections.length, "sections");

  const intent = extractDeterministic(parsedDoc);

  if (intent && intent.tiers && intent.tiers.length > 0) {
    console.log("[ais-extractor] Deterministic extraction succeeded:", intent.tiers.length, "tiers found");
    const missingFields = validateAIS(intent);
    const confidence = calculateConfidence(intent, missingFields);
    return { intent, missingFields, confidence };
  }

  console.log("[ais-extractor] Deterministic extraction found no tiers, falling back to chunked LLM");
  return extractWithChunkedLLM(parsedDoc, providerOpts);
}

// ---------------------------------------------------------------------------
// Deterministic extractor — parses structured tables directly
// ---------------------------------------------------------------------------
function extractDeterministic(parsedDoc) {
  const sections = parsedDoc.sections;
  const intent = {
    appName: null,
    description: null,
    environment: null,
    targetPlatform: null,
    namespace: null,
    tiers: [],
    sharedSecrets: [],
    configMaps: [],
    networkPolicies: [],
    deployOrder: [],
    validationTests: [],
    rollbackCriteria: [],
  };

  const consumed = new Set();

  for (let i = 0; i < sections.length; i++) {
    if (consumed.has(i)) continue;
    const sec = sections[i];
    const h = (sec.heading || "").toLowerCase();

    // Section 1: Application Overview
    if (h.includes("application overview") || h.includes("app overview")) {
      const kv = flattenKV(sec.tables);
      intent.appName = findVal(kv, "application name", "app name", "name");
      intent.description = findVal(kv, "description");
      intent.environment = findVal(kv, "environment", "env");
    }

    // Section 2: Target Platform
    else if (h.includes("target platform")) {
      const kv = flattenKV(sec.tables);
      intent.targetPlatform = (findVal(kv, "platform type", "platform") || "openshift").toLowerCase();
      intent.namespace = findVal(kv, "namespace", "project");
      const order = findVal(kv, "deployment order", "deploy order");
      if (order) intent.deployOrder = order.split(",").map((s) => s.trim()).filter(Boolean);
    }

    // Section 3: Shared Resources / Secrets / ConfigMaps
    else if (h.includes("shared resource")) {
      extractSharedResources(sec, sections, i, intent, consumed);
    }
    else if (h.includes("configmap") && !consumed.has(i)) {
      extractConfigMaps(sec, intent);
    }

    // Network Connectivity Matrix
    else if (h.includes("network") && (h.includes("matrix") || h.includes("connectivity") || h.includes("policy"))) {
      extractNetworkPolicies(sec, intent);
    }

    // Validation Tests
    else if (h.includes("validation") || h.includes("post-deploy")) {
      extractValidationTests(sec, intent);
    }

    // Rollback Criteria
    else if (h.includes("rollback")) {
      extractRollbackCriteria(sec, intent);
    }

    // Tier sections: "Tier 1", "Tier 2", "Tier 3", or major component headings
    else if (h.match(/tier\s*\d|database|frontend|backend|web\s*server|app\s*server|api\s*server|nginx|postgres|mysql|mongodb|redis/i)) {
      const tier = extractTier(sec, sections, i, consumed);
      if (tier && tier.name) intent.tiers.push(tier);
    }
  }

  // Infer deploy order from tiers if not specified
  if (intent.deployOrder.length === 0 && intent.tiers.length > 0) {
    const db = intent.tiers.filter((t) => t.role === "database").map((t) => t.name);
    const app = intent.tiers.filter((t) => t.role === "app").map((t) => t.name);
    const fe = intent.tiers.filter((t) => t.role === "frontend").map((t) => t.name);
    intent.deployOrder = [...db, ...app, ...fe];
  }

  return intent;
}

function extractSharedResources(sec, allSections, idx, intent, consumed) {
  const range = [sec];
  for (let j = idx + 1; j < allSections.length && j < idx + 5; j++) {
    if (allSections[j].level <= sec.level && allSections[j].heading) break;
    range.push(allSections[j]);
    consumed.add(j);
  }

  for (const s of range) {
    const h = (s.heading || "").toLowerCase();
    for (const table of s.tables) {
      const headers = (table.headers || []).map((h) => h.toLowerCase());
      if (headers.some((hd) => hd.includes("secret name") || hd.includes("secret"))) {
        for (const row of table.rows) {
          const name = findRowVal(row, headers, "secret name", "name");
          const keys = findRowVal(row, headers, "keys", "key");
          const usedBy = findRowVal(row, headers, "used by", "usedby");
          if (name) {
            intent.sharedSecrets.push({
              name,
              keys: keys ? keys.split(",").map((k) => k.trim()).filter(Boolean) : [],
              usedBy: usedBy ? usedBy.split(",").map((k) => k.trim()).filter(Boolean) : [],
              autoGenerate: true,
            });
          }
        }
      }
      if (headers.some((hd) => hd.includes("configmap") || hd.includes("config map"))) {
        for (const row of table.rows) {
          const name = findRowVal(row, headers, "configmap name", "name", "configmap");
          const dataStr = findRowVal(row, headers, "data", "keys", "key");
          const usedBy = findRowVal(row, headers, "used by", "usedby");
          if (name) {
            const data = {};
            if (dataStr) {
              dataStr.split(",").forEach((pair) => {
                const [k, v] = pair.split("=").map((s) => s.trim());
                if (k) data[k] = v || "";
              });
            }
            intent.configMaps.push({ name, data, usedBy: usedBy ? usedBy.split(",").map((s) => s.trim()) : [] });
          }
        }
      }
    }
  }
}

function extractConfigMaps(sec, intent) {
  for (const table of sec.tables) {
    const headers = (table.headers || []).map((h) => h.toLowerCase());
    for (const row of table.rows) {
      const name = findRowVal(row, headers, "configmap name", "name", "configmap");
      const dataStr = findRowVal(row, headers, "data", "keys");
      const usedBy = findRowVal(row, headers, "used by", "usedby");
      if (name && !intent.configMaps.some((c) => c.name === name)) {
        const data = {};
        if (dataStr) {
          dataStr.split(",").forEach((pair) => {
            const [k, v] = pair.split("=").map((s) => s.trim());
            if (k) data[k] = v || "";
          });
        }
        intent.configMaps.push({ name, data, usedBy: usedBy ? usedBy.split(",").map((s) => s.trim()) : [] });
      }
    }
  }
}

function extractTier(sec, allSections, idx, consumed) {
  const kv = flattenKV(sec.tables);
  const h = (sec.heading || "").toLowerCase();

  const tier = {
    name: findVal(kv, "component name", "component", "name") || null,
    role: (findVal(kv, "role") || inferRole(h)).toLowerCase(),
    image: findVal(kv, "container image", "image"),
    replicas: { min: 1, max: 1 },
    port: toInt(findVal(kv, "port")),
    protocol: findVal(kv, "protocol") || "TCP",
    resources: {
      cpuReq: findVal(kv, "cpu request", "cpu req"),
      cpuLim: findVal(kv, "cpu limit", "cpu lim"),
      memReq: findVal(kv, "memory request", "mem request", "memory req", "mem req"),
      memLim: findVal(kv, "memory limit", "mem limit", "memory lim", "mem lim"),
    },
    envVars: [],
    storage: null,
    probes: { liveness: null, readiness: null },
    expose: false,
    hostname: null,
    tls: null,
    reverseProxy: null,
    dependsOn: [],
    initSql: null,
    security: { runAsNonRoot: false, readOnlyRootFs: false, dropCapabilities: false },
  };

  // Replicas
  const repMin = findVal(kv, "replicas min", "replicas", "min replicas");
  const repMax = findVal(kv, "replicas max", "max replicas");
  if (repMin) tier.replicas.min = toInt(repMin) || 1;
  if (repMax) tier.replicas.max = toInt(repMax) || tier.replicas.min;
  const repStr = findVal(kv, "replicas");
  if (repStr && !repMin) {
    const m = repStr.match(/(\d+)/);
    if (m) tier.replicas.min = parseInt(m[1], 10);
    tier.replicas.max = tier.replicas.min;
  }

  // Storage
  const storageSize = findVal(kv, "storage size", "storage");
  if (storageSize && storageSize.match(/\d+[KMGT]i/i)) {
    tier.storage = {
      size: storageSize,
      mountPath: findVal(kv, "storage mount path", "mount path", "mountpath") || "/data",
      storageClass: findVal(kv, "storage class", "storageclass") || "default",
      accessMode: findVal(kv, "access mode", "accessmode") || "ReadWriteOnce",
    };
  }

  // Expose
  const exposeVal = findVal(kv, "expose externally", "expose", "external");
  tier.expose = toBool(exposeVal);
  if (tier.expose) {
    tier.hostname = findVal(kv, "hostname", "public hostname", "host");
    tier.tls = findVal(kv, "tls") || null;
  }

  // Security
  tier.security.runAsNonRoot = toBool(findVal(kv, "run as non-root", "run as non root", "runasnonroot"));
  tier.security.readOnlyRootFs = toBool(findVal(kv, "read-only root filesystem", "read only root filesystem", "readonlyrootfilesystem", "readonly root"));
  tier.security.dropCapabilities = toBool(findVal(kv, "drop capabilities", "drop all capabilities", "dropcapabilities"));

  // Depends on
  const dep = findVal(kv, "depends on", "dependson", "dependencies");
  if (dep) tier.dependsOn = dep.split(",").map((s) => s.trim()).filter(Boolean);

  // Scan sub-sections for env vars, probes, init SQL, reverse proxy
  for (let j = idx + 1; j < allSections.length && j < idx + 8; j++) {
    const sub = allSections[j];
    if (sub.level <= sec.level && sub.heading && j > idx) break;
    if (consumed) consumed.add(j);
    const sh = (sub.heading || "").toLowerCase();

    // Environment Variables
    if (sh.includes("environment") || sh.includes("env var")) {
      for (const table of sub.tables) {
        const headers = (table.headers || []).map((h) => h.toLowerCase());
        for (const row of table.rows) {
          const name = findRowVal(row, headers, "name");
          const value = findRowVal(row, headers, "value");
          const fromSecret = findRowVal(row, headers, "from secret", "fromsecret", "secret");
          const secretKey = findRowVal(row, headers, "secret key", "secretkey", "key");
          if (name) {
            const ev = { name };
            if (fromSecret) { ev.fromSecret = fromSecret; ev.secretKey = secretKey || name; }
            else if (value) { ev.value = value; }
            tier.envVars.push(ev);
          }
        }
      }
    }

    // Health Probes
    if (sh.includes("probe") || sh.includes("health")) {
      for (const table of sub.tables) {
        const headers = (table.headers || []).map((h) => h.toLowerCase());
        for (const row of table.rows) {
          const probeType = (findRowVal(row, headers, "probe") || "").toLowerCase();
          const type = (findRowVal(row, headers, "type") || "http").toLowerCase();
          const path = findRowVal(row, headers, "path");
          const command = findRowVal(row, headers, "command");
          const port = toInt(findRowVal(row, headers, "port")) || tier.port;
          const initialDelay = toInt(findRowVal(row, headers, "initial delay", "initialdelay")) || 10;
          const period = toInt(findRowVal(row, headers, "period")) || 10;

          const probe = { type: type === "httpget" ? "http" : type, path, command, port, initialDelay, period };

          if (probeType.includes("liveness") || probeType === "liveness") {
            tier.probes.liveness = probe;
          }
          if (probeType.includes("readiness") || probeType === "readiness") {
            tier.probes.readiness = probe;
          }
        }
      }
    }

    // Init SQL
    if (sh.includes("init") && sh.includes("sql")) {
      tier.initSql = sub.content ? sub.content.trim() : null;
    }

    // Reverse Proxy
    if (sh.includes("reverse proxy") || sh.includes("proxy")) {
      for (const table of sub.tables) {
        const headers = (table.headers || []).map((h) => h.toLowerCase());
        for (const row of table.rows) {
          const path = findRowVal(row, headers, "path");
          const upstream = findRowVal(row, headers, "upstream", "backend");
          if (path || upstream) {
            tier.reverseProxy = { path: path || "/*", upstream: upstream || "" };
          }
        }
      }
    }
  }

  return tier;
}

function extractNetworkPolicies(sec, intent) {
  for (const table of sec.tables) {
    const headers = (table.headers || []).map((h) => h.toLowerCase());
    for (const row of table.rows) {
      const from = findRowVal(row, headers, "from", "source");
      const to = findRowVal(row, headers, "to", "destination", "target");
      const port = toInt(findRowVal(row, headers, "port"));
      const protocol = findRowVal(row, headers, "protocol") || "TCP";
      const allowed = toBool(findRowVal(row, headers, "allowed", "allow"));
      if (from && to) {
        intent.networkPolicies.push({ from, to, port, protocol, allowed });
      }
    }
  }
}

function extractValidationTests(sec, intent) {
  for (const table of sec.tables) {
    const headers = (table.headers || []).map((h) => h.toLowerCase());
    for (const row of table.rows) {
      const desc = findRowVal(row, headers, "description", "test", "check");
      const cmd = findRowVal(row, headers, "command", "cmd");
      const expected = findRowVal(row, headers, "expected", "result", "expected result");
      if (desc) {
        intent.validationTests.push({ description: desc, command: cmd || "", expected: expected || "" });
      }
    }
  }
}

function extractRollbackCriteria(sec, intent) {
  if (sec.content) {
    const lines = sec.content.split(/\n|•|●|▪/).map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
    intent.rollbackCriteria.push(...lines);
  }
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------
function flattenKV(tables) {
  const kv = {};
  for (const table of tables || []) {
    if (!table.headers || table.headers.length < 2) continue;
    const fIdx = table.headers.findIndex((h) => /field|key|property|parameter|name/i.test(h));
    const vIdx = table.headers.findIndex((h) => /value|data|setting/i.test(h));
    const fi = fIdx >= 0 ? fIdx : 0;
    const vi = vIdx >= 0 ? vIdx : 1;
    for (const row of table.rows) {
      const key = (row[table.headers[fi]] || "").toLowerCase().trim();
      const val = (row[table.headers[vi]] || "").trim();
      if (key) kv[key] = val;
    }
  }
  return kv;
}

function findVal(kv, ...candidates) {
  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (kv[cl]) return kv[cl];
    for (const [k, v] of Object.entries(kv)) {
      if (k.includes(cl) || cl.includes(k)) return v;
    }
  }
  return null;
}

function findRowVal(row, headers, ...candidates) {
  for (const c of candidates) {
    const cl = c.toLowerCase();
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].includes(cl) || cl.includes(headers[i])) {
        const key = Object.keys(row)[i] || headers[i];
        const val = row[key];
        if (val !== undefined && val !== "") return val;
      }
    }
  }
  return null;
}

function toInt(val) {
  if (!val) return null;
  const n = parseInt(String(val), 10);
  return isNaN(n) ? null : n;
}

function toBool(val) {
  if (!val) return false;
  return /^(yes|true|1|y)$/i.test(String(val).trim());
}

function inferRole(heading) {
  const h = heading.toLowerCase();
  if (h.includes("database") || h.includes("postgres") || h.includes("mysql") || h.includes("mongo") || h.includes("redis") || h.includes("sql")) return "database";
  if (h.includes("frontend") || h.includes("web") || h.includes("nginx") || h.includes("ui") || h.includes("static")) return "frontend";
  return "app";
}

// ---------------------------------------------------------------------------
// Chunked multi-pass LLM extraction — breaks doc into small sections,
// processes each in parallel, then merges results. Avoids timeout on large docs.
// ---------------------------------------------------------------------------
async function extractWithChunkedLLM(parsedDoc, providerOpts) {
  const chunks = chunkSections(parsedDoc.sections, 1500);
  console.log("[ais-extractor] Chunked LLM: " + chunks.length + " chunks from " + parsedDoc.sections.length + " sections");

  const llmOpts = buildLLMOpts(providerOpts);

  const CHUNK_PROMPT = `You are analyzing ONE section of a deployment document. Extract any deployment information you find into a JSON object. Include ONLY fields present in this section. Possible fields:
- appName, description, environment, targetPlatform, namespace, deployOrder
- tier: {name, role, image, replicas:{min,max}, port, protocol, resources:{cpuReq,cpuLim,memReq,memLim}, envVars:[{name,value?,fromSecret?,secretKey?}], storage:{size,mountPath,storageClass,accessMode}, probes:{liveness,readiness}, expose, hostname, tls, dependsOn, initSql, security:{runAsNonRoot,readOnlyRootFs,dropCapabilities}}
- secret: {name, keys, usedBy}
- configMap: {name, data:{}, usedBy}
- networkPolicy: {from, to, port, protocol, allowed}
- validationTest: {description, command, expected}
- rollbackCriteria: [strings]
Return ONLY valid JSON. If this section has no deployment info, return {}.

SECTION:
`;

  // Process chunks in parallel (max 4 concurrent)
  const partials = [];
  const batchSize = 4;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(chunk => callLLM({
        messages: [
          { role: "system", content: "Return ONLY valid compact JSON. No markdown." },
          { role: "user", content: CHUNK_PROMPT + chunk },
        ],
        maxTokens: 2048,
        maxRetries: 1,
        ...llmOpts,
      }))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        const text = typeof r.value === "string" ? r.value : (r.value?.text || r.value?.content || "");
        try {
          const parsed = tryParseJSON(text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""));
          if (parsed && Object.keys(parsed).length > 0) partials.push(parsed);
        } catch { /* skip unparseable chunks */ }
      }
    }
  }

  if (partials.length === 0) {
    // Last resort: try single call with full doc
    console.log("[ais-extractor] Chunked extraction yielded no results, trying single LLM call");
    return extractWithLLM(parsedDoc, providerOpts);
  }

  // Merge partial results
  const intent = mergePartialIntents(partials);

  // If merge is too sparse, use LLM to finalize
  if (intent.tiers.length === 0) {
    console.log("[ais-extractor] Merged intent has no tiers, trying single LLM call");
    return extractWithLLM(parsedDoc, providerOpts);
  }

  const missingFields = validateAIS(intent);
  const confidence = calculateConfidence(intent, missingFields);
  console.log("[ais-extractor] Chunked LLM extraction complete:", intent.tiers.length, "tiers, confidence:", confidence);
  return { intent, missingFields, confidence };
}

function chunkSections(sections, maxTokens) {
  const chunks = [];
  let current = "";
  let currentTokens = 0;

  for (const sec of sections) {
    const text = formatSectionForLLM(sec);
    const tokens = Math.ceil(text.split(/\s+/).length * 1.3);

    if (currentTokens + tokens > maxTokens && current) {
      chunks.push(current);
      current = "";
      currentTokens = 0;
    }

    current += text + "\n\n";
    currentTokens += tokens;
  }

  if (current.trim()) chunks.push(current);
  return chunks;
}

function formatSectionForLLM(sec) {
  const lines = [];
  if (sec.heading) lines.push("#".repeat(Math.min(sec.level || 1, 4)) + " " + sec.heading);
  if (sec.content) lines.push(sec.content);
  for (const table of sec.tables) {
    if (table.headers?.length > 0) {
      lines.push("| " + table.headers.join(" | ") + " |");
      lines.push("| " + table.headers.map(() => "---").join(" | ") + " |");
      for (const row of table.rows) {
        lines.push("| " + table.headers.map((h) => row[h] || "").join(" | ") + " |");
      }
    }
  }
  return lines.join("\n");
}

function mergePartialIntents(partials) {
  const intent = {
    appName: null,
    description: null,
    environment: null,
    targetPlatform: null,
    namespace: null,
    tiers: [],
    sharedSecrets: [],
    configMaps: [],
    networkPolicies: [],
    deployOrder: [],
    validationTests: [],
    rollbackCriteria: [],
  };

  const seenTiers = new Set();
  const seenSecrets = new Set();
  const seenConfigMaps = new Set();

  for (const p of partials) {
    if (p.appName && !intent.appName) intent.appName = p.appName;
    if (p.description && !intent.description) intent.description = p.description;
    if (p.environment && !intent.environment) intent.environment = p.environment;
    if (p.targetPlatform && !intent.targetPlatform) intent.targetPlatform = p.targetPlatform;
    if (p.namespace && !intent.namespace) intent.namespace = p.namespace;
    if (p.deployOrder?.length && intent.deployOrder.length === 0) intent.deployOrder = p.deployOrder;

    // Single tier from a chunk
    if (p.tier && p.tier.name && !seenTiers.has(p.tier.name)) {
      seenTiers.add(p.tier.name);
      intent.tiers.push(p.tier);
    }
    // Array of tiers
    if (Array.isArray(p.tiers)) {
      for (const t of p.tiers) {
        if (t.name && !seenTiers.has(t.name)) {
          seenTiers.add(t.name);
          intent.tiers.push(t);
        }
      }
    }

    // Secrets
    if (p.secret && p.secret.name && !seenSecrets.has(p.secret.name)) {
      seenSecrets.add(p.secret.name);
      intent.sharedSecrets.push({ ...p.secret, autoGenerate: true });
    }
    if (Array.isArray(p.sharedSecrets)) {
      for (const s of p.sharedSecrets) {
        if (s.name && !seenSecrets.has(s.name)) {
          seenSecrets.add(s.name);
          intent.sharedSecrets.push({ ...s, autoGenerate: true });
        }
      }
    }

    // ConfigMaps
    if (p.configMap && p.configMap.name && !seenConfigMaps.has(p.configMap.name)) {
      seenConfigMaps.add(p.configMap.name);
      intent.configMaps.push(p.configMap);
    }
    if (Array.isArray(p.configMaps)) {
      for (const cm of p.configMaps) {
        if (cm.name && !seenConfigMaps.has(cm.name)) {
          seenConfigMaps.add(cm.name);
          intent.configMaps.push(cm);
        }
      }
    }

    // Network policies
    if (Array.isArray(p.networkPolicies)) {
      intent.networkPolicies.push(...p.networkPolicies);
    }
    if (p.networkPolicy) {
      intent.networkPolicies.push(p.networkPolicy);
    }

    // Validation tests
    if (Array.isArray(p.validationTests)) {
      intent.validationTests.push(...p.validationTests);
    }
    if (p.validationTest) {
      intent.validationTests.push(p.validationTest);
    }

    // Rollback criteria
    if (Array.isArray(p.rollbackCriteria)) {
      intent.rollbackCriteria.push(...p.rollbackCriteria);
    }
  }

  // Infer deploy order
  if (intent.deployOrder.length === 0 && intent.tiers.length > 0) {
    const db = intent.tiers.filter((t) => t.role === "database").map((t) => t.name);
    const app = intent.tiers.filter((t) => t.role === "app").map((t) => t.name);
    const fe = intent.tiers.filter((t) => t.role === "frontend").map((t) => t.name);
    intent.deployOrder = [...db, ...app, ...fe];
  }

  return intent;
}

function buildLLMOpts(providerOpts) {
  const config = loadConfig();
  const llmOpts = {};
  if (config.llm) {
    if (config.llm.provider) llmOpts.provider = config.llm.provider;
    if (config.llm.apiKey) llmOpts.apiKey = config.llm.apiKey;
    if (config.llm.apiUrl) llmOpts.apiUrl = config.llm.apiUrl;
    if (config.llm.model) llmOpts.model = config.llm.model;
  }
  if (providerOpts.provider) llmOpts.provider = providerOpts.provider;
  if (providerOpts.apiKey) llmOpts.apiKey = providerOpts.apiKey;
  if (providerOpts.apiUrl) llmOpts.apiUrl = providerOpts.apiUrl;
  if (providerOpts.model) llmOpts.model = providerOpts.model;
  if (providerOpts.azureDeployment) llmOpts.azureDeployment = providerOpts.azureDeployment;
  if (providerOpts.azureApiVersion) llmOpts.azureApiVersion = providerOpts.azureApiVersion;
  return llmOpts;
}

// ---------------------------------------------------------------------------
// LLM fallback (only used for freeform/prose documents)
// ---------------------------------------------------------------------------
async function extractWithLLM(parsedDoc, providerOpts) {
  const PROMPT = `Parse this deployment document into a JSON object with these fields:
- appName, description, environment, targetPlatform, namespace
- tiers: [{name, role, image, replicas:{min,max}, port, protocol, resources:{cpuReq,cpuLim,memReq,memLim}, envVars:[{name,value?,fromSecret?,secretKey?}], storage:{size,mountPath,storageClass,accessMode}|null, probes, expose, hostname?, tls?, dependsOn:[], initSql?, security:{runAsNonRoot,readOnlyRootFs,dropCapabilities}}]
- sharedSecrets, configMaps, networkPolicies, deployOrder, validationTests, rollbackCriteria
Return ONLY valid JSON.\n\nDOCUMENT:\n`;

  const docText = formatDocForLLM(parsedDoc);

  const llmOpts = buildLLMOpts(providerOpts);

  const result = await callLLM({
    messages: [
      { role: "system", content: "Return ONLY valid compact JSON." },
      { role: "user", content: PROMPT + docText },
    ],
    maxTokens: 4096,
    maxRetries: 1,
    ...llmOpts,
  });

  const response = typeof result === "string" ? result : (result?.text || result?.content || "");
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");

  let intent;
  try { intent = tryParseJSON(cleaned); }
  catch (err) { throw new Error("Failed to parse LLM response as JSON: " + err.message); }

  const missingFields = validateAIS(intent);
  const confidence = calculateConfidence(intent, missingFields);
  return { intent, missingFields, confidence };
}

function tryParseJSON(text) {
  try { return JSON.parse(text); }
  catch (firstErr) {
    let fixed = text;
    const opens = { "{": 0, "[": 0 };
    let inString = false, escape = false;
    for (const ch of fixed) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") opens["{"]++;
      if (ch === "}") opens["{"]--;
      if (ch === "[") opens["["]++;
      if (ch === "]") opens["["]--;
    }
    if (inString) fixed += '"';
    while (opens["["] > 0) { fixed += "]"; opens["["]--; }
    while (opens["{"] > 0) { fixed += "}"; opens["{"]--; }
    try { return JSON.parse(fixed); }
    catch { throw firstErr; }
  }
}

function formatDocForLLM(parsedDoc) {
  const lines = [];
  for (const sec of parsedDoc.sections) {
    if (sec.heading) lines.push("#".repeat(Math.min(sec.level || 1, 4)) + " " + sec.heading);
    if (sec.content) lines.push(sec.content);
    for (const table of sec.tables) {
      if (table.headers?.length > 0) {
        lines.push("| " + table.headers.join(" | ") + " |");
        lines.push("| " + table.headers.map(() => "---").join(" | ") + " |");
        for (const row of table.rows) {
          lines.push("| " + table.headers.map((h) => row[h] || "").join(" | ") + " |");
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateAIS(intent) {
  const missing = [];
  if (!intent.appName) missing.push("appName — what is the application called?");
  if (!intent.namespace) missing.push("namespace — which K8s namespace to deploy into?");
  if (!intent.targetPlatform) missing.push("targetPlatform — which platform (openshift/eks/gke/aks/k8s)?");

  if (!Array.isArray(intent.tiers) || intent.tiers.length === 0) {
    missing.push("tiers — no application tiers/components found in the document");
    return missing;
  }

  for (const tier of intent.tiers) {
    const p = `tier[${tier.name || "?"}]`;
    if (!tier.name) missing.push(`${p}.name — component name is required`);
    if (!tier.image) missing.push(`${p}.image — container image is required`);
    if (!tier.port) missing.push(`${p}.port — listening port is required`);
    if (!tier.role) missing.push(`${p}.role — must be frontend, app, or database`);
    if (!tier.resources) missing.push(`${p}.resources — CPU/memory requests and limits`);
  }

  const dbTiers = intent.tiers.filter((t) => t.role === "database");
  for (const db of dbTiers) {
    if (!db.storage) missing.push(`tier[${db.name}].storage — databases typically need persistent storage`);
  }

  const exposed = intent.tiers.filter((t) => t.expose);
  for (const exp of exposed) {
    if (!exp.hostname) missing.push(`tier[${exp.name}].hostname — exposed tiers need a hostname`);
  }

  if (!intent.deployOrder || intent.deployOrder.length === 0) {
    missing.push("deployOrder — specify the order to deploy tiers (databases first)");
  }

  return missing;
}

function calculateConfidence(intent, missingFields) {
  const totalFields = 10 + (intent.tiers || []).length * 8;
  const filled = totalFields - missingFields.length;
  return Math.round((filled / totalFields) * 100);
}

// The deterministic extractor alone — no LLM fallback. Callers that have
// their own free-prose path (the Generate Manifests API) use this to decide
// whether the document follows the structured grammar before spending tokens.
export { extractDeterministic, validateAIS, calculateConfidence };
