/**
 * Error → Root Cause Knowledge Base
 *
 * Comprehensive mapping of Kubernetes/OpenShift error patterns to root causes,
 * explanations, and remediation steps. Used by the AI pipeline to enrich
 * diagnostic context and improve response accuracy.
 */

const ERRORS = [];

function entry(pattern, rootCause, explanation, remediation, severity, platformNotes = {}, relatedErrors = []) {
  ERRORS.push({ pattern, rootCause, explanation, remediation, severity, platformNotes, relatedErrors });
}

// ---------------------------------------------------------------------------
// Pod Scheduling Failures
// ---------------------------------------------------------------------------
entry("FailedScheduling.*Insufficient cpu",
  "Node CPU exhausted",
  "No node has enough allocatable CPU to satisfy the pod's resource requests.",
  ["Reduce pod CPU requests", "Add nodes to the cluster", "Remove low-priority workloads", "Check if requests are set too high relative to actual usage"],
  "critical",
  { eks: "Scale EKS node group or add Karpenter provisioner", aks: "Scale AKS node pool via az aks nodepool scale", gke: "Enable GKE cluster autoscaler or add node pool" },
  ["FailedScheduling.*Insufficient memory"]
);
entry("FailedScheduling.*Insufficient memory",
  "Node memory exhausted",
  "No node has enough allocatable memory for the pod's resource requests.",
  ["Reduce pod memory requests", "Add nodes to the cluster", "Investigate memory-heavy workloads with 'top pods'"],
  "critical",
  { eks: "Scale EKS node group or enable Karpenter", aks: "Scale AKS node pool", gke: "Enable GKE autoscaler" },
  ["FailedScheduling.*Insufficient cpu"]
);
entry("FailedScheduling.*taint",
  "Taint/toleration mismatch",
  "The pod does not tolerate the taint on the target node(s).",
  ["Add matching tolerations to the pod spec", "Remove the taint from the node: kubectl taint nodes <node> <key>-", "Check if taint was applied intentionally"],
  "warning"
);
entry("FailedScheduling.*node affinity",
  "Node affinity mismatch",
  "The pod's nodeAffinity/nodeSelector doesn't match any available node labels.",
  ["Update nodeSelector or nodeAffinity in the pod spec", "Label nodes to match: kubectl label node <node> <key>=<value>", "Check if required nodes are in Ready state"],
  "warning"
);
entry("FailedScheduling.*persistentvolumeclaim",
  "PVC not bound",
  "The pod references a PersistentVolumeClaim that hasn't been provisioned or bound.",
  ["Check PVC status: kubectl get pvc", "Verify StorageClass exists and is provisioning", "Check if storage backend is healthy"],
  "critical",
  { eks: "Verify EBS CSI driver is installed: kubectl get pods -n kube-system -l app=ebs-csi-controller", aks: "Check Azure Disk CSI driver", gke: "Verify GCE PD CSI driver" }
);
entry("FailedScheduling.*exceeded quota",
  "ResourceQuota exceeded",
  "The namespace's ResourceQuota prevents scheduling additional pods.",
  ["Check quota: kubectl describe quota -n <ns>", "Request quota increase from admin", "Delete unused pods/deployments in the namespace"],
  "warning"
);
entry("FailedScheduling.*unbound immediate PersistentVolumeClaims",
  "Storage not provisioned",
  "PVC with immediate binding mode has no matching PV available.",
  ["Check StorageClass provisioner health", "Verify cloud provider storage quota", "Check if PV exists with matching spec"],
  "critical"
);
entry("FailedScheduling.*too many pods",
  "Node pod limit reached",
  "The node has reached its maximum pod capacity (default 110 per node, lower on some platforms).",
  ["Add more nodes to the cluster", "Check max-pods setting on kubelet", "Consolidate small pods"],
  "warning",
  { eks: "EKS default is 110 pods/node, limited by ENI capacity on smaller instances" }
);
entry("FailedScheduling.*unschedulable",
  "All nodes cordoned",
  "All candidate nodes are marked as unschedulable (cordoned).",
  ["Uncordon nodes: kubectl uncordon <node>", "Check if maintenance or drain is in progress", "Add new nodes if cluster is scaling down"],
  "critical"
);
entry("FailedScheduling.*TopologySpreadConstraint",
  "Topology spread unsatisfiable",
  "Cannot satisfy pod topology spread constraints across available zones/nodes.",
  ["Relax maxSkew in topology spread constraint", "Add nodes in underrepresented zones", "Change whenUnsatisfiable to ScheduleAnyway"],
  "warning"
);
entry("FailedScheduling.*inter-pod anti-affinity",
  "Anti-affinity conflict",
  "Pod anti-affinity rules prevent scheduling on any available node.",
  ["Add more nodes to different failure domains", "Relax anti-affinity from Required to Preferred", "Check if too many replicas for available nodes"],
  "warning"
);

