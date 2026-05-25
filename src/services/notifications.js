import { randomUUID } from "node:crypto";
import { query as dbQuery } from "../utils/db.js";

const KV_KEY = "notification_channels";
const VALID_TYPES = ["slack", "teams", "webhook"];
const VALID_EVENTS = [
  "compliance_drop",
  "slo_breach",
  "change_detected",
  "rca_critical",
  "policy_violation",
];
const SEVERITY_LEVELS = ["info", "warning", "critical"];
const RATE_LIMIT_MS = 5 * 60 * 1000;
const HISTORY_MAX = 100;
const FETCH_TIMEOUT_MS = 5000;

let _channels = [];
const _history = [];
const _rateLimitMap = new Map();

async function persist() {
  try {
    await dbQuery(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [KV_KEY, JSON.stringify(_channels)]
    );
  } catch (err) {
    console.error("[notifications] persist failed:", err.message);
  }
}

function validateChannel(def) {
  if (!def.name || typeof def.name !== "string") {
    throw new Error("Channel name is required");
  }
  if (!VALID_TYPES.includes(def.type)) {
    throw new Error(`Invalid channel type: ${def.type}. Must be one of: ${VALID_TYPES.join(", ")}`);
  }
  if (!def.url || typeof def.url !== "string") {
    throw new Error("Channel url is required");
  }
  if (def.events) {
    for (const e of def.events) {
      if (!VALID_EVENTS.includes(e)) {
        throw new Error(`Invalid event type: ${e}. Must be one of: ${VALID_EVENTS.join(", ")}`);
      }
    }
  }
  if (def.filters?.minSeverity && !SEVERITY_LEVELS.includes(def.filters.minSeverity)) {
    throw new Error(`Invalid severity: ${def.filters.minSeverity}. Must be one of: ${SEVERITY_LEVELS.join(", ")}`);
  }
}

function severityIndex(sev) {
  const idx = SEVERITY_LEVELS.indexOf(sev);
  return idx === -1 ? 0 : idx;
}

function matchesChannel(channel, event) {
  if (!channel.enabled) return false;

  if (channel.events?.length && !channel.events.includes(event.type)) {
    return false;
  }

  if (channel.filters?.minSeverity) {
    if (severityIndex(event.severity) < severityIndex(channel.filters.minSeverity)) {
      return false;
    }
  }

  if (channel.filters?.namespaces?.length && !channel.filters.namespaces.includes("*")) {
    if (event.namespace && !channel.filters.namespaces.includes(event.namespace)) {
      return false;
    }
  }

  return true;
}

function isRateLimited(channelId, eventType) {
  const key = `${channelId}:${eventType}`;
  const last = _rateLimitMap.get(key);
  if (last && Date.now() - last < RATE_LIMIT_MS) return true;
  _rateLimitMap.set(key, Date.now());
  return false;
}

function addToHistory(entry) {
  _history.unshift(entry);
  if (_history.length > HISTORY_MAX) _history.length = HISTORY_MAX;
}

function severityColor(severity) {
  switch (severity) {
    case "critical": return "#dc3545";
    case "warning": return "#ffc107";
    default: return "#17a2b8";
  }
}

