/**
 * Notifications & ChatOps Tools
 *
 * Pushes alerts and reports to Slack, Microsoft Teams, and PagerDuty.
 * All endpoints are configured via environment variables — tools never accept
 * raw URLs from arguments to avoid SSRF.
 *
 * Env:
 *   SLACK_WEBHOOK_URL          - default Slack incoming webhook
 *   TEAMS_WEBHOOK_URL          - default MS Teams incoming webhook
 *   PAGERDUTY_ROUTING_KEY      - PagerDuty Events API v2 routing key
 *   NOTIFY_DEFAULT_CHANNEL     - one of: slack | teams | pagerduty
 */

import { z } from "zod";
import { listFiringAlerts } from "../services/alertmanager.js";
import { getLatestHealthReport } from "../services/scheduler.js";

const SEVERITY_EMOJI = {
  critical: ":rotating_light:",
  high: ":fire:",
  warning: ":warning:",
  info: ":information_source:",
  low: ":white_check_mark:",
};

const SEVERITY_TEAMS_COLOR = {
  critical: "FF0000",
  high: "E74C3C",
  warning: "F39C12",
  info: "3498DB",
  low: "2ECC71",
};

const PAGERDUTY_SEVERITY_MAP = {
  critical: "critical",
  high: "error",
  warning: "warning",
  info: "info",
  low: "info",
};

// ---------------------------------------------------------------------------
// Channel transports
// ---------------------------------------------------------------------------

async function sendSlack({ webhookUrl, title, message, severity = "info", fields = [] }) {
  const url = webhookUrl || process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_WEBHOOK_URL not configured");

  const emoji = SEVERITY_EMOJI[severity] || SEVERITY_EMOJI.info;
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${title}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: message || "(no message)" },
    },
  ];

  if (fields.length) {
    blocks.push({
      type: "section",
      fields: fields.slice(0, 10).map((f) => ({
        type: "mrkdwn",
        text: `*${f.name}*\n${f.value}`,
      })),
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `OpenShift MCP • ${new Date().toISOString()}`,
      },
    ],
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `${emoji} ${title}`, blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
  }
  return { ok: true, channel: "slack", status: res.status };
}

async function sendTeams({ webhookUrl, title, message, severity = "info", fields = [] }) {
  const url = webhookUrl || process.env.TEAMS_WEBHOOK_URL;
  if (!url) throw new Error("TEAMS_WEBHOOK_URL not configured");

  const themeColor = SEVERITY_TEAMS_COLOR[severity] || SEVERITY_TEAMS_COLOR.info;
  const facts = fields.slice(0, 20).map((f) => ({ name: f.name, value: String(f.value) }));

  const card = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor,
    summary: title,
    title,
    text: message || "",
    sections: facts.length
      ? [
          {
            facts,
            markdown: true,
          },
        ]
      : [],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    throw new Error(`Teams webhook returned ${res.status}: ${await res.text()}`);
  }
  return { ok: true, channel: "teams", status: res.status };
}

