import { z } from "zod";
import { ocpGet, ocpPost, ocpFetch } from "../utils/openshift-client.js";

const TEKTON_NOT_INSTALLED_MSG =
  "Tekton does not appear to be installed on this cluster. " +
  "The Tekton API (tekton.dev/v1) was not found.\n\n" +
  "To install Tekton Pipelines, you can:\n" +
  "- Install the **Red Hat OpenShift Pipelines** operator from OperatorHub\n" +
  "- Or install upstream Tekton: `kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml`";

/**
 * Return true if the error looks like a Tekton-not-installed 404.
 */
function isTektonMissing(err) {
  const msg = err?.message || "";
  return msg.includes("404") || msg.includes("the server could not find the requested resource");
}

/**
 * Build a markdown table from an array of row objects.
 * `columns` is an array of { header, key, align? } where key is the accessor.
 */
function markdownTable(columns, rows) {
  if (rows.length === 0) return "_No items found._";
  const header = "| " + columns.map((c) => c.header).join(" | ") + " |";
  const separator =
    "| " + columns.map((c) => (c.align === "right" ? "---:" : "---")).join(" | ") + " |";
  const body = rows.map(
    (row) =>
      "| " +
      columns.map((c) => {
        const val = typeof c.key === "function" ? c.key(row) : row[c.key];
        return val != null ? String(val) : "";
      }).join(" | ") +
      " |"
  );
  return [header, separator, ...body].join("\n");
}

/**
 * Derive a short human-readable status from a PipelineRun or TaskRun.
 */
function runStatus(resource) {
  const conditions = resource?.status?.conditions || [];
  const succeeded = conditions.find((c) => c.type === "Succeeded");
  if (!succeeded) return "Pending";
  if (succeeded.status === "True") return "Succeeded";
  if (succeeded.status === "False") return "Failed";
  return succeeded.reason || "Running";
}

/**
 * Compute a human-readable duration between two ISO timestamps.
 */
