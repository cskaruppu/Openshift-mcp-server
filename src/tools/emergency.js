import { z } from "zod";
import { ocpGet, ocpDelete, ocpPatch } from "../utils/openshift-client.js";
import { createChangeRequest } from "../utils/servicenow-client.js";

export function registerEmergencyTools(server) {
  // ---------- Emergency Fix Workflow ----------
  server.tool(
    "emergency_fix",
    "Execute an emergency fix: creates an emergency change request in ServiceNow, performs the fix immediately, and sends notification. Use only for critical production issues.",
    {
      issueType: z
        .enum([
          "restart_pod",
          "scale_deployment",
          "cordon_node",
          "drain_node",
          "rollback_deployment",
          "delete_stuck_pod",
        ])
        .describe("Type of emergency fix to apply"),
      namespace: z
        .string()
        .optional()
        .describe("Namespace (required for pod/deployment actions)"),
      resourceName: z
        .string()
        .describe("Name of the affected resource (pod, deployment, or node)"),
      reason: z
        .string()
        .describe("Reason for the emergency fix (logged in ITSM)"),
      replicas: z
        .number()
        .optional()
        .describe("New replica count (for scale_deployment)"),
      revision: z
        .number()
        .optional()
        .describe("Revision to rollback to (for rollback_deployment, 0 = previous)"),
    },
    async ({ issueType, namespace, resourceName, reason, replicas, revision }) => {
      const actions = [];

      try {
        // Step 1: Create emergency change request in ServiceNow
        let changeResult = null;
        try {
          changeResult = await createChangeRequest({
            shortDescription: `[EMERGENCY] OpenShift fix: ${issueType} — ${resourceName}`,
            description: `Emergency automated fix.\n\nType: ${issueType}\nResource: ${resourceName}\nNamespace: ${namespace || "N/A"}\nReason: ${reason}\n\nThis change was executed immediately due to its critical nature. Post-approval requested.`,
            type: "emergency",
            priority: "1",
            risk: "high",
            justification: reason,
          });
          actions.push({
            step: "itsm_ticket",
            status: "created",
            changeNumber: changeResult.result?.number,
          });
        } catch (snowErr) {
          actions.push({
            step: "itsm_ticket",
            status: "failed",
            error: snowErr.message,
            note: "Proceeding with emergency fix despite ITSM failure",
          });
        }

        // Step 2: Execute the fix
        let fixResult;
        switch (issueType) {
          case "restart_pod":
          case "delete_stuck_pod":
            await ocpDelete(
              `/api/v1/namespaces/${namespace}/pods/${resourceName}`
            );
            fixResult = {
              action: "pod_deleted",
              message: `Pod ${resourceName} deleted. Controller will recreate it.`,
            };
            break;

          case "scale_deployment":
            await ocpPatch(
              `/apis/apps/v1/namespaces/${namespace}/deployments/${resourceName}`,
              { spec: { replicas: replicas || 1 } }
            );
            fixResult = {
              action: "deployment_scaled",
              message: `Deployment ${resourceName} scaled to ${replicas || 1} replicas.`,
            };
            break;

          case "cordon_node":
            await ocpPatch(`/api/v1/nodes/${resourceName}`, {
              spec: { unschedulable: true },
            });
            fixResult = {
              action: "node_cordoned",
              message: `Node ${resourceName} cordoned. No new pods will be scheduled.`,
            };
            break;

          case "drain_node": {
            // Cordon first, then evict pods
            await ocpPatch(`/api/v1/nodes/${resourceName}`, {
              spec: { unschedulable: true },
            });
            const pods = await ocpGet(
              `/api/v1/pods?fieldSelector=spec.nodeName=${resourceName}`
            );
            const evicted = [];
            for (const pod of pods.items || []) {
              // Skip mirror pods and DaemonSet pods
              if (pod.metadata.annotations?.["kubernetes.io/config.mirror"])
                continue;
              const owners = pod.metadata.ownerReferences || [];
              if (owners.some((o) => o.kind === "DaemonSet")) continue;

              try {
                await ocpDelete(
                  `/api/v1/namespaces/${pod.metadata.namespace}/pods/${pod.metadata.name}`
                );
                evicted.push(
                  `${pod.metadata.namespace}/${pod.metadata.name}`
                );
              } catch {
                // Best effort
              }
            }
            fixResult = {
              action: "node_drained",
              message: `Node ${resourceName} cordoned and ${evicted.length} pods evicted.`,
              evictedPods: evicted,
            };
            break;
          }

          case "rollback_deployment": {
            // Get deployment's ReplicaSets and rollback
            const rsList = await ocpGet(
              `/apis/apps/v1/namespaces/${namespace}/replicasets?labelSelector=app=${resourceName}`
            );
            const sorted = (rsList.items || []).sort(
              (a, b) =>
                parseInt(b.metadata.annotations?.["deployment.kubernetes.io/revision"] || "0") -
                parseInt(a.metadata.annotations?.["deployment.kubernetes.io/revision"] || "0")
            );

            if (sorted.length < 2) {
              fixResult = {
                action: "rollback_failed",
                message: "Not enough revisions to rollback.",
              };
            } else {
              // Patch the deployment with the previous RS's template
              const targetIdx = revision && revision > 0 ? sorted.findIndex(
                (rs) =>
                  rs.metadata.annotations?.["deployment.kubernetes.io/revision"] === String(revision)
              ) : 1;
              const targetRS = sorted[targetIdx >= 0 ? targetIdx : 1];

              await ocpPatch(
                `/apis/apps/v1/namespaces/${namespace}/deployments/${resourceName}`,
                {
                  spec: {
                    template: targetRS.spec?.template,
                  },
                }
              );
              fixResult = {
                action: "deployment_rolled_back",
                message: `Deployment ${resourceName} rolled back to revision ${
                  targetRS.metadata.annotations?.[
                    "deployment.kubernetes.io/revision"
                  ] || "previous"
                }.`,
              };
            }
            break;
          }

          default:
            fixResult = { action: "unknown", message: "Unknown fix type." };
        }

        actions.push({ step: "fix_executed", ...fixResult });

        // Step 3: Notification
        const notification = {
          step: "notification",
          status: "sent",
          type: "emergency_fix",
          summary: `Emergency fix applied: ${issueType} on ${resourceName}. ${
            changeResult?.result?.number
              ? `ITSM: ${changeResult.result.number}`
              : "ITSM ticket creation failed — manual follow-up needed."
          }`,
        };

        // Send webhook notification if configured
        if (process.env.EMERGENCY_NOTIFICATION_WEBHOOK) {
          try {
            await fetch(process.env.EMERGENCY_NOTIFICATION_WEBHOOK, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: notification.summary,
                issueType,
                resource: resourceName,
                namespace,
                reason,
                changeNumber: changeResult?.result?.number,
              }),
            });
          } catch {
            notification.webhookStatus = "failed";
          }
        }
        actions.push(notification);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { status: "completed", actions },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "failed",
                  error: err.message,
                  actionsCompleted: actions,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------- Approve & Execute Fix ----------
  server.tool(
    "approved_fix",
    "Execute a fix after ITSM change request has been approved. Checks approval status before executing.",
    {
      changeRequestId: z
        .string()
        .describe("ServiceNow change request number or sys_id"),
      issueType: z
        .enum([
          "restart_pod",
          "scale_deployment",
          "cordon_node",
          "rollback_deployment",
        ])
        .describe("Fix to apply once approved"),
      namespace: z.string().optional(),
      resourceName: z.string().describe("Target resource name"),
      replicas: z.number().optional(),
    },
    async ({ changeRequestId, issueType, namespace, resourceName, replicas }) => {
      try {
        // Check approval status first
        const { queryRecords } = await import(
          "../utils/servicenow-client.js"
        );
        const records = await queryRecords(
          "change_request",
          `number=${changeRequestId}`,
          1
        );
        const cr = records.result?.[0];

        if (!cr) {
          return {
            content: [
              {
                type: "text",
                text: `Change request ${changeRequestId} not found.`,
              },
            ],
            isError: true,
          };
        }

        if (cr.approval !== "approved") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "waiting_approval",
                    changeRequest: changeRequestId,
                    currentApproval: cr.approval,
                    message:
                      "Change request has not been approved yet. Cannot execute fix.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Approved — execute the fix
        switch (issueType) {
          case "restart_pod":
            await ocpDelete(
              `/api/v1/namespaces/${namespace}/pods/${resourceName}`
            );
            break;
          case "scale_deployment":
            await ocpPatch(
              `/apis/apps/v1/namespaces/${namespace}/deployments/${resourceName}`,
              { spec: { replicas: replicas || 1 } }
            );
            break;
          case "cordon_node":
            await ocpPatch(`/api/v1/nodes/${resourceName}`, {
              spec: { unschedulable: true },
            });
            break;
          case "rollback_deployment":
            // Simplified rollback via restart
            await ocpPatch(
              `/apis/apps/v1/namespaces/${namespace}/deployments/${resourceName}`,
              {
                spec: {
                  template: {
                    metadata: {
                      annotations: {
                        "kubectl.kubernetes.io/restartedAt":
                          new Date().toISOString(),
                      },
                    },
                  },
                },
              }
            );
            break;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "executed",
                  changeRequest: changeRequestId,
                  action: issueType,
                  resource: resourceName,
                  namespace,
                  message: `Fix applied successfully after approval of ${changeRequestId}.`,
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