async function sendPagerDuty({
  routingKey,
  title,
  message,
  severity = "warning",
  source = "openshift-mcp",
  dedupKey,
  customDetails = {},
  action = "trigger",
}) {
  const key = routingKey || process.env.PAGERDUTY_ROUTING_KEY;
  if (!key) throw new Error("PAGERDUTY_ROUTING_KEY not configured");

  const pdSeverity = PAGERDUTY_SEVERITY_MAP[severity] || "warning";
  const payload = {
    routing_key: key,
    event_action: action,
    dedup_key: dedupKey,
    payload: {
      summary: title,
      severity: pdSeverity,
      source,
      custom_details: { message, ...customDetails },
    },
  };

  const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`PagerDuty Events API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, channel: "pagerduty", status: res.status, dedupKey: body.dedup_key };
}

async function dispatch(channel, payload) {
  switch (channel) {
    case "slack":     return sendSlack(payload);
    case "teams":     return sendTeams(payload);
    case "pagerduty": return sendPagerDuty(payload);
    default:          throw new Error(`Unsupported channel: ${channel}`);
  }
}

function defaultChannel() {
  const c = (process.env.NOTIFY_DEFAULT_CHANNEL || "").toLowerCase();
  if (["slack", "teams", "pagerduty"].includes(c)) return c;
  if (process.env.SLACK_WEBHOOK_URL) return "slack";
  if (process.env.TEAMS_WEBHOOK_URL) return "teams";
  if (process.env.PAGERDUTY_ROUTING_KEY) return "pagerduty";
  return null;
}

function fmtAlert(a) {
  const labels = a.labels || {};
  const ann = a.annotations || {};
  return {
    name: labels.alertname || "Unknown",
    severity: labels.severity || "warning",
    namespace: labels.namespace || "-",
    summary: ann.summary || ann.description || "",
    startsAt: a.startsAt,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerNotificationTools(server) {
  // ---------- notify_send ----------
  server.tool(
    "notify_send",
    "Send a custom notification to Slack, Teams, or PagerDuty",
    {
      channel: z
        .enum(["slack", "teams", "pagerduty"])
        .optional()
        .describe("Target channel; defaults to NOTIFY_DEFAULT_CHANNEL or first configured"),
      title: z.string().describe("Short headline / subject"),
      message: z.string().optional().describe("Body of the notification (markdown supported on Slack/Teams)"),
      severity: z
        .enum(["critical", "high", "warning", "info", "low"])
        .optional()
        .default("info"),
      fields: z
        .array(z.object({ name: z.string(), value: z.string() }))
        .optional()
        .describe("Optional key/value pairs displayed below the message"),
      dedupKey: z.string().optional().describe("PagerDuty dedup key (only for pagerduty)"),
    },
    async ({ channel, title, message, severity, fields, dedupKey }) => {
      try {
        const ch = channel || defaultChannel();
        if (!ch) {
          return {
            content: [{ type: "text", text: "No notification channel configured. Set SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL, or PAGERDUTY_ROUTING_KEY." }],
            isError: true,
          };
        }
        const result = await dispatch(ch, {
          title,
          message,
          severity: severity || "info",
          fields: fields || [],
          dedupKey,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- notify_alerts ----------
  server.tool(
    "notify_alerts",
    "Forward currently firing Alertmanager alerts to a notification channel",
    {
      channel: z.enum(["slack", "teams", "pagerduty"]).optional(),
      severity: z
        .enum(["critical", "high", "warning", "info", "low"])
        .optional()
        .describe("Minimum severity to forward (default: warning)"),
      maxAlerts: z.number().int().min(1).max(50).optional().default(20),
    },
    async ({ channel, severity, maxAlerts }) => {
      try {
        const ch = channel || defaultChannel();
        if (!ch) {
          return { content: [{ type: "text", text: "No notification channel configured." }], isError: true };
        }

        const alerts = (await listFiringAlerts()) || [];
        const minSev = severity || "warning";
        const sevRank = { critical: 5, high: 4, warning: 3, info: 2, low: 1 };
        const threshold = sevRank[minSev] || 3;

        const filtered = alerts
          .map(fmtAlert)
          .filter((a) => (sevRank[a.severity] || 0) >= threshold)
          .slice(0, maxAlerts);

        if (!filtered.length) {
          return {
            content: [{ type: "text", text: `No firing alerts at severity >= ${minSev}` }],
          };
        }

        const top = filtered[0];
        const title = `${filtered.length} firing alert${filtered.length > 1 ? "s" : ""} (${minSev}+)`;
        const lines = filtered
          .map((a) => `• *${a.name}* [${a.severity}] ns=${a.namespace} — ${a.summary}`)
          .join("\n");

        const result = await dispatch(ch, {
          title,
          message: lines,
          severity: top.severity,
          fields: filtered.slice(0, 5).map((a) => ({ name: a.name, value: `${a.severity} • ${a.namespace}` })),
          dedupKey: `mcp-alerts-${minSev}`,
        });

        return {
          content: [
            { type: "text", text: JSON.stringify({ forwarded: filtered.length, ...result }, null, 2) },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- notify_health_report ----------
  server.tool(
    "notify_health_report",
    "Send the latest scheduled cluster health report to a notification channel",
    {
      channel: z.enum(["slack", "teams", "pagerduty"]).optional(),
    },
    async ({ channel }) => {
      try {
        const ch = channel || defaultChannel();
        if (!ch) {
          return { content: [{ type: "text", text: "No notification channel configured." }], isError: true };
        }

        const report = await getLatestHealthReport();
        if (!report) {
          return {
            content: [{ type: "text", text: "No health report available yet (scheduler may not have run)." }],
          };
        }

        const summary = report.summary || report.text || JSON.stringify(report).slice(0, 1500);
        const sev = report.severity || (report.healthy === false ? "warning" : "info");
        const fields = [];
        if (report.score != null) fields.push({ name: "Health Score", value: String(report.score) });
        if (report.nodesReady != null) fields.push({ name: "Nodes Ready", value: String(report.nodesReady) });
        if (report.alertCount != null) fields.push({ name: "Firing Alerts", value: String(report.alertCount) });
        if (report.timestamp) fields.push({ name: "Generated", value: report.timestamp });

        const result = await dispatch(ch, {
          title: "OpenShift Cluster Health Report",
          message: typeof summary === "string" ? summary : JSON.stringify(summary).slice(0, 1500),
          severity: sev,
          fields,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- notify_test ----------
  server.tool(
    "notify_test",
    "Send a test notification to verify a channel is correctly configured",
    {
      channel: z.enum(["slack", "teams", "pagerduty"]).optional(),
    },
    async ({ channel }) => {
      try {
        const ch = channel || defaultChannel();
        if (!ch) {
          return { content: [{ type: "text", text: "No notification channel configured." }], isError: true };
        }
        const result = await dispatch(ch, {
          title: "OpenShift MCP — Test Notification",
          message: "If you can read this, the channel is wired up correctly.",
          severity: "info",
          fields: [
            { name: "Source", value: "agentic-ai-server" },
            { name: "Time", value: new Date().toISOString() },
          ],
          dedupKey: "mcp-test",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- notify_pagerduty_resolve ----------
  server.tool(
    "notify_pagerduty_resolve",
    "Resolve a PagerDuty incident by dedup key",
    {
      dedupKey: z.string().describe("Dedup key used when triggering the incident"),
      title: z.string().optional().default("Resolved by OpenShift MCP"),
    },
    async ({ dedupKey, title }) => {
      try {
        const result = await sendPagerDuty({
          title: title || "Resolved by OpenShift MCP",
          severity: "info",
          dedupKey,
          action: "resolve",
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- notify_channels_status ----------
  server.tool(
    "notify_channels_status",
    "Show which notification channels are configured (does not send anything)",
    {},
    async () => {
      const status = {
        slack: !!process.env.SLACK_WEBHOOK_URL,
        teams: !!process.env.TEAMS_WEBHOOK_URL,
        pagerduty: !!process.env.PAGERDUTY_ROUTING_KEY,
        defaultChannel: defaultChannel(),
      };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
  );
}