function duration(start, end) {
  if (!start) return "";
  const s = new Date(start);
  const e = end ? new Date(end) : new Date();
  const diffMs = e - s;
  if (diffMs < 0) return "";
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${remMins}m`;
}

export function registerTektonTools(server) {
  // ---------- List Pipelines ----------
  server.tool(
    "tekton_list_pipelines",
    "List Tekton pipelines in a namespace with their task counts",
    {
      namespace: z.string().describe("Namespace to list pipelines from"),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(
          `/apis/tekton.dev/v1/namespaces/${namespace}/pipelines`
        );
        const pipelines = data.items || [];

        const table = markdownTable(
          [
            { header: "Name", key: "name" },
            { header: "Tasks", key: "tasks", align: "right" },
            { header: "Created", key: "created" },
          ],
          pipelines.map((p) => ({
            name: p.metadata.name,
            tasks: (p.spec?.tasks || []).length + (p.spec?.finally || []).length,
            created: p.metadata.creationTimestamp,
          }))
        );

        const text =
          `## Tekton Pipelines in \`${namespace}\`\n\n` +
          `Found **${pipelines.length}** pipeline(s).\n\n` +
          table;

        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List PipelineRuns ----------
  server.tool(
    "tekton_list_pipelineruns",
    "List Tekton pipeline runs in a namespace, optionally filtered by pipeline name",
    {
      namespace: z.string().describe("Namespace to list pipeline runs from"),
      pipelineName: z
        .string()
        .optional()
        .describe("Filter runs for a specific pipeline name"),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe("Maximum number of runs to return (default 20)"),
    },
    async ({ namespace, pipelineName, limit }) => {
      try {
        let path = `/apis/tekton.dev/v1/namespaces/${namespace}/pipelineruns`;
        const params = [];
        if (pipelineName) {
          params.push(
            `labelSelector=${encodeURIComponent(`tekton.dev/pipeline=${pipelineName}`)}`
          );
        }
        if (params.length > 0) path += `?${params.join("&")}`;

        const data = await ocpGet(path);
        let runs = data.items || [];

        // Sort by creation time, newest first
        runs.sort(
          (a, b) =>
            new Date(b.metadata.creationTimestamp) -
            new Date(a.metadata.creationTimestamp)
        );

        // Apply limit
        runs = runs.slice(0, limit);

        const table = markdownTable(
          [
            { header: "Name", key: "name" },
            { header: "Pipeline", key: "pipeline" },
            { header: "Status", key: "status" },
            { header: "Duration", key: "duration" },
            { header: "Started", key: "started" },
          ],
          runs.map((r) => ({
            name: r.metadata.name,
            pipeline:
              r.metadata.labels?.["tekton.dev/pipeline"] ||
              r.spec?.pipelineRef?.name ||
              "",
            status: runStatus(r),
            duration: duration(
              r.status?.startTime,
              r.status?.completionTime
            ),
            started: r.status?.startTime || r.metadata.creationTimestamp,
          }))
        );

        const heading = pipelineName
          ? `## Pipeline Runs for \`${pipelineName}\` in \`${namespace}\``
          : `## Pipeline Runs in \`${namespace}\``;

        const text =
          `${heading}\n\n` +
          `Showing **${runs.length}** run(s).\n\n` +
          table;

        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Get PipelineRun ----------
  server.tool(
    "tekton_get_pipelinerun",
    "Get detailed information about a specific Tekton pipeline run including task statuses",
    {
      name: z.string().describe("Name of the pipeline run"),
      namespace: z.string().describe("Namespace of the pipeline run"),
    },
    async ({ name, namespace }) => {
      try {
        const pr = await ocpGet(
          `/apis/tekton.dev/v1/namespaces/${namespace}/pipelineruns/${name}`
        );

        const status = runStatus(pr);
        const conditions = pr.status?.conditions || [];
        const succeeded = conditions.find((c) => c.type === "Succeeded");

        // Build task run status table
        const taskRuns = pr.status?.childReferences || [];
        const taskTable = markdownTable(
          [
            { header: "Task", key: "task" },
            { header: "Status", key: "status" },
            { header: "Duration", key: "duration" },
            { header: "Pod", key: "pod" },
          ],
          taskRuns.map((tr) => {
            const trStatus = pr.status?.taskRuns?.[tr.name] || {};
            const trConditions = trStatus.conditions ||
              pr.status?.childReferences?.find((c) => c.name === tr.name)
                ? []
                : [];
            return {
              task: tr.pipelineTaskName || tr.name,
              status: trStatus.conditions
                ? runStatus({ status: trStatus })
                : tr.name
                  ? "See taskrun"
                  : "Unknown",
              duration: duration(
                trStatus.startTime,
                trStatus.completionTime
              ),
              pod: trStatus.podName || "",
            };
          })
        );

        // Pipeline params
        const params = pr.spec?.params || [];
        const paramLines = params.length > 0
          ? params.map((p) => `- **${p.name}**: \`${p.value}\``).join("\n")
          : "_No parameters._";

        const text = [
          `## PipelineRun: \`${name}\``,
          "",
          `| Field | Value |`,
          `| --- | --- |`,
          `| **Namespace** | ${namespace} |`,
          `| **Pipeline** | ${pr.metadata.labels?.["tekton.dev/pipeline"] || pr.spec?.pipelineRef?.name || "inline"} |`,
          `| **Status** | ${status} |`,
          `| **Reason** | ${succeeded?.reason || ""} |`,
          `| **Message** | ${succeeded?.message || ""} |`,
          `| **Started** | ${pr.status?.startTime || "N/A"} |`,
          `| **Completed** | ${pr.status?.completionTime || "N/A"} |`,
          `| **Duration** | ${duration(pr.status?.startTime, pr.status?.completionTime)} |`,
          `| **Service Account** | ${pr.spec?.taskRunTemplate?.serviceAccountName || pr.spec?.serviceAccountName || "default"} |`,
          "",
          "### Parameters",
          paramLines,
          "",
          "### Task Runs",
          taskTable,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Start Pipeline ----------
  server.tool(
    "tekton_start_pipeline",
    "Start a new Tekton pipeline run for a given pipeline",
    {
      pipelineName: z.string().describe("Name of the pipeline to run"),
      namespace: z.string().describe("Namespace where the pipeline lives"),
      params: z
        .record(z.string())
        .optional()
        .describe("Pipeline parameters as key-value pairs, e.g. {\"repo-url\": \"https://...\"}"),
      serviceAccount: z
        .string()
        .optional()
        .describe("Service account name to use for the run"),
    },
    async ({ pipelineName, namespace, params, serviceAccount }) => {
      try {
        const pipelineRunName = `${pipelineName}-run-${Date.now()}`;

        const pipelineRun = {
          apiVersion: "tekton.dev/v1",
          kind: "PipelineRun",
          metadata: {
            name: pipelineRunName,
            namespace,
          },
          spec: {
            pipelineRef: {
              name: pipelineName,
            },
          },
        };

        // Add params if provided
        if (params && Object.keys(params).length > 0) {
          pipelineRun.spec.params = Object.entries(params).map(
            ([name, value]) => ({ name, value })
          );
        }

        // Add service account if provided
        if (serviceAccount) {
          pipelineRun.spec.taskRunTemplate = {
            serviceAccountName: serviceAccount,
          };
        }

        const result = await ocpPost(
          `/apis/tekton.dev/v1/namespaces/${namespace}/pipelineruns`,
          pipelineRun
        );

        const text = [
          `## Pipeline Run Started`,
          "",
          `| Field | Value |`,
          `| --- | --- |`,
          `| **Name** | \`${result.metadata.name}\` |`,
          `| **Namespace** | ${namespace} |`,
          `| **Pipeline** | ${pipelineName} |`,
          `| **Service Account** | ${serviceAccount || "default"} |`,
          "",
          params && Object.keys(params).length > 0
            ? "### Parameters\n" +
              Object.entries(params)
                .map(([k, v]) => `- **${k}**: \`${v}\``)
                .join("\n")
            : "",
          "",
          `Use \`tekton_get_pipelinerun\` with name \`${result.metadata.name}\` to track progress.`,
        ]
          .filter(Boolean)
          .join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- List Tasks ----------
  server.tool(
    "tekton_list_tasks",
    "List Tekton tasks in a namespace",
    {
      namespace: z.string().describe("Namespace to list tasks from"),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(
          `/apis/tekton.dev/v1/namespaces/${namespace}/tasks`
        );
        const tasks = data.items || [];

        const table = markdownTable(
          [
            { header: "Name", key: "name" },
            { header: "Steps", key: "steps", align: "right" },
            { header: "Created", key: "created" },
          ],
          tasks.map((t) => ({
            name: t.metadata.name,
            steps: (t.spec?.steps || []).length,
            created: t.metadata.creationTimestamp,
          }))
        );

        const text =
          `## Tekton Tasks in \`${namespace}\`\n\n` +
          `Found **${tasks.length}** task(s).\n\n` +
          table;

        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Restart PipelineRun ----------
  server.tool(
    "tekton_pipelinerun_restart",
    "Restart a Tekton PipelineRun with the same spec (creates a new run)",
    {
      name: z.string().describe("Name of the PipelineRun to restart"),
      namespace: z.string().describe("Namespace of the PipelineRun"),
    },
    async ({ name, namespace }) => {
      try {
        const original = await ocpGet(
          `/apis/tekton.dev/v1/namespaces/${namespace}/pipelineruns/${name}`
        );

        const newName = `${name.replace(/-retry-\d+$/, "")}-retry-${Date.now()}`;
        const newRun = {
          apiVersion: "tekton.dev/v1",
          kind: "PipelineRun",
          metadata: {
            name: newName,
            namespace,
            labels: { ...(original.metadata.labels || {}), "tekton.dev/restarted-from": name },
          },
          spec: { ...original.spec },
        };
        delete newRun.spec.status;

        const result = await ocpPost(
          `/apis/tekton.dev/v1/namespaces/${namespace}/pipelineruns`,
          newRun
        );

        return {
          content: [{
            type: "text",
            text: `## PipelineRun Restarted\n\n` +
              `| Field | Value |\n| --- | --- |\n` +
              `| **Original** | \`${name}\` |\n` +
              `| **New Run** | \`${result.metadata.name}\` |\n` +
              `| **Namespace** | ${namespace} |\n\n` +
              `Use \`tekton_get_pipelinerun\` with name \`${result.metadata.name}\` to track progress.`,
          }],
        };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Start Task ----------
  server.tool(
    "tekton_start_task",
    "Start a Tekton Task by creating a TaskRun",
    {
      name: z.string().describe("Name of the Task to run"),
      namespace: z.string().describe("Namespace where the task lives"),
      params: z
        .record(z.string())
        .optional()
        .describe("Task parameters as key-value pairs"),
      serviceAccount: z.string().optional().describe("Service account name"),
    },
    async ({ name, namespace, params, serviceAccount }) => {
      try {
        const taskRunName = `${name}-run-${Date.now()}`;
        const taskRun = {
          apiVersion: "tekton.dev/v1",
          kind: "TaskRun",
          metadata: { name: taskRunName, namespace },
          spec: {
            taskRef: { name },
            ...(serviceAccount ? { serviceAccountName: serviceAccount } : {}),
          },
        };
        if (params && Object.keys(params).length > 0) {
          taskRun.spec.params = Object.entries(params).map(([k, v]) => ({ name: k, value: v }));
        }

        const result = await ocpPost(
          `/apis/tekton.dev/v1/namespaces/${namespace}/taskruns`,
          taskRun
        );

        return {
          content: [{
            type: "text",
            text: `## TaskRun Started\n\n` +
              `| Field | Value |\n| --- | --- |\n` +
              `| **Name** | \`${result.metadata.name}\` |\n` +
              `| **Task** | ${name} |\n` +
              `| **Namespace** | ${namespace} |\n\n` +
              `Use \`tekton_get_taskrun_logs\` to view logs.`,
          }],
        };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Restart TaskRun ----------
  server.tool(
    "tekton_taskrun_restart",
    "Restart a Tekton TaskRun with the same spec (creates a new run)",
    {
      name: z.string().describe("Name of the TaskRun to restart"),
      namespace: z.string().describe("Namespace of the TaskRun"),
    },
    async ({ name, namespace }) => {
      try {
        const original = await ocpGet(
          `/apis/tekton.dev/v1/namespaces/${namespace}/taskruns/${name}`
        );

        const newName = `${name.replace(/-retry-\d+$/, "")}-retry-${Date.now()}`;
        const newRun = {
          apiVersion: "tekton.dev/v1",
          kind: "TaskRun",
          metadata: {
            name: newName,
            namespace,
            labels: { ...(original.metadata.labels || {}), "tekton.dev/restarted-from": name },
          },
          spec: { ...original.spec },
        };
        delete newRun.spec.status;

        const result = await ocpPost(
          `/apis/tekton.dev/v1/namespaces/${namespace}/taskruns`,
          newRun
        );

        return {
          content: [{
            type: "text",
            text: `## TaskRun Restarted\n\n` +
              `| Field | Value |\n| --- | --- |\n` +
              `| **Original** | \`${name}\` |\n` +
              `| **New Run** | \`${result.metadata.name}\` |\n` +
              `| **Namespace** | ${namespace} |\n`,
          }],
        };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Get TaskRun Logs ----------
  server.tool(
    "tekton_get_taskrun_logs",
    "Get logs from a Tekton task run by finding its associated pod",
    {
      name: z.string().describe("Name of the task run"),
      namespace: z.string().describe("Namespace of the task run"),
    },
    async ({ name, namespace }) => {
      try {
        // Get the taskrun to find the pod name
        const taskrun = await ocpGet(
          `/apis/tekton.dev/v1/namespaces/${namespace}/taskruns/${name}`
        );

        const podName = taskrun.status?.podName;
        if (!podName) {
          return {
            content: [
              {
                type: "text",
                text:
                  `TaskRun \`${name}\` does not have an associated pod yet. ` +
                  `Current status: **${runStatus(taskrun)}**`,
              },
            ],
          };
        }

        // Get the pod to find all step containers
        const pod = await ocpGet(
          `/api/v1/namespaces/${namespace}/pods/${podName}`
        );

        const stepContainers = (pod.spec?.containers || [])
          .filter((c) => c.name.startsWith("step-"))
          .map((c) => c.name);

        if (stepContainers.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No step containers found in pod \`${podName}\` for TaskRun \`${name}\`.`,
              },
            ],
          };
        }

        // Fetch logs for each step container
        const logSections = [];
        for (const container of stepContainers) {
          try {
            const logs = await ocpFetch(
              `/api/v1/namespaces/${namespace}/pods/${podName}/log?container=${container}&tailLines=100`,
              { headers: { Accept: "text/plain" } }
            );
            const stepName = container.replace(/^step-/, "");
            logSections.push(
              `### Step: \`${stepName}\`\n\n\`\`\`\n${logs || "(no output)"}\n\`\`\``
            );
          } catch (logErr) {
            const stepName = container.replace(/^step-/, "");
            logSections.push(
              `### Step: \`${stepName}\`\n\n_Could not retrieve logs: ${logErr.message}_`
            );
          }
        }

        const status = runStatus(taskrun);
        const text = [
          `## TaskRun Logs: \`${name}\``,
          "",
          `| Field | Value |`,
          `| --- | --- |`,
          `| **Pod** | \`${podName}\` |`,
          `| **Status** | ${status} |`,
          `| **Steps** | ${stepContainers.length} |`,
          "",
          ...logSections,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (isTektonMissing(err)) {
          return { content: [{ type: "text", text: TEKTON_NOT_INSTALLED_MSG }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