// ---------------------------------------------------------------------------
// Container Runtime Errors
// ---------------------------------------------------------------------------
entry("CrashLoopBackOff.*exit code 1",
  "Application error",
  "The container exited with code 1 (general application error). Check container logs for the specific error.",
  ["Check logs: kubectl logs <pod> --previous", "Verify environment variables and config", "Check application health/readiness endpoints", "Verify database/service connectivity"],
  "critical"
);
entry("CrashLoopBackOff.*exit code 137",
  "SIGKILL (OOM or external kill)",
  "Container received SIGKILL — most commonly due to exceeding memory limit (OOMKilled) or an external signal.",
  ["Increase memory limits in container spec", "Profile application memory usage", "Check for memory leaks", "Review if kernel OOM killer is active on the node"],
  "critical",
  {}, ["OOMKilled"]
);
entry("CrashLoopBackOff.*exit code 139",
  "SIGSEGV (segmentation fault)",
  "Container crashed due to a segmentation fault — typically a bug in native code.",
  ["Check application core dumps", "Update base image and dependencies", "Run application with address sanitizer for debugging"],
  "critical"
);
entry("CrashLoopBackOff.*exit code 143",
  "SIGTERM timeout",
  "Container didn't stop within terminationGracePeriodSeconds after SIGTERM.",
  ["Implement proper SIGTERM handler in application", "Increase terminationGracePeriodSeconds", "Check for long-running shutdown operations"],
  "warning"
);
entry("CrashLoopBackOff.*exit code 126",
  "Permission denied on entrypoint",
  "The container entrypoint exists but is not executable.",
  ["Check file permissions on entrypoint script: chmod +x", "Verify securityContext.runAsUser can execute the file", "Check if filesystem is mounted read-only"],
  "critical",
  { openshift: "Check SCC — restricted SCC may prevent running as required UID" }
);
entry("CrashLoopBackOff.*exit code 127",
  "Command not found",
  "The container entrypoint or command does not exist in the image.",
  ["Verify the command path in the Dockerfile/container spec", "Check if the base image contains the expected binaries", "Try running with 'sh -c' wrapper"],
  "critical"
);
entry("CrashLoopBackOff.*exit code 2",
  "Shell misuse or missing argument",
  "Exit code 2 typically means incorrect shell usage or a missing required argument.",
  ["Check command arguments in the pod spec", "Verify environment variables are set", "Test the command manually in a debug container"],
  "warning"
);
entry("OOMKilled",
  "Container exceeded memory limit",
  "The container used more memory than its resource limit allows, and was killed by the kernel OOM killer.",
  ["Increase memory limit: kubectl set resources deployment/<name> --limits=memory=<new>", "Profile application memory usage", "Check for memory leaks (heap dumps, pprof)", "Consider setting memory request = limit to avoid overcommit"],
  "critical",
  {}, ["CrashLoopBackOff.*exit code 137"]
);
entry("CreateContainerConfigError",
  "ConfigMap or Secret not found",
  "The container references a ConfigMap or Secret that doesn't exist in the namespace.",
  ["Check ConfigMap/Secret exists: kubectl get cm,secret -n <ns>", "Verify the key name matches what the container expects", "Check if the reference uses optional: false"],
  "critical"
);
entry("CreateContainerError.*not found",
  "Image entrypoint issue",
  "The container could not be created — typically the entrypoint is missing or the image is corrupt.",
  ["Verify image entrypoint/CMD in Dockerfile", "Pull and inspect the image locally", "Check if image layers are complete"],
  "critical"
);
entry("RunContainerError",
  "Container runtime failure",
  "The container runtime (CRI-O/containerd) failed to start the container.",
  ["Check node container runtime status", "Verify container image is compatible with the runtime", "Check node disk space and inode count"],
  "critical",
  { openshift: "Check CRI-O status: oc debug node/<node> -- chroot /host systemctl status crio" }
);
entry("PostStartHookError",
  "PostStart lifecycle hook failed",
  "The container's postStart lifecycle hook returned an error.",
  ["Check the postStart hook command/httpGet configuration", "Verify the target service is reachable from the container", "Review hook timeout settings"],
  "warning"
);
entry("BackOff.*restarting failed container",
  "Container restart backoff",
  "The container has failed multiple times and Kubernetes is increasing the restart delay.",
  ["Check previous logs: kubectl logs <pod> --previous", "Look at exit code to determine failure type", "Check events for more context"],
  "critical"
);

