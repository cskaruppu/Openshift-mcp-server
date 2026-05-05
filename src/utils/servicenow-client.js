/**
 * ServiceNow REST API client utility.
 */

const SNOW_INSTANCE = process.env.SERVICENOW_INSTANCE || "";
const SNOW_USER = process.env.SERVICENOW_USERNAME || "";
const SNOW_PASS = process.env.SERVICENOW_PASSWORD || "";

function authHeader() {
  return `Basic ${Buffer.from(`${SNOW_USER}:${SNOW_PASS}`).toString("base64")}`;
}

export async function snowFetch(path, options = {}) {
  if (!SNOW_INSTANCE) {
    throw new Error("ServiceNow instance URL not configured. Set SERVICENOW_INSTANCE environment variable.");
  }
  const url = `${SNOW_INSTANCE}/api${path}`;
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
    throw new Error(`Cannot connect to ServiceNow (${SNOW_INSTANCE}): ${e.message}. Verify SERVICENOW_INSTANCE is correct and reachable.`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ServiceNow API ${resp.status}: ${body}`);
  }
  return resp.json();
}

/** Create an incident */
export async function createIncident({
  shortDescription,
  description,
  urgency = "2",
  impact = "2",
  category = "Infrastructure",
  assignmentGroup = "",
  callerID = "",
}) {
  return snowFetch("/now/table/incident", {
    method: "POST",
    body: JSON.stringify({
      short_description: shortDescription,
      description,
      urgency,
      impact,
      category,
      assignment_group: assignmentGroup,
      caller_id: callerID,
    }),
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
}) {
  return snowFetch("/now/table/change_request", {
    method: "POST",
    body: JSON.stringify({
      short_description: shortDescription,
      description,
      type,
      priority,
      assignment_group: assignmentGroup,
      risk,
      justification,
    }),
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
