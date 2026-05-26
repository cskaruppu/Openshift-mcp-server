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

const EXTRACTION_PROMPT = `You are an expert Kubernetes deployment architect. Parse the following document into a structured Application Intent Schema (AIS) JSON.

CRITICAL RULES:
1. Extract EVERY field from the document. Use the exact values specified.
2. For container images, use the exact image:tag specified. Do NOT invent images.
3. For environment variables referencing secrets, set fromSecret and secretKey instead of value.
4. deployOrder must respect dependsOn relationships (databases first, then app, then frontend).
5. If a field is not specified in the document, set it to null — do NOT guess.
6. For resources, keep the exact units (m for millicores, Mi/Gi for memory).
7. For each tier, set role to exactly: "database", "app", or "frontend".
8. For storage, only include if explicitly mentioned. Database tiers typically need storage.
9. Port numbers must be integers, not strings.
10. TLS value should be "edge", "passthrough", "reencrypt", or null.

Return ONLY valid JSON matching this schema:
{
  "appName": "string",
  "description": "string",
  "environment": "string (dev/staging/production)",
  "targetPlatform": "string (openshift/eks/gke/aks/k8s/rancher)",
  "namespace": "string",
  "tiers": [{
    "name": "component-name",
    "role": "frontend|app|database",
    "image": "registry/org/image:tag",
    "replicas": { "min": 1, "max": 1 },
    "port": 8080,
    "protocol": "TCP",
    "resources": { "cpuReq": "100m", "cpuLim": "500m", "memReq": "256Mi", "memLim": "1Gi" },
    "envVars": [
      { "name": "ENV_NAME", "value": "literal_value" },
      { "name": "SECRET_VAR", "fromSecret": "secret-name", "secretKey": "key" }
    ],
    "storage": { "size": "10Gi", "mountPath": "/data", "storageClass": "default", "accessMode": "ReadWriteOnce" } or null,
    "probes": {
      "liveness": { "type": "http|tcp|exec", "path": "/healthz", "port": 8080, "command": null, "initialDelay": 30, "period": 10 },
      "readiness": { "type": "http|tcp|exec", "path": "/ready", "port": 8080, "command": null, "initialDelay": 5, "period": 5 }
    },
    "expose": false,
    "hostname": null,
    "tls": null,
    "reverseProxy": null or { "path": "/api/*", "upstream": "http://service:port" },
    "dependsOn": ["other-tier-name"],
    "initSql": null or "CREATE TABLE ...",
    "security": { "runAsNonRoot": true, "readOnlyRootFs": false, "dropCapabilities": true }
  }],
  "sharedSecrets": [{ "name": "secret-name", "keys": ["username", "password"], "usedBy": ["tier1", "tier2"], "autoGenerate": true }],
  "configMaps": [{ "name": "cm-name", "data": { "KEY": "value" }, "usedBy": ["tier1"] }],
  "networkPolicies": [
    { "from": "internet", "to": "frontend", "port": 443, "protocol": "TCP", "allowed": true },
    { "from": "frontend", "to": "app", "port": 3000, "protocol": "TCP", "allowed": true },
    { "from": "frontend", "to": "database", "port": 5432, "protocol": "TCP", "allowed": false }
  ],
  "deployOrder": ["database-name", "app-name", "frontend-name"],
  "validationTests": [{ "description": "Health check", "command": "curl http://hostname/healthz", "expected": "200 OK" }],
  "rollbackCriteria": ["Any tier fails to become Ready within timeout"]
}

DOCUMENT CONTENT:
`;

/**
 * Extract AIS from parsed document.
 * @param {object} parsedDoc - Output from doc-parser (sections + rawText)
 * @returns {{ intent: object, missingFields: string[], confidence: number }}
 */
export async function extractAIS(parsedDoc) {
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

  const result = await callLLM({
    messages: [
      { role: "system", content: "You are a Kubernetes deployment specification parser. Return only valid JSON, no markdown fences, no explanation." },
      { role: "user", content: userPrompt },
    ],
    ...llmOpts,
  });

  const response = typeof result === "string" ? result : (result?.text || result?.content || "");

  let intent;
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    intent = JSON.parse(cleaned);
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
