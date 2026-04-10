import { z } from "zod";
import {
  listJobTemplates,
  launchJobTemplate,
  getJobStatus,
  listInventories,
  listWorkflowTemplates,
  launchWorkflow,
} from "../utils/ansible-client.js";

export function registerAnsibleTools(server) {
  // ---------- List Job Templates ----------
  server.tool(
    "list_ansible_job_templates",
    "List available Ansible Automation Platform job templates for OpenShift remediation",
    {
      search: z
        .string()
        .optional()
        .describe("Search term to filter job templates"),
    },
    async ({ search }) => {
      try {
        const data = await listJobTemplates(search);
        const templates = (data.results || []).map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          project: t.summary_fields?.project?.name,
          inventory: t.summary_fields?.inventory?.name,
          lastJobStatus: t.summary_fields?.last_job?.status,
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(templates, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Launch Ansible Job ----------
  server.tool(
    "launch_ansible_job",
    "Launch an Ansible job template to remediate an OpenShift issue (use after ITSM approval)",
    {
      templateId: z.number().describe("ID of the job template to launch"),
      extraVars: z
        .record(z.string())
        .optional()
        .default({})
        .describe(
          "Extra variables to pass (e.g., target_namespace, pod_name, action)"
        ),
    },
    async ({ templateId, extraVars }) => {
      try {
        const result = await launchJobTemplate(templateId, extraVars);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "launched",
                  jobId: result.id || result.job,
                  message: `Ansible job launched successfully. Job ID: ${result.id || result.job}`,
                  url: result.url,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- Check Ansible Job Status ----------
  server.tool(
    "check_ansible_job_status",
    "Check the status of a running Ansible job",
    {
      jobId: z.number().describe("Ansible job ID to check"),
    },
    async ({ jobId }) => {
      try {
        const job = await getJobStatus(jobId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  jobId: job.id,
                  name: job.name,
                  status: job.status,
                  failed: job.failed,
                  started: job.started,
                  finished: job.finished,
                  elapsed: job.elapsed,
                  resultStdout: job.result_stdout
                    ? job.result_stdout.substring(0, 2000)
                    : null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- List Inventories ----------
  server.tool(
    "list_ansible_inventories",
    "List available Ansible inventories",
    {},
    async () => {
      try {
        const data = await listInventories();
        const inventories = (data.results || []).map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          totalHosts: i.total_hosts,
          hostsWithFailures: i.hosts_with_active_failures,
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(inventories, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------- List & Launch Workflow Templates ----------
  server.tool(
    "list_ansible_workflows",
    "List Ansible workflow templates for multi-step remediation",
    {
      search: z.string().optional().describe("Search filter"),
    },
    async ({ search }) => {
      try {
        const data = await listWorkflowTemplates(search);
        const workflows = (data.results || []).map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify(workflows, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "launch_ansible_workflow",
    "Launch an Ansible workflow template for complex multi-step remediation",
    {
      workflowId: z.number().describe("Workflow template ID"),
      extraVars: z.record(z.string()).optional().default({}),
    },
    async ({ workflowId, extraVars }) => {
      try {
        const result = await launchWorkflow(workflowId, extraVars);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "launched",
                  workflowJobId: result.id || result.workflow_job,
                  message: `Workflow launched. ID: ${result.id || result.workflow_job}`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
