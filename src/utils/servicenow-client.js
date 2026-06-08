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

function authHeader() {
  const { user, pass } = getConfig();
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

export async function snowFetch(path, options = {}) {
  const { instance } = getConfig();
  if (!instance) {
    throw new Error("ServiceNow instance URL not configured. Set SERVICENOW_INSTANCE via the dashboard Settings panel or environment variable.");
  }
  const url = `${instance}/api${path}`;
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  } catch (e) {
    throw new Error(`Cannot connect to ServiceNow (${instance}): ${e.message}. Verify SERVICENOW_INSTANCE is correct and reachable.`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 500) {
      let hint = "Server error — check ServiceNow instance logs.";
      if (/ACL/.test(body)) hint = "ACL denied — API user needs 'itil' role.";
      else if (/caller_id|assignment_group/.test(body)) hint = "A reference field has an invalid value. Check caller_id and assignment_group.";
      else if (/mandatory/i.test(body)) hint = "A mandatory field is missing. Check your instance's form configuration.";
      throw new Error(`ServiceNow API 500: ${hint} Raw: ${body.slice(0, 200)}`);
    }
    if (resp.status === 401) throw new Error(`ServiceNow auth failed (401). Check SERVICENOW_USERNAME and SERVICENOW_PASSWORD.`);
    if (resp.status === 403) throw new Error(`ServiceNow forbidden (403). API user needs 'itil' role for table access.`);
    throw new Error(`ServiceNow API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

/** Create an incident.
 *  Only sends non-empty optional fields to avoid triggering ServiceNow
 *  business rules that fail on empty string references (common on PDIs). */
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
  const effectiveCaller = callerID || getConfig().user;
  if (effectiveCaller) payload.caller_id = effectiveCaller;
  return snowFetch("/now/table/incident", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Create a change request */
export async function createChangeRequest({
  shortDescription,
  description,
  type = "normal",
  priority = "3",
  assignmentGroup = "",
  risk = "moderate",
  justification = "",
  implementationPlan = "",
  backoutPlan = "",
  testPlan = "",
  impact = "3",
  category = "Infrastructure",
  startDate = "",
  endDate = "",
  workNotes = "",
}) {
  const payload = {
    short_description: shortDescription,
    description,
    type,
    priority,
    assignment_group: assignmentGroup,
    risk,
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

/** Update a record */
export async function updateRecord(table, sysId, data) {
  return snowFetch(`/now/table/${table}/${sysId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
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

/** Resolve a ServiceNow incident.
 *  Sets state to Resolved (6) with close code, notes, and detailed work notes. */
export async function resolveIncident(sysId, {
  closeCode = "Solved (Permanently)",
  closeNotes = "Resolved by TCS Agentic AI",
  workNotes = "",
} = {}) {
  if (workNotes) {
    await updateRecord("incident", sysId, { work_notes: workNotes });
  }
  return updateRecord("incident", sysId, {
    state: "6",
    close_code: closeCode,
    close_notes: closeNotes,
  });
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