// ---------------------------------------------------------------------------
// Image Pull Errors
// ---------------------------------------------------------------------------
entry("ImagePullBackOff.*unauthorized",
  "Registry authentication failed",
  "The container runtime cannot authenticate with the image registry.",
  ["Create/update imagePullSecret: kubectl create secret docker-registry", "Verify secret is referenced in pod spec or serviceAccount", "Check registry credentials haven't expired"],
  "critical",
  { openshift: "Check internal registry auth: oc whoami -t", eks: "For ECR: ensure node IAM role has ecr:GetAuthorizationToken", aks: "For ACR: attach ACR to AKS cluster: az aks update --attach-acr" }
);
entry("ImagePullBackOff.*not found",
  "Image tag doesn't exist",
  "The specified image or tag was not found in the registry.",
  ["Verify image name and tag: kubectl describe pod <pod>", "Check if the tag was pushed to the registry", "Try with a known good tag like 'latest' to isolate"],
  "critical"
);
entry("ImagePullBackOff.*manifest unknown",
  "Image manifest deleted",
  "The image tag exists but its manifest has been removed from the registry.",
  ["Rebuild and push the image", "Check registry garbage collection schedule", "Pin images by digest instead of tag"],
  "critical"
);
entry("ImagePullBackOff.*timeout",
  "Registry unreachable",
  "The container runtime timed out trying to reach the image registry.",
  ["Check network connectivity to registry", "Verify DNS resolution for registry hostname", "Check firewall/proxy rules", "Try pulling from the node directly"],
  "critical",
  { eks: "Check VPC endpoints for ECR", aks: "Check NSG rules and private link config", gke: "Check VPC firewall rules" }
);
entry("ErrImagePull.*x509",
  "Registry TLS certificate not trusted",
  "The container runtime doesn't trust the registry's TLS certificate.",
  ["Add registry CA to node trust store", "Configure insecure registry in container runtime (not recommended for prod)", "Use a proper certificate from a trusted CA"],
  "critical",
  { openshift: "Add CA to cluster: oc create configmap registry-ca --from-file=<ca.crt> -n openshift-config" }
);
entry("ErrImagePull.*denied",
  "Registry access denied",
  "The authenticated user/role doesn't have permission to pull from this repository.",
  ["Check registry repository permissions", "Verify the imagePullSecret has pull access", "Check RBAC on the registry side"],
  "critical"
);

