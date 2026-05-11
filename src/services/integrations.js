/**
 * Integration Hooks (Pillar 5).
 *
 * Lightweight outbound integrations:
 *   - Slack (webhook-based)
 *   - Microsoft Teams (webhook-based)
 *   - Generic webhook (for PagerDuty, custom systems)
 *   - Prometheus (PromQL query proxy)
 *   - ServiceNow (already wired in dashboard-api.js — we just call it)
 *
 * Configuration is stored in the existing kv_store table under
 * key "integrations.config" so admins can configure via UI.
 *
 * All sends are fire-and-forget; failures are logged but never throw.
 */

import { query, isEnabled } from "../utils/db.js";

const CONFIG_KEY = "integrations.config";

// ---------------------------------------------------------------------------
// Config storage (uses existing kv_store table)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  slack: { enabled: false, webhookUrl: "", channel: "#alerts", username: "TCS Agentic AI" },
  teams: { enabled: false, webhookUrl: "" },
  webhook: { enabled: false, url: "", secret: "" },
  prometheus: { enabled: false, url: "", bearerToken: "" },
  pagerduty: { enabled: false, integrationKey: "" },
};

let _cachedConfig = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 60_000;

export async function getIntegrationsConfig() {
  if (_cachedConfig && Date.now() < _cacheExpiry) return _cachedConfig;
  if (!(await isEnabled())) {
    _cachedConfig = { ...DEFAULT_CONFIG };
    _cacheExpiry = Date.now() + CACHE_TTL_MS;
    return _cachedConfig;
  }
  try {
    const res = await query("SELECT value FROM kv_store WHERE key = $1", [CONFIG_KEY]);
    const stored = res?.rows?.[0]?.value || {};
    _cachedConfig = mergeConfig(DEFAULT_CONFIG, stored);
    _cacheExpiry = Date.now() + CACHE_TTL_MS;
    return _cachedConfig;
  } catch (err) {
    return { ...DEFAULT_CONFIG };
  }
}

export async function setIntegrationsConfig(updates) {
  const current = await getIntegrationsConfig();
  const merged = mergeConfig(current, updates);
  if (await isEnabled()) {
    try {
      await query(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [CONFIG_KEY, JSON.stringify(merged)]
      );
    } catch (err) {
      console.error("[integrations] save failed:", err.message);
    }
  }
  _cachedConfig = merged;
  _cacheExpiry = Date.now() + CACHE_TTL_MS;
  return merged;
}

function mergeConfig(base, override) {
  const result = { ...base };
  for (const key of Object.keys(base)) {
    if (override[key] && typeof override[key] === "object") {
      result[key] = { ...base[key], ...override[key] };
    }
  }
  return result;
}

// Redacted config for /api/integrations GET — never expose secrets
export function redactConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.slack?.webhookUrl) out.slack.webhookUrl = redactSecret(out.slack.webhookUrl);
  if (out.teams?.webhookUrl) out.teams.webhookUrl = redactSecret(out.teams.webhookUrl);
  if (out.webhook?.secret) out.webhook.secret = "***";
  if (out.webhook?.url) out.webhook.url = redactSecret(out.webhook.url);
  if (out.prometheus?.bearerToken) out.prometheus.bearerToken = "***";
  if (out.pagerduty?.integrationKey) out.pagerduty.integrationKey = "***";
  return out;
}

