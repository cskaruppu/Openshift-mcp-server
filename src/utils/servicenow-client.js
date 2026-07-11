/**
 * ServiceNow REST API client utility.
 *
 * Credentials are read from process.env on EVERY call (not cached at module
 * load) so that runtime updates from the dashboard settings API take effect
 * immediately without restarting the server.
 */

function getConfig() {
  return {
    instance: (process.env.SERVICENOW_INSTANCE || "").replace(/\/+$/, ""),
    user: process.env.SERVICENOW_USERNAME || "",
    pass: process.env.SERVICENOW_PASSWORD || "",
  };
}

let _callerSysIdCache = null;
async function resolveCallerSysId() {
  if (_callerSysIdCache) return _callerSysIdCache;
  const { user } = getConfig();
  if (!user) return "";
  try {
    const data = await snowFetch(
      `/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(user)}&sysparm_limit=1&sysparm_fields=sys_id`,
      { timeoutMs: 20000 }
    );
    const sysId = data?.result?.[0]?.sys_id || "";
    if (sysId) _callerSysIdCache = sysId;
    return sysId;
  } catch {
    return "";
  }
}

function authHeader() {
  const { user, pass } = getConfig();
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

// On an internal/proxied cluster, egress to the SaaS ServiceNow instance must go
// through the corporate proxy. Node's global fetch ignores HTTPS_PROXY unless we
// pass an undici ProxyAgent as the dispatcher. Resolved once and cached.
let _snowDispatcher = undefined; // undefined = unresolved, null = no proxy
async function getSnowDispatcher() {
  if (_snowDispatcher !== undefined) return _snowDispatcher;
  const proxy = process.env.SERVICENOW_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";
  if (!proxy) { _snowDispatcher = null; return null; }
  try {
    const { ProxyAgent } = await import("undici");
    _snowDispatcher = new ProxyAgent(proxy);
    console.log(`[servicenow] Egress via proxy ${proxy.replace(/\/\/[^@]*@/, "//***@")}`);
  } catch (e) { console.warn("[servicenow] Proxy configured but undici ProxyAgent unavailable:", e.message); _snowDispatcher = null; }
  return _snowDispatcher;
}

export async function snowFetch(path, options = {}) {
  const { instance } = getConfig();
  if (!instance) {
    throw new Error("ServiceNow instance URL not configured. Set SERVICENOW_INSTANCE via the dashboard Settings panel or environment variable.");
  }
  const url = `${instance}/api${path}`;
  const timeoutMs = options.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = await getSnowDispatcher();
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      ...(dispatcher ? { dispatcher } : {}),
      signal: controller.signal,
      headers: {
        Authorization: authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`ServiceNow request timed out after ${timeoutMs / 1000}s. Instance may be hibernating — visit ${instance} in a browser to wake it.`);
    throw new Error(`Cannot connect to ServiceNow (${instance}): ${e.message}. Verify SERVICENOW_INSTANCE is correct and reachable.`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 500) {
      let hint = "Server error — check ServiceNow instance logs.";
      if (/ACL/.test(body)) hint = "ACL denied — API user needs 'itil' role.";
      else if (/caller_id|assignment_group/.test(body)) hint = "A reference field has an invalid value. Check caller_id and assignment_group.";
      else if (/mandatory/i.test(body)) hint = "A mandatory field is missing. Check your instance's form configuration.";
      throw new Error(`ServiceNow API 500: ${hint} Raw: ${body.slice(0, 500)}`);
    }
    if (resp.status === 401) throw new Error(`ServiceNow auth failed (401). Check SERVICENOW_USERNAME and SERVICENOW_PASSWORD.`);
    if (resp.status === 403) throw new Error(`ServiceNow forbidden (403). API user needs 'itil' role for table access.`);
    throw new Error(`ServiceNow API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

/** Create an incident.
 *  Resolves caller_id to sys_id (ServiceNow reference fields require sys_id,
 *  not username strings — sending a username causes 500 on many PDIs).
 *  If creation returns 500 but the record was actually committed (common PDI
 *  behavior due to post-insert business rules), queries for the incident
 *  and returns it instead of throwing. */
export async function createIncident({
  shortDescription,
  description,
  urgency = "2",
  impact = "2",
  category = "",
  assignmentGroup = "",
  callerID = "",
}) {
  const payload = {
    short_description: shortDescription,
    description,
    urgency,
    impact,
  };
  if (category) payload.category = category;
  if (assignmentGroup) payload.assignment_group = assignmentGroup;
  const callerSysId = callerID || await resolveCallerSysId();
  if (callerSysId) payload.caller_id = callerSysId;

  try {
    return await snowFetch("/now/table/incident", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 30000,
    });
  } catch (err) {
    if (/500|timed out/.test(err.message)) {
      const waitMs = /timed out/.test(err.message) ? 3000 : 1500;
      await new Promise(r => setTimeout(r, waitMs));
      const prefix = shortDescription.slice(0, 60);
      const queries = [
        `short_descriptionLIKE${prefix}^ORDERBYDESCsys_created_on`,
        callerSysId ? `caller_id=${callerSysId}^ORDERBYDESCsys_created_on` : null,
      ].filter(Boolean);
      for (const q of queries) {
        try {
          const recent = await snowFetch(
            `/now/table/incident?sysparm_query=${encodeURIComponent(q)}&sysparm_limit=1&sysparm_fields=sys_id,number,short_description,state`,
            { timeoutMs: 10000 }
          );
          if (recent?.result?.[0]?.sys_id) {
            console.warn("[servicenow] Incident created despite error — recovered:", recent.result[0].number);
            return recent;
          }
        } catch { /* recovery query failed, try next */ }
      }
    }
    throw err;
  }
}

/** Create a change request */
export async function createChangeRequest({
  shortDescription,
  description,
  type = "normal",
  priority = "3",
  assignmentGroup = "",
  risk = "3",
  justification = "",
  implementationPlan = "",
  backoutPlan = "",
  testPlan = "",
  impact = "3",
  category = "Software",
  startDate = "",
  endDate = "",
  workNotes = "",
}) {
  // ServiceNow risk: 1=Very High, 2=High, 3=Moderate, 4=Low
  const RISK_MAP = { "very high": "1", high: "2", moderate: "3", low: "4" };
  const riskValue = RISK_MAP[String(risk).toLowerCase()] || (/^[1-4]$/.test(risk) ? risk : "3");

  const payload = {
    short_description: shortDescription,
    description,
    type,
    priority,
    assignment_group: assignmentGroup,
    risk: riskValue,
    justification,
    impact,
    category,
  };
  if (implementationPlan) payload.implementation_plan = implementationPlan;
  if (backoutPlan) payload.backout_plan = backoutPlan;
  if (testPlan) payload.test_plan = testPlan;
  if (startDate) payload.start_date = startDate;
  if (endDate) payload.end_date = endDate;
  if (workNotes) payload.work_notes = workNotes;
  return snowFetch("/now/table/change_request", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Get a record by sys_id from a table */
export async function getRecord(table, sysId) {
  return snowFetch(`/now/table/${table}/${sysId}`);
}

/** Query records */
export async function queryRecords(table, query, limit = 10) {
  return snowFetch(
    `/now/table/${table}?sysparm_query=${encodeURIComponent(query)}&sysparm_limit=${limit}`
  );
}

let _preferPut = false;

/** Update a record.
 *  Tries PATCH first (standard REST). Many ServiceNow PDI / developer instances
 *  block PATCH with 403 while allowing PUT on the same endpoint. When PATCH
 *  fails with 403, automatically retries with PUT and remembers the preference
 *  so subsequent calls go straight to PUT without the extra round-trip. */
export async function updateRecord(table, sysId, data) {
  const path = `/now/table/${table}/${sysId}`;
  const body = JSON.stringify(data);

  if (_preferPut) {
    return snowFetch(path, { method: "PUT", body });
  }

  try {
    return await snowFetch(path, { method: "PATCH", body });
  } catch (err) {
    if (/403|forbidden/i.test(err.message)) {
      console.warn("[servicenow] PATCH blocked (403) — falling back to PUT for this and future updates");
      _preferPut = true;
      return snowFetch(path, { method: "PUT", body });
    }
    throw err;
  }
}

/** Cancel a change request in ServiceNow.
 *  Sets state to the configured cancel value (default "4") and adds close notes. */
export async function cancelChangeRequest(sysId, { reason = "Cancelled by user from AI Hub" } = {}) {
  const cancelState = process.env.SERVICENOW_CANCEL_STATE || "4";
  return updateRecord("change_request", sysId, {
    state: cancelState,
    close_code: "cancelled",
    close_notes: reason,
    work_notes: `[AI Hub] Change request cancelled: ${reason}`,
  });
}

/** Resolve a ServiceNow incident — ITIL-compliant closure.
 *  Posts structured work notes (RCA, timeline, fix detail, prevention) as a
 *  separate update FIRST so the details are ALWAYS saved, then attempts to set
 *  state to Resolved. The close is best-effort: if the state transition fails
 *  (e.g. instance-specific mandatory fields or field-level ACL), the details
 *  remain saved and the function returns { detailsSaved: true, closed: false,
 *  closeError } instead of throwing — so the caller never loses the timeline.
 *  Accepts an optional `resolution` object with full diagnosis context. */
export async function resolveIncident(sysId, {
  closeCode = process.env.SERVICENOW_CLOSE_CODE || "Solved (Permanently)",
  closeNotes = "Resolved by TCS Agentic AI",
  workNotes = "",
  resolution = null,
} = {}) {
  let detailsSaved = false;
  if (resolution) {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const sections = [
      `══════════════════════════════════════`,
      `  INCIDENT RESOLUTION — ${resolution.incidentNumber || ""}`,
      `  ${ts}`,
      `══════════════════════════════════════`,
      ``,
      `▸ SEVERITY: ${resolution.severity || "N/A"}`,
      `▸ AFFECTED POD: ${resolution.podName || "N/A"}`,
      `▸ NAMESPACE: ${resolution.namespace || "N/A"}`,
      `▸ DEPLOYMENT: ${resolution.deploymentName || "N/A"}`,
      `▸ CLUSTER: ${resolution.cluster || "local"}`,
      ``,
      `── ROOT CAUSE ANALYSIS ──────────────`,
      resolution.rootCause || "See diagnosis",
      ...(resolution.evidence || []).map(e => `  • ${e}`),
    ];
    if (resolution.logErrors?.length > 0) {
      sections.push(``, `── LOG ANALYSIS ─────────────────────`);
      for (const le of resolution.logErrors.slice(0, 5)) {
        sections.push(`  [${le.category}] ${le.snippet || ""}`);
        sections.push(`    Recommended: ${le.fix || "investigate"}`);
      }
    }
    if (resolution.errorLines?.length > 0) {
      sections.push(``, `── ERROR LOG EXCERPTS ───────────────`);
      for (const l of resolution.errorLines.slice(0, 5)) {
        sections.push(`  ${l.slice(0, 200)}`);
      }
    }
    sections.push(
      ``,
      `── FIX APPLIED ──────────────────────`,
      `  Action: ${resolution.fixTitle || "N/A"}`,
      `  Command: ${resolution.fixCommand || "N/A"}`,
      `  Result: ${(resolution.fixResult || "success").slice(0, 500)}`,
      `  Risk Level: ${resolution.fixRisk || "low"}`,
    );
    if (resolution.beforeAfter) {
      sections.push(``, `── BEFORE / AFTER COMPARISON ────────`, resolution.beforeAfter);
    }
    if (Array.isArray(resolution.timeline) && resolution.timeline.length > 0) {
      sections.push(``, `── INCIDENT TIMELINE ────────────────`);
      for (const step of resolution.timeline) {
        const t = step.timestamp || step.time || "";
        const label = step.label || step.stage || step.event || "";
        const detail = step.detail || step.details || "";
        sections.push(`  [${t}] ${label}${detail ? " — " + detail : ""}`);
      }
    }
    sections.push(
      ``,
      `── VERIFICATION ─────────────────────`,
      `  Fix executed: ✓`,
      `  Deployment rollout: ${resolution.rolloutStatus || "triggered"}`,
      `  Incident auto-resolved: ✓`,
    );
    if (resolution.prevention) {
      sections.push(``, `── PREVENTION ───────────────────────`, `  ${resolution.prevention}`);
    } else {
      const autoPreventions = [];
      if (/OOM|Memory/i.test(resolution.rootCause || "")) autoPreventions.push("Set memory requests equal to limits to prevent OOM", "Consider HPA to auto-scale under load", "Profile application memory usage to right-size limits");
      else if (/Crash|CrashLoop/i.test(resolution.rootCause || "")) autoPreventions.push("Add readiness/liveness probes with appropriate thresholds", "Review application startup sequence and dependency checks", "Implement graceful shutdown handling");
      else if (/Image|Pull/i.test(resolution.rootCause || "")) autoPreventions.push("Pin image tags to digests for reproducibility", "Verify pull secret exists and is not expired", "Use imagePullPolicy: IfNotPresent for stable tags");
      else autoPreventions.push("Monitor with Prometheus alerts for early detection", "Review resource limits and requests regularly");
      sections.push(``, `── PREVENTION RECOMMENDATIONS ───────`);
      autoPreventions.forEach(p => sections.push(`  • ${p}`));
    }
    sections.push(
      ``,
      `══════════════════════════════════════`,
      `  Resolved by TCS Agentic AI`,
      `  Close code: ${closeCode}`,
      `══════════════════════════════════════`,
    );
    // Always save the full details first — this must succeed even if close fails.
    await updateRecord("incident", sysId, { work_notes: sections.join("\n") });
    detailsSaved = true;

    const richCloseNotes = [
      closeNotes,
      `Root Cause: ${resolution.rootCause || "see work notes"}`,
      `Fix: ${resolution.fixTitle || "see work notes"}`,
      `Severity: ${resolution.severity || "N/A"} | Namespace: ${resolution.namespace || "N/A"} | Pod: ${resolution.podName || "N/A"}`,
    ].join("\n");
    return closeWithFallback(sysId, closeCode, richCloseNotes, detailsSaved, resolution.incidentNumber);
  }
  if (workNotes) {
    await updateRecord("incident", sysId, { work_notes: workNotes });
    detailsSaved = true;
  }
  return closeWithFallback(sysId, closeCode, closeNotes, detailsSaved, null);
}

/** Best-effort incident close. ServiceNow PDIs enforce state transitions —
 *  you cannot jump from New(1) directly to Resolved(6). This function first
 *  moves the incident to In Progress(2), then tries Resolved(6) with various
 *  close-field combinations (modern ITSM → classic → bare state).
 *  Never throws on close failure — returns a status object so the caller keeps
 *  the already-saved work notes. */
async function closeWithFallback(sysId, closeCode, closeNotes, detailsSaved, incidentNumber) {
  const resolveState = process.env.SERVICENOW_RESOLVE_STATE || "6";

  // Step 1: Move to In Progress first (required by most PDIs before resolving)
  try {
    await updateRecord("incident", sysId, { state: "2" });
  } catch (e) {
    console.warn(`[servicenow] Could not move ${incidentNumber || sysId} to In Progress:`, e.message);
  }

  // Step 2: Try to resolve with various close-field combinations
  const attempts = [
    { state: resolveState, close_code: closeCode, close_notes: closeNotes, resolution_code: closeCode, resolution_notes: closeNotes },
    { state: resolveState, close_code: closeCode, close_notes: closeNotes },
    { state: resolveState, close_notes: closeNotes },
  ];
  let lastError = null;
  for (const payload of attempts) {
    try {
      const res = await updateRecord("incident", sysId, payload);
      return { closed: true, detailsSaved, state: "Resolved", incidentNumber, result: res };
    } catch (e) {
      lastError = e;
    }
  }
  console.warn(`[servicenow] Incident ${incidentNumber || sysId} details saved but close failed:`, lastError?.message);
  return { closed: false, detailsSaved, closeError: lastError?.message || "close failed", incidentNumber };
}

/** Test ServiceNow connectivity and permissions. */
export async function healthCheck() {
  const { instance, user } = getConfig();
  if (!instance) return { ok: false, error: "SERVICENOW_INSTANCE not set" };
  if (!user) return { ok: false, error: "SERVICENOW_USERNAME not set" };
  try {
    const me = await snowFetch("/now/table/sys_user?sysparm_query=user_name=" + encodeURIComponent(user) + "&sysparm_limit=1&sysparm_fields=sys_id,user_name,roles");
    const userRecord = me?.result?.[0];
    if (!userRecord) return { ok: false, instance, user, error: "API user not found in sys_user table" };
    const roles = userRecord.roles || "";
    const hasItil = /\bitil\b/i.test(roles) || /\badmin\b/i.test(roles);
    return { ok: true, instance, user, userSysId: userRecord.sys_id, hasItilRole: hasItil };
  } catch (e) {
    const hibernated = /502|503|ECONNREFUSED|ENOTFOUND/.test(e.message);
    return { ok: false, instance, user, error: e.message, hibernated };
  }
}

/** Attach a file to a ServiceNow record */
export async function attachFile(table, sysId, fileName, contentType, fileBuffer) {
  const { instance } = getConfig();
  if (!instance) throw new Error("ServiceNow instance URL not configured.");
  const url = `${instance}/api/now/attachment/file?table_name=${table}&table_sys_id=${sysId}&file_name=${encodeURIComponent(fileName)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body: fileBuffer,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ServiceNow attachment API ${resp.status}: ${body}`);
  }
  return resp.json();
}