// ---------------------------------------------------------------------------
// Networking Errors
// ---------------------------------------------------------------------------
entry("dial tcp.*connection refused",
  "Target service not listening",
  "The connection was refused — the target process is not running or not listening on the expected port.",
  ["Verify the target pod is running: kubectl get pods", "Check the target port matches the service port", "Test connectivity: kubectl exec <pod> -- curl <service>:<port>"],
  "critical"
);
entry("dial tcp.*i/o timeout",
  "Network connectivity blocked",
  "The connection timed out — NetworkPolicy, firewall, or wrong IP may be blocking traffic.",
  ["Check NetworkPolicies: kubectl get networkpolicy -n <ns>", "Verify service endpoints: kubectl get endpoints <svc>", "Test DNS resolution: kubectl exec <pod> -- nslookup <svc>"],
  "critical"
);
entry("no endpoints available",
  "Service has no backing pods",
  "The Service selector doesn't match any running pods, or all matching pods are NotReady.",
  ["Check pod labels match service selector", "Verify pods are in Running/Ready state", "Check readiness probe configuration"],
  "warning"
);
entry("upstream connect error",
  "Envoy/Istio sidecar connectivity issue",
  "The Istio/Envoy sidecar proxy cannot connect to the upstream service.",
  ["Check if sidecar injection is enabled", "Verify DestinationRule and VirtualService config", "Check mTLS settings between services"],
  "warning",
  { openshift: "Check OSSM ControlPlane status: oc get smcp -n istio-system" }
);
entry("DNS resolution failed|NXDOMAIN|could not resolve",
  "DNS resolution failure",
  "CoreDNS cannot resolve the service/hostname.",
  ["Check CoreDNS pods: kubectl get pods -n kube-system -l k8s-app=kube-dns", "Verify service name is correct (format: <svc>.<ns>.svc.cluster.local)", "Check CoreDNS configmap for custom entries"],
  "critical"
);
entry("connection reset by peer",
  "Server-side connection reset",
  "The remote end reset the TCP connection — typically a server crash or TLS mismatch.",
  ["Check target pod logs for crashes", "Verify TLS configuration matches between client and server", "Check if a load balancer is terminating connections"],
  "warning"
);
entry("TLS handshake timeout",
  "TLS handshake failure",
  "The TLS handshake timed out — certificate issue or high network latency.",
  ["Verify TLS certificate validity", "Check certificate chain is complete", "Test with openssl s_client"],
  "warning"
);
entry("net/http: request canceled",
  "Context deadline exceeded",
  "The HTTP request was canceled due to timeout — the client or gateway timeout is too low.",
  ["Increase timeout settings on the client/ingress", "Optimize the backend response time", "Check if the backend is overloaded"],
  "warning"
);
entry("Service Unavailable.*503",
  "Backend overloaded or not ready",
  "HTTP 503 means the backend cannot handle the request — it's overloaded or not ready.",
  ["Check backend pod health and readiness", "Scale up the deployment if under load", "Check HPA settings for autoscaling"],
  "warning"
);
entry("Gateway Timeout.*504",
  "Upstream took too long",
  "HTTP 504 means the upstream server did not respond within the gateway timeout.",
  ["Increase ingress/route timeout annotation", "Optimize backend query performance", "Check database connectivity from backend pods"],
  "warning"
);
entry("Too Many Requests.*429",
  "Rate limiting active",
  "HTTP 429 means rate limiting is being enforced.",
  ["Implement client-side retry with exponential backoff", "Request rate limit increase", "Distribute load across more clients"],
  "info"
);

// ---------------------------------------------------------------------------
// Storage Errors
// ---------------------------------------------------------------------------
entry("FailedMount.*not found",
  "PV or PVC doesn't exist",
  "The pod references a volume (PV/PVC) that cannot be found.",
  ["Create the PVC: kubectl apply -f <pvc.yaml>", "Verify PVC name in pod volume spec", "Check namespace matches"],
  "critical"
);
entry("FailedMount.*already mounted|multi-attach",
  "ReadWriteOnce volume contention",
  "The volume is ReadWriteOnce and already mounted on another node.",
  ["Use ReadWriteMany if supported by storage class", "Ensure only one pod accesses the volume at a time", "Delete the stale VolumeAttachment: kubectl delete volumeattachment <name>"],
  "critical"
);
entry("FailedMount.*timeout",
  "Storage backend slow or unreachable",
  "The volume mount timed out — the storage backend is slow or unreachable.",
  ["Check storage backend health", "Verify network connectivity to storage", "Check CSI driver logs"],
  "critical",
  { eks: "Check EBS volume status in AWS console", aks: "Check Azure Disk status in portal", gke: "Check GCE Persistent Disk status" }
);
entry("VolumeResizeFailed",
  "CSI driver doesn't support expansion",
  "The storage class or CSI driver does not support volume expansion.",
  ["Check storageClass.allowVolumeExpansion field", "Use a storage class that supports expansion", "Migrate data to a larger volume manually"],
  "warning"
);
entry("ProvisioningFailed",
  "StorageClass misconfigured",
  "The dynamic provisioner failed to create a volume — StorageClass may be misconfigured.",
  ["Check StorageClass provisioner name", "Verify CSI driver is deployed and healthy", "Check cloud provider storage quotas"],
  "critical"
);

// ---------------------------------------------------------------------------
// RBAC / Security Errors
// ---------------------------------------------------------------------------
entry("forbidden.*cannot.*create|cannot create",
  "Missing RBAC role for create",
  "The service account lacks permission to create the requested resource.",
  ["Create a RoleBinding: kubectl create rolebinding <name> --role=<role> --serviceaccount=<ns>:<sa>", "Check existing roles: kubectl get roles,clusterroles", "Verify the correct service account is used"],
  "warning"
);
entry("unable to validate against any security context constraint",
  "No matching SCC (OpenShift)",
  "The pod's security context doesn't match any available SecurityContextConstraint.",
  ["Check available SCCs: oc get scc", "Add SCC to service account: oc adm policy add-scc-to-user <scc> -z <sa> -n <ns>", "Adjust pod securityContext to match restricted SCC"],
  "critical",
  { openshift: "Use 'oc adm policy who-can use scc restricted' to check access" }
);
entry("admission webhook.*denied",
  "Admission webhook rejected the request",
  "A mutating or validating admission webhook denied the resource creation/update.",
  ["Check webhook configuration: kubectl get validatingwebhookconfigurations", "Review webhook logs for denial reason", "Check if policy engine (OPA/Kyverno) is blocking"],
  "warning"
);
entry("pods.*is forbidden",
  "ServiceAccount lacks pod permissions",
  "The pod's service account doesn't have permission to perform the requested operation.",
  ["Create appropriate Role and RoleBinding", "Check if RBAC is correctly configured for the namespace", "Verify service account exists and is referenced in pod spec"],
  "warning"
);

