/**
 * User & Access as tools for AI Chat and MCP clients: who can do something,
 * why someone has access, and what could be removed. Read-only: changes are
 * still requests approved in User & Access.
 */
import { z } from "zod";

const clustersNow = async () => {
  const AI = await import("../services/access-insights.js");
  const known = AI.lastResult()?.sum?.clusters?.map((c) => c.cluster);
  return known?.length ? known : ["local"];
};

export async function whoCan({ verb, resource, namespace = null, cluster = null }) {
  const UA = await import("../services/user-access.js");
  const cl = cluster ? [cluster] : await clustersNow();
  const out = {};
  for (const c of cl.slice(0, 10)) {
    try { out[c] = await UA.runOn(c, "who-can", { verb, resource, namespace, group: "" }, null); }
    catch (e) { out[c] = { error: e.message }; }
  }
  return { question: `who can ${verb} ${resource}${namespace ? ` in ${namespace}` : " cluster-wide"}`, answer: out };
}

export async function explainAccess({ user }) {
  const UA = await import("../services/user-access.js");
  const sum = await UA.summary(await clustersNow(), null);
  const p = sum.people.find((x) => x.name === user);
  if (!p) return { user, found: false, text: `${user} has no access on the clusters read.` };
  const reqs = sum.requests || [];
  const grants = Object.entries(p.clusters).flatMap(([c, gs]) => gs.map((g) => {
    const q = reqs.find((x) => x.kind === "grant" && x.user === user && x.role === g.role && (x.namespace || "cluster") === g.scope && x.clusters.includes(c) && ["done", "partly done"].includes(x.status));
    return { cluster: c, role: g.role, where: g.scope === "cluster" ? "whole cluster" : `namespace ${g.scope}`, how: g.via === "direct" ? "bound directly" : `member of group ${g.via}${g.synced ? " (synced from AD)" : ""}`, binding: g.binding?.name || null, by: q ? `${q.id}, approved by ${q.decidedBy} on ${String(q.decidedAt).slice(0, 10)}${q.reason ? ` (${q.reason})` : ""}` : g.binding?.managed ? "platform-managed" : "given outside the platform", ends: q?.expires || null };
  }));
  const AI = await import("../services/access-insights.js");
  const r = AI.lastResult()?.result;
  return { user, login: p.source, lastLogin: p.lastLogin, grants, risk: r?.identities.find((i) => i.name === user) || null, suggestions: (r?.suggestions || []).filter((s) => s.user === user).map((s) => ({ title: s.title, why: s.why, evidence: s.evidence })) };
}

export async function accessSuggestions({ kind = null } = {}) {
  const UA = await import("../services/user-access.js");
  const AI = await import("../services/access-insights.js");
  const res = await AI.insights(await UA.summary(await clustersNow(), null));
  return {
    auditLog: res.audit ? `${res.audit.source}, ${res.audit.days} days` : "not connected (suggestions from logins only)",
    kpis: res.kpis,
    suggestions: res.suggestions.filter((s) => !kind || s.kind === kind).slice(0, 30).map((s) => ({ user: s.user, clusters: s.clusters, action: s.title, why: s.why, evidence: s.evidence, riskReduction: s.delta })),
    alerts: res.alerts.filter((a) => a.status === "open").slice(0, 10).map((a) => ({ level: a.level, title: a.title, facts: a.facts })),
    highestRisk: res.identities.slice(0, 8).map((i) => ({ name: i.name, score: i.score, why: i.why })),
    note: "Suggestions are applied only through approved requests in Automation Hub → User & Access → Access insights.",
  };
}

export const AGENT_TOOLS = [
  {
    name: "access_who_can",
    description: "User & Access: who can do an action on the clusters (OpenShift ResourceAccessReview) — e.g. who can delete pods in payments. Returns users and groups per cluster.",
    input_schema: { type: "object", properties: { verb: { type: "string", description: "get, list, create, update, patch, delete…" }, resource: { type: "string", description: "pods, secrets, deployments, nodes…" }, namespace: { type: "string" }, cluster: { type: "string" } }, required: ["verb", "resource"] },
    handler: (a) => whoCan(a || {}),
  },
  {
    name: "access_explain",
    description: "User & Access: why a person has access — every role on every cluster, how it is given (group or direct), the request and approver behind it, the end date, their risk score and any suggestion to reduce it.",
    input_schema: { type: "object", properties: { user: { type: "string" } }, required: ["user"] },
    handler: (a) => explainAccess(a || {}),
  },
  {
    name: "access_suggestions",
    description: "User & Access: least-privilege suggestions (disable inactive people, remove unused roles, downgrade, narrow, make admin temporary, reduce service accounts), open session alerts and the riskiest identities. kind filters: disable, remove, downgrade, narrow, temporary, reduce, peer.",
    input_schema: { type: "object", properties: { kind: { type: "string" } }, required: [] },
    handler: (a) => accessSuggestions(a || {}),
  },
];

/** For the MCP server. */
export function registerAccessTools(server) {
  const wrap = (fn) => async (a) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await fn(a || {}), null, 2) }] }; }
    catch (e) { return { content: [{ type: "text", text: `User & Access: ${e.message}` }], isError: true }; }
  };
  server.tool("access_who_can", AGENT_TOOLS[0].description, { verb: z.string(), resource: z.string(), namespace: z.string().optional(), cluster: z.string().optional() }, wrap(whoCan));
  server.tool("access_explain", AGENT_TOOLS[1].description, { user: z.string() }, wrap(explainAccess));
  server.tool("access_suggestions", AGENT_TOOLS[2].description, { kind: z.string().optional() }, wrap(accessSuggestions));
}
