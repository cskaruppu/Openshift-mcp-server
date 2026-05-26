import { createHmac, timingSafeEqual } from "node:crypto";

const SLACK_SIG_VERSION = "v0";
const SLACK_SIG_MAX_AGE_SEC = 60 * 5;

function ephemeral(text, extra = {}) {
  return { response_type: "ephemeral", text, ...extra };
}

function inChannel(text, extra = {}) {
  return { response_type: "in_channel", text, ...extra };
}

function helpText() {
  return [
    "*Kubernetes ChatOps Commands*",
    "`/k8s help` - show this message",
    "`/k8s status` - cluster health summary",
    "`/k8s incidents` - list open incidents",
    "`/k8s ack <INC-ID>` - acknowledge an incident",
    "`/k8s alerts` - view active alerts",
  ].join("\n");
}

async function safeAudit(event) {
  try {
    const audit = await import("./audit-log.js");
    await audit.logAuditEvent(event);
  } catch (err) {
    console.error("[chatops] audit log failed:", err.message);
  }
}

async function handleStatus() {
  try {
    const hub = await import("./mcp-hub.js");
    if (typeof hub.getLiveState === "function") {
      const state = await hub.getLiveState();
      const summary = state?.summary || state?.clusterSummary || JSON.stringify(state).slice(0, 500);
      return ephemeral(`*Cluster Status*\n${summary}`);
    }
  } catch (_) {}
  return ephemeral("Cluster status: use `/api/health` for live state.");
}

async function handleIncidents() {
  try {
    const incidentMgr = await import("./incident-manager.js");
    const stats = typeof incidentMgr.getIncidentStats === "function"
      ? await incidentMgr.getIncidentStats({ days: 30 })
      : null;
    const open = await incidentMgr.listIncidents({ status: "open", limit: 10 });
    const list = Array.isArray(open) ? open : open?.incidents || [];

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "Open Incidents" },
      },
    ];

    if (stats) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Open:* ${stats.open ?? 0}  *Triaging:* ${stats.triaging ?? 0}  *Resolved (30d):* ${stats.resolved ?? 0}`,
        },
      });
    }

    if (!list.length) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No open incidents._" },
      });
    } else {
      for (const inc of list) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${inc.id}* - ${inc.title || "(untitled)"}\nSeverity: ${inc.severity || "n/a"} | Status: ${inc.status || "open"}`,
          },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Acknowledge" },
            value: `ack_incident:${inc.id}`,
            action_id: `ack_${inc.id}`,
          },
        });
      }
    }

    return ephemeral(`${list.length} open incident(s)`, { blocks });
  } catch (err) {
    return ephemeral(`Failed to list incidents: ${err.message}`);
  }
}

async function handleAck(args, userName) {
  const id = (args || "").trim().split(/\s+/)[0];
  if (!id) {
    return ephemeral("Usage: `/k8s ack <INC-ID>`");
  }
  try {
    const incidentMgr = await import("./incident-manager.js");
    const updated = await incidentMgr.updateIncident(
      id,
      { status: "triaging", assignee: userName },
      userName || "chatops"
    );
    await safeAudit({
      type: "action_taken",
      severity: "info",
      title: `Incident ${id} acknowledged via Slack`,
      username: userName,
      source: "slack",
      details: { incidentId: id, action: "ack" },
    });
    return inChannel(`Incident *${id}* acknowledged by <@${userName}>. Status: ${updated?.status || "triaging"}`);
  } catch (err) {
    return ephemeral(`Failed to acknowledge ${id}: ${err.message}`);
  }
}

function handleAlerts() {
  const base = process.env.DASHBOARD_URL || "http://localhost:3000";
  return ephemeral(`Use the dashboard to view alerts at ${base}/intelligence`);
}

export async function handleSlackSlashCommand(parsedBody) {
  const { text = "", user_name = "", user_id = "" } = parsedBody || {};
  const trimmed = text.trim();
  const [sub, ...rest] = trimmed.split(/\s+/);
  const args = rest.join(" ");
  const subcommand = (sub || "help").toLowerCase();

  await safeAudit({
    type: "action_taken",
    severity: "info",
    title: `Slack slash command: ${subcommand}`,
    username: user_name || user_id,
    source: "slack",
    details: { subcommand, args },
  });

  switch (subcommand) {
    case "help":
    case "":
      return ephemeral(helpText());
    case "status":
      return handleStatus();
    case "incidents":
      return handleIncidents();
    case "ack":
      return handleAck(args, user_name);
    case "alerts":
      return handleAlerts();
    default:
      return ephemeral(`Unknown command: \`${subcommand}\`. Try \`/k8s help\``);
  }
}