// ---------------------------------------------------------------------------
// Operator/Controller Errors
// ---------------------------------------------------------------------------
entry("Degraded:\\s*True",
  "Operator health check failed",
  "The operator reports a degraded condition — its functionality is impaired.",
  ["Check operator pod logs", "Verify operator dependencies are healthy", "Check if operator needs an update"],
  "warning",
  { openshift: "Check: oc get clusteroperator <name> -o yaml" }
);
entry("Available:\\s*False",
  "Operator not functioning",
  "The operator is not available — it cannot perform its primary function.",
  ["Check operator pod status and logs", "Verify CRDs are installed", "Try restarting the operator pod"],
  "critical"
);
entry("ReconcileError",
  "Controller reconciliation failed",
  "The controller's reconcile loop encountered an error.",
  ["Check controller-manager logs", "Verify the custom resource spec is valid", "Check if dependent resources exist"],
  "warning"
);
entry("Upgradeable.*False",
  "Operator blocking cluster upgrade",
  "The operator condition reports it is not upgradeable — this blocks cluster upgrades.",
  ["Check operator release notes for upgrade prerequisites", "Resolve the operator condition: oc get co <name> -o yaml", "Update the operator before upgrading the cluster"],
  "warning",
  { openshift: "Common on OpenShift — check 'oc adm upgrade' for blockers" }
);

// ---------------------------------------------------------------------------
// Upgrade/Version Errors
// ---------------------------------------------------------------------------
entry("UpgradePreconditionFailed",
  "Cluster not ready for upgrade",
  "One or more preconditions for the cluster upgrade have not been met.",
  ["Run preflight check: /precheck upgrade", "Resolve degraded operators", "Ensure all nodes are Ready", "Check for deprecated API usage"],
  "critical",
  { openshift: "Use: oc adm upgrade --include-not-recommended for full list" }
);
entry("APIRemovedInVersion|removed API",
  "Deprecated API still in use",
  "Workloads are using Kubernetes APIs that are removed in the target version.",
  ["Scan for deprecated APIs: kubectl api-resources --api-group=<group>", "Update manifests to use new API versions", "Check Helm charts for outdated apiVersion fields"],
  "warning"
);

// ---------------------------------------------------------------------------
// HPA / Autoscaling Errors
// ---------------------------------------------------------------------------
entry("FailedGetResourceMetric|unable to get metrics",
  "Metrics server not available",
  "The HPA cannot fetch resource metrics — metrics-server may not be running.",
  ["Check metrics-server: kubectl get pods -n kube-system -l k8s-app=metrics-server", "Verify metrics-server has correct API access", "Check if custom metrics adapter is configured"],
  "warning"
);
entry("FailedComputeMetricsReplicas",
  "HPA cannot compute target replicas",
  "The HPA failed to compute the desired replica count from available metrics.",
  ["Verify target metric name and type in HPA spec", "Check if pods have resource requests set", "Ensure metrics are being collected"],
  "warning"
);
entry("ScalingActive.*False",
  "HPA disabled or blocked",
  "The HPA is not actively scaling — it may be disabled or unable to function.",
  ["Check HPA conditions: kubectl describe hpa <name>", "Verify minReplicas <= maxReplicas", "Check if scale target exists"],
  "info"
);

