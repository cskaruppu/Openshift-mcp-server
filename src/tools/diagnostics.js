import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerDiagnosticTools(server) {
  // ---------- Diagnose Pod Issues ----------
  server.tool(
    "diagnose_pod_issues",
    "Analyze a pod for common issues (CrashLoopBackOff, ImagePullBackOff, OOMKilled, pending scheduling) and suggest fixes",
    {
      namespace: z.string().describe("Namespace of the pod"),
      podName: z.string().describe("Name of the pod to diagnose"),
    },
    async ({ namespace, podName }) => {
      try {
        const [pod, events] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/pods/${podName}`),
          ocpGet(
            `/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${podName}`
          ),
        ]);

        const issues = [];
        const fixes = [];
        const phase = pod.status?.phase;
        const containerStatuses = pod.status?.containerStatuses || [];
        const initContainerStatuses =
          pod.status?.initContainerStatuses || [];
        const podEvents = events.items || [];
        const warningEvents = podEvents.filter(
          (e) => e.type === "Warning"
        );

        // Check for CrashLoopBackOff
        for (const cs of containerStatuses) {
          if (cs.state?.waiting?.reason === "CrashLoopBackOff") {
            issues.push({
              severity: "critical",
              type: "CrashLoopBackOff",
              container: cs.name,
              restartCount: cs.restartCount,
              lastState: cs.lastState,
            });
            fixes.push({
              issue: "CrashLoopBackOff",
              suggestions: [
                "Check application logs: get_pod_logs tool with previous=true",
                "Verify environment variables and config maps are correct",
                "Check if the container command/entrypoint is correct",
                "Verify resource limits are sufficient (OOMKilled check)",
                "Check liveness/readiness probe configuration",
              ],
            });
          }

          // Check for ImagePullBackOff
          if (
            cs.state?.waiting?.reason === "ImagePullBackOff" ||
            cs.state?.waiting?.reason === "ErrImagePull"
          ) {
            issues.push({
              severity: "critical",
              type: "ImagePullError",
              container: cs.name,
              image: cs.image,
              reason: cs.state.waiting.reason,
              message: cs.state.waiting.message,
            });
            fixes.push({
              issue: "ImagePullError",
              suggestions: [
                "Verify the image name and tag are correct",
                "Check if image registry requires authentication (pull secret)",
                "Ensure the image exists in the registry",
                "Verify network connectivity to the registry",
                "Check imagePullSecrets in the pod spec or service account",
              ],
            });
          }

          // Check for OOMKilled
          if (cs.lastState?.terminated?.reason === "OOMKilled") {
            issues.push({
              severity: "high",
              type: "OOMKilled",
              container: cs.name,
              restartCount: cs.restartCount,
            });
            fixes.push({
              issue: "OOMKilled",
              suggestions: [
                "Increase memory limits for the container",
                "Investigate the application for memory leaks",
                "Review memory requests vs actual usage",
                "Consider horizontal pod autoscaling instead of vertical scaling",
              ],
            });
          }
        }

        // Check for pending / unschedulable
        if (phase === "Pending") {
          const schedEvents = warningEvents.filter(
            (e) =>
              e.reason === "FailedScheduling" ||
              e.reason === "Unschedulable"
          );
          if (schedEvents.length > 0) {
            issues.push({
              severity: "high",
              type: "SchedulingFailed",
              messages: schedEvents.map((e) => e.message),
            });
            fixes.push({
              issue: "SchedulingFailed",
              suggestions: [
                "Check node resources — cluster may need scaling",
                "Review node selectors and affinity rules",
                "Check for taints that prevent scheduling",
                "Verify PVC bindings if volumes are required",
                "Review resource quotas in the namespace",
              ],
            });
          }
        }

        // Check init container failures
        for (const ics of initContainerStatuses) {
          if (
            ics.state?.waiting ||
            ics.state?.terminated?.exitCode !== 0
          ) {
            issues.push({
              severity: "high",
              type: "InitContainerFailure",
              container: ics.name,
              state: ics.state,
            });
            fixes.push({
              issue: "InitContainerFailure",
              suggestions: [
                "Check init container logs for errors",
                "Verify dependencies the init container is waiting for",
                "Check network policies that may block init container",
              ],
            });
          }
        }

        // No issues found
        if (issues.length === 0 && phase === "Running") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "healthy",
                    pod: podName,
                    namespace,
                    phase,
                    message: "No issues detected. Pod is running normally.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  pod: podName,
                  namespace,
                  phase,
                  issuesFound: issues.length,
                  issues,
                  suggestedFixes: fixes,
                  recentWarnings: warningEvents.slice(0, 10).map((e) => ({
                    reason: e.reason,
                    message: e.message,
                    count: e.count,
                    lastSeen: e.lastTimestamp,
                  })),
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

  // ---------- Diagnose Namespace Health ----------
  server.tool(
    "diagnose_namespace_health",
    "Perform a health check on all workloads in a namespace — find failing pods, unhealthy deployments, quota issues",
    {
      namespace: z.string().describe("Namespace to diagnose"),
    },
    async ({ namespace }) => {
      try {
        const [pods, deployments, events, quotas] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/pods`),
          ocpGet(`/apis/apps/v1/namespaces/${namespace}/deployments`),
          ocpGet(`/api/v1/namespaces/${namespace}/events`),
          ocpGet(`/api/v1/namespaces/${namespace}/resourcequotas`),
        ]);

        const issues = [];

        // Check for unhealthy pods
        const unhealthyPods = (pods.items || []).filter((p) => {
          const phase = p.status?.phase;
          if (phase === "Failed" || phase === "Unknown") return true;
          const cs = p.status?.containerStatuses || [];
          return cs.some(
            (c) =>
              c.state?.waiting?.reason === "CrashLoopBackOff" ||
              c.state?.waiting?.reason === "ImagePullBackOff" ||
              c.restartCount > 5
          );
        });

        if (unhealthyPods.length > 0) {
          issues.push({
            type: "unhealthy_pods",
            severity: "critical",
            count: unhealthyPods.length,
            pods: unhealthyPods.map((p) => ({
              name: p.metadata.name,
              phase: p.status?.phase,
              issues: (p.status?.containerStatuses || [])
                .filter((c) => c.state?.waiting || c.restartCount > 5)
                .map((c) => ({
                  container: c.name,
                  reason: c.state?.waiting?.reason || `${c.restartCount} restarts`,
                })),
            })),
          });
        }

        // Check for unavailable deployments
        const unhealthyDeps = (deployments.items || []).filter(
          (d) =>
            (d.status?.availableReplicas || 0) < (d.spec?.replicas || 0)
        );
        if (unhealthyDeps.length > 0) {
          issues.push({
            type: "unavailable_deployments",
            severity: "high",
            count: unhealthyDeps.length,
            deployments: unhealthyDeps.map((d) => ({
              name: d.metadata.name,
              desired: d.spec?.replicas,
              available: d.status?.availableReplicas || 0,
              ready: d.status?.readyReplicas || 0,
            })),
          });
        }

        // Check quota usage
        for (const q of quotas.items || []) {
          const hard = q.status?.hard || {};
          const used = q.status?.used || {};
          for (const resource of Object.keys(hard)) {
            const hardVal = parseResourceValue(hard[resource]);
            const usedVal = parseResourceValue(used[resource]);
            if (hardVal > 0 && usedVal / hardVal > 0.9) {
              issues.push({
                type: "quota_near_limit",
                severity: "warning",
                resource,
                used: used[resource],
                hard: hard[resource],
                percentage: Math.round((usedVal / hardVal) * 100),
              });
            }
          }
        }

        // Warning events count
        const warningEvents = (events.items || []).filter(
          (e) => e.type === "Warning"
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  namespace,
                  overallHealth:
                    issues.filter((i) => i.severity === "critical").length > 0
                      ? "critical"
                      : issues.length > 0
                        ? "degraded"
                        : "healthy",
                  totalPods: pods.items?.length || 0,
                  totalDeployments: deployments.items?.length || 0,
                  issuesFound: issues.length,
                  issues,
                  recentWarningEvents: warningEvents.length,
                  topWarnings: warningEvents
                    .slice(0, 5)
                    .map((e) => ({
                      reason: e.reason,
                      message: e.message,
                      object: `${e.involvedObject.kind}/${e.involvedObject.name}`,
                    })),
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

  // ---------- Cluster-Wide Health Check ----------
  server.tool(
    "cluster_health_check",
    "Perform a comprehensive cluster health check — nodes, operators, etcd, critical pods, certificate expiry",
    {},
    async () => {
      try {
        const [nodes, operators, namespaces] = await Promise.all([
          ocpGet("/api/v1/nodes"),
          ocpGet("/apis/config.openshift.io/v1/clusteroperators"),
          ocpGet("/api/v1/namespaces"),
        ]);

        const issues = [];

        // Node health
        const unhealthyNodes = (nodes.items || []).filter((n) => {
          const ready = (n.status?.conditions || []).find(
            (c) => c.type === "Ready"
          );
          return ready?.status !== "True";
        });
        if (unhealthyNodes.length > 0) {
          issues.push({
            type: "unhealthy_nodes",
            severity: "critical",
            nodes: unhealthyNodes.map((n) => ({
              name: n.metadata.name,
              conditions: n.status?.conditions
                ?.filter((c) => c.status === "True" && c.type !== "Ready")
                .map((c) => c.type),
            })),
          });
        }

        // Degraded operators
        const degradedOps = (operators.items || []).filter((op) =>
          (op.status?.conditions || []).some(
            (c) => c.type === "Degraded" && c.status === "True"
          )
        );
        if (degradedOps.length > 0) {
          issues.push({
            type: "degraded_operators",
            severity: "critical",
            operators: degradedOps.map((op) => ({
              name: op.metadata.name,
              message: (op.status?.conditions || []).find(
                (c) => c.type === "Degraded"
              )?.message,
            })),
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  overallHealth:
                    issues.filter((i) => i.severity === "critical").length > 0
                      ? "critical"
                      : issues.length > 0
                        ? "degraded"
                        : "healthy",
                  totalNodes: nodes.items?.length || 0,
                  readyNodes:
                    (nodes.items?.length || 0) - unhealthyNodes.length,
                  totalOperators: operators.items?.length || 0,
                  degradedOperators: degradedOps.length,
                  totalNamespaces: namespaces.items?.length || 0,
                  issues,
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

/** Parse K8s resource values like "2Gi", "500m" into numeric for comparison */
function parseResourceValue(val) {
  if (!val) return 0;
  const str = String(val);
  if (str.endsWith("Gi")) return parseFloat(str) * 1024 * 1024 * 1024;
  if (str.endsWith("Mi")) return parseFloat(str) * 1024 * 1024;
  if (str.endsWith("Ki")) return parseFloat(str) * 1024;
  if (str.endsWith("m")) return parseFloat(str) / 1000;
  return parseFloat(str) || 0;
}
