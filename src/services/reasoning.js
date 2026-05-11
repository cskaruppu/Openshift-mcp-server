/**
 * Reasoning Engine (Pillar 2).
 *
 * Provides chain-of-thought transparency: every chat request can attach a
 * reasoning trace describing what tools were considered, which were called,
 * and how the final answer was synthesized.
 *
 * This is a LIGHTWEIGHT orchestrator — it doesn't replace the existing chat
 * routing in chat-api.js. Instead, it wraps it to capture the decision
 * sequence so the UI can show "here's how I thought about this question".
 *
 * Two main concepts:
 *   - Trace: an ordered list of reasoning steps for a single request
 *   - Confidence: a self-reported number per step (0..1) so the UI can
 *     highlight low-confidence answers and prompt the user for clarification.
 *
 * EU AI Act readiness: traces are persistable and exportable.
 */

import { query, isEnabled } from "../utils/db.js";

const TRACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS reasoning_traces (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,
  request_text TEXT,
  trace JSONB NOT NULL,
  final_confidence REAL,
  decision_path TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reasoning_conv ON reasoning_traces(conversation_id, created_at DESC);
`;

let _schemaEnsured = false;
async function ensureTraceSchema() {
  if (_schemaEnsured) return;
  if (!(await isEnabled())) return;
  try {
    await query(TRACE_SCHEMA);
    _schemaEnsured = true;
  } catch (err) {
    console.error("[reasoning] schema init failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// ReasoningTrace builder — used inline by chat-api.js when reasoning is on
// ---------------------------------------------------------------------------

export class ReasoningTrace {
  constructor({ conversationId, request } = {}) {
    this.conversationId = conversationId || null;
    this.request = String(request || "");
    this.steps = [];
    this.startedAt = Date.now();
    this.finalConfidence = null;
    this.decisionPath = null;
  }

  /**
   * Record a reasoning step.
   * @param {object} step
   * @param {string} step.kind - "observe" | "decide" | "tool" | "compose" | "verify"
   * @param {string} step.summary - one-line summary
   * @param {string} [step.detail] - longer rationale
   * @param {object} [step.evidence] - data the step looked at
   * @param {number} [step.confidence] - 0..1
   */
  add(step) {
    this.steps.push({
      kind: step.kind || "observe",
      summary: step.summary || "",
      detail: step.detail || null,
      evidence: step.evidence || null,
      confidence: typeof step.confidence === "number" ? step.confidence : null,
      timestamp: Date.now() - this.startedAt,
    });
    return this;
  }

  setFinalConfidence(c) {
    if (typeof c === "number") this.finalConfidence = Math.max(0, Math.min(1, c));
    return this;
  }

  setDecisionPath(path) {
    this.decisionPath = String(path || "");
    return this;
  }

  durationMs() {
    return Date.now() - this.startedAt;
  }

  toJSON() {
    return {
      conversationId: this.conversationId,
      request: this.request,
      steps: this.steps,
      finalConfidence: this.finalConfidence,
      decisionPath: this.decisionPath,
      durationMs: this.durationMs(),
    };
  }

  /** Render the trace as a chat-renderable @@REASONING|json@@ tag. */
  toTag() {
    return "@@REASONING|" + JSON.stringify(this.toJSON()).replace(/@@/g, "@ @") + "@@";
  }

  async persist() {
    await ensureTraceSchema();
    if (!(await isEnabled())) return;
    try {
      await query(
        `INSERT INTO reasoning_traces
         (conversation_id, request_text, trace, final_confidence, decision_path, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          this.conversationId,
          this.request.slice(0, 1000),
          JSON.stringify(this.toJSON()),
          this.finalConfidence,
          this.decisionPath,
          this.durationMs(),
        ]
      );
    } catch (err) {
      // silent
    }
  }
}

// ---------------------------------------------------------------------------
// Confidence-aware fallback: if final confidence is below threshold,
// rewrite the response to surface uncertainty and offer clarification.
// ---------------------------------------------------------------------------

const LOW_CONFIDENCE_THRESHOLD = 0.4;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.65;

export function annotateLowConfidence(reply, trace) {
  if (!trace || typeof trace.finalConfidence !== "number") return reply;
  const c = trace.finalConfidence;
  if (c >= MEDIUM_CONFIDENCE_THRESHOLD) return reply;

  if (c < LOW_CONFIDENCE_THRESHOLD) {
    return `> **Low confidence answer (${Math.round(c * 100)}%)** — I'm not sure I understood the question correctly. Please clarify what you'd like me to do, or pick from these options:\n\n${reply}\n\n*If this isn't what you wanted, try rephrasing or use a slash command like \`/security\`, \`/recommendations\`, or \`/plan <goal>\`.*`;
  }
  return `> **Medium confidence (${Math.round(c * 100)}%)** — Here's my best answer:\n\n${reply}`;
}

// ---------------------------------------------------------------------------
// Convenience: build a default reasoning trace from an NLU parse result
// ---------------------------------------------------------------------------

export function traceFromNluParse(parse, request, conversationId) {
  const t = new ReasoningTrace({ conversationId, request });

  // Step 1: Observation
  t.add({
    kind: "observe",
    summary: `Parsed request as ${parse.intent || "unknown"} intent on ${parse.resource || "no resource"}`,
    detail: parse.namespace ? `Namespace context: ${parse.namespace}` : null,
    evidence: {
      intent: parse.intent,
      resource: parse.resource,
      scope: parse.scope,
      filter: parse.filter,
      name: parse.name,
      namespace: parse.namespace,
    },
    confidence: parse.confidence,
  });

  // Step 2: Constraints (if any from Pillar 1)
  if (parse.constraints) {
    t.add({
      kind: "observe",
      summary: `Detected constraints: ${Object.keys(parse.constraints).join(", ")}`,
      evidence: parse.constraints,
      confidence: 0.9,
    });
  }

  // Step 3: Goal hint (if any from Pillar 1)
  if (parse.goalHint) {
    t.add({
      kind: "decide",
      summary: `Multi-step goal detected: ${parse.goalHint} — consider /plan command`,
      confidence: 0.7,
    });
  }

  // Step 4: Persona hint
  if (parse.personaHint) {
    t.add({
      kind: "observe",
      summary: `User language suggests persona: ${parse.personaHint}`,
      confidence: 0.6,
    });
  }

  t.setFinalConfidence(parse.confidence || 0.5);
  return t;
}

// ---------------------------------------------------------------------------
// Recent traces — for UI history view
// ---------------------------------------------------------------------------

export async function getRecentTraces({ conversationId, limit = 20 } = {}) {
  await ensureTraceSchema();
  if (!(await isEnabled())) return [];
  const params = [Math.min(100, Math.max(1, limit))];
  let where = "";
  if (conversationId) {
    params.push(conversationId);
    where = `WHERE conversation_id = $${params.length}`;
  }
  try {
    const res = await query(
      `SELECT id, conversation_id, request_text, trace, final_confidence,
              decision_path, duration_ms, created_at
       FROM reasoning_traces ${where} ORDER BY id DESC LIMIT $1`,
      params
    );
    return res?.rows || [];
  } catch (err) {
    return [];
  }
}
