/**
 * Ansible Automation Platform (AAP / Controller) REST API client.
 */

const AAP_URL = process.env.ANSIBLE_CONTROLLER_URL || "";
const AAP_TOKEN = process.env.ANSIBLE_CONTROLLER_TOKEN || "";

export async function aapFetch(path, options = {}) {
  const url = `${AAP_URL}/api/v2${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AAP_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ansible API ${resp.status}: ${body}`);
  }
  return resp.json();
}

/** List job templates */
export async function listJobTemplates(search = "") {
  const qs = search ? `?search=${encodeURIComponent(search)}` : "";
  return aapFetch(`/job_templates/${qs}`);
}

/** Launch a job template */
export async function launchJobTemplate(templateId, extraVars = {}) {
  return aapFetch(`/job_templates/${templateId}/launch/`, {
    method: "POST",
    body: JSON.stringify({ extra_vars: extraVars }),
  });
}

/** Get job status */
export async function getJobStatus(jobId) {
  return aapFetch(`/jobs/${jobId}/`);
}

/** List inventories */
export async function listInventories() {
  return aapFetch("/inventories/");
}

/** List projects */
export async function listProjects() {
  return aapFetch("/projects/");
}

/** Get workflow job templates */
export async function listWorkflowTemplates(search = "") {
  const qs = search ? `?search=${encodeURIComponent(search)}` : "";
  return aapFetch(`/workflow_job_templates/${qs}`);
}

/** Launch a workflow */
export async function launchWorkflow(workflowId, extraVars = {}) {
  return aapFetch(`/workflow_job_templates/${workflowId}/launch/`, {
    method: "POST",
    body: JSON.stringify({ extra_vars: extraVars }),
  });
}