function buildSlackPayload(event) {
  const fields = [
    { type: "mrkdwn", text: `*Event:*\n${event.type}` },
    { type: "mrkdwn", text: `*Severity:*\n${event.severity || "info"}` },
  ];
  if (event.namespace) {
    fields.push({ type: "mrkdwn", text: `*Namespace:*\n${event.namespace}` });
  }

  return {
    attachments: [
      {
        color: severityColor(event.severity),
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*${event.title}*` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: event.message },
          },
          {
            type: "section",
            fields,
          },
        ],
        fallback: `${event.title}: ${event.message}`,
      },
    ],
  };
}

function buildTeamsPayload(event) {
  const facts = [
    { name: "Event", value: event.type },
    { name: "Severity", value: event.severity || "info" },
  ];
  if (event.namespace) {
    facts.push({ name: "Namespace", value: event.namespace });
  }

  return {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: severityColor(event.severity).replace("#", ""),
    summary: event.title,
    sections: [
      {
        activityTitle: event.title,
        activitySubtitle: new Date().toISOString(),
        facts,
        text: event.message,
        markdown: true,
      },
    ],
  };
}

function buildWebhookPayload(event) {
  return {
    event: event.type,
    severity: event.severity || "info",
    title: event.title,
    message: event.message,
    details: event.details || null,
    timestamp: new Date().toISOString(),
  };
}

async function sendToChannel(channel, event) {
  let payload;
  switch (channel.type) {
    case "slack":
      payload = buildSlackPayload(event);
      break;
    case "teams":
      payload = buildTeamsPayload(event);
      break;
    case "webhook":
      payload = buildWebhookPayload(event);
      break;
    default:
      return { success: false, error: `Unknown channel type: ${channel.type}` };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const resp = await fetch(channel.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { success: false, error: `HTTP ${resp.status}: ${body}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function loadChannels() {
  try {
    const res = await dbQuery("SELECT value FROM kv_store WHERE key = $1", [KV_KEY]);
    const stored = res?.rows?.[0]?.value;
    if (Array.isArray(stored)) {
      _channels = stored;
    }
  } catch (err) {
    console.error("[notifications] loadChannels failed:", err.message);
  }
  return _channels;
}

export function getChannels() {
  return _channels;
}

export async function createChannel(channelDef) {
  validateChannel(channelDef);

  const channel = {
    id: randomUUID(),
    name: channelDef.name,
    type: channelDef.type,
    url: channelDef.url,
    enabled: channelDef.enabled !== false,
    events: channelDef.events || [...VALID_EVENTS],
    filters: {
      minSeverity: channelDef.filters?.minSeverity || "warning",
      namespaces: channelDef.filters?.namespaces || ["*"],
    },
    createdAt: new Date().toISOString(),
  };

  _channels.push(channel);
  await persist();
  return channel;
}

export async function updateChannel(id, updates) {
  const idx = _channels.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Channel not found: ${id}`);

  const merged = { ..._channels[idx], ...updates, id };
  if (updates.filters) {
    merged.filters = { ..._channels[idx].filters, ...updates.filters };
  }

  validateChannel(merged);
  _channels[idx] = merged;
  await persist();
  return merged;
}

export async function deleteChannel(id) {
  const idx = _channels.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Channel not found: ${id}`);

  const removed = _channels.splice(idx, 1)[0];
  await persist();
  return removed;
}

export async function testChannel(id) {
  const channel = _channels.find((c) => c.id === id);
  if (!channel) throw new Error(`Channel not found: ${id}`);

  const testEvent = {
    type: "compliance_drop",
    severity: "info",
    title: "Test Notification",
    message: "This is a test notification from the Kubernetes MCP server.",
    details: { test: true },
    namespace: "default",
  };

  const result = await sendToChannel(channel, testEvent);
  addToHistory({
    channelId: channel.id,
    channelName: channel.name,
    event: testEvent,
    result,
    sentAt: new Date().toISOString(),
    test: true,
  });

  return result;
}

export async function notify(event) {
  if (!event?.type || !event?.title || !event?.message) {
    throw new Error("Event must include type, title, and message");
  }

  const results = [];

  for (const channel of _channels) {
    if (!matchesChannel(channel, event)) continue;
    if (isRateLimited(channel.id, event.type)) {
      results.push({
        channelId: channel.id,
        channelName: channel.name,
        skipped: true,
        reason: "rate_limited",
      });
      continue;
    }

    const result = await sendToChannel(channel, event);

    addToHistory({
      channelId: channel.id,
      channelName: channel.name,
      event,
      result,
      sentAt: new Date().toISOString(),
      test: false,
    });

    results.push({
      channelId: channel.id,
      channelName: channel.name,
      ...result,
    });
  }

  return results;
}

export function getNotificationHistory() {
  return _history;
}