async function handleApproveAction(actionId, user) {
  try {
    const wf = await import("./action-workflow.js");
    const result = await wf.confirmAction(actionId);
    await safeAudit({
      type: "action_taken",
      severity: "info",
      title: `Action ${actionId} approved`,
      username: user,
      source: "slack",
      details: { actionId, decision: "approve" },
    });
    return ephemeral(`Action *${actionId}* approved. Status: ${result?.status || "confirmed"}`);
  } catch (err) {
    return ephemeral(`Failed to approve ${actionId}: ${err.message}`);
  }
}

async function handleRejectAction(actionId, user) {
  try {
    const wf = await import("./action-workflow.js");
    const result = await wf.cancelAction(actionId);
    await safeAudit({
      type: "action_taken",
      severity: "info",
      title: `Action ${actionId} rejected`,
      username: user,
      source: "slack",
      details: { actionId, decision: "reject" },
    });
    return ephemeral(`Action *${actionId}* rejected. Status: ${result?.status || "cancelled"}`);
  } catch (err) {
    return ephemeral(`Failed to reject ${actionId}: ${err.message}`);
  }
}

async function handleAckIncidentInteraction(incidentId, user) {
  try {
    const incidentMgr = await import("./incident-manager.js");
    const updated = await incidentMgr.updateIncident(
      incidentId,
      { status: "triaging", assignee: user },
      user || "chatops"
    );
    await safeAudit({
      type: "action_taken",
      severity: "info",
      title: `Incident ${incidentId} acknowledged`,
      username: user,
      source: "slack",
      details: { incidentId, action: "ack" },
    });
    return ephemeral(`Incident *${incidentId}* acknowledged. Status: ${updated?.status || "triaging"}`);
  } catch (err) {
    return ephemeral(`Failed to acknowledge ${incidentId}: ${err.message}`);
  }
}

export async function handleSlackInteraction(parsedPayload) {
  const payload = parsedPayload || {};
  const user = payload.user?.username || payload.user?.name || payload.user?.id || "unknown";
  const actions = Array.isArray(payload.actions) ? payload.actions : [];

  if (!actions.length) {
    return ephemeral("No action received.");
  }

  const action = actions[0];
  const value = action.value || action.action_id || "";
  const [kind, target] = value.includes(":") ? value.split(":", 2) : [value, ""];

  switch (kind) {
    case "approve_action":
      return handleApproveAction(target, user);
    case "reject_action":
      return handleRejectAction(target, user);
    case "ack_incident":
      return handleAckIncidentInteraction(target, user);
    default:
      return ephemeral(`Unknown interaction: \`${kind}\``);
  }
}

export async function handleTeamsAction(body) {
  const data = body || {};
  const action = data.action || data.actionId || "";
  const target = data.target || data.id || "";
  const user = data.user || data.from?.name || data.userId || "teams-user";

  try {
    switch (action) {
      case "approve_action": {
        const wf = await import("./action-workflow.js");
        const result = await wf.confirmAction(target);
        await safeAudit({
          type: "action_taken",
          severity: "info",
          title: `Action ${target} approved (Teams)`,
          username: user,
          source: "teams",
          details: { actionId: target, decision: "approve" },
        });
        return { success: true, status: result?.status || "confirmed" };
      }
      case "reject_action": {
        const wf = await import("./action-workflow.js");
        const result = await wf.cancelAction(target);
        await safeAudit({
          type: "action_taken",
          severity: "info",
          title: `Action ${target} rejected (Teams)`,
          username: user,
          source: "teams",
          details: { actionId: target, decision: "reject" },
        });
        return { success: true, status: result?.status || "cancelled" };
      }
      case "ack_incident": {
        const incidentMgr = await import("./incident-manager.js");
        const updated = await incidentMgr.updateIncident(
          target,
          { status: "triaging", assignee: user },
          user
        );
        await safeAudit({
          type: "action_taken",
          severity: "info",
          title: `Incident ${target} acknowledged (Teams)`,
          username: user,
          source: "teams",
          details: { incidentId: target, action: "ack" },
        });
        return { success: true, status: updated?.status || "triaging" };
      }
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function verifySlackSignature(rawBody, signature, timestamp, signingSecret) {
  if (!signingSecret) return true;
  if (!rawBody || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > SLACK_SIG_MAX_AGE_SEC) return false;

  const base = `${SLACK_SIG_VERSION}:${timestamp}:${rawBody}`;
  const expected = `${SLACK_SIG_VERSION}=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
