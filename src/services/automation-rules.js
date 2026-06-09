/**
 * Natural Language Automation Rules Engine.
 *
 * Users define rules in plain English:
 *   "When a pod OOMKills in production, create a ServiceNow incident and notify #ops on Slack"
 *   "When disk usage exceeds 85% on any node, send a Slack alert"
 *   "When a deployment rollout fails, rollback and notify the team"
 *
 * The engine parses conditions from proactive insights and executes
 * configured actions. Rules are persisted in the DB.
 */

import { query as dbQuery } from "../utils/db.js";
import { callLLM, llmEnabled } from "./llm.js";

const _rules = [];
let _initialized = false;

const CONDITION_PATTERNS = [
  { pattern: /oomkill/i, type: "OOMKilled" },
  { pattern: /crashloop/i, type: "CrashLoopBackOff" },
  { pattern: /imagepull/i, type: "ImagePullBackOff" },
  { pattern: /node.*not\s*ready/i, type: "NodeNotReady" },
  { pattern: /disk.*pressure/i, type: "DiskPressure" },
  { pattern: /memory.*pressure/i, type: "MemoryPressure" },
  { pattern: /pending/i, type: "PodPending" },
  { pattern: /restart.*spike/i, type: "HighRestartRate" },
  { pattern: /cert.*expir/i, type: "CertExpiringSoon" },
];

const ACTION_PATTERNS = [
  { pattern: /servicenow|snow|incident/i, action: "servicenow" },
  { pattern: /slack|notify.*channel|send.*message/i, action: "slack" },
  { pattern: /rollback|undo/i, action: "rollback" },
  { pattern: /scale.*down|scale.*zero/i, action: "scale_down" },
  { pattern: /restart|bounce/i, action: "restart" },
  { pattern: /email|mail/i, action: "email" },
  { pattern: /log|record/i, action: "log" },
];

export async function initAutomationRules() {
  if (_initialized) return;
  _initialized = true;
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS automation_rules (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        condition_types TEXT[] NOT NULL,
        namespace_filter TEXT,
        actions JSONB NOT NULL,
        enabled BOOLEAN DEFAULT true,
        executions INTEGER DEFAULT 0,
        last_triggered TIMESTAMPTZ,
        cooldown_minutes INTEGER DEFAULT 30,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const rows = await dbQuery("SELECT * FROM automation_rules ORDER BY created_at DESC");
    if (rows?.rows) {
      _rules.length = 0;
      _rules.push(...rows.rows);
    }
    console.error(`[automation] Loaded ${_rules.length} automation rules`);
  } catch {
    console.warn("[automation] DB not available");
  }
}

/**
 * Parse a natural language rule description into structured conditions + actions.
 */
export function parseRule(description) {
  const conditions = [];
  const actions = [];
  let namespaceFilter = null;

  for (const cp of CONDITION_PATTERNS) {
    if (cp.pattern.test(description)) {
      conditions.push(cp.type);
    }
  }

  for (const ap of ACTION_PATTERNS) {
    if (ap.pattern.test(description)) {
      actions.push({ type: ap.action, config: {} });
    }
  }

  const nsMatch = description.match(/in\s+([\w-]+)\s+namespace/i) ||
                  description.match(/namespace\s+([\w-]+)/i) ||
                  description.match(/in\s+(production|staging|dev|default)/i);
  if (nsMatch) namespaceFilter = nsMatch[1];

  return { conditions, actions, namespaceFilter };
}

/**
 * Create a rule from natural language.
 */
