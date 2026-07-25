/**
 * Feature Flags — central on/off control for each agentic pillar.
 *
 * Every pillar can be disabled via an environment variable WITHOUT any
 * code changes. Failing safely: if any service depends on a disabled
 * feature it falls back to pre-pillar behavior.
 *
 * Env var format: PILLAR_<N>_<FEATURE> = "true" | "false"
 *
 * All flags DEFAULT TO ENABLED (true). Set to "false" or "0" to disable.
 *
 * Read pattern:
 *   import { flags } from "./feature-flags.js";
 *   if (flags.pillar6Telemetry()) { ... }
 *
 * Flags can also be read at runtime via GET /api/feature-flags so admins
 * can see the live state without inspecting the deployment env.
 */

function envFlag(name, defaultValue = true) {
  const v = process.env[name];
  if (v == null || v === "") return defaultValue;
  const s = String(v).toLowerCase().trim();
  if (s === "false" || s === "0" || s === "off" || s === "no") return false;
  if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
  return defaultValue;
}

export const flags = {
  // Pillar 1: Inject NLU-detected persona, constraints, goal hints into LLM context
  pillar1InjectContext: () => envFlag("PILLAR_1_INJECT_CONTEXT", true),

  // Pillar 2: Show reasoning trace by default in chat responses
  pillar2ReasoningDefault: () => envFlag("PILLAR_2_REASONING_DEFAULT", true),

  // Pillar 3: Auto-inject user preferences/facts into LLM system prompt
  pillar3AutoMemory: () => envFlag("PILLAR_3_AUTO_MEMORY", true),

  // Pillar 4: AI-driven plan generation (vs template-only)
  pillar4AiPlans: () => envFlag("PILLAR_4_AI_PLANS", true),

  // Pillar 5: Outbound notifications (Slack/Teams/PagerDuty/Webhook)
  pillar5Notifications: () => envFlag("PILLAR_5_NOTIFICATIONS", true),

  // Pillar 5 UI: Show integrations settings page
  pillar5Ui: () => envFlag("PILLAR_5_UI_ENABLED", true),

  // Pillar 6: Record LLM telemetry events
  pillar6Telemetry: () => envFlag("PILLAR_6_TELEMETRY", true),

  // Pillar 7: Enforce command classification + confirmation tokens
  pillar7Guardrails: () => envFlag("PILLAR_7_GUARDRAILS", true),

  // Pillar 7: Write audit log entries
  pillar7AuditLog: () => envFlag("PILLAR_7_AUDIT_LOG", true),

  // Autonomous incident detection (threshold evaluator + correlation).
  // Phase 1 is read-only SHADOW MODE: it surfaces the incidents that WOULD be
  // opened without raising tickets or remediating anything.
  incidentAutoDetect: () => envFlag("INCIDENT_AUTO_DETECT", true),

  // Master safety interlock for autonomous ACTION (ticket creation +
  // remediation). Stays OFF until thresholds have been validated in shadow
  // mode; Phase 1 never reads it as anything but a display value.
  incidentAutoAct: () => envFlag("INCIDENT_AUTO_ACT", false),
};

/** Snapshot of all flag states for the admin endpoint. */
export function snapshot() {
  return {
    pillar1_inject_context: flags.pillar1InjectContext(),
    pillar2_reasoning_default: flags.pillar2ReasoningDefault(),
    pillar3_auto_memory: flags.pillar3AutoMemory(),
    pillar4_ai_plans: flags.pillar4AiPlans(),
    pillar5_notifications: flags.pillar5Notifications(),
    pillar5_ui: flags.pillar5Ui(),
    pillar6_telemetry: flags.pillar6Telemetry(),
    pillar7_guardrails: flags.pillar7Guardrails(),
    pillar7_audit_log: flags.pillar7AuditLog(),
    incident_auto_detect: flags.incidentAutoDetect(),
    incident_auto_act: flags.incidentAutoAct(),
  };
}

/**
 * Build a human-readable summary table for the AI Hub Performance panel
 * showing which pillars are enabled vs disabled.
 */
export function summaryText() {
  const s = snapshot();
  const rows = [
    ["Pillar 1 — Understanding context injection", s.pillar1_inject_context],
    ["Pillar 2 — Reasoning trace by default", s.pillar2_reasoning_default],
    ["Pillar 3 — Auto memory injection", s.pillar3_auto_memory],
    ["Pillar 4 — AI plan generation", s.pillar4_ai_plans],
    ["Pillar 5 — Outbound notifications", s.pillar5_notifications],
    ["Pillar 5 UI — Integration settings", s.pillar5_ui],
    ["Pillar 6 — Telemetry recording", s.pillar6_telemetry],
    ["Pillar 7 — Command guardrails", s.pillar7_guardrails],
    ["Pillar 7 — Audit logging", s.pillar7_audit_log],
    ["Incident auto-detection (shadow mode)", s.incident_auto_detect],
    ["Incident autonomous action (ticket + remediate)", s.incident_auto_act],
  ];
  return rows.map(([label, on]) => `${on ? "[ON]" : "[OFF]"} ${label}`).join("\n");
}