function redactSecret(url) {
  if (!url) return "";
  // Keep host and last 4 chars of path
  try {
    const u = new URL(url);
    return u.protocol + "//" + u.host + "/...***" + url.slice(-4);
  } catch {
    return url.slice(0, 10) + "...***";
  }
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export async function sendSlackMessage({ text, blocks, severity, title, namespace, cluster }) {
  const cfg = await getIntegrationsConfig();
  if (!cfg.slack?.enabled || !cfg.slack?.webhookUrl) {
    return { sent: false, reason: "Slack not configured" };
  }

  const sevEmoji = { critical: ":rotating_light:", high: ":warning:", medium: ":large_orange_diamond:", low: ":information_source:" };
  const emoji = sevEmoji[severity?.toLowerCase()] || ":robot_face:";

  const payload = blocks ? { blocks, channel: cfg.slack.channel, username: cfg.slack.username }
    : {
        channel: cfg.slack.channel,
        username: cfg.slack.username,
        text: `${emoji} *${title || "TCS Agentic AI Alert"}*${cluster ? ` · cluster ${cluster}` : ""}${namespace ? ` · ns ${namespace}` : ""}\n${text || ""}`,
      };

  try {
    const r = await fetch(cfg.slack.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { sent: r.ok, status: r.status };
  } catch (err) {
    console.error("[integrations.slack] failed:", err.message);
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Microsoft Teams
// ---------------------------------------------------------------------------

export async function sendTeamsMessage({ text, title, severity }) {
  const cfg = await getIntegrationsConfig();
  if (!cfg.teams?.enabled || !cfg.teams?.webhookUrl) {
    return { sent: false, reason: "Teams not configured" };
  }

  const colors = { critical: "ff0000", high: "ff8800", medium: "ffcc00", low: "0066cc" };
  const themeColor = colors[severity?.toLowerCase()] || "5f4e99";

  const card = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor,
    summary: title || "TCS Agentic AI Alert",
    title: title || "TCS Agentic AI Alert",
    text: text || "",
  };

  try {
    const r = await fetch(cfg.teams.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
    return { sent: r.ok, status: r.status };
  } catch (err) {
    console.error("[integrations.teams] failed:", err.message);
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// PagerDuty (Events API v2)
// ---------------------------------------------------------------------------

export async function sendPagerDutyAlert({ summary, severity, source, customDetails }) {
  const cfg = await getIntegrationsConfig();
  if (!cfg.pagerduty?.enabled || !cfg.pagerduty?.integrationKey) {
    return { sent: false, reason: "PagerDuty not configured" };
  }

  const payload = {
    routing_key: cfg.pagerduty.integrationKey,
    event_action: "trigger",
    payload: {
      summary: summary || "TCS Agentic AI Event",
      severity: ["critical", "error", "warning", "info"].includes(severity) ? severity : "warning",
      source: source || "tcs-agentic-ai",
      custom_details: customDetails || {},
    },
  };

  try {
    const r = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    return { sent: r.ok, status: r.status, dedupKey: data.dedup_key };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Generic webhook (HMAC-signed)
// ---------------------------------------------------------------------------

import crypto from "crypto";

export async function sendWebhook({ event, payload }) {
  const cfg = await getIntegrationsConfig();
  if (!cfg.webhook?.enabled || !cfg.webhook?.url) {
    return { sent: false, reason: "Webhook not configured" };
  }
  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    payload,
  });
  const headers = { "Content-Type": "application/json" };
  if (cfg.webhook.secret) {
    const sig = crypto.createHmac("sha256", cfg.webhook.secret).update(body).digest("hex");
    headers["X-Signature-256"] = "sha256=" + sig;
  }
  try {
    const r = await fetch(cfg.webhook.url, { method: "POST", headers, body });
    return { sent: r.ok, status: r.status };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Prometheus query proxy
// ---------------------------------------------------------------------------

export async function queryPrometheus(promql, { range, step } = {}) {
  const cfg = await getIntegrationsConfig();
  if (!cfg.prometheus?.enabled || !cfg.prometheus?.url) {
    return { ok: false, error: "Prometheus not configured" };
  }
  const base = cfg.prometheus.url.replace(/\/$/, "");
  const headers = {};
  if (cfg.prometheus.bearerToken) headers.Authorization = "Bearer " + cfg.prometheus.bearerToken;

  let url;
  if (range && range.start && range.end) {
    const params = new URLSearchParams({
      query: promql,
      start: String(Math.floor(new Date(range.start).getTime() / 1000)),
      end: String(Math.floor(new Date(range.end).getTime() / 1000)),
      step: String(step || "60s"),
    });
    url = `${base}/api/v1/query_range?${params}`;
  } else {
    url = `${base}/api/v1/query?query=${encodeURIComponent(promql)}`;
  }

  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: true, data: data.data, status: data.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Convenience: notify all configured integrations (multi-channel broadcast)
// ---------------------------------------------------------------------------

export async function notifyAll({ title, text, severity, namespace, cluster, customDetails }) {
  // Feature flag: master switch for outbound notifications
  try {
    const ff = await import("./feature-flags.js");
    if (!ff.flags.pillar5Notifications()) {
      return { disabled: true, reason: "Pillar 5 notifications disabled via feature flag" };
    }
  } catch { /* feature flags unavailable, allow */ }

  const results = {};
  await Promise.all([
    sendSlackMessage({ title, text, severity, namespace, cluster }).then((r) => { results.slack = r; }),
    sendTeamsMessage({ title, text, severity }).then((r) => { results.teams = r; }),
    sendPagerDutyAlert({ summary: title || text, severity, source: cluster, customDetails })
      .then((r) => { results.pagerduty = r; }),
    sendWebhook({ event: "notification", payload: { title, text, severity, namespace, cluster } })
      .then((r) => { results.webhook = r; }),
  ]);
  return results;
}

// ---------------------------------------------------------------------------
// Connection test helpers (no message sent — just verifies reachability)
// ---------------------------------------------------------------------------

export async function testConnection(type) {
  const cfg = await getIntegrationsConfig();
  switch (type) {
    case "slack":
      return cfg.slack.enabled
        ? sendSlackMessage({ title: "Connection Test", text: "TCS Agentic AI is now connected to this channel.", severity: "low" })
        : { sent: false, reason: "Slack not enabled" };
    case "teams":
      return cfg.teams.enabled
        ? sendTeamsMessage({ title: "Connection Test", text: "TCS Agentic AI is now connected.", severity: "low" })
        : { sent: false, reason: "Teams not enabled" };
    case "webhook":
      return cfg.webhook.enabled
        ? sendWebhook({ event: "test", payload: { message: "TCS Agentic AI test event" } })
        : { sent: false, reason: "Webhook not enabled" };
    case "pagerduty":
      return cfg.pagerduty.enabled
        ? sendPagerDutyAlert({ summary: "TCS Agentic AI Test", severity: "info", source: "tcs-agentic-ai" })
        : { sent: false, reason: "PagerDuty not enabled" };
    case "prometheus":
      return cfg.prometheus.enabled
        ? queryPrometheus("up")
        : { ok: false, error: "Prometheus not enabled" };
    default:
      return { error: "Unknown integration type: " + type };
  }
}