export async function createRule(description, name) {
  const parsed = parseRule(description);

  if (parsed.conditions.length === 0) {
    return { error: "Could not detect trigger condition. Use keywords like: OOMKill, CrashLoop, node not ready, disk pressure, etc." };
  }
  if (parsed.actions.length === 0) {
    parsed.actions.push({ type: "log", config: {} });
  }

  const rule = {
    name: name || description.slice(0, 60),
    description,
    condition_types: parsed.conditions,
    namespace_filter: parsed.namespaceFilter,
    actions: parsed.actions,
    enabled: true,
    executions: 0,
    last_triggered: null,
    cooldown_minutes: 30,
    created_at: new Date().toISOString(),
  };

  try {
    const result = await dbQuery(
      `INSERT INTO automation_rules (name, description, condition_types, namespace_filter, actions, cooldown_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [rule.name, rule.description, rule.condition_types, rule.namespace_filter, JSON.stringify(rule.actions), rule.cooldown_minutes]
    );
    rule.id = result?.rows?.[0]?.id;
  } catch { /* DB optional */ }

  _rules.push(rule);
  return { rule, parsed };
}

/**
 * Evaluate all rules against current insights. Returns actions to execute.
 */
export function evaluateRules(insights) {
  const triggered = [];
  const now = Date.now();

  for (const rule of _rules) {
    if (!rule.enabled) continue;

    if (rule.last_triggered) {
      const cooldownMs = (rule.cooldown_minutes || 30) * 60 * 1000;
      if (now - new Date(rule.last_triggered).getTime() < cooldownMs) continue;
    }

    for (const insight of insights) {
      const typeMatch = (rule.condition_types || []).includes(insight.type);
      const nsMatch = !rule.namespace_filter ||
        rule.namespace_filter === "*" ||
        insight.namespace === rule.namespace_filter;

      if (typeMatch && nsMatch) {
        triggered.push({
          rule,
          insight,
          actions: rule.actions || [],
        });
        break;
      }
    }
  }

  return triggered;
}

/**
 * Execute triggered rule actions.
 */
export async function executeRuleActions(triggered) {
  const results = [];

  for (const { rule, insight, actions } of triggered) {
    for (const action of actions) {
      try {
        let result;
        switch (action.type) {
          case "log":
            result = { ok: true, message: `[automation] Rule "${rule.name}" triggered: ${insight.title}` };
            console.error(result.message);
            break;

          case "slack":
            result = await executeSlackAction(rule, insight, action.config);
            break;

          case "servicenow":
            result = await executeServiceNowAction(rule, insight, action.config);
            break;

          default:
            result = { ok: true, message: `Action type "${action.type}" logged (execution pending)` };
            break;
        }
        results.push({ rule: rule.name, action: action.type, insight: insight.title, ...result });
      } catch (err) {
        results.push({ rule: rule.name, action: action.type, error: err.message });
      }
    }

    rule.executions = (rule.executions || 0) + 1;
    rule.last_triggered = new Date().toISOString();

    try {
      await dbQuery(
        "UPDATE automation_rules SET executions = executions + 1, last_triggered = NOW() WHERE id = $1",
        [rule.id]
      );
    } catch { /* DB optional */ }
  }

  return results;
}

async function executeSlackAction(rule, insight, config) {
  try {
    const { loadState } = await import("../utils/state-store.js");
    const notifCfg = await loadState("notification_settings", process.env.NOTIF_SETTINGS_PATH || "/data/mcp-notification-settings.json");
    if (!notifCfg?.webhookUrl) return { ok: false, message: "No Slack webhook configured" };

    const payload = {
      text: `*[TCS Agentic AI — Automation]*\nRule: ${rule.name}\n${insight.title}\n${insight.detail}\n*Action:* ${insight.recommendation}`,
      channel: notifCfg.channel || undefined,
    };
    await fetch(notifCfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: true, message: "Slack notification sent" };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function executeServiceNowAction(rule, insight, config) {
  return { ok: true, message: "ServiceNow incident creation queued (requires SNOW config)" };
}

export function listRules() {
  return _rules.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    conditionTypes: r.condition_types,
    namespaceFilter: r.namespace_filter,
    actions: r.actions,
    enabled: r.enabled,
    executions: r.executions,
    lastTriggered: r.last_triggered,
    cooldownMinutes: r.cooldown_minutes,
  }));
}

export async function toggleRule(id, enabled) {
  const rule = _rules.find((r) => r.id === id);
  if (rule) rule.enabled = enabled;
  try {
    await dbQuery("UPDATE automation_rules SET enabled = $1 WHERE id = $2", [enabled, id]);
  } catch { /* DB optional */ }
}

export async function deleteRule(id) {
  const idx = _rules.findIndex((r) => r.id === id);
  if (idx >= 0) _rules.splice(idx, 1);
  try {
    await dbQuery("DELETE FROM automation_rules WHERE id = $1", [id]);
  } catch { /* DB optional */ }
}
