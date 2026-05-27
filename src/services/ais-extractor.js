/**
 * Application Intent Schema (AIS) Extractor
 * Takes parsed document sections and uses LLM to extract a structured
 * deployment intent, validates completeness, and returns missing fields.
 */

import { callLLM } from "./llm.js";
import { loadConfig } from "../utils/config.js";

const AIS_SCHEMA = {
  appName: "string",
  description: "string",
  environment: "string",
  targetPlatform: "string",
  namespace: "string",
  tiers: [
    {
      name: "string",
      role: "frontend|app|database",
      image: "string",
      replicas: { min: "number", max: "number" },
      port: "number",
      protocol: "string",
      resources: { cpuReq: "string", cpuLim: "string", memReq: "string", memLim: "string" },
      envVars: [{ name: "string", value: "string", fromSecret: "string?", secretKey: "string?" }],
      storage: { size: "string", mountPath: "string", storageClass: "string", accessMode: "string" },
      probes: {
        liveness: { type: "string", path: "string", port: "number", initialDelay: "number", period: "number" },
        readiness: { type: "string", path: "string", port: "number", initialDelay: "number", period: "number" },
      },
      expose: "boolean",
      hostname: "string?",
      tls: "string?",
      reverseProxy: { path: "string?", upstream: "string?" },
      dependsOn: ["string"],
      initSql: "string?",
      security: { runAsNonRoot: "boolean", readOnlyRootFs: "boolean", dropCapabilities: "boolean" },
    },
  ],
  sharedSecrets: [{ name: "string", keys: ["string"], usedBy: ["string"] }],
  configMaps: [{ name: "string", data: {}, usedBy: ["string"] }],
  networkPolicies: [{ from: "string", to: "string", port: "number", protocol: "string", allowed: "boolean" }],
  deployOrder: ["string"],
  validationTests: [{ description: "string", command: "string", expected: "string" }],
  rollbackCriteria: ["string"],
};

const EXTRACTION_PROMPT = `Parse this deployment document into a JSON object with these fields:
- appName, description, environment, targetPlatform, namespace
- tiers: array of {name, role("database"|"app"|"frontend"), image, replicas:{min,max}, port, protocol, resources:{cpuReq,cpuLim,memReq,memLim}, envVars:[{name,value?,fromSecret?,secretKey?}], storage:{size,mountPath,storageClass,accessMode}|null, probes:{liveness:{type,path?,command?,port,initialDelay,period},readiness:{...}}, expose(bool), hostname?, tls?, reverseProxy:{path,upstream}?, dependsOn:[], initSql?, security:{runAsNonRoot,readOnlyRootFs,dropCapabilities}}
- sharedSecrets: [{name, keys:[], usedBy:[], autoGenerate:bool}]
- configMaps: [{name, data:{}, usedBy:[]}]
- networkPolicies: [{from, to, port, protocol, allowed:bool}]
- deployOrder: [tier names in order]
- validationTests: [{description, command, expected}]
- rollbackCriteria: [strings]

Rules: use exact values from doc, integers for ports, null for unspecified fields. Return ONLY valid JSON.

DOCUMENT:
`;

/**
 * Extract AIS from parsed document.
 * @param {object} parsedDoc - Output from doc-parser (sections + rawText)
 * @returns {{ intent: object, missingFields: string[], confidence: number }}
 */
export async function extractAIS(parsedDoc, providerOpts = {}) {
  const docText = formatDocForLLM(parsedDoc);
  const userPrompt = EXTRACTION_PROMPT + docText;

  const config = loadConfig();
  const llmOpts = {};
  if (config.llm) {
    if (config.llm.provider) llmOpts.provider = config.llm.provider;
    if (config.llm.apiKey) llmOpts.apiKey = config.llm.apiKey;
    if (config.llm.apiUrl) llmOpts.apiUrl = config.llm.apiUrl;
    if (config.llm.model) llmOpts.model = config.llm.model;
  }
  // Dashboard-provided provider settings override config-file defaults
  if (providerOpts.provider) llmOpts.provider = providerOpts.provider;
  if (providerOpts.apiKey) llmOpts.apiKey = providerOpts.apiKey;
  if (providerOpts.apiUrl) llmOpts.apiUrl = providerOpts.apiUrl;
  if (providerOpts.model) llmOpts.model = providerOpts.model;
  if (providerOpts.azureDeployment) llmOpts.azureDeployment = providerOpts.azureDeployment;
  if (providerOpts.azureApiVersion) llmOpts.azureApiVersion = providerOpts.azureApiVersion;

  console.log("[ais-extractor] Starting extraction, provider:", llmOpts.provider, "prompt length:", userPrompt.length);

  const result = await callLLM({
    messages: [
      { role: "system", content: "You are a Kubernetes deployment specification parser. Return ONLY valid compact JSON, no markdown fences, no explanation, no trailing text." },
      { role: "user", content: userPrompt },
    ],
    maxTokens: 4096,
    maxRetries: 1,
    ...llmOpts,
  });

  console.log("[ais-extractor] LLM returned, response type:", typeof result, "text length:", (result?.text || "").length);

  const response = typeof result === "string" ? result : (result?.text || result?.content || "");

  let intent;
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    intent = tryParseJSON(cleaned);
  } catch (err) {
    throw new Error("Failed to parse LLM response as JSON: " + err.message);
  }

  const missingFields = validateAIS(intent);
  const confidence = calculateConfidence(intent, missingFields);

  return { intent, missingFields, confidence };
}

/**
 * Build AIS from structured text input (when user pastes specs in chat).
 */
export async function extractAISFromText(text) {
  const { parseMarkdownText } = await import("./doc-parser.js");
  const parsed = parseMarkdownText(text);
  return extractAIS(parsed);
}

/**
 * Try to parse JSON, with recovery for truncated responses.
 * Attempts to close unclosed brackets/braces to salvage partial output.
 */
function tryParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    let fixed = text;
    const opens = { "{": 0, "[": 0 };
    let inString = false;
    let escape = false;
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
    try {
      return JSON.parse(fixed);
    } catch {
      throw firstErr;
    }
  }
}

function formatDocForLLM(parsedDoc) {
  const lines = [];
  for (const sec of parsedDoc.sections) {
    if (sec.heading) {
      const prefix = "#".repeat(Math.min(sec.level || 1, 4));
      lines.push(`${prefix} ${sec.heading}`);
    }
    if (sec.content) lines.push(sec.content);
    for (const table of sec.tables) {
      if (table.headers && table.headers.length > 0) {
        lines.push("| " + table.headers.join(" | ") + " |");
        lines.push("| " + table.headers.map(() => "---").join(" | ") + " |");
        for (const row of table.rows) {
          const cells = table.headers.map((h) => row[h] || "");
          lines.push("| " + cells.join(" | ") + " |");
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

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
    const prefix = `tier[${tier.name || "?"}]`;
    if (!tier.name) missing.push(`${prefix}.name — component name is required`);
    if (!tier.image) missing.push(`${prefix}.image — container image is required`);
    if (!tier.port) missing.push(`${prefix}.port — listening port is required`);
    if (!tier.role) missing.push(`${prefix}.role — must be frontend, app, or database`);
    if (!tier.resources) missing.push(`${prefix}.resources — CPU/memory requests and limits`);
    if (!tier.replicas) missing.push(`${prefix}.replicas — replica count (min/max)`);
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

export { AIS_SCHEMA };
