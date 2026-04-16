/**
 * LLM fallback for the NLU parser.
 *
 * When the deterministic parser returns low-confidence (< threshold), we ask
 * the LLM to classify the intent using a tight JSON schema. Result is merged
 * back into the same {intent, resource, name, namespace, filter, allNs}
 * shape so downstream handlers don't care which path was taken.
 */

import { classifyJSON, llmEnabled } from "./llm.js";

const CONFIDENCE_FLOOR = parseFloat(process.env.NLU_LLM_THRESHOLD || "0.45");

const SCHEMA_PROMPT = `Parse the user's OpenShift question into JSON with fields:
{
  "intent": "list|get|logs|top|delete|update|create|run|help|diagnose|unknown",
  "resource": "pod|deployment|service|configmap|secret|statefulset|daemonset|replicaset|job|cronjob|pvc|pv|ingress|route|node|namespace|project|clusteroperator|event|null",
  "name": "resource-name or null",
  "namespace": "namespace or null",
  "filter": "CrashLoopBackOff|ImagePullBackOff|OOMKilled|CreateContainerConfigError|Pending|Failed|Evicted|null",
  "allNs": true/false
}

Examples:
User: "why is the web pod broken in prod"
Output: {"intent":"diagnose","resource":"pod","name":"web","namespace":"prod","filter":null,"allNs":false}

User: "how many pods?"
Output: {"intent":"list","resource":"pod","name":null,"namespace":null,"filter":null,"allNs":true}

Respond with ONLY the JSON object.`;

/**
 * Classify an ambiguous message via the LLM.
 * Returns the parsed shape, or null on failure (caller falls back to local).
 */
export async function classifyWithLLM(message, llmOpts = {}) {
  if (!llmEnabled(llmOpts)) return null;
  const r = await classifyJSON({
    prompt: `User message: "${message}"\n\n${SCHEMA_PROMPT}`,
    system: "You are a strict NLU classifier. Output only valid JSON.",
    ...llmOpts,
  });
  if (!r || typeof r !== "object") return null;
  // Normalize — map nulls, coerce booleans
  return {
    intent: r.intent || "unknown",
    resource: r.resource || null,
    name: r.name || null,
    namespace: r.namespace || null,
    filter: r.filter || null,
    allNs: !!r.allNs,
    scope: null,
    options: {},
    confidence: 0.7,
    raw: message,
    _llmFallback: true,
  };
}

/**
 * Enhance a locally-parsed result with LLM classification if confidence is
 * below the floor. Never overrides a high-confidence local parse.
 */
export async function maybeEnhance(parsed, message, llmOpts = {}) {
  if (!parsed || parsed.confidence >= CONFIDENCE_FLOOR) return parsed;
  const enhanced = await classifyWithLLM(message, llmOpts);
  if (!enhanced) return parsed;
  // Merge — prefer local non-null values, fill in gaps from LLM
  return {
    intent: parsed.intent !== "unknown" ? parsed.intent : enhanced.intent,
    resource: parsed.resource || enhanced.resource,
    name: parsed.name || enhanced.name,
    namespace: parsed.namespace || enhanced.namespace,
    filter: parsed.filter || enhanced.filter,
    allNs: parsed.allNs || enhanced.allNs,
    scope: parsed.scope,
    options: parsed.options || {},
    confidence: Math.max(parsed.confidence, enhanced.confidence),
    raw: parsed.raw,
    _llmFallback: true,
  };
}