// ---------------------------------------------------------------------------
// Platform-Specific Errors
// ---------------------------------------------------------------------------
entry("security context constraint.*denied|SCC.*denied",
  "SCC denied (OpenShift)",
  "The SecurityContextConstraint policy is denying the pod's security context.",
  ["Check which SCC is needed: oc get pod <pod> -o yaml | grep scc", "Grant SCC: oc adm policy add-scc-to-user <scc> -z <sa> -n <ns>", "Use 'restricted' SCC with adjusted securityContext"],
  "critical",
  { openshift: "Most common fix: adjust pod securityContext to match restricted-v2 SCC" }
);
entry("MachineConfig.*render.*fail|mc render error",
  "MachineConfig render failure (OpenShift)",
  "The MachineConfigDaemon failed to render the machine configuration.",
  ["Check MCO logs: oc logs -n openshift-machine-config-operator -l k8s-app=machine-config-daemon", "Verify MachineConfig syntax: oc get mc <name> -o yaml", "Check for conflicting MachineConfigs"],
  "critical",
  { openshift: "MC conflicts cause node drain failures and block upgrades" }
);
entry("route.*admission.*rejected|admission.*route",
  "Route admission error (OpenShift)",
  "The OpenShift router admission webhook rejected the Route.",
  ["Check Route host uniqueness across namespaces", "Verify TLS configuration on the Route", "Check router shard configuration"],
  "warning",
  { openshift: "Each hostname must be unique cluster-wide" }
);
entry("vpc-cni.*error|aws-node.*error|ipamd",
  "VPC CNI error (EKS)",
  "The AWS VPC CNI plugin encountered an error — likely IP exhaustion or ENI limits.",
  ["Check aws-node daemonset: kubectl get ds aws-node -n kube-system", "Verify subnet has available IPs", "Consider using prefix delegation for more IPs per ENI", "Check ENI limits for instance type"],
  "critical",
  { eks: "Common on c5.large and t3.medium with many pods — consider larger instance type" }
);
entry("azure.*identity.*error|aad.*error",
  "Azure identity error (AKS)",
  "Azure Active Directory or Managed Identity authentication failed.",
  ["Verify managed identity binding: az identity list", "Check pod identity webhook: kubectl get pods -n kube-system -l app=aad-pod-identity", "Ensure AzureIdentity and AzureIdentityBinding resources exist"],
  "critical",
  { aks: "Use workload identity (newer) instead of pod identity for better security" }
);
entry("binary.*authorization.*denied",
  "Binary Authorization denied (GKE)",
  "Google Binary Authorization policy is blocking the image deployment.",
  ["Check Binary Authorization policy: gcloud container binauthz policy export", "Create attestation for the image", "Add a break-glass annotation for emergency deploys"],
  "warning",
  { gke: "Use break-glass: add annotation 'alpha.image-policy.k8s.io/break-glass: true'" }
);

// ---------------------------------------------------------------------------
// Build the regex lookup index
// ---------------------------------------------------------------------------
const REGEX_INDEX = ERRORS.map(e => ({
  regex: new RegExp(e.pattern, "i"),
  entry: e,
}));

const REASON_INDEX = new Map();
for (const e of ERRORS) {
  const reasons = e.pattern.match(/CrashLoopBackOff|OOMKilled|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|CreateContainerError|RunContainerError|FailedScheduling|FailedMount|BackOff|PostStartHookError|Degraded|ReconcileError/gi) || [];
  for (const r of reasons) {
    const key = r.toLowerCase();
    if (!REASON_INDEX.has(key)) REASON_INDEX.set(key, []);
    REASON_INDEX.get(key).push(e);
  }
}

export function lookupError(errorPattern, platform) {
  if (!errorPattern) return null;
  for (const { regex, entry } of REGEX_INDEX) {
    if (regex.test(errorPattern)) {
      return {
        ...entry,
        platformNotes: platform && entry.platformNotes[platform]
          ? { [platform]: entry.platformNotes[platform] }
          : entry.platformNotes,
      };
    }
  }
  return null;
}

export function findMatchingErrors(logLines, events) {
  const matches = [];
  const seen = new Set();
  const allLines = [
    ...(Array.isArray(logLines) ? logLines : []),
    ...(Array.isArray(events) ? events : []),
  ];
  for (let i = 0; i < allLines.length; i++) {
    const line = String(allLines[i]);
    for (const { regex, entry } of REGEX_INDEX) {
      if (regex.test(line) && !seen.has(entry.pattern)) {
        seen.add(entry.pattern);
        matches.push({ line: i, text: line.substring(0, 200), entry });
      }
    }
  }
  return matches;
}

export function getErrorsForReason(reason) {
  if (!reason) return [];
  const key = reason.toLowerCase();
  // Direct lookup
  if (REASON_INDEX.has(key)) return REASON_INDEX.get(key);
  // Partial match
  for (const [k, v] of REASON_INDEX) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  // Regex fallback
  return ERRORS.filter(e => new RegExp(e.pattern, "i").test(reason));
}
