/**
 * Error Knowledge Base — comprehensive error-to-root-cause mapping for
 * Kubernetes and OpenShift troubleshooting.
 *
 * Provides O(1) lookup of known error patterns, regex-based matching against
 * log lines and events, and reason-based grouping for pod status conditions.
 *
 * Coverage:
 *   - Pod scheduling failures
 *   - Container runtime errors (CrashLoopBackOff, OOMKilled, etc.)
 *   - Image pull errors
 *   - Networking errors
 *   - Storage / volume errors
 *   - RBAC / security errors
 *   - Operator / controller errors
 *   - Upgrade / version errors
 *   - Resource quota errors
 *   - HPA / autoscaling errors
 *   - Platform-specific errors (OpenShift, EKS, AKS, GKE)
 */

// ---------------------------------------------------------------------------
// Internal knowledge store
// ---------------------------------------------------------------------------

/**
 * Each entry in the knowledge base has:
 *   id         — unique stable identifier
 *   pattern    — human-readable pattern description
 *   regex      — RegExp for matching against log lines / event messages
 *   rootCause  — short root-cause label
 *   explanation — detailed explanation
 *   remediation — ordered steps to fix
 *   severity   — "critical" | "warning" | "info"
 *   category   — broad category tag
 *   reasons    — pod status reasons this error relates to (for getErrorsForReason)
 *   platformNotes — platform-specific guidance
 *   relatedErrors — ids of errors that often co-occur
 */

const _entries = [];

function _add(entry) {
  _entries.push({
    id: entry.id,
    pattern: entry.pattern,
    regex: entry.regex instanceof RegExp ? entry.regex : new RegExp(entry.regex, "i"),
    rootCause: entry.rootCause,
    explanation: entry.explanation,
    remediation: entry.remediation || [],
    severity: entry.severity || "warning",
    category: entry.category || "general",
    reasons: entry.reasons || [],
    platformNotes: entry.platformNotes || {},
    relatedErrors: entry.relatedErrors || [],
  });
}

// ---------------------------------------------------------------------------
// 1. POD SCHEDULING FAILURES  (20+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "sched-insufficient-cpu",
  pattern: "FailedScheduling + Insufficient cpu",
  regex: /FailedScheduling.*Insufficient\s+cpu/i,
  rootCause: "Node pool lacks sufficient CPU capacity",
  explanation:
    "The scheduler cannot place the pod because no node has enough allocatable CPU to satisfy the pod's resource requests. This typically means the cluster needs horizontal scaling or pod CPU requests are set too high.",
  remediation: [
    "Review pod CPU requests with: kubectl describe pod <name>",
    "Compare against node allocatable CPU: kubectl describe nodes | grep -A5 Allocatable",
    "Lower pod cpu requests if over-provisioned",
    "Add nodes or enable cluster autoscaler to expand the node pool",
    "Check for pods in Completed/Evicted state consuming requests: kubectl get pods --field-selector=status.phase!=Running",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    openshift: "Check MachineSet replicas and MachineAutoscaler CRs",
    eks: "Verify Karpenter provisioner or Cluster Autoscaler ASG limits",
    aks: "Check AKS node pool autoscaling min/max in az aks nodepool show",
    gke: "Verify GKE node auto-provisioning or node pool autoscaling",
  },
  relatedErrors: ["sched-insufficient-memory", "quota-exceeded"],
});

_add({
  id: "sched-insufficient-memory",
  pattern: "FailedScheduling + Insufficient memory",
  regex: /FailedScheduling.*Insufficient\s+memory/i,
  rootCause: "Node pool lacks sufficient memory capacity",
  explanation:
    "No node has enough allocatable memory to satisfy the pod's memory requests. The cluster may need more or larger nodes, or the pod's memory requests may be inflated.",
  remediation: [
    "Review pod memory requests: kubectl describe pod <name>",
    "Check node allocatable memory: kubectl describe nodes | grep -A5 Allocatable",
    "Reduce pod memory requests if over-provisioned",
    "Scale out the node pool or switch to a larger instance type",
    "Evict idle pods or rebalance workloads across namespaces",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    openshift: "Check MachineSet instance type and MachineAutoscaler",
    eks: "Review Karpenter node template instance families or ASG instance types",
    aks: "Use az aks nodepool scale or adjust VM SKU",
    gke: "Enable node auto-provisioning with appropriate resource limits",
  },
  relatedErrors: ["sched-insufficient-cpu", "quota-exceeded"],
});

_add({
  id: "sched-taint-toleration",
  pattern: "FailedScheduling + node(s) had taint",
  regex: /FailedScheduling.*node\(s\)\s+had\s+taint/i,
  rootCause: "Taint/toleration mismatch",
  explanation:
    "All candidate nodes have taints that the pod does not tolerate. This commonly happens with dedicated node pools (e.g. GPU, infra) or when nodes are drained/cordoned.",
  remediation: [
    "List node taints: kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints",
    "Add matching tolerations to the pod spec",
    "Or remove/modify the taint if it was applied by mistake: kubectl taint node <node> <key>-",
    "For infra nodes, ensure workload pods target the correct pool",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    openshift: "Infra nodes carry node-role.kubernetes.io/infra taint by default; add toleration or target worker nodes",
    eks: "EKS managed node groups may apply CriticalAddonsOnly taint on system pools",
    gke: "GKE Autopilot auto-taints certain workloads; check sandbox constraints",
  },
  relatedErrors: ["sched-node-affinity"],
});

_add({
  id: "sched-node-affinity",
  pattern: "FailedScheduling + node(s) didn't match Pod's node affinity",
  regex: /FailedScheduling.*node\(s\)\s+didn.t\s+match\s+(Pod.s\s+)?node\s+affinity/i,
  rootCause: "Node affinity rules exclude all available nodes",
  explanation:
    "The pod has requiredDuringSchedulingIgnoredDuringExecution node affinity that no current node satisfies. This is often due to missing labels on nodes.",
  remediation: [
    "Inspect the pod's nodeAffinity: kubectl get pod <name> -o jsonpath='{.spec.affinity}'",
    "List node labels: kubectl get nodes --show-labels",
    "Add the required label to target nodes: kubectl label node <node> <key>=<value>",
    "Or relax the affinity rule to preferredDuringScheduling",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    openshift: "MachineSet metadata.labels propagate to nodes; update the MachineSet for persistence",
  },
  relatedErrors: ["sched-taint-toleration", "sched-topology-spread"],
});

_add({
  id: "sched-pvc-not-found",
  pattern: "FailedScheduling + persistentvolumeclaim not found",
  regex: /FailedScheduling.*persistentvolumeclaim.*not\s+found/i,
  rootCause: "Referenced PVC does not exist",
  explanation:
    "The pod references a PersistentVolumeClaim that has not been created in the same namespace. The scheduler cannot proceed until the PVC exists and is bound.",
  remediation: [
    "Verify the PVC name in the pod spec matches an existing PVC: kubectl get pvc -n <ns>",
    "Create the missing PVC with the correct storageClassName and access mode",
    "If using a StatefulSet, confirm volumeClaimTemplates are correct",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["storage-pvc-binding", "storage-provisioning-failed"],
});

_add({
  id: "sched-exceeded-quota",
  pattern: "FailedScheduling + exceeded quota",
  regex: /FailedScheduling.*exceeded\s+quota/i,
  rootCause: "ResourceQuota limit reached",
  explanation:
    "The namespace has a ResourceQuota and creating this pod would exceed the allowed CPU, memory, or pod count. The scheduler rejects the pod before it can be placed.",
  remediation: [
    "Check quota usage: kubectl describe resourcequota -n <ns>",
    "Either increase the quota or free resources by scaling down other workloads",
    "Review pod requests — they may be inflated relative to actual usage",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    openshift: "ClusterResourceQuota may also apply across namespaces; check with oc describe clusterresourcequota",
  },
  relatedErrors: ["quota-exceeded", "quota-insufficient"],
});

_add({
  id: "sched-unbound-pvc",
  pattern: "FailedScheduling + pod has unbound immediate PersistentVolumeClaims",
  regex: /FailedScheduling.*unbound\s+immediate\s+PersistentVolumeClaim/i,
  rootCause: "PVC not provisioned — storage backend issue",
  explanation:
    "The PVC exists but has not been bound to a PersistentVolume. This means either the StorageClass provisioner failed, no matching PV exists, or the storage backend is unreachable.",
  remediation: [
    "Check PVC status: kubectl describe pvc <name> -n <ns>",
    "Look at PVC events for provisioner errors",
    "Verify StorageClass exists and provisioner is running: kubectl get sc",
    "Ensure the storage backend (NFS, Ceph, EBS, etc.) is healthy",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["storage-provisioning-failed", "storage-pvc-binding"],
});

_add({
  id: "sched-too-many-pods",
  pattern: "FailedScheduling + too many pods",
  regex: /FailedScheduling.*too\s+many\s+pods/i,
  rootCause: "Node pod limit reached (default 110 per node)",
  explanation:
    "Every candidate node has already reached its maximum pod count (kubelet --max-pods, default 110). Even if CPU/memory are available, no more pods can be placed.",
  remediation: [
    "Check current pod counts per node: kubectl get pods --all-namespaces -o wide | awk '{print $8}' | sort | uniq -c",
    "Add more nodes to the cluster",
    "Increase --max-pods on kubelet (requires node restart)",
    "Consolidate small pods or use sidecar patterns to reduce pod count",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    eks: "EKS ENI-based networking limits pods per node based on instance type; check max-pods calculator",
    aks: "AKS defaults to 30 pods/node with kubenet, 250 with Azure CNI",
    gke: "GKE Autopilot has per-node pod limits based on pod resource requests",
  },
  relatedErrors: ["sched-insufficient-cpu", "sched-insufficient-memory"],
});

_add({
  id: "sched-nodes-unschedulable",
  pattern: "FailedScheduling + node(s) were unschedulable",
  regex: /FailedScheduling.*node\(s\)\s+were\s+unschedulable/i,
  rootCause: "All nodes are cordoned or marked unschedulable",
  explanation:
    "Every node in the cluster has spec.unschedulable=true, typically because they were cordoned for maintenance. No workloads can be scheduled until at least one node is uncordoned.",
  remediation: [
    "List node status: kubectl get nodes",
    "Uncordon healthy nodes: kubectl uncordon <node>",
    "If maintenance is in progress, wait for completion or add new nodes",
    "Check if a DaemonSet or operator cordoned nodes unexpectedly",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    openshift: "Machine health check may have cordoned degraded nodes; check oc get machines -A",
  },
  relatedErrors: ["sched-taint-toleration"],
});

_add({
  id: "sched-topology-spread",
  pattern: "FailedScheduling + TopologySpreadConstraint",
  regex: /FailedScheduling.*TopologySpreadConstraint/i,
  rootCause: "Cannot satisfy pod topology spread constraints",
  explanation:
    "The pod has topologySpreadConstraints (e.g. spread across zones) but there are not enough eligible nodes in different topology domains to satisfy maxSkew.",
  remediation: [
    "Review topology spread constraints in pod spec",
    "Verify nodes have the expected topology labels (topology.kubernetes.io/zone, etc.)",
    "Relax maxSkew or change whenUnsatisfiable to ScheduleAnyway",
    "Add nodes in under-represented topology domains",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-node-affinity"],
});

_add({
  id: "sched-pod-affinity",
  pattern: "FailedScheduling + didn't match pod affinity/anti-affinity",
  regex: /FailedScheduling.*didn.t\s+match\s+pod\s+(anti-?)?affinity/i,
  rootCause: "Pod affinity or anti-affinity rules cannot be satisfied",
  explanation:
    "The pod has inter-pod affinity or anti-affinity rules that conflict with current pod placement. This often happens with required anti-affinity across a small cluster.",
  remediation: [
    "Check pod affinity rules: kubectl get pod <name> -o jsonpath='{.spec.affinity.podAntiAffinity}'",
    "Ensure enough distinct nodes/zones exist for anti-affinity",
    "Consider switching from requiredDuringScheduling to preferredDuringScheduling",
    "Scale up the cluster to provide more scheduling domains",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-topology-spread", "sched-node-affinity"],
});

_add({
  id: "sched-preemption-not-possible",
  pattern: "FailedScheduling + preemption not possible",
  regex: /FailedScheduling.*(preemption.*not\s+possible|no\s+preemption\s+victims)/i,
  rootCause: "Priority-based preemption cannot free enough resources",
  explanation:
    "The scheduler attempted preemption but could not evict enough lower-priority pods to make room. All running pods have equal or higher priority.",
  remediation: [
    "Check PriorityClass of the pending pod and running pods",
    "Add higher-priority PriorityClass to critical workloads",
    "Scale the cluster to add capacity",
    "Review if non-essential workloads can be reduced in priority",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-insufficient-cpu", "sched-insufficient-memory"],
});

_add({
  id: "sched-volume-zone-conflict",
  pattern: "FailedScheduling + volume node affinity conflict",
  regex: /FailedScheduling.*volume\s+node\s+affinity\s+conflict/i,
  rootCause: "Pod's PV is in a different availability zone than candidate nodes",
  explanation:
    "The PersistentVolume is zonal (e.g. an EBS/GCE-PD volume) and only accessible from nodes in one zone, but no schedulable nodes exist in that zone.",
  remediation: [
    "Check PV node affinity: kubectl describe pv <pv-name>",
    "Ensure nodes exist in the PV's zone",
    "Consider using a regional storage class for multi-zone access",
    "Migrate the PV to a different zone if needed",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    eks: "EBS volumes are zonal; use EFS for multi-AZ access",
    gke: "GCE-PD are zonal; use regional PDs for cross-zone access",
    aks: "Azure Disks are zonal; use Azure Files for multi-zone access",
  },
  relatedErrors: ["sched-node-affinity", "storage-failed-mount"],
});

_add({
  id: "sched-host-port-conflict",
  pattern: "FailedScheduling + host port conflict",
  regex: /FailedScheduling.*(host\s*[Pp]ort|port\s+\d+.*already\s+allocated)/i,
  rootCause: "Requested hostPort is already in use on all candidate nodes",
  explanation:
    "The pod requests a specific hostPort that is already bound on every eligible node. Only one pod per node can use a given hostPort.",
  remediation: [
    "Avoid hostPort unless absolutely necessary; use Services instead",
    "If hostPort is required, ensure enough nodes exist for the replica count",
    "Check what is using the port: kubectl get pods --all-namespaces -o wide | grep hostPort",
    "Consider using a NodePort Service or LoadBalancer as an alternative",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-too-many-pods"],
});

_add({
  id: "sched-node-selector-mismatch",
  pattern: "FailedScheduling + node(s) didn't match node selector",
  regex: /FailedScheduling.*node\(s\)\s+didn.t\s+match\s+node\s+selector/i,
  rootCause: "No nodes have the labels required by nodeSelector",
  explanation:
    "The pod spec has a nodeSelector that no node satisfies. This is simpler than node affinity but has the same effect — the pod cannot be scheduled.",
  remediation: [
    "Check the pod's nodeSelector: kubectl get pod <name> -o jsonpath='{.spec.nodeSelector}'",
    "List node labels: kubectl get nodes --show-labels",
    "Add the missing label to appropriate nodes: kubectl label node <node> <key>=<value>",
    "Or update the pod/deployment nodeSelector to match existing labels",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-node-affinity", "sched-taint-toleration"],
});

_add({
  id: "sched-resource-claim",
  pattern: "FailedScheduling + resource claim not ready",
  regex: /FailedScheduling.*resource\s+claim.*not\s+(ready|available)/i,
  rootCause: "Dynamic resource allocation claim not fulfilled",
  explanation:
    "The pod references a ResourceClaim (DRA, e.g. for GPU resources) that the resource driver has not yet fulfilled.",
  remediation: [
    "Check ResourceClaim status: kubectl describe resourceclaim <name> -n <ns>",
    "Verify the resource driver DaemonSet is running on target nodes",
    "Ensure the requested resource (e.g. GPU model/count) is available in the cluster",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-insufficient-cpu"],
});

_add({
  id: "sched-namespace-terminating",
  pattern: "FailedScheduling + namespace is terminating",
  regex: /FailedScheduling.*namespace.*terminating/i,
  rootCause: "Target namespace is being deleted",
  explanation:
    "The pod's namespace is in Terminating state. No new resources can be created in a terminating namespace.",
  remediation: [
    "Check namespace status: kubectl get namespace <ns>",
    "Wait for namespace deletion to complete, or investigate stuck finalizers",
    "Deploy the workload into a different active namespace",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: [],
});

_add({
  id: "sched-insufficient-gpu",
  pattern: "FailedScheduling + Insufficient nvidia.com/gpu",
  regex: /FailedScheduling.*Insufficient\s+(nvidia\.com\/gpu|amd\.com\/gpu|gpu)/i,
  rootCause: "No nodes with available GPU resources",
  explanation:
    "The pod requests GPU resources but no node has enough allocatable GPUs. GPU nodes may not exist, or all GPUs are already claimed.",
  remediation: [
    "Check GPU availability: kubectl describe nodes | grep -A3 'nvidia.com/gpu'",
    "Add GPU-enabled nodes to the cluster",
    "Reduce GPU requests if the workload can share GPUs",
    "Verify the GPU device plugin DaemonSet is running",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  platformNotes: {
    eks: "Install NVIDIA device plugin or use EKS GPU AMI",
    gke: "Enable GPU node pool; install NVIDIA driver via DaemonSet",
    aks: "Use GPU-enabled VM SKU (NC/ND series) and nvidia device plugin",
    openshift: "Install NVIDIA GPU Operator from OperatorHub",
  },
  relatedErrors: ["sched-insufficient-cpu", "sched-resource-claim"],
});

_add({
  id: "sched-pod-overhead",
  pattern: "FailedScheduling + overhead exceeds",
  regex: /FailedScheduling.*(overhead\s+exceeds|total\s+request.*exceeds)/i,
  rootCause: "Pod overhead (e.g. from RuntimeClass) plus requests exceed node capacity",
  explanation:
    "When using sandboxed runtimes (kata, gVisor), the RuntimeClass may define pod overhead that is added to container requests. The combined total exceeds available capacity.",
  remediation: [
    "Check RuntimeClass overhead: kubectl get runtimeclass <name> -o yaml",
    "Reduce container resource requests to account for overhead",
    "Use larger nodes that can accommodate the overhead",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-insufficient-cpu", "sched-insufficient-memory"],
});

_add({
  id: "sched-scheduler-error",
  pattern: "FailedScheduling + scheduler error",
  regex: /FailedScheduling.*(scheduler\s+error|internal\s+error|plugin.*error)/i,
  rootCause: "Scheduler plugin or extender returned an error",
  explanation:
    "A scheduler plugin, extender, or webhook returned an error during the scheduling cycle. This may be a bug in a custom scheduler component.",
  remediation: [
    "Check kube-scheduler logs for detailed error information",
    "Verify scheduler extender endpoints are healthy",
    "Review any custom scheduler plugins for errors",
    "Restart the scheduler pod if the error is transient",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: [],
});

// ---------------------------------------------------------------------------
// 2. CONTAINER RUNTIME ERRORS  (20+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "crash-exit-1",
  pattern: "CrashLoopBackOff + exit code 1",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*1(?!\d)/i,
  rootCause: "Application error (non-zero exit)",
  explanation:
    "The container process exited with code 1, the most common general-purpose error code. The root cause is in the application itself — a misconfigured environment variable, missing file, failed database connection, etc.",
  remediation: [
    "Check container logs: kubectl logs <pod> -c <container> --previous",
    "Look for application startup errors (connection failures, missing config)",
    "Verify environment variables and ConfigMap/Secret references",
    "Run the container locally with the same env to reproduce",
    "Check if the application needs migration or initialization that hasn't run",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-2", "runtime-config-error"],
});

_add({
  id: "crash-exit-137",
  pattern: "CrashLoopBackOff + exit code 137",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*137/i,
  rootCause: "SIGKILL — OOM killed or forced termination",
  explanation:
    "Exit code 137 = 128 + 9 (SIGKILL). Most commonly caused by the kernel OOM killer because the container exceeded its memory limit. Can also be sent by the kubelet if the container failed to stop within the terminationGracePeriodSeconds.",
  remediation: [
    "Check for OOMKilled status: kubectl describe pod <pod> | grep -i oomkilled",
    "If OOM: increase memory limits in the container spec",
    "Profile the application's actual memory usage to set appropriate limits",
    "Check for memory leaks in the application",
    "If not OOM: check terminationGracePeriodSeconds and ensure graceful shutdown is fast enough",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff", "OOMKilled"],
  relatedErrors: ["runtime-oomkilled", "crash-exit-1"],
});

_add({
  id: "crash-exit-139",
  pattern: "CrashLoopBackOff + exit code 139",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*139/i,
  rootCause: "SIGSEGV — segmentation fault",
  explanation:
    "Exit code 139 = 128 + 11 (SIGSEGV). The process attempted to access invalid memory. This is a bug in native code (C/C++/Rust/Go with unsafe pointers). Can also be caused by corrupt container images or incompatible CPU architecture.",
  remediation: [
    "Check container logs for crash dump or stack trace",
    "Verify the image architecture matches the node (amd64 vs arm64)",
    "If using multi-arch images, verify the manifest list includes the correct platform",
    "Try an older known-good image version",
    "Report the segfault to the application maintainers with core dump if available",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-137", "crash-exit-134"],
});

_add({
  id: "crash-exit-143",
  pattern: "CrashLoopBackOff + exit code 143",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*143/i,
  rootCause: "SIGTERM — graceful shutdown timeout exceeded",
  explanation:
    "Exit code 143 = 128 + 15 (SIGTERM). The container received SIGTERM (graceful shutdown) and exited with this code. If combined with CrashLoopBackOff, the application may be failing health checks and getting restarted repeatedly.",
  remediation: [
    "Check liveness probe configuration — it may be too aggressive",
    "Increase initialDelaySeconds if the app needs more startup time",
    "Verify the application handles SIGTERM properly",
    "Increase terminationGracePeriodSeconds if shutdown takes long",
    "Check if a preStop hook is consuming the grace period",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-137", "runtime-liveness-probe-failed"],
});

_add({
  id: "crash-exit-126",
  pattern: "CrashLoopBackOff + exit code 126",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*126/i,
  rootCause: "Permission denied — cannot execute entrypoint",
  explanation:
    "Exit code 126 means the command was found but cannot be executed (no execute permission). This often happens when the container runs as a non-root user and the entrypoint script lacks +x permissions.",
  remediation: [
    "Check entrypoint file permissions in the Dockerfile: RUN chmod +x /entrypoint.sh",
    "Verify the image was built correctly with executable scripts",
    "Check if securityContext.runAsUser conflicts with file ownership",
    "Inspect the image: docker run --rm -it --entrypoint sh <image> -c 'ls -la /entrypoint.sh'",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  platformNotes: {
    openshift: "OpenShift runs containers as random UID by default; ensure entrypoint is world-executable (chmod 755)",
  },
  relatedErrors: ["crash-exit-127", "rbac-scc-denied"],
});

_add({
  id: "crash-exit-127",
  pattern: "CrashLoopBackOff + exit code 127",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*127/i,
  rootCause: "Command not found — wrong entrypoint or missing binary",
  explanation:
    "Exit code 127 means the specified command/entrypoint was not found in the container filesystem. This commonly happens when the Dockerfile or pod spec specifies the wrong command, or the image is a minimal (distroless/scratch) image without a shell.",
  remediation: [
    "Verify the command/args in the pod spec match what exists in the image",
    "Inspect the image to list available binaries: docker run --rm --entrypoint ls <image> /usr/local/bin/",
    "Check if you're using a shell form command on a distroless image (use exec form instead)",
    "Rebuild the image with the correct binary installed",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-126"],
});

_add({
  id: "crash-exit-2",
  pattern: "CrashLoopBackOff + exit code 2",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*2(?!\d)/i,
  rootCause: "Shell misuse or missing required argument",
  explanation:
    "Exit code 2 typically indicates incorrect shell command usage (bad flag, missing argument) or a bash syntax error. The application's CLI may have been invoked with wrong parameters.",
  remediation: [
    "Check container logs for usage/help output indicating wrong arguments",
    "Verify command and args fields in the pod spec",
    "Ensure ConfigMap-sourced arguments are correctly formatted",
    "Test the command locally: docker run --rm <image> <command> <args>",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-1", "crash-exit-127"],
});

_add({
  id: "crash-exit-134",
  pattern: "CrashLoopBackOff + exit code 134",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*134/i,
  rootCause: "SIGABRT — application abort/assertion failure",
  explanation:
    "Exit code 134 = 128 + 6 (SIGABRT). The application called abort() or an assertion failed. This indicates a programming error or corrupt state in native code.",
  remediation: [
    "Check container logs for assertion failure messages",
    "Look for core dump if enabled (check /proc/sys/kernel/core_pattern)",
    "Try a previous known-good image version",
    "Report the crash to the application maintainers",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-139", "crash-exit-137"],
});

_add({
  id: "crash-exit-0-loop",
  pattern: "CrashLoopBackOff + exit code 0",
  regex: /CrashLoopBackOff[\s\S]{0,300}exit\s*code[:\s]*0(?!\d)/i,
  rootCause: "Container exits immediately with success — not a long-running process",
  explanation:
    "The container ran to completion (exit 0) but Kubernetes expects it to keep running. This happens when a batch job is deployed as a Deployment instead of a Job, or the entrypoint finishes immediately.",
  remediation: [
    "If this is a batch task, use a Job or CronJob resource instead of a Deployment",
    "If the app should be long-running, check why it exits (missing foreground flag, backgrounded process)",
    "Ensure the entrypoint runs the process in the foreground (e.g. exec, not & background)",
    "Add a restartPolicy of OnFailure or Never if appropriate",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-1"],
});

_add({
  id: "runtime-oomkilled",
  pattern: "OOMKilled",
  regex: /OOMKilled/i,
  rootCause: "Container exceeded memory limit",
  explanation:
    "The Linux kernel's OOM killer terminated the container because it tried to allocate more memory than its cgroup limit allows. The pod's last termination reason will show OOMKilled.",
  remediation: [
    "Check current memory limit: kubectl describe pod <pod> | grep -A2 Limits",
    "Profile actual memory usage: kubectl top pod <pod>",
    "Increase the memory limit to accommodate peak usage + 20% headroom",
    "Investigate memory leaks in the application (heap dumps, profiling)",
    "Consider setting memory requests = limits to get Guaranteed QoS class",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["OOMKilled"],
  relatedErrors: ["crash-exit-137", "quota-exceeded"],
});

_add({
  id: "runtime-config-error",
  pattern: "CreateContainerConfigError",
  regex: /CreateContainerConfigError/i,
  rootCause: "ConfigMap or Secret referenced but not found (or wrong key)",
  explanation:
    "The kubelet cannot create the container because it references a ConfigMap or Secret (via envFrom, env valueFrom, or volume mount) that doesn't exist in the namespace, or a specific key within it is missing.",
  remediation: [
    "Check pod events: kubectl describe pod <pod>",
    "Verify all referenced ConfigMaps exist: kubectl get configmap -n <ns>",
    "Verify all referenced Secrets exist: kubectl get secrets -n <ns>",
    "Check that specific keys referenced in valueFrom exist in the ConfigMap/Secret",
    "Ensure the ServiceAccount's imagePullSecrets reference exists",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CreateContainerConfigError"],
  relatedErrors: ["runtime-create-container-error"],
});

_add({
  id: "runtime-create-container-error",
  pattern: "CreateContainerError + not found",
  regex: /CreateContainerError[\s\S]{0,200}not\s+found/i,
  rootCause: "Container image entrypoint or command not found",
  explanation:
    "The container runtime failed to create the container. Often the image was pulled but the specified entrypoint/command does not exist in the image filesystem.",
  remediation: [
    "Verify the command/args in the pod spec",
    "Inspect the image entrypoint: docker inspect <image> | jq '.[0].Config.Entrypoint'",
    "Ensure the image was built correctly with the expected binary",
    "Check if the image is correct (not a wrong/base image accidentally referenced)",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CreateContainerError"],
  relatedErrors: ["crash-exit-127", "runtime-config-error"],
});

_add({
  id: "runtime-run-container-error",
  pattern: "RunContainerError",
  regex: /RunContainerError/i,
  rootCause: "Container runtime failure during startup",
  explanation:
    "The container runtime (containerd/CRI-O) failed to start the container. This can be caused by invalid security settings (seccomp, AppArmor, SELinux), device mount failures, or runtime bugs.",
  remediation: [
    "Check detailed event message: kubectl describe pod <pod>",
    "Verify securityContext settings (seccompProfile, seLinuxOptions)",
    "Check container runtime logs on the node: journalctl -u containerd or journalctl -u crio",
    "Ensure required device plugins are installed if requesting devices",
    "Try removing security constraints temporarily to isolate the issue",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["RunContainerError"],
  platformNotes: {
    openshift: "CRI-O may reject containers that violate the assigned SCC; check oc describe pod for SCC annotations",
  },
  relatedErrors: ["runtime-config-error", "rbac-scc-denied"],
});

_add({
  id: "runtime-post-start-hook",
  pattern: "PostStartHookError",
  regex: /PostStartHook.*(?:error|fail)/i,
  rootCause: "PostStart lifecycle hook failed",
  explanation:
    "The container's postStart lifecycle hook returned an error. Kubernetes will kill and restart the container when this happens. The hook may have timed out or the command it runs failed.",
  remediation: [
    "Check the postStart hook definition: kubectl get pod <pod> -o jsonpath='{.spec.containers[*].lifecycle.postStart}'",
    "Test the hook command manually inside the container",
    "Check if the hook depends on a service that isn't ready yet",
    "Add error handling/retry logic to the hook script",
    "Consider using an init container instead of a postStart hook for complex initialization",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["PostStartHookError"],
  relatedErrors: ["runtime-pre-stop-hook"],
});

_add({
  id: "runtime-pre-stop-hook",
  pattern: "PreStopHookError",
  regex: /PreStopHook.*(?:error|fail)/i,
  rootCause: "PreStop lifecycle hook failed",
  explanation:
    "The container's preStop lifecycle hook failed. This can cause issues during pod termination/rolling updates, as the container may not drain gracefully.",
  remediation: [
    "Check the preStop hook definition in the pod spec",
    "Ensure the hook command exits cleanly within terminationGracePeriodSeconds",
    "Test the hook manually in a running container",
    "Add timeouts to the hook script to prevent hanging",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["PreStopHookError"],
  relatedErrors: ["runtime-post-start-hook"],
});

_add({
  id: "runtime-liveness-probe-failed",
  pattern: "Liveness probe failed",
  regex: /Liveness\s+probe\s+failed/i,
  rootCause: "Liveness probe failure causing container restart",
  explanation:
    "The kubelet's liveness probe failed beyond failureThreshold, so the container was killed and restarted. The application may be deadlocked, overloaded, or the probe is misconfigured.",
  remediation: [
    "Check probe config: kubectl describe pod <pod> | grep -A5 Liveness",
    "Increase initialDelaySeconds if the app takes long to start",
    "Increase timeoutSeconds if the endpoint is slow under load",
    "Increase failureThreshold to allow more transient failures",
    "Verify the probe endpoint/command is correct and lightweight",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["CrashLoopBackOff", "Unhealthy"],
  relatedErrors: ["runtime-readiness-probe-failed", "crash-exit-143"],
});

_add({
  id: "runtime-readiness-probe-failed",
  pattern: "Readiness probe failed",
  regex: /Readiness\s+probe\s+failed/i,
  rootCause: "Readiness probe failure — pod removed from Service endpoints",
  explanation:
    "The readiness probe failed, so the pod was removed from Service endpoints and will not receive traffic. Unlike liveness failure, the container is NOT restarted. This can cause apparent downtime.",
  remediation: [
    "Check probe config: kubectl describe pod <pod> | grep -A5 Readiness",
    "Verify the readiness endpoint returns 200 under normal conditions",
    "Check if the application depends on an external service that is down",
    "Increase timeoutSeconds if the endpoint is slow",
    "Separate readiness from liveness probes with different endpoints if needed",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["Unhealthy"],
  relatedErrors: ["runtime-liveness-probe-failed", "net-no-endpoints"],
});

_add({
  id: "runtime-startup-probe-failed",
  pattern: "Startup probe failed",
  regex: /Startup\s+probe\s+failed/i,
  rootCause: "Startup probe failed — application took too long to initialize",
  explanation:
    "The startup probe exceeded its failureThreshold * periodSeconds window. The application did not become ready within the allowed startup time, so the container was killed.",
  remediation: [
    "Increase failureThreshold to allow more startup time (total = failureThreshold * periodSeconds)",
    "Check application logs for slow startup causes (DB migrations, cache warming)",
    "Optimize application startup time",
    "Ensure the startup probe endpoint is implemented and lightweight",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["CrashLoopBackOff", "Unhealthy"],
  relatedErrors: ["runtime-liveness-probe-failed"],
});

_add({
  id: "runtime-back-off-restarting",
  pattern: "Back-off restarting failed container",
  regex: /Back-off\s+restarting\s+failed\s+container/i,
  rootCause: "Container repeatedly crashing — exponential backoff active",
  explanation:
    "Kubernetes is using exponential backoff (10s, 20s, 40s, ... up to 5min) before restarting the crashed container. The container has failed multiple times and the underlying cause needs to be fixed.",
  remediation: [
    "Check container logs from previous run: kubectl logs <pod> --previous",
    "Check events for specific error details: kubectl describe pod <pod>",
    "Fix the underlying application crash before the container will stabilize",
    "Consider deleting the pod to reset the backoff timer once the fix is deployed",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CrashLoopBackOff"],
  relatedErrors: ["crash-exit-1", "crash-exit-137"],
});

_add({
  id: "runtime-container-cannot-run",
  pattern: "container cannot run with an effective UID",
  regex: /container\s+cannot\s+run.*effective\s+UID/i,
  rootCause: "Container UID conflicts with security policy",
  explanation:
    "The container tries to run as a UID that is not allowed by the pod security policy, PodSecurity admission, or OpenShift SCC.",
  remediation: [
    "Check which UID the image expects: docker inspect <image> | jq '.[0].Config.User'",
    "Set securityContext.runAsUser to an allowed UID",
    "On OpenShift, request an SCC that allows the needed UID range",
    "Rebuild the image to run as non-root (recommended)",
  ],
  severity: "critical",
  category: "runtime",
  reasons: ["CreateContainerError", "RunContainerError"],
  platformNotes: {
    openshift: "Default restricted SCC assigns random UID; set appropriate SCC via ServiceAccount annotation",
  },
  relatedErrors: ["rbac-scc-denied", "crash-exit-126"],
});

// ---------------------------------------------------------------------------
// 3. IMAGE PULL ERRORS  (10+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "image-unauthorized",
  pattern: "ImagePullBackOff + unauthorized",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}(?:unauthorized|authentication\s+required|401)/i,
  rootCause: "Registry credentials wrong or missing",
  explanation:
    "The kubelet cannot pull the image because the registry requires authentication and either no imagePullSecret is configured, or the credentials are incorrect/expired.",
  remediation: [
    "Check imagePullSecrets on the pod/ServiceAccount: kubectl get pod <pod> -o jsonpath='{.spec.imagePullSecrets}'",
    "Verify the secret exists and is valid: kubectl get secret <name> -o jsonpath='{.data.\\.dockerconfigjson}' | base64 -d",
    "Recreate the pull secret: kubectl create secret docker-registry <name> --docker-server=<registry> --docker-username=<user> --docker-password=<token>",
    "Ensure the ServiceAccount has the imagePullSecret: kubectl patch sa default -p '{\"imagePullSecrets\":[{\"name\":\"<secret>\"}]}'",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  platformNotes: {
    openshift: "OpenShift uses internal registry at image-registry.openshift-image-registry.svc:5000; check builder/deployer SA secrets",
    eks: "For ECR, ensure IAM role on node/pod has ecr:GetAuthorizationToken and ecr:BatchGetImage permissions",
    aks: "Attach ACR to AKS: az aks update --attach-acr <acr-name>",
    gke: "For Artifact Registry, ensure node SA or Workload Identity has artifactregistry.reader role",
  },
  relatedErrors: ["image-denied"],
});

_add({
  id: "image-not-found",
  pattern: "ImagePullBackOff + not found",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}(?:not\s+found|manifest\s+for.*not\s+found|repository\s+does\s+not\s+exist)/i,
  rootCause: "Image or tag does not exist in the registry",
  explanation:
    "The specified image repository or tag was not found. The image name may be misspelled, the tag may not have been pushed, or the repository may have been deleted.",
  remediation: [
    "Verify the image name and tag are correct (check for typos)",
    "List available tags in the registry (e.g. docker/crane/skopeo)",
    "Ensure the CI/CD pipeline pushed the image before deploying",
    "Check if you need to specify the full registry path (e.g. docker.io/library/ prefix)",
    "If using :latest, the tag may not exist; use explicit version tags instead",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  relatedErrors: ["image-manifest-unknown"],
});

_add({
  id: "image-manifest-unknown",
  pattern: "ImagePullBackOff + manifest unknown",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}manifest\s+unknown/i,
  rootCause: "Image tag deleted or overwritten in registry",
  explanation:
    "The tag existed at some point but the manifest has been removed. This can happen when tags are garbage-collected, overwritten by a failed push, or the retention policy deleted old images.",
  remediation: [
    "Check if the tag was garbage collected by the registry retention policy",
    "Re-push the image with the same tag from CI/CD",
    "Use immutable tags (SHA digest) instead of mutable tags to prevent this",
    "Update the deployment to use a known-good tag: kubectl set image deployment/<name> <container>=<image>:<new-tag>",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  relatedErrors: ["image-not-found"],
});

_add({
  id: "image-timeout",
  pattern: "ImagePullBackOff + timeout",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}(?:timeout|timed?\s*out|deadline\s+exceeded|context\s+deadline)/i,
  rootCause: "Registry unreachable — network or firewall issue",
  explanation:
    "The kubelet could not reach the container registry within the timeout period. This is typically a network issue — firewall rules blocking outbound HTTPS, proxy misconfiguration, or DNS failure.",
  remediation: [
    "Test registry connectivity from a node: curl -v https://<registry>/v2/",
    "Check proxy settings: HTTP_PROXY, HTTPS_PROXY, NO_PROXY environment on the node/runtime",
    "Verify DNS resolution: nslookup <registry> from the node",
    "Check firewall/security group rules allow outbound 443 to the registry",
    "If using a pull-through cache, verify the cache is healthy",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  platformNotes: {
    openshift: "Check cluster-wide proxy settings: oc get proxy/cluster -o yaml",
    eks: "Verify VPC endpoints for ECR if running in private subnets",
    aks: "Check NSG rules and Azure Firewall for ACR connectivity",
    gke: "Private clusters need Cloud NAT or Private Google Access for Artifact Registry",
  },
  relatedErrors: ["image-unauthorized"],
});

_add({
  id: "image-x509",
  pattern: "ErrImagePull + x509",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}x509/i,
  rootCause: "Registry TLS certificate not trusted",
  explanation:
    "The registry's TLS certificate cannot be verified. This happens with self-signed certificates, private CAs, or expired certificates. The container runtime rejects the connection.",
  remediation: [
    "Check if the registry uses a self-signed or private CA certificate",
    "Add the CA cert to the node's trusted store and restart the runtime",
    "For containerd: configure [plugins.\"io.containerd.grpc.v1.cri\".registry.configs.\"<registry>\".tls]",
    "For CRI-O: add CA cert to /etc/containers/certs.d/<registry>/",
    "As a temporary workaround (not recommended for production): allow insecure registries",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  platformNotes: {
    openshift: "Add CA to image.config.openshift.io/cluster: oc create configmap custom-ca --from-file=ca-bundle.crt -n openshift-config",
  },
  relatedErrors: ["image-unauthorized"],
});

_add({
  id: "image-denied",
  pattern: "ErrImagePull + denied",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}(?:denied|forbidden|403)/i,
  rootCause: "RBAC on the container registry denies access",
  explanation:
    "The credentials are valid (authenticated) but the account lacks permission to pull from this specific repository. This is a registry-side authorization issue.",
  remediation: [
    "Check the registry's access control / IAM policies",
    "Ensure the service account or robot account has pull permissions on the repository",
    "For ECR: verify the repository policy allows the pulling account",
    "For ACR/Artifact Registry: check IAM role assignments",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  platformNotes: {
    eks: "ECR repository policy must allow ecr:BatchGetImage for the node role or IRSA role",
    aks: "Ensure AcrPull role is assigned: az role assignment create --role AcrPull --assignee <principalId>",
    gke: "Grant artifactregistry.reader role to the node SA or Workload Identity KSA",
  },
  relatedErrors: ["image-unauthorized"],
});

_add({
  id: "image-platform-mismatch",
  pattern: "ImagePullBackOff + no matching manifest for platform",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}no\s+matching\s+manifest.*platform/i,
  rootCause: "Image not available for node's CPU architecture",
  explanation:
    "The image manifest list does not include a variant for the node's platform (e.g. pulling an amd64-only image on an arm64 node or vice versa).",
  remediation: [
    "Check the image platforms: docker manifest inspect <image>",
    "Build and push a multi-arch image using docker buildx",
    "Target nodes with the correct architecture using nodeSelector: kubernetes.io/arch=amd64",
    "Use a different image version that supports the target platform",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  relatedErrors: ["image-not-found"],
});

_add({
  id: "image-rate-limit",
  pattern: "ImagePullBackOff + rate limit / too many requests",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}(?:rate\s+limit|429|too\s+many\s+requests|toomanyrequests)/i,
  rootCause: "Registry pull rate limit exceeded (e.g. Docker Hub)",
  explanation:
    "The container registry is rate-limiting pull requests. Docker Hub limits anonymous pulls to 100/6h and free authenticated to 200/6h. This affects all pods on the node sharing the same IP/credentials.",
  remediation: [
    "Authenticate to Docker Hub for higher limits: add imagePullSecret",
    "Use a pull-through registry cache / mirror to reduce external pulls",
    "Upgrade to Docker Hub Pro/Team for higher rate limits",
    "Pre-pull images to nodes during off-peak hours",
    "Consider mirroring frequently used images to a private registry",
  ],
  severity: "warning",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  relatedErrors: ["image-timeout"],
});

_add({
  id: "image-invalid-reference",
  pattern: "ErrImagePull + invalid reference format",
  regex: /(?:ImagePullBackOff|ErrImagePull)[\s\S]{0,300}invalid\s+reference\s+format/i,
  rootCause: "Malformed image reference in pod spec",
  explanation:
    "The image name in the pod spec is not a valid container image reference. This can be caused by special characters, missing repository name, or template variables that were not expanded.",
  remediation: [
    "Check the image field: kubectl get pod <pod> -o jsonpath='{.spec.containers[*].image}'",
    "Ensure there are no unresolved template variables (e.g. ${VERSION})",
    "Verify the format follows [registry/][repository/]name[:tag|@digest]",
    "Fix the Deployment/StatefulSet image field and re-deploy",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  relatedErrors: ["image-not-found"],
});

_add({
  id: "image-pull-backoff-generic",
  pattern: "ImagePullBackOff (generic)",
  regex: /ImagePullBackOff/i,
  rootCause: "Image pull failure — multiple possible causes",
  explanation:
    "The kubelet failed to pull the container image and is backing off before retrying. Check the detailed event message for specific cause (auth, not found, timeout, etc.).",
  remediation: [
    "Check detailed events: kubectl describe pod <pod> | grep -A10 Events",
    "Test the pull manually on the node: crictl pull <image>",
    "Verify imagePullPolicy (Always, IfNotPresent, Never) is appropriate",
    "Check network connectivity from the node to the registry",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  relatedErrors: ["image-unauthorized", "image-not-found", "image-timeout"],
});

// ---------------------------------------------------------------------------
// 4. NETWORKING ERRORS  (20+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "net-connection-refused",
  pattern: "dial tcp connection refused",
  regex: /dial\s+tcp[\s\S]{0,100}connection\s+refused/i,
  rootCause: "Target service is not listening on the expected port",
  explanation:
    "A TCP connection to the target IP:port was actively refused. The target host is reachable but nothing is listening on that port. This usually means the backend pod/service isn't running or is listening on a different port.",
  remediation: [
    "Check if the target pod is running: kubectl get pods -l <selector>",
    "Verify the container is listening on the expected port: kubectl exec <pod> -- netstat -tlnp",
    "Compare Service targetPort with the container's actual listening port",
    "Check if the service selector matches pod labels: kubectl get endpoints <svc>",
    "Look for init containers or startup delays preventing the port from opening",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-no-endpoints", "net-service-unavailable"],
});

_add({
  id: "net-io-timeout",
  pattern: "dial tcp i/o timeout",
  regex: /dial\s+tcp[\s\S]{0,100}i\/o\s+timeout/i,
  rootCause: "Network policy blocking, firewall rule, or wrong IP",
  explanation:
    "The TCP connection attempt timed out — the target host did not respond at all. This is typically caused by NetworkPolicies dropping packets, cloud firewall/security group rules, incorrect IP, or routing issues.",
  remediation: [
    "Check NetworkPolicies in source and destination namespaces: kubectl get networkpolicy -n <ns>",
    "Verify the target IP is correct and the pod/service exists",
    "Test connectivity: kubectl exec <source-pod> -- nc -zv <target-ip> <port> -w 5",
    "Check cloud security groups / firewall rules",
    "Verify Calico/Cilium/OVN network plugin is healthy",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  platformNotes: {
    openshift: "Check OVN-Kubernetes EgressFirewall and AdminNetworkPolicy resources",
    eks: "Check VPC security groups and NACLs; verify VPC CNI plugin health",
    aks: "Check NSG rules and Azure Network Policy (Calico/Azure) config",
    gke: "Check VPC firewall rules and GKE network policy enforcement",
  },
  relatedErrors: ["net-connection-refused", "net-dns-failed"],
});

_add({
  id: "net-no-endpoints",
  pattern: "no endpoints available for service",
  regex: /no\s+endpoints?\s+available/i,
  rootCause: "Service selector does not match any running/ready pods",
  explanation:
    "The Service has no endpoints. This means either no pods match the Service's label selector, or all matching pods have failed readiness probes and were removed from endpoints.",
  remediation: [
    "Check endpoints: kubectl get endpoints <service> -n <ns>",
    "Compare Service selector with pod labels: kubectl get svc <service> -o yaml | grep selector",
    "List pods matching the selector: kubectl get pods -l <selector> -n <ns>",
    "If pods exist but aren't in endpoints, check readiness probes",
    "Ensure the Service and pods are in the same namespace",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-connection-refused", "runtime-readiness-probe-failed"],
});

_add({
  id: "net-upstream-connect-error",
  pattern: "upstream connect error or disconnect/reset",
  regex: /upstream\s+connect\s+error|upstream_reset_before_response_started/i,
  rootCause: "Istio/Envoy sidecar connectivity issue",
  explanation:
    "The Envoy sidecar proxy (Istio, OSM, or similar service mesh) cannot connect to the upstream service. This can be caused by mTLS misconfiguration, circuit breaking, or the backend not being in the mesh.",
  remediation: [
    "Check if mTLS mode matches between source and destination: istioctl authn tls-check <pod>",
    "Verify the destination service is part of the mesh",
    "Check DestinationRule for circuit-breaker settings that may be tripping",
    "Look for PeerAuthentication resources requiring STRICT mTLS on the target",
    "Check Envoy access logs: kubectl logs <pod> -c istio-proxy",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  platformNotes: {
    openshift: "OpenShift Service Mesh (OSSM) uses Maistra; check ServiceMeshMemberRoll for namespace inclusion",
  },
  relatedErrors: ["net-connection-refused", "net-tls-handshake-timeout"],
});

_add({
  id: "net-dns-failed",
  pattern: "DNS resolution failed",
  regex: /(?:dns\s+resolution\s+failed|could\s+not\s+resolve|nslookup.*NXDOMAIN|name\s+or\s+service\s+not\s+known|no\s+such\s+host)/i,
  rootCause: "CoreDNS issue or service/hostname incorrect",
  explanation:
    "DNS name resolution failed. The service name may be misspelled, CoreDNS may be down or overloaded, or the DNS search path is not configured correctly for the expected name format.",
  remediation: [
    "Verify the hostname is correct (use <svc>.<ns>.svc.cluster.local for cross-namespace)",
    "Check CoreDNS pods are running: kubectl get pods -n kube-system -l k8s-app=kube-dns",
    "Test DNS from the pod: kubectl exec <pod> -- nslookup <hostname>",
    "Check CoreDNS logs: kubectl logs -n kube-system -l k8s-app=kube-dns",
    "Verify /etc/resolv.conf in the pod: kubectl exec <pod> -- cat /etc/resolv.conf",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  platformNotes: {
    openshift: "OpenShift uses CoreDNS in openshift-dns namespace; check oc get pods -n openshift-dns",
  },
  relatedErrors: ["net-connection-refused", "net-io-timeout"],
});

_add({
  id: "net-connection-reset",
  pattern: "connection reset by peer",
  regex: /connection\s+reset\s+by\s+peer/i,
  rootCause: "Server-side crash, TLS mismatch, or connection dropped",
  explanation:
    "The remote end sent a TCP RST, forcefully closing the connection. This can indicate the server process crashed, there's a TLS/plaintext mismatch, a load balancer health check issue, or a network device is terminating the connection.",
  remediation: [
    "Check server-side logs for crash or error messages",
    "Verify TLS configuration matches between client and server",
    "Check if a network policy or service mesh is interfering",
    "Look for load balancer idle timeout issues",
    "Increase keep-alive settings if connections are dropped due to inactivity",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-tls-handshake-timeout", "net-connection-refused"],
});

_add({
  id: "net-tls-handshake-timeout",
  pattern: "TLS handshake timeout",
  regex: /TLS\s+handshake\s+timeout/i,
  rootCause: "TLS certificate issue or network latency",
  explanation:
    "The TLS handshake did not complete within the timeout. This can be caused by certificate verification failures, SNI mismatch, slow network, or an intermediate device stripping TLS.",
  remediation: [
    "Test TLS connectivity: openssl s_client -connect <host>:<port> -servername <sni>",
    "Verify the target's TLS certificate is valid and not expired",
    "Check for network devices (proxy, WAF) that may interfere with TLS",
    "Increase client-side TLS timeout if network latency is high",
    "Ensure SNI matches the expected hostname",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-connection-reset", "image-x509"],
});

_add({
  id: "net-request-canceled",
  pattern: "net/http: request canceled (context deadline exceeded)",
  regex: /(?:request\s+canceled|context\s+deadline\s+exceeded)/i,
  rootCause: "HTTP request timeout — upstream too slow",
  explanation:
    "The HTTP client canceled the request because it exceeded the context deadline (timeout). The upstream service is taking too long to respond, or the timeout is set too low for the expected operation.",
  remediation: [
    "Increase the client-side timeout for slow operations",
    "Check upstream service health and response times",
    "Add retries with backoff for transient slowness",
    "Consider async patterns for long-running operations",
    "Check if resource constraints (CPU/memory) are causing the upstream to be slow",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-gateway-timeout"],
});

_add({
  id: "net-service-unavailable",
  pattern: "Service Unavailable (503)",
  regex: /(?:503|Service\s+Unavailable)/i,
  rootCause: "Backend overloaded, not ready, or no healthy endpoints",
  explanation:
    "The load balancer or ingress returned HTTP 503 Service Unavailable. All backend pods may be failing health checks, the service may have no endpoints, or the backend is overloaded.",
  remediation: [
    "Check pod readiness: kubectl get pods -l <selector>",
    "Verify endpoints: kubectl get endpoints <svc>",
    "Check backend pod logs for errors",
    "If using Ingress, check ingress controller logs",
    "Verify HPA is scaling appropriately under load",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-no-endpoints", "net-gateway-timeout"],
});

_add({
  id: "net-gateway-timeout",
  pattern: "Gateway Timeout (504)",
  regex: /(?:504|Gateway\s+Timeout)/i,
  rootCause: "Upstream service took too long to respond",
  explanation:
    "The reverse proxy, ingress controller, or load balancer timed out waiting for the upstream service to respond. The backend may be overloaded or performing a long operation.",
  remediation: [
    "Increase proxy timeout settings (Ingress annotation, LB settings)",
    "Check backend pod CPU/memory and scale if needed",
    "Optimize slow backend operations (database queries, external API calls)",
    "For NGINX Ingress: set nginx.ingress.kubernetes.io/proxy-read-timeout annotation",
    "For HAProxy: increase timeout server / timeout tunnel",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  platformNotes: {
    openshift: "Set haproxy.router.openshift.io/timeout annotation on the Route",
  },
  relatedErrors: ["net-service-unavailable", "net-request-canceled"],
});

_add({
  id: "net-too-many-requests",
  pattern: "Too Many Requests (429)",
  regex: /(?:429|Too\s+Many\s+Requests)/i,
  rootCause: "Rate limiting is active on the target service",
  explanation:
    "The target service or API gateway is rate-limiting requests. The client is sending requests faster than the allowed rate.",
  remediation: [
    "Implement exponential backoff and retry logic in the client",
    "Check rate limit headers (X-RateLimit-Limit, Retry-After) for guidance",
    "Increase rate limits if you control the target service",
    "Distribute requests across multiple instances/endpoints",
    "Cache responses where possible to reduce request rate",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["image-rate-limit"],
});

_add({
  id: "net-ingress-class-not-found",
  pattern: "Ingress class not found",
  regex: /(?:ingress\s+class.*not\s+found|unknown\s+ingress\s+class|IngressClass.*does\s+not\s+exist)/i,
  rootCause: "Specified IngressClass does not exist in the cluster",
  explanation:
    "The Ingress resource references an IngressClass that doesn't exist, so no ingress controller will process it. Traffic will not be routed.",
  remediation: [
    "List available IngressClasses: kubectl get ingressclass",
    "Update the Ingress to use an existing class",
    "Install the required ingress controller (NGINX, Traefik, etc.)",
    "Set the default IngressClass annotation if appropriate",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "net-calico-felix-error",
  pattern: "calico/node or felix error",
  regex: /(?:calico.*felix|felix.*error|bird.*protocol|calico-node.*not\s+ready)/i,
  rootCause: "Calico CNI plugin problem — network connectivity may be degraded",
  explanation:
    "The Calico CNI plugin (felix/bird) is experiencing errors. This can disrupt pod networking, NetworkPolicy enforcement, and cross-node communication.",
  remediation: [
    "Check calico-node DaemonSet status: kubectl get ds -n calico-system calico-node",
    "Review felix logs: kubectl logs -n calico-system <calico-node-pod> -c calico-node",
    "Verify IP pool configuration: calicoctl get ippools",
    "Check if nodes can reach each other on the required ports (BGP 179, VXLAN 4789)",
    "Restart calico-node pods if transient: kubectl rollout restart ds/calico-node -n calico-system",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-io-timeout"],
});

_add({
  id: "net-pod-cidr-exhaustion",
  pattern: "failed to allocate IP / CIDR exhausted",
  regex: /(?:failed\s+to\s+allocate.*(?:IP|address|CIDR)|CIDR.*exhaust|no\s+available\s+(?:IP|address)|IP\s+address.*not\s+available)/i,
  rootCause: "Pod CIDR IP addresses exhausted on the node",
  explanation:
    "The node's pod CIDR range has no more IP addresses available. Each node gets a /24 (256 IPs) by default. With many pods per node or small CIDRs, this can be exhausted.",
  remediation: [
    "Check node's pod CIDR allocation: kubectl describe node <node> | grep PodCIDR",
    "Reduce the number of pods on the affected node",
    "Increase the cluster CIDR range (requires cluster recreation in some platforms)",
    "Use a CNI that supports larger per-node CIDR blocks",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  platformNotes: {
    eks: "EKS VPC CNI uses ENIs; IP exhaustion depends on instance type max ENIs * IPs-per-ENI. Enable prefix delegation for more IPs.",
    aks: "Azure CNI pre-allocates IPs from the subnet; increase subnet size or use overlay mode",
    gke: "GKE uses alias IP ranges; check node pod range size in the subnet",
  },
  relatedErrors: ["sched-too-many-pods"],
});

_add({
  id: "net-service-mesh-injection-failed",
  pattern: "sidecar injection failed",
  regex: /(?:sidecar\s+injection\s+failed|istio.*inject.*error|mutating\s+webhook.*istio)/i,
  rootCause: "Service mesh sidecar injector webhook failed",
  explanation:
    "The mutating admission webhook for sidecar injection (Istio, Linkerd, etc.) failed to inject the proxy container. The pod may start without mesh connectivity.",
  remediation: [
    "Check webhook configuration: kubectl get mutatingwebhookconfiguration",
    "Verify the sidecar injector is running: kubectl get pods -n istio-system",
    "Check namespace labels for injection: kubectl get ns <ns> --show-labels",
    "Review injector logs for specific errors",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-upstream-connect-error"],
});

_add({
  id: "net-endpoint-slice-overflow",
  pattern: "EndpointSlice overflow / too many endpoints",
  regex: /(?:EndpointSlice.*overflow|too\s+many\s+endpoints|endpoint\s+count\s+exceeded)/i,
  rootCause: "Service has more endpoints than EndpointSlice supports",
  explanation:
    "The Service has so many backing pods that the EndpointSlice limit has been reached. Kubernetes defaults to 100 endpoints per slice and 1000 total.",
  remediation: [
    "Check endpoint count: kubectl get endpointslices -l kubernetes.io/service-name=<svc>",
    "Consider splitting the service into multiple services",
    "Increase max-endpoints-per-slice on kube-controller-manager if needed",
    "Use headless services with client-side load balancing for very large deployments",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-no-endpoints"],
});

_add({
  id: "net-port-already-allocated",
  pattern: "port is already allocated",
  regex: /port\s+\d+\s+.*already\s+allocated/i,
  rootCause: "NodePort or LoadBalancer port collision",
  explanation:
    "Another Service is already using the requested NodePort. NodePorts must be unique across the cluster (default range 30000-32767).",
  remediation: [
    "Find the conflicting service: kubectl get svc --all-namespaces | grep <port>",
    "Change the NodePort to an unused value",
    "Let Kubernetes auto-assign a free port by removing the nodePort field",
    "Expand the NodePort range in kube-apiserver if needed",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["sched-host-port-conflict"],
});

// ---------------------------------------------------------------------------
// 5. STORAGE ERRORS  (15+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "storage-failed-mount",
  pattern: "FailedMount + not found",
  regex: /FailedMount[\s\S]{0,300}not\s+found/i,
  rootCause: "PersistentVolume or PVC does not exist",
  explanation:
    "The pod references a volume that cannot be mounted because the PV or PVC is missing. The volume source (configMap, secret, PVC, etc.) may not have been created.",
  remediation: [
    "Check pod volume definitions: kubectl describe pod <pod> | grep -A5 Volumes",
    "Verify referenced PVCs exist: kubectl get pvc -n <ns>",
    "Verify referenced ConfigMaps/Secrets exist: kubectl get configmap,secret -n <ns>",
    "Create the missing volume source",
  ],
  severity: "critical",
  category: "storage",
  reasons: ["FailedMount"],
  relatedErrors: ["sched-pvc-not-found", "runtime-config-error"],
});

_add({
  id: "storage-already-mounted",
  pattern: "FailedMount + already mounted / multi-attach",
  regex: /(?:FailedMount|FailedAttachVolume)[\s\S]{0,300}(?:already\s+mounted|multi-attach|volume\s+is\s+already\s+(?:used|exclusively\s+attached)|ReadWriteOnce)/i,
  rootCause: "ReadWriteOnce volume contention — attached to another node",
  explanation:
    "The volume has ReadWriteOnce access mode and is already mounted on a different node. Only one node can mount an RWO volume at a time. This commonly occurs during rolling updates when old and new pods are scheduled on different nodes.",
  remediation: [
    "Check which node currently has the volume: kubectl describe pv <pv-name> | grep 'Node Affinity'",
    "Wait for the old pod to terminate and release the volume",
    "Use Recreate deployment strategy instead of RollingUpdate for RWO volumes",
    "Switch to ReadWriteMany (RWX) if the storage backend supports it (NFS, CephFS, Azure Files)",
    "Use pod affinity to keep the pod on the same node as the volume",
  ],
  severity: "critical",
  category: "storage",
  reasons: ["FailedMount", "FailedAttachVolume"],
  platformNotes: {
    eks: "EBS is RWO-only; use EFS for RWX or Recreate strategy",
    aks: "Azure Disk is RWO; use Azure Files for RWX",
    gke: "PD is RWO; use Filestore for RWX access",
  },
  relatedErrors: ["storage-failed-mount"],
});

_add({
  id: "storage-mount-timeout",
  pattern: "FailedMount + timeout",
  regex: /(?:FailedMount|FailedAttachVolume)[\s\S]{0,300}(?:timeout|timed?\s*out|deadline\s+exceeded|waiting\s+for)/i,
  rootCause: "Storage backend slow or unreachable",
  explanation:
    "The volume mount timed out. The storage backend (cloud provider, NFS server, Ceph cluster) may be unreachable, overloaded, or the CSI driver is failing.",
  remediation: [
    "Check storage backend health (NFS server, Ceph health, cloud provider status)",
    "Verify CSI driver pods are running: kubectl get pods -n <csi-namespace>",
    "Check VolumeAttachment status: kubectl get volumeattachment",
    "Increase mount timeout if the storage is known to be slow",
    "Check network connectivity between node and storage backend",
  ],
  severity: "critical",
  category: "storage",
  reasons: ["FailedMount", "FailedAttachVolume"],
  relatedErrors: ["storage-failed-mount"],
});

_add({
  id: "storage-volume-resize-failed",
  pattern: "VolumeResizeFailed",
  regex: /(?:VolumeResizeFailed|resize.*failed|FileSystemResizeFailed)/i,
  rootCause: "CSI driver or filesystem does not support expansion",
  explanation:
    "The volume or filesystem resize failed. The CSI driver may not support expansion, the StorageClass may not allow it, or the underlying storage backend cannot resize the volume.",
  remediation: [
    "Check if StorageClass allows expansion: kubectl get sc <name> -o jsonpath='{.allowVolumeExpansion}'",
    "Ensure the CSI driver supports volume expansion",
    "Check node-level filesystem resize capability",
    "Try restarting the pod to trigger a new filesystem resize attempt",
    "If resizing from a snapshot, verify the original volume size is correct",
  ],
  severity: "warning",
  category: "storage",
  reasons: ["VolumeResizeFailed", "FileSystemResizeFailed"],
  relatedErrors: [],
});

_add({
  id: "storage-pvc-binding",
  pattern: "FailedBinding — no matching PV",
  regex: /(?:FailedBinding|no\s+persistent\s+volumes?\s+available)/i,
  rootCause: "No PV matching the PVC spec (size, access mode, storageClass)",
  explanation:
    "The PVC cannot bind because no PV satisfies its requirements. Either the storageClass doesn't exist, no PV has enough capacity, or access modes don't match.",
  remediation: [
    "Check PVC status: kubectl describe pvc <name> -n <ns>",
    "Verify StorageClass exists: kubectl get sc",
    "Ensure PV capacity >= PVC request",
    "Check access mode compatibility (RWO, RWX, ROX)",
    "If using dynamic provisioning, verify the provisioner is running",
  ],
  severity: "critical",
  category: "storage",
  reasons: ["FailedBinding"],
  relatedErrors: ["storage-provisioning-failed", "sched-unbound-pvc"],
});

_add({
  id: "storage-provisioning-failed",
  pattern: "ProvisioningFailed",
  regex: /(?:ProvisioningFailed|failed\s+to\s+provision\s+volume)/i,
  rootCause: "StorageClass misconfigured or provisioner unavailable",
  explanation:
    "Dynamic volume provisioning failed. The StorageClass provisioner could not create the underlying storage resource. This may be due to misconfigured parameters, IAM permissions, or the provisioner being down.",
  remediation: [
    "Check PVC events for detailed error: kubectl describe pvc <name>",
    "Verify StorageClass parameters: kubectl get sc <name> -o yaml",
    "Ensure the CSI driver / provisioner pods are healthy",
    "Check IAM/RBAC permissions for the provisioner to create storage resources",
    "Verify cloud provider quotas for disks/volumes",
  ],
  severity: "critical",
  category: "storage",
  reasons: ["ProvisioningFailed"],
  platformNotes: {
    eks: "Check EBS CSI driver pods and IAM role: kubectl get pods -n kube-system -l app=ebs-csi-controller",
    aks: "Verify Azure Disk CSI driver and MSI permissions",
    gke: "Check GCE PD CSI driver and service account permissions",
    openshift: "Check OCS/ODF operator health and Ceph cluster status",
  },
  relatedErrors: ["storage-pvc-binding"],
});

_add({
  id: "storage-node-expand-failed",
  pattern: "NodeExpandVolumeFailed",
  regex: /(?:NodeExpandVolumeFailed|failed\s+to\s+expand\s+volume\s+on\s+node)/i,
  rootCause: "Filesystem resize failed on the node",
  explanation:
    "The controller successfully resized the underlying block device, but the filesystem resize on the node failed. This requires node-level access and the correct filesystem tools.",
  remediation: [
    "Check kubelet logs on the node for filesystem resize errors",
    "Ensure the node has the required filesystem tools (resize2fs, xfs_growfs)",
    "Restart the pod to trigger a new resize attempt",
    "If the filesystem is corrupt, backup data and recreate the PVC",
  ],
  severity: "warning",
  category: "storage",
  reasons: ["NodeExpandVolumeFailed"],
  relatedErrors: ["storage-volume-resize-failed"],
});

_add({
  id: "storage-stale-nfs-handle",
  pattern: "Stale NFS file handle",
  regex: /[Ss]tale\s+(?:NFS\s+)?file\s+handle/i,
  rootCause: "NFS server was restarted or export was recreated",
  explanation:
    "The NFS file handle cached by the kernel is no longer valid. This happens when the NFS server is restarted, the export is deleted and recreated, or there's a failover to a different NFS server.",
  remediation: [
    "Restart the affected pods to re-mount the NFS volume",
    "Check NFS server health and ensure exports are stable",
    "Consider using a more robust storage solution for critical workloads",
    "If using NFS provisioner, verify it's healthy and the backing storage is stable",
  ],
  severity: "critical",
  category: "storage",
  reasons: [],
  relatedErrors: ["storage-mount-timeout"],
});

_add({
  id: "storage-volume-attachment-stuck",
  pattern: "VolumeAttachment stuck / not detached",
  regex: /(?:VolumeAttachment.*(?:stuck|not\s+detach)|DetachVolume.*failed|volume.*(?:still\s+attached|in-use))/i,
  rootCause: "Volume stuck in attached state on a previous node",
  explanation:
    "The volume is still marked as attached to a previous node, preventing it from being attached to the new node. This can happen if a node dies unexpectedly without cleanly detaching volumes.",
  remediation: [
    "Check VolumeAttachment objects: kubectl get volumeattachment | grep <pv-name>",
    "If the old node is gone, delete the stale VolumeAttachment: kubectl delete volumeattachment <name>",
    "Force-detach the volume via the cloud provider console/CLI",
    "Wait for the node controller to mark the node as unreachable and force-detach (typically 6 minutes)",
  ],
  severity: "critical",
  category: "storage",
  reasons: ["FailedAttachVolume"],
  relatedErrors: ["storage-already-mounted"],
});

_add({
  id: "storage-read-only-filesystem",
  pattern: "read-only file system",
  regex: /read-only\s+file\s+system/i,
  rootCause: "Volume mounted as read-only or filesystem corrupted",
  explanation:
    "Write operations failed because the filesystem is mounted read-only. This can be intentional (readOnly: true in volume mount) or caused by filesystem corruption that triggered a forced read-only remount.",
  remediation: [
    "Check if readOnly is set in the volumeMount spec",
    "If intentional, ensure the application handles read-only correctly",
    "If unintentional, check the underlying disk for filesystem errors",
    "Check dmesg/journal on the node for filesystem corruption messages",
    "Recreate the PV/PVC from a backup if the filesystem is corrupt",
  ],
  severity: "warning",
  category: "storage",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "storage-disk-pressure",
  pattern: "DiskPressure on node",
  regex: /(?:DiskPressure|nodefs.*(?:available|pressure)|imagefs.*(?:available|pressure))/i,
  rootCause: "Node disk space is critically low",
  explanation:
    "The node is reporting DiskPressure condition because available disk space is below the eviction threshold. Pods may be evicted. Causes include large log files, unused container images, or insufficient disk size.",
  remediation: [
    "Check node conditions: kubectl describe node <node> | grep -A5 Conditions",
    "Clean up unused container images: crictl rmi --prune",
    "Remove completed pods: kubectl delete pods --field-selector=status.phase=Succeeded",
    "Increase node disk size or add dedicated volumes for container storage",
    "Configure log rotation to limit log file sizes",
  ],
  severity: "critical",
  category: "storage",
  reasons: ["Evicted", "DiskPressure"],
  relatedErrors: [],
});

_add({
  id: "storage-ephemeral-exceeded",
  pattern: "ephemeral storage exceeded",
  regex: /(?:ephemeral.*storage.*exceeded|local\s+ephemeral\s+storage.*limit)/i,
  rootCause: "Container exceeded ephemeral storage limit",
  explanation:
    "The container wrote too much data to emptyDir, container writable layer, or log files, exceeding the ephemeral-storage limit. The pod will be evicted.",
  remediation: [
    "Check ephemeral-storage usage and limits: kubectl describe pod <pod>",
    "Increase ephemeral-storage limit in the container spec",
    "Use a PVC for large data instead of ephemeral storage",
    "Limit log output or configure log rotation in the application",
    "Check for runaway temp file creation in the application",
  ],
  severity: "warning",
  category: "storage",
  reasons: ["Evicted"],
  relatedErrors: ["storage-disk-pressure"],
});

_add({
  id: "storage-subpath-error",
  pattern: "subPath mount error",
  regex: /(?:subPath.*(?:error|not\s+found|cannot)|failed\s+to.*subpath)/i,
  rootCause: "SubPath does not exist in the volume",
  explanation:
    "The volume mount specifies a subPath that does not exist in the underlying volume. The mount fails because the directory or file is missing.",
  remediation: [
    "Verify the subPath exists in the volume (ConfigMap key, PVC directory)",
    "For ConfigMaps, ensure the key name matches the subPath value",
    "Create the directory in the volume before mounting",
    "Use subPathExpr with a downward API variable if the path is dynamic",
  ],
  severity: "warning",
  category: "storage",
  reasons: ["FailedMount"],
  relatedErrors: ["storage-failed-mount"],
});

_add({
  id: "storage-quota-exceeded",
  pattern: "exceeded storage quota",
  regex: /(?:storage\s+quota.*exceeded|exceeded.*storage\s+quota|quota.*persistentvolumeclaim)/i,
  rootCause: "Namespace storage quota exceeded",
  explanation:
    "The namespace ResourceQuota limits total PVC storage and creating this PVC would exceed the limit.",
  remediation: [
    "Check storage quota: kubectl describe resourcequota -n <ns>",
    "Free up storage by deleting unused PVCs",
    "Request a quota increase from the cluster administrator",
    "Use smaller PVC sizes where possible",
  ],
  severity: "warning",
  category: "storage",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

// ---------------------------------------------------------------------------
// 6. RBAC / SECURITY ERRORS  (15+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "rbac-cannot-create",
  pattern: "forbidden + cannot create",
  regex: /forbidden[\s\S]{0,200}cannot\s+(?:create|get|list|watch|update|patch|delete)/i,
  rootCause: "Missing RBAC role for the operation",
  explanation:
    "The user or ServiceAccount lacks the RBAC permissions to perform this action. A ClusterRole/Role and ClusterRoleBinding/RoleBinding need to be configured.",
  remediation: [
    "Check the specific resource and verb from the error message",
    "Verify the ServiceAccount: kubectl get pod <pod> -o jsonpath='{.spec.serviceAccountName}'",
    "Check existing bindings: kubectl get rolebindings,clusterrolebindings -A | grep <sa-name>",
    "Create the needed Role and RoleBinding: kubectl create role <name> --verb=<verb> --resource=<resource>",
    "Bind it: kubectl create rolebinding <name> --role=<name> --serviceaccount=<ns>:<sa>",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  platformNotes: {
    openshift: "Also check ClusterRoles created by operators; use oc adm policy who-can <verb> <resource>",
  },
  relatedErrors: ["rbac-pods-forbidden", "rbac-user-cannot"],
});

_add({
  id: "rbac-scc-denied",
  pattern: "forbidden + security context constraint (OpenShift)",
  regex: /(?:forbidden[\s\S]{0,200}security\s+context\s+constraint|unable\s+to\s+validate\s+against\s+any\s+security\s+context\s+constraint)/i,
  rootCause: "SCC violation — container security settings not allowed (OpenShift)",
  explanation:
    "The pod's security settings (runAsUser, capabilities, volumes, etc.) don't match any Security Context Constraint (SCC) available to its ServiceAccount. This is OpenShift-specific and is the most common deployment blocker.",
  remediation: [
    "Check the denied SCC fields in the error message",
    "View available SCCs: oc get scc",
    "Check which SCCs are available to the SA: oc adm policy who-can use scc anyuid",
    "Grant a less restrictive SCC: oc adm policy add-scc-to-user <scc> -z <sa> -n <ns>",
    "Prefer modifying the pod to comply with restricted SCC rather than granting elevated SCCs",
    "Common SCCs in order of restrictiveness: restricted > nonroot > anyuid > hostaccess > privileged",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  platformNotes: {
    openshift: "Default SCC is 'restricted' which blocks root, hostNetwork, hostPID, and most capabilities. Use 'oc describe scc <name>' to see constraints.",
  },
  relatedErrors: ["rbac-cannot-create", "crash-exit-126"],
});

_add({
  id: "rbac-scc-validate",
  pattern: "unable to validate against any security context constraint",
  regex: /unable\s+to\s+validate\s+against\s+any\s+security\s+context\s+constraint/i,
  rootCause: "No matching SCC for the pod's security requirements (OpenShift)",
  explanation:
    "None of the SCCs available to the pod's ServiceAccount allow the pod's security configuration. Every SCC was tried and none matched.",
  remediation: [
    "List SCCs the SA can use: oc adm policy who-can use scc anyuid --as=system:serviceaccount:<ns>:<sa>",
    "Common issues: requesting root UID, host networking, privileged mode, or special capabilities",
    "Modify pod spec to comply with restricted SCC (best practice)",
    "Or grant a specific SCC: oc adm policy add-scc-to-user <scc> -z <sa> -n <ns>",
    "Check if an operator should be granting SCCs via its ClusterServiceVersion",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  platformNotes: {
    openshift: "Use 'oc adm policy scc-review -f <pod-spec.yaml>' to see which SCCs would accept the pod",
  },
  relatedErrors: ["rbac-scc-denied"],
});

_add({
  id: "rbac-admission-webhook-denied",
  pattern: "admission webhook denied the request",
  regex: /admission\s+webhook[\s\S]{0,200}denied/i,
  rootCause: "Validating or mutating webhook rejected the request",
  explanation:
    "A validating admission webhook denied the create/update request. This is often from policy engines (OPA/Gatekeeper, Kyverno), PodSecurity admission, or custom webhooks.",
  remediation: [
    "Check the full error message for the webhook name and denial reason",
    "List webhooks: kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration",
    "Fix the resource to comply with the policy (e.g. add required labels, fix security settings)",
    "If the webhook is incorrect, check the policy engine configuration",
    "In emergencies, the webhook can be disabled (dangerous): add failurePolicy: Ignore",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-scc-denied", "rbac-pod-security-violation"],
});

_add({
  id: "rbac-pods-forbidden",
  pattern: "pods is forbidden",
  regex: /pods[\s\S]{0,50}(?:is\s+)?forbidden/i,
  rootCause: "ServiceAccount lacks permissions for pod operations",
  explanation:
    "The ServiceAccount used by the pod (or by a controller managing pods) does not have the necessary RBAC permissions to perform pod operations (get, list, create, delete).",
  remediation: [
    "Identify the ServiceAccount making the request",
    "Check existing roles: kubectl get clusterrole,role -A | grep <sa-or-role>",
    "Create or update a Role/ClusterRole with pods verb permissions",
    "Bind it to the ServiceAccount with a RoleBinding/ClusterRoleBinding",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-cannot-create"],
});

_add({
  id: "rbac-user-cannot",
  pattern: "User cannot <verb> <resource> in the namespace",
  regex: /User[\s\S]{0,50}cannot[\s\S]{0,100}in\s+the\s+namespace/i,
  rootCause: "Role binding missing for the user in this namespace",
  explanation:
    "The authenticated user does not have a RoleBinding in the target namespace granting the requested permission. The ClusterRole may exist but the binding is namespace-scoped and missing.",
  remediation: [
    "Check the user's roles: kubectl auth can-i --list --as=<user> -n <ns>",
    "Create a RoleBinding: kubectl create rolebinding <name> --clusterrole=<role> --user=<user> -n <ns>",
    "Or add the user to an existing group that has the needed permissions",
    "Verify the identity provider is sending correct groups/claims",
  ],
  severity: "warning",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-cannot-create"],
});

_add({
  id: "rbac-pod-security-violation",
  pattern: "PodSecurity admission violation",
  regex: /(?:violat.*(?:PodSecurity|pod-security\.kubernetes\.io)|pod-security.*(?:warn|deny|audit))/i,
  rootCause: "Pod violates namespace PodSecurity admission level",
  explanation:
    "The namespace has PodSecurity admission labels (e.g. pod-security.kubernetes.io/enforce: restricted) and the pod violates the security constraints at the enforce level.",
  remediation: [
    "Check namespace labels: kubectl get ns <ns> --show-labels | grep pod-security",
    "Fix the pod spec to comply with the security level (see k8s.io/docs/concepts/security/pod-security-standards/)",
    "Common issues: running as root, requesting capabilities, using hostPath",
    "If necessary, relax the namespace policy (not recommended for production)",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-scc-denied", "rbac-admission-webhook-denied"],
});

_add({
  id: "rbac-cert-expired",
  pattern: "certificate has expired or is not yet valid",
  regex: /(?:certificate\s+has\s+expired|certificate.*not\s+yet\s+valid|x509.*expired)/i,
  rootCause: "TLS certificate expired — authentication or API communication failing",
  explanation:
    "A TLS certificate used for cluster communication (API server, kubelet, etcd, or webhook) has expired. This can cause authentication failures and cluster instability.",
  remediation: [
    "Identify the expired certificate from the error message",
    "Check API server certificates: kubeadm certs check-expiration",
    "Renew certificates: kubeadm certs renew all",
    "Restart affected components after renewal",
    "Set up certificate rotation to prevent future expirations",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  platformNotes: {
    openshift: "OpenShift auto-rotates most certificates; check oc get co | grep cert for cluster operator status",
    eks: "EKS manages control plane certificates automatically",
    gke: "GKE manages certificates automatically",
  },
  relatedErrors: [],
});

_add({
  id: "rbac-token-expired",
  pattern: "token has expired / unauthorized",
  regex: /(?:token\s+(?:has\s+)?expired|Unauthorized|401.*(?:token|auth))/i,
  rootCause: "Authentication token expired or invalid",
  explanation:
    "The bearer token used for API server authentication has expired or is invalid. This affects ServiceAccount tokens, OIDC tokens, or other auth mechanisms.",
  remediation: [
    "Check if the token is a ServiceAccount token or user token",
    "For SA tokens, delete and recreate the secret or restart the pod to get a new projected token",
    "For OIDC tokens, re-authenticate with the identity provider",
    "Verify token audience and issuer match API server configuration",
    "Check if BoundServiceAccountToken feature is rotating tokens correctly",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-user-cannot"],
});

_add({
  id: "rbac-impersonate-denied",
  pattern: "impersonate forbidden",
  regex: /(?:cannot\s+impersonate|impersonat.*forbidden)/i,
  rootCause: "User lacks impersonation RBAC permission",
  explanation:
    "The user is trying to impersonate another user/group/SA but lacks the 'impersonate' verb on the target resource. This is needed for tools like kubectl --as=<user>.",
  remediation: [
    "Grant impersonate permissions via ClusterRole: create a role with apiGroups: [''], resources: ['users','groups','serviceaccounts'], verbs: ['impersonate']",
    "Bind it to the user who needs impersonation",
    "Use the least-privilege approach: only allow impersonating specific targets",
  ],
  severity: "warning",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-user-cannot"],
});

_add({
  id: "rbac-network-policy-denied",
  pattern: "Network policy denied traffic",
  regex: /(?:network\s+polic.*denied|denied\s+by.*network\s+polic|traffic.*blocked.*network\s*polic)/i,
  rootCause: "NetworkPolicy is blocking traffic between pods or to external",
  explanation:
    "A Kubernetes NetworkPolicy is explicitly denying the traffic. When any NetworkPolicy selects a pod, all non-allowed traffic is blocked (default-deny behavior).",
  remediation: [
    "List NetworkPolicies in the source namespace: kubectl get networkpolicy -n <ns>",
    "Check policy selectors and ingress/egress rules: kubectl describe networkpolicy <name>",
    "Add an allow rule for the needed traffic flow",
    "Verify both ingress (destination) and egress (source) policies",
    "Test with a temporary allow-all policy to confirm NetworkPolicy is the cause",
  ],
  severity: "warning",
  category: "rbac",
  reasons: [],
  relatedErrors: ["net-io-timeout", "net-connection-refused"],
});

_add({
  id: "rbac-seccomp-violation",
  pattern: "seccomp profile violation",
  regex: /(?:seccomp.*(?:violation|denied|blocked|not\s+allowed)|operation\s+not\s+permitted.*seccomp)/i,
  rootCause: "Seccomp profile blocks a system call the container needs",
  explanation:
    "The container's seccomp profile (security context) blocks a system call that the application requires. The default RuntimeDefault profile is suitable for most workloads but some applications need specific syscalls.",
  remediation: [
    "Identify the blocked syscall from audit logs or strace",
    "Create a custom seccomp profile that allows the needed syscall",
    "Use RuntimeDefault profile if no custom profile exists (secure default)",
    "Load the custom profile via a seccomp profile CRD or local file",
  ],
  severity: "warning",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-scc-denied"],
});

_add({
  id: "rbac-selinux-denied",
  pattern: "SELinux denial",
  regex: /(?:SELinux.*(?:denied|prevented|blocking)|avc:\s+denied)/i,
  rootCause: "SELinux policy is blocking a container operation",
  explanation:
    "SELinux on the node is in enforcing mode and blocking a file access or operation by the container process. This is common on RHEL/CentOS-based nodes.",
  remediation: [
    "Check SELinux audit log: ausearch -m avc -ts recent",
    "Use audit2allow to generate the needed policy module",
    "Set the correct SELinux label in the pod securityContext.seLinuxOptions",
    "If the volume mount is blocked, ensure the volume has the correct :Z or :z suffix",
  ],
  severity: "warning",
  category: "rbac",
  reasons: [],
  platformNotes: {
    openshift: "OpenShift uses SELinux in enforcing mode; use MCS labels via SCC or set seLinuxOptions in securityContext",
  },
  relatedErrors: ["rbac-scc-denied"],
});

// ---------------------------------------------------------------------------
// 7. OPERATOR / CONTROLLER ERRORS  (15+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "operator-degraded",
  pattern: "Degraded: True",
  regex: /(?:Degraded\s*[:=]\s*True|condition.*Degraded.*True)/i,
  rootCause: "Operator health check failed — degraded performance",
  explanation:
    "An operator or cluster component is reporting Degraded=True. It may still be partially functional but is not operating optimally. This can block cluster upgrades.",
  remediation: [
    "Check operator status: kubectl get clusteroperators (OpenShift) or kubectl get csv -A (OLM)",
    "Review operator pod logs for detailed error messages",
    "Check the Degraded condition message for specific causes",
    "Restart the operator pod if the issue appears transient",
    "Check dependent resources (ConfigMaps, Secrets, CRDs) referenced by the operator",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  platformNotes: {
    openshift: "Check oc get co for ClusterOperator status; oc describe co/<name> for details",
  },
  relatedErrors: ["operator-available-false"],
});

_add({
  id: "operator-available-false",
  pattern: "Available: False",
  regex: /(?:Available\s*[:=]\s*False|condition.*Available.*False)/i,
  rootCause: "Operator is not functioning — critical failure",
  explanation:
    "The operator or cluster component reports Available=False, meaning it is not providing its intended functionality at all. This is more severe than Degraded.",
  remediation: [
    "Check operator pod status: kubectl get pods -n <operator-namespace>",
    "Review operator logs: kubectl logs <operator-pod> -n <operator-namespace>",
    "Check for missing CRDs: kubectl get crd | grep <operator-name>",
    "Verify dependencies (etcd, API server, networking) are healthy",
    "Check if a failed upgrade left the operator in a bad state",
  ],
  severity: "critical",
  category: "operator",
  reasons: [],
  platformNotes: {
    openshift: "For ClusterOperators, run: oc describe co/<name> and check message/reason fields",
  },
  relatedErrors: ["operator-degraded"],
});

_add({
  id: "operator-install-plan-failed",
  pattern: "InstallPlanFailed",
  regex: /(?:InstallPlanFailed|InstallPlan.*(?:failed|error))/i,
  rootCause: "OLM operator installation failed",
  explanation:
    "The Operator Lifecycle Manager (OLM) failed to execute the InstallPlan for an operator. This can be due to RBAC issues, resource conflicts, or CRD incompatibilities.",
  remediation: [
    "Check InstallPlan status: kubectl get installplan -n <ns>",
    "Describe the failed plan: kubectl describe installplan <name> -n <ns>",
    "Check for resource conflicts or missing permissions",
    "Delete the InstallPlan and let OLM recreate it",
    "Verify the CatalogSource is healthy: kubectl get catalogsource -n <ns>",
  ],
  severity: "critical",
  category: "operator",
  reasons: ["InstallPlanFailed"],
  platformNotes: {
    openshift: "Check oc get ip -n <ns> and oc get csv -n <ns> for install status",
  },
  relatedErrors: ["operator-available-false"],
});

_add({
  id: "operator-cluster-operator-degraded",
  pattern: "ClusterOperator degraded",
  regex: /ClusterOperator[\s\S]{0,100}(?:degraded|failing)/i,
  rootCause: "OpenShift cluster operator needs attention",
  explanation:
    "An OpenShift ClusterOperator is not healthy. This can affect core cluster functionality (networking, storage, ingress, authentication, etc.).",
  remediation: [
    "List all cluster operators: oc get clusteroperators",
    "Check the specific operator: oc describe co/<name>",
    "Review the operator namespace pods: oc get pods -n openshift-<component>",
    "Check logs for the operator pods",
    "If caused by a recent config change, revert it",
  ],
  severity: "critical",
  category: "operator",
  reasons: [],
  platformNotes: {
    openshift: "Cluster operators must all be Available=True and Degraded=False before upgrades can proceed",
  },
  relatedErrors: ["operator-degraded", "operator-available-false"],
});

_add({
  id: "operator-reconcile-error",
  pattern: "ReconcileError",
  regex: /(?:Reconcile\s*Error|reconcil.*(?:failed|error)|controller.*reconcil.*error)/i,
  rootCause: "Controller reconciliation loop failed",
  explanation:
    "The operator's controller reconciliation loop encountered an error while trying to converge the actual state to the desired state. This will be retried with backoff.",
  remediation: [
    "Check operator logs for the specific reconciliation error",
    "Verify the custom resource spec is valid",
    "Check if dependent resources (ConfigMaps, Secrets, other CRs) exist",
    "Look for conflicting resources or ownership issues",
    "Restart the operator if the error persists after fixing the root cause",
  ],
  severity: "warning",
  category: "operator",
  reasons: ["ReconcileError"],
  relatedErrors: ["operator-degraded"],
});

_add({
  id: "operator-upgradeable-false",
  pattern: "OperatorCondition Upgradeable=False",
  regex: /(?:Upgradeable\s*[:=]\s*False|cannot\s+upgrade\s+operator)/i,
  rootCause: "Operator is blocking cluster or operator upgrade",
  explanation:
    "The operator has set Upgradeable=False, indicating that the cluster or operator should not be upgraded until the condition is cleared. There may be manual steps required.",
  remediation: [
    "Check the Upgradeable condition message for details",
    "Perform any required pre-upgrade steps documented by the operator",
    "Verify the operator's minimum Kubernetes/OpenShift version requirements",
    "Check for deprecated API usage that needs migration before upgrade",
    "Contact the operator vendor if the condition is unclear",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  platformNotes: {
    openshift: "ClusterOperator Upgradeable=False blocks OTA upgrades; check oc get co for details",
  },
  relatedErrors: ["upgrade-precondition-failed"],
});

_add({
  id: "operator-leader-election-lost",
  pattern: "leader election lost",
  regex: /(?:leader\s+election\s+lost|lost\s+leader\s+lease|failed\s+to\s+acquire\s+leader\s+lease)/i,
  rootCause: "Operator lost leader election — failover in progress",
  explanation:
    "The operator pod lost its leader election lease. Another replica should acquire the lease. If no replica acquires it, the operator becomes inactive.",
  remediation: [
    "Check if another operator replica took over leadership",
    "Verify lease objects: kubectl get lease -n <operator-namespace>",
    "If no leader exists, restart operator pods",
    "Check for clock skew between nodes that may affect lease renewal",
    "Increase lease duration if the operator is frequently losing leadership",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "operator-crd-conflict",
  pattern: "CRD conflict / version mismatch",
  regex: /(?:CRD.*(?:conflict|version.*mismatch|already\s+exists)|CustomResourceDefinition.*(?:conflict|error))/i,
  rootCause: "CRD version conflict between operators",
  explanation:
    "Two operators are trying to manage the same CRD, or a CRD version upgrade failed. This can happen when multiple operator versions coexist or manual CRD modifications were made.",
  remediation: [
    "Check CRD versions: kubectl get crd <name> -o jsonpath='{.spec.versions[*].name}'",
    "Identify which operators reference the CRD",
    "Ensure only one operator manages each CRD",
    "If upgrading, follow the operator's documented upgrade path",
    "Back up CRs before deleting and recreating CRDs",
  ],
  severity: "critical",
  category: "operator",
  reasons: [],
  relatedErrors: ["operator-install-plan-failed"],
});

_add({
  id: "operator-webhook-timeout",
  pattern: "operator webhook timeout / unavailable",
  regex: /(?:webhook.*(?:timeout|unavailable|connection\s+refused)|failed\s+calling\s+webhook)/i,
  rootCause: "Operator's webhook server is not reachable",
  explanation:
    "The operator's validating or mutating webhook is not responding. This blocks all API requests for the resources the webhook validates, which can prevent creating or modifying resources.",
  remediation: [
    "Check webhook pod status: kubectl get pods -n <operator-namespace>",
    "Verify the webhook Service has endpoints",
    "Check webhook TLS certificate validity",
    "If the operator is being uninstalled, delete the webhook configuration manually",
    "Set failurePolicy to Ignore temporarily (ONLY in emergencies)",
  ],
  severity: "critical",
  category: "operator",
  reasons: [],
  relatedErrors: ["rbac-admission-webhook-denied"],
});

_add({
  id: "operator-catalog-source-error",
  pattern: "CatalogSource connection error",
  regex: /(?:CatalogSource.*(?:error|failed|unhealthy)|GRPC.*catalog.*error|operator-registry.*error)/i,
  rootCause: "OLM CatalogSource is unhealthy or unreachable",
  explanation:
    "The CatalogSource that provides operator metadata is failing. Without it, new subscriptions cannot be resolved and operators cannot be installed or upgraded.",
  remediation: [
    "Check CatalogSource pods: kubectl get pods -n <catalog-namespace>",
    "Describe the CatalogSource: kubectl describe catalogsource <name>",
    "Check for image pull errors on the catalog pod",
    "Verify the catalog image is accessible from the cluster",
    "Delete and recreate the CatalogSource if it's stuck",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  platformNotes: {
    openshift: "Default CatalogSources are in openshift-marketplace namespace; check oc get catalogsource -n openshift-marketplace",
  },
  relatedErrors: ["operator-install-plan-failed"],
});

_add({
  id: "operator-subscription-error",
  pattern: "Subscription install error",
  regex: /(?:Subscription[\s\S]{0,100}(?:error|failed|ConstraintsNotSatisfiable)|ResolutionFailed)/i,
  rootCause: "OLM Subscription cannot be resolved or installed",
  explanation:
    "The OLM Subscription failed to resolve a valid install plan. This can be due to package not found, version constraints not satisfiable, or channel not existing in the catalog.",
  remediation: [
    "Check Subscription status: kubectl describe subscription <name> -n <ns>",
    "Verify the package name and channel exist in the CatalogSource",
    "List available packages: kubectl get packagemanifest | grep <name>",
    "Check for version dependency conflicts",
    "Update the subscription to a valid channel/version",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  relatedErrors: ["operator-catalog-source-error", "operator-install-plan-failed"],
});

_add({
  id: "operator-finalizer-stuck",
  pattern: "Finalizer stuck / resource not deleted",
  regex: /(?:finalizer.*(?:stuck|blocking|preventing)|resource.*not\s+deleted.*finalizer|cannot\s+delete.*finalizer)/i,
  rootCause: "Operator finalizer preventing resource deletion",
  explanation:
    "A resource has a finalizer set by an operator, but the operator is not running or cannot complete the cleanup. The resource is stuck in Terminating state indefinitely.",
  remediation: [
    "Check the resource's finalizers: kubectl get <resource> <name> -o jsonpath='{.metadata.finalizers}'",
    "If the operator is running, check its logs for cleanup errors",
    "If the operator is removed, manually remove the finalizer: kubectl patch <resource> <name> --type merge -p '{\"metadata\":{\"finalizers\":[]}}'",
    "Be cautious removing finalizers — they exist to ensure cleanup of external resources",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "operator-owned-resource-conflict",
  pattern: "owned resource conflict / already managed",
  regex: /(?:owned\s+resource.*conflict|resource.*already\s+managed\s+by|controller-manager.*conflict)/i,
  rootCause: "Multiple controllers trying to manage the same resource",
  explanation:
    "Two controllers or operators are competing to manage the same resource. This causes update conflicts and unpredictable behavior.",
  remediation: [
    "Check ownerReferences on the conflicting resource",
    "Ensure only one operator/controller manages each resource",
    "Remove duplicate operator installations",
    "Check for overlapping label selectors between controllers",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  relatedErrors: ["operator-crd-conflict"],
});

// ---------------------------------------------------------------------------
// 8. UPGRADE / VERSION ERRORS  (10+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "upgrade-precondition-failed",
  pattern: "UpgradePreconditionFailed",
  regex: /(?:UpgradePreconditionFailed|precondition.*failed.*upgrade|cluster\s+not\s+ready\s+for\s+upgrade)/i,
  rootCause: "Cluster not ready for upgrade — preconditions not met",
  explanation:
    "Upgrade precondition checks failed. Common reasons: degraded operators, unresolved alerts, insufficient nodes, or incompatible configurations.",
  remediation: [
    "Check cluster operator status: all must be Available=True, Degraded=False",
    "Resolve any critical alerts",
    "Ensure etcd cluster is healthy",
    "Verify sufficient node capacity for surge during upgrade",
    "Check for manually modified operator-managed resources that block upgrade",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  platformNotes: {
    openshift: "Run oc adm upgrade to see current status and blocking conditions",
  },
  relatedErrors: ["operator-upgradeable-false", "operator-degraded"],
});

_add({
  id: "upgrade-cannot-update-operator",
  pattern: "CannotUpdateOperator / version constraint",
  regex: /(?:CannotUpdateOperator|operator.*version\s+constraint|dependency.*version.*conflict)/i,
  rootCause: "Operator version constraint prevents update",
  explanation:
    "The operator cannot be updated to the target version due to version constraints — a dependency requires a different version range, or the update path skips required intermediate versions.",
  remediation: [
    "Check available update channels: kubectl get packagemanifest <operator> -o jsonpath='{.status.channels[*].name}'",
    "Follow the documented sequential upgrade path (don't skip versions)",
    "Update dependencies first if they have version requirements",
    "Check the operator's compatibility matrix for your cluster version",
  ],
  severity: "warning",
  category: "upgrade",
  reasons: [],
  relatedErrors: ["upgrade-precondition-failed"],
});

_add({
  id: "upgrade-api-removed",
  pattern: "API removed in version",
  regex: /(?:APIRemovedInVersion|api.*removed.*(?:version|release)|deprecated\s+API.*removed|uses\s+removed\s+API)/i,
  rootCause: "Workloads use deprecated APIs removed in the target version",
  explanation:
    "The cluster or operator upgrade is blocked because workloads still use APIs that have been removed in the target Kubernetes version (e.g. extensions/v1beta1 Ingress removed in 1.22).",
  remediation: [
    "Identify deprecated API usage: kubectl get apirequestcounts | grep removed",
    "Migrate resources to the replacement API version",
    "Use tools like kubent or pluto to scan for deprecated APIs",
    "Update Helm charts and manifests to use current API versions",
    "Re-apply migrated resources before attempting the upgrade",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  platformNotes: {
    openshift: "oc get apirequestcounts shows usage of deprecated APIs; admin acks may be required",
  },
  relatedErrors: ["upgrade-precondition-failed"],
});

_add({
  id: "upgrade-incompatible-version",
  pattern: "IncompatibleVersion / version jump too large",
  regex: /(?:IncompatibleVersion|version\s+jump.*too\s+large|cannot\s+upgrade.*skip|unsupported\s+upgrade\s+path)/i,
  rootCause: "Cannot skip versions — sequential upgrade required",
  explanation:
    "The upgrade path from current to target version requires intermediate steps. Kubernetes and OpenShift support only N-1 to N upgrades (minor versions).",
  remediation: [
    "Plan sequential upgrades through each minor version",
    "Check the platform's upgrade path documentation",
    "For OpenShift, consult the EUS-to-EUS upgrade matrix",
    "Ensure each intermediate version is stable before proceeding to the next",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  relatedErrors: ["upgrade-precondition-failed"],
});

_add({
  id: "upgrade-etcd-unhealthy",
  pattern: "etcd unhealthy during upgrade",
  regex: /(?:etcd[\s\S]{0,100}(?:unhealthy|degraded|leader.*lost)|EtcdMemberUnhealthy)/i,
  rootCause: "etcd cluster health issues blocking upgrade",
  explanation:
    "The etcd cluster is not fully healthy, which blocks or risks an upgrade. etcd requires quorum and healthy members for safe upgrades.",
  remediation: [
    "Check etcd member health: etcdctl endpoint health --cluster",
    "Verify etcd has quorum (majority of members healthy)",
    "Check etcd pod logs for error messages",
    "Resolve any disk I/O latency issues on etcd nodes",
    "Ensure etcd has enough disk space (alert at 80%+ usage)",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  platformNotes: {
    openshift: "Check oc get co etcd and oc logs -n openshift-etcd etcd-<node>",
  },
  relatedErrors: ["upgrade-precondition-failed"],
});

_add({
  id: "upgrade-machine-config-degraded",
  pattern: "MachineConfigPool degraded during upgrade",
  regex: /(?:MachineConfigPool[\s\S]{0,100}(?:degraded|error|failed)|MachineConfig.*render.*fail)/i,
  rootCause: "Machine configuration failed to apply to nodes",
  explanation:
    "A MachineConfigPool (OpenShift) is in a degraded state. Nodes may be failing to apply the new configuration, blocking the upgrade.",
  remediation: [
    "Check MCP status: oc get mcp",
    "Describe the degraded MCP: oc describe mcp <name>",
    "Check individual machine status: oc get machines -A",
    "Review the rendered MachineConfig for errors",
    "Check node logs/journal for configuration application failures",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  platformNotes: {
    openshift: "MachineConfig changes trigger node reboots; ensure PodDisruptionBudgets allow drain",
  },
  relatedErrors: ["operator-degraded"],
});

_add({
  id: "upgrade-pdb-blocked",
  pattern: "PodDisruptionBudget blocking drain/upgrade",
  regex: /(?:PodDisruptionBudget[\s\S]{0,100}(?:block|prevent|not\s+allow)|cannot\s+evict.*disruption\s+budget|PDB.*violated)/i,
  rootCause: "PDB prevents pod eviction needed for node drain",
  explanation:
    "A PodDisruptionBudget is preventing the required number of pod evictions during a node drain. This blocks rolling upgrades that need to drain nodes.",
  remediation: [
    "Check PDB status: kubectl get pdb -A",
    "Identify the blocking PDB: kubectl describe pdb <name>",
    "Ensure minAvailable/maxUnavailable allows at least one disruption",
    "Scale up the deployment temporarily to allow eviction while maintaining availability",
    "In emergencies, relax or temporarily delete the PDB (coordinate with application team)",
  ],
  severity: "warning",
  category: "upgrade",
  reasons: [],
  relatedErrors: ["upgrade-precondition-failed"],
});

_add({
  id: "upgrade-webhook-blocking",
  pattern: "Webhook blocking upgrade",
  regex: /(?:webhook.*blocking\s+upgrade|webhook.*(?:timeout|error).*during\s+upgrade|admission.*fail.*upgrade)/i,
  rootCause: "Admission webhook failing during upgrade mutations",
  explanation:
    "A validating or mutating admission webhook is failing during upgrade-related API requests, blocking the upgrade process.",
  remediation: [
    "Identify the failing webhook from the error message",
    "Check the webhook pod is running and healthy",
    "Verify webhook TLS certificates are valid",
    "Consider setting failurePolicy: Ignore on non-critical webhooks during upgrade (revert after)",
    "Ensure webhook supports the new API versions being used during upgrade",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  relatedErrors: ["operator-webhook-timeout", "rbac-admission-webhook-denied"],
});

_add({
  id: "upgrade-storage-migration-failed",
  pattern: "StorageVersionMigration failed",
  regex: /(?:StorageVersionMigration.*(?:failed|error)|storage.*version.*migration.*(?:failed|error))/i,
  rootCause: "API storage version migration failed during upgrade",
  explanation:
    "Kubernetes needs to migrate stored resource representations when API versions change. If migration fails, some resources may be stored in deprecated formats.",
  remediation: [
    "Check StorageVersionMigration status: kubectl get storageversionmigration",
    "Review the specific migration error details",
    "Manually trigger re-migration after fixing the underlying issue",
    "Ensure the API server is healthy and can write to etcd",
  ],
  severity: "warning",
  category: "upgrade",
  reasons: [],
  relatedErrors: ["upgrade-api-removed"],
});

_add({
  id: "upgrade-node-not-ready-after-reboot",
  pattern: "Node NotReady after upgrade reboot",
  regex: /(?:Node.*NotReady.*(?:upgrade|reboot)|node.*not\s+ready\s+after.*(?:upgrade|update))/i,
  rootCause: "Node failed to rejoin cluster after upgrade reboot",
  explanation:
    "A node rebooted during upgrade but did not come back online. The kubelet may have failed to start with the new configuration, or the node is stuck in a boot loop.",
  remediation: [
    "Check node status: kubectl get nodes",
    "SSH to the node and check kubelet status: systemctl status kubelet",
    "Check kubelet logs: journalctl -u kubelet -f",
    "Verify the node can reach the API server",
    "Check for disk/hardware issues that may prevent boot",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  relatedErrors: ["sched-nodes-unschedulable"],
});

// ---------------------------------------------------------------------------
// 9. RESOURCE / QUOTA ERRORS  (10+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "quota-exceeded",
  pattern: "exceeded quota",
  regex: /exceeded\s+quota/i,
  rootCause: "ResourceQuota limit hit for the namespace",
  explanation:
    "The namespace's ResourceQuota has been exceeded. The request to create or update a resource was rejected because it would push usage above the quota limit.",
  remediation: [
    "Check quota usage: kubectl describe resourcequota -n <ns>",
    "Identify the specific resource type that hit the limit (cpu, memory, pods, configmaps, etc.)",
    "Free resources by scaling down or removing unused workloads",
    "Request a quota increase from the cluster administrator",
    "Optimize resource requests to use less of the quota",
  ],
  severity: "critical",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-insufficient", "sched-exceeded-quota"],
});

_add({
  id: "quota-limit-range-forbidden",
  pattern: "LimitRange + forbidden",
  regex: /LimitRange[\s\S]{0,200}forbidden/i,
  rootCause: "Container exceeds namespace LimitRange constraints",
  explanation:
    "The namespace has a LimitRange that sets min/max/default constraints on container resource requests/limits. The pod's containers exceed these constraints.",
  remediation: [
    "Check LimitRange: kubectl describe limitrange -n <ns>",
    "Adjust container resources to fall within the LimitRange min/max",
    "If the LimitRange is too restrictive, ask the admin to update it",
    "Note: LimitRange also applies to PVC sizes and ephemeral storage",
  ],
  severity: "warning",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-insufficient",
  pattern: "insufficient quota",
  regex: /insufficient\s+quota/i,
  rootCause: "Not enough remaining quota to create the resource",
  explanation:
    "There is not enough remaining quota in the namespace to create the requested resource. This is similar to 'exceeded quota' but may appear in different contexts (e.g. cloud provider quotas).",
  remediation: [
    "Check namespace ResourceQuota: kubectl describe resourcequota -n <ns>",
    "Check cloud provider quotas (vCPU, disk, IP addresses) if applicable",
    "Scale down unused workloads to free quota",
    "Request quota increase",
  ],
  severity: "critical",
  category: "quota",
  reasons: [],
  platformNotes: {
    eks: "Check AWS service quotas: aws service-quotas list-service-quotas --service-code ec2",
    aks: "Check Azure subscription quotas: az vm list-usage --location <region>",
    gke: "Check GCP project quotas: gcloud compute project-info describe",
  },
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-pod-count-exceeded",
  pattern: "exceeded quota: pod count",
  regex: /(?:exceeded\s+quota.*pods|pod\s+count.*quota|quota.*count.*pods.*exceeded)/i,
  rootCause: "Maximum number of pods in namespace exceeded",
  explanation:
    "The ResourceQuota limits the number of pods in the namespace and this limit has been reached. No new pods can be created.",
  remediation: [
    "Check pod count quota: kubectl describe resourcequota -n <ns> | grep pods",
    "Remove completed/failed pods: kubectl delete pods --field-selector=status.phase=Failed -n <ns>",
    "Scale down unnecessary deployments",
    "Request a higher pod quota",
  ],
  severity: "critical",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-cpu-limit-exceeded",
  pattern: "exceeded quota: limits.cpu",
  regex: /exceeded\s+quota.*limits\.cpu/i,
  rootCause: "Namespace CPU limit quota exceeded",
  explanation:
    "The total CPU limits of all containers in the namespace would exceed the ResourceQuota's limits.cpu. Reduce CPU limits or increase quota.",
  remediation: [
    "Check CPU quota: kubectl describe resourcequota -n <ns> | grep cpu",
    "Review container CPU limits across deployments",
    "Reduce CPU limits on over-provisioned containers",
    "Request quota increase if workloads legitimately need more CPU",
  ],
  severity: "critical",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-memory-limit-exceeded",
  pattern: "exceeded quota: limits.memory",
  regex: /exceeded\s+quota.*limits\.memory/i,
  rootCause: "Namespace memory limit quota exceeded",
  explanation:
    "The total memory limits of all containers in the namespace would exceed the ResourceQuota's limits.memory.",
  remediation: [
    "Check memory quota: kubectl describe resourcequota -n <ns> | grep memory",
    "Review container memory limits across deployments",
    "Profile actual memory usage with kubectl top pod to right-size limits",
    "Request quota increase if workloads legitimately need more memory",
  ],
  severity: "critical",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-configmap-exceeded",
  pattern: "exceeded quota: configmaps",
  regex: /exceeded\s+quota.*configmaps/i,
  rootCause: "Maximum number of ConfigMaps in namespace exceeded",
  explanation:
    "The namespace has hit the ConfigMap count quota. This can happen when Helm releases accumulate or controllers create ConfigMaps for leader election.",
  remediation: [
    "Check ConfigMap quota and usage: kubectl describe resourcequota -n <ns>",
    "Clean up unused ConfigMaps: kubectl get configmap -n <ns>",
    "Remove stale Helm release records if using Helm: helm list -n <ns> --all",
    "Request quota increase if needed",
  ],
  severity: "warning",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-services-exceeded",
  pattern: "exceeded quota: services / loadbalancers",
  regex: /exceeded\s+quota.*(?:services|loadbalancers)/i,
  rootCause: "Service or LoadBalancer count quota exceeded",
  explanation:
    "The namespace or cloud account has hit the maximum number of Services or LoadBalancers. Cloud providers often limit the number of external load balancers.",
  remediation: [
    "Check service quota: kubectl describe resourcequota -n <ns> | grep services",
    "Consolidate services using shared ingress or gateway instead of individual LoadBalancers",
    "Delete unused services",
    "Request cloud provider quota increase for load balancers",
  ],
  severity: "warning",
  category: "quota",
  reasons: [],
  platformNotes: {
    eks: "AWS limits ALB/NLB count per region; request increase via Service Quotas",
    aks: "Azure limits public IPs and load balancers per subscription",
    gke: "GCP limits forwarding rules per project",
  },
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-object-count",
  pattern: "exceeded quota: count/<resource>",
  regex: /exceeded\s+quota.*count\//i,
  rootCause: "Object count quota exceeded for a specific resource type",
  explanation:
    "A quota on the number of objects of a specific type (count/deployments.apps, count/secrets, etc.) has been exceeded.",
  remediation: [
    "Check the specific resource type from the error message",
    "Clean up unused resources of that type",
    "Request quota increase if the limit is too restrictive",
  ],
  severity: "warning",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-no-request-set",
  pattern: "must specify requests/limits when quota is active",
  regex: /(?:must\s+specify.*(?:requests|limits)|missing\s+(?:request|limit).*quota)/i,
  rootCause: "Container missing resource requests/limits required by quota",
  explanation:
    "When a ResourceQuota constraining CPU or memory is active in a namespace, all containers must specify resource requests and limits. Containers without them are rejected.",
  remediation: [
    "Add resource requests and limits to all containers in the pod spec",
    "Or configure a LimitRange with default values to auto-inject",
    "Example: resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } }",
  ],
  severity: "warning",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-limit-range-forbidden"],
});

// ---------------------------------------------------------------------------
// 10. HPA / AUTOSCALING ERRORS  (10+ patterns)
// ---------------------------------------------------------------------------

_add({
  id: "hpa-failed-get-metrics",
  pattern: "FailedGetResourceMetric — metrics-server not running",
  regex: /FailedGetResourceMetric/i,
  rootCause: "metrics-server not running or unavailable",
  explanation:
    "The HPA cannot fetch resource metrics (CPU/memory) because the metrics-server is not installed, not running, or not healthy. Without metrics, the HPA cannot make scaling decisions.",
  remediation: [
    "Check if metrics-server is installed: kubectl get deployment metrics-server -n kube-system",
    "Verify metrics-server pods are running: kubectl get pods -n kube-system -l k8s-app=metrics-server",
    "Check metrics-server logs for errors",
    "Install metrics-server if missing: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml",
    "Test metrics API: kubectl top nodes",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: ["FailedGetResourceMetric"],
  platformNotes: {
    eks: "EKS requires metrics-server to be installed manually or via add-on",
    gke: "GKE includes metrics-server by default; check if it's healthy",
    aks: "AKS includes metrics-server by default; check kube-system namespace",
    openshift: "OpenShift uses Prometheus-adapter; check monitoring stack in openshift-monitoring",
  },
  relatedErrors: ["hpa-unable-get-metrics", "hpa-compute-failed"],
});

_add({
  id: "hpa-compute-failed",
  pattern: "FailedComputeMetricsReplicas",
  regex: /FailedComputeMetricsReplicas/i,
  rootCause: "HPA cannot compute target replica count",
  explanation:
    "The HPA has metrics but cannot compute the desired replica count. This can happen when the metric value is zero, the target is invalid, or there's a calculation error.",
  remediation: [
    "Check HPA status: kubectl describe hpa <name>",
    "Verify the metric target is valid and achievable",
    "Ensure pods report non-zero resource usage",
    "Check if the metric name in HPA matches the actual metric",
    "Review custom/external metrics if using non-resource metrics",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: ["FailedComputeMetricsReplicas"],
  relatedErrors: ["hpa-failed-get-metrics"],
});

_add({
  id: "hpa-unable-get-metrics",
  pattern: "unable to get metrics for resource",
  regex: /unable\s+to\s+get\s+metrics?\s+for\s+resource/i,
  rootCause: "Metrics API unavailable or metric not found",
  explanation:
    "The HPA tried to query the metrics API but could not retrieve the requested metric. The metrics API may be down, or the metric name/label selector may be incorrect.",
  remediation: [
    "Check if metrics API is available: kubectl get apiservice | grep metrics",
    "For custom metrics: verify the custom metrics adapter (Prometheus adapter) is running",
    "Ensure the metric name in HPA matches exactly: kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1",
    "Check if the target pods have the expected labels for metric selection",
    "Restart the metrics adapter if it's in a bad state",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-failed-get-metrics"],
});

_add({
  id: "hpa-scaling-active-false",
  pattern: "ScalingActive: False",
  regex: /ScalingActive\s*[:=]\s*False/i,
  rootCause: "HPA disabled or unable to scale",
  explanation:
    "The HPA's ScalingActive condition is False, meaning it is not actively scaling. This can be because the HPA is explicitly disabled, the deployment does not exist, or there's a fundamental configuration error.",
  remediation: [
    "Check HPA conditions: kubectl describe hpa <name>",
    "Verify the target deployment/statefulset exists: kubectl get <kind> <name>",
    "Ensure min and max replicas are valid (min > 0, max >= min)",
    "Check if the HPA is paused via annotation",
    "Verify the scaleTargetRef fields are correct",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-failed-get-metrics"],
});

_add({
  id: "hpa-scaling-limited",
  pattern: "ScalingLimited — reached max/min replicas",
  regex: /(?:ScalingLimited|(?:max|min)imum\s+replicas?\s+reached|TooMany|TooFew)/i,
  rootCause: "HPA at min or max replica count",
  explanation:
    "The HPA wants to scale beyond its configured min/max boundaries. If at max, the workload may need more capacity. If at min, scaling down is complete.",
  remediation: [
    "Check current HPA status: kubectl describe hpa <name>",
    "If at max and load is still high, increase maxReplicas",
    "Verify your cluster has capacity for additional replicas",
    "Consider optimizing the application to handle more load per replica",
    "Review the scaling metric — it may need tuning",
  ],
  severity: "info",
  category: "autoscaling",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "hpa-invalid-metric-source",
  pattern: "invalid metric source / unknown metric type",
  regex: /(?:invalid\s+metric\s+source|unknown\s+metric\s+type|unsupported\s+metric\s+source)/i,
  rootCause: "HPA references an unsupported metric type",
  explanation:
    "The HPA spec contains a metric source type that is not recognized (e.g. external metrics without an adapter, or a typo in the metric type).",
  remediation: [
    "Check HPA metric configuration: kubectl get hpa <name> -o yaml",
    "Valid metric types: Resource, Pods, Object, External, ContainerResource",
    "Ensure the appropriate metrics adapter is installed for custom/external metrics",
    "Fix typos in metric type or name",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-unable-get-metrics"],
});

_add({
  id: "hpa-failed-rescale",
  pattern: "FailedRescale",
  regex: /FailedRescale/i,
  rootCause: "HPA failed to update the replica count on the target",
  explanation:
    "The HPA calculated a new replica count but failed to apply it to the target Deployment/StatefulSet. This may be a permissions issue or the target is in a bad state.",
  remediation: [
    "Check HPA events: kubectl describe hpa <name>",
    "Verify the HPA controller has permissions to update the scale subresource",
    "Check if the target deployment/statefulset is paused",
    "Look for admission webhooks that might block the scale update",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: ["FailedRescale"],
  relatedErrors: ["rbac-cannot-create"],
});

_add({
  id: "hpa-behavior-not-applied",
  pattern: "HPA behavior / stabilization not applied",
  regex: /(?:behavior.*not\s+applied|stabilization.*window|scale\s+down.*(?:delay|cooldown))/i,
  rootCause: "HPA scaling behavior configuration issue",
  explanation:
    "The HPA's behavior (scaleUp/scaleDown policies, stabilizationWindow) may not be working as expected. This can cause too-rapid scaling or inability to scale down.",
  remediation: [
    "Review HPA behavior config: kubectl get hpa <name> -o yaml",
    "Check stabilizationWindowSeconds — it prevents flapping (default 300s for scaleDown)",
    "Adjust scaleDown policies if pods are not being removed",
    "Set selectPolicy: Min/Max/Disabled to control scaling direction",
  ],
  severity: "info",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-scaling-limited"],
});

_add({
  id: "hpa-target-not-found",
  pattern: "HPA target not found",
  regex: /(?:HPA.*target.*not\s+found|unable\s+to\s+find.*scale\s+target|scaleTargetRef.*not\s+found)/i,
  rootCause: "HPA references a non-existent deployment or statefulset",
  explanation:
    "The HPA's scaleTargetRef points to a Deployment, StatefulSet, or other scalable resource that does not exist. The HPA is inactive.",
  remediation: [
    "Check scaleTargetRef in HPA: kubectl get hpa <name> -o jsonpath='{.spec.scaleTargetRef}'",
    "Verify the target exists in the same namespace: kubectl get <kind> <name>",
    "Fix the HPA spec to reference the correct target",
    "Check for typos in the resource name or API group",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-scaling-active-false"],
});

_add({
  id: "hpa-insufficient-replicas",
  pattern: "HPA insufficient replicas / unable to scale",
  regex: /(?:insufficient\s+replicas|unable\s+to\s+scale\s+(?:up|down).*(?:resources|capacity))/i,
  rootCause: "Cannot scale up due to resource constraints",
  explanation:
    "The HPA wants to create more replicas but the cluster cannot accommodate them due to insufficient CPU, memory, or other resources.",
  remediation: [
    "Check if new pods are pending: kubectl get pods | grep Pending",
    "Verify cluster capacity: kubectl top nodes",
    "Enable cluster autoscaler to add nodes dynamically",
    "Reduce per-pod resource requests to fit more replicas",
    "Check ResourceQuota if quotas are limiting replica creation",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["sched-insufficient-cpu", "sched-insufficient-memory", "quota-exceeded"],
});

// ---------------------------------------------------------------------------
// 11. PLATFORM-SPECIFIC ERRORS  (25+ patterns)
// ---------------------------------------------------------------------------

// --- OpenShift-specific ---

_add({
  id: "ocp-build-failed",
  pattern: "OpenShift BuildConfig failed",
  regex: /(?:BuildConfig.*(?:failed|error)|Build.*(?:Failed|Error)|build.*(?:source|docker|s2i).*(?:fail|error))/i,
  rootCause: "OpenShift build process failed",
  explanation:
    "An OpenShift Build (S2I, Docker, or custom) failed. This could be a source code compilation error, Dockerfile issue, or builder image problem.",
  remediation: [
    "Check build logs: oc logs build/<build-name>",
    "Describe the build: oc describe build/<build-name>",
    "Verify the source repository URL and ref are correct",
    "Check builder image availability: oc get is -n openshift",
    "Verify the build secret (source secret, push secret) exists",
    "For S2I builds, ensure assemble script exits cleanly",
  ],
  severity: "warning",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "Use oc start-build <bc> --follow to watch build progress in real-time",
  },
  relatedErrors: [],
});

_add({
  id: "ocp-route-admission-error",
  pattern: "OpenShift Route admission error",
  regex: /(?:Route.*(?:admission|rejected|denied)|HostAlreadyClaimed|route.*(?:not\s+admitted|failed))/i,
  rootCause: "OpenShift Route cannot be admitted",
  explanation:
    "The Route was rejected by the router admission controller. Common reasons: hostname already claimed by another route, wildcard policy violation, or TLS configuration error.",
  remediation: [
    "Check Route status: oc describe route <name>",
    "Look for HostAlreadyClaimed — another route owns this hostname",
    "Verify TLS settings (termination, certificate, key)",
    "Check if the router allows wildcard routes",
    "Ensure the Route target Service has endpoints",
  ],
  severity: "warning",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "Use oc get routes --all-namespaces | grep <hostname> to find conflicting routes",
  },
  relatedErrors: [],
});

_add({
  id: "ocp-machine-config-render-failure",
  pattern: "MachineConfig render failure",
  regex: /(?:MachineConfig.*render.*(?:fail|error)|MCO.*render.*fail|machine-config-daemon.*error)/i,
  rootCause: "MachineConfig rendering failed — node configuration broken",
  explanation:
    "The Machine Config Operator (MCO) failed to render the configuration for a node pool. This prevents nodes from being updated and can block upgrades.",
  remediation: [
    "Check MachineConfigPool status: oc get mcp",
    "Review MachineConfig objects for syntax errors: oc get mc",
    "Check MCO logs: oc logs -n openshift-machine-config-operator -l k8s-app=machine-config-operator",
    "Revert the problematic MachineConfig if recently changed",
    "Check machine-config-daemon logs on affected nodes",
  ],
  severity: "critical",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "MCO renders a final config per pool; any invalid MC can break the entire pool",
  },
  relatedErrors: ["upgrade-machine-config-degraded"],
});

_add({
  id: "ocp-oauth-error",
  pattern: "OpenShift OAuth/authentication error",
  regex: /(?:oauth.*(?:error|fail)|authentication.*operator.*(?:degraded|error)|identity\s+provider.*(?:error|fail))/i,
  rootCause: "OpenShift authentication/OAuth issue",
  explanation:
    "The OpenShift OAuth server or authentication operator is experiencing issues. Users may not be able to log in.",
  remediation: [
    "Check authentication operator: oc get co authentication",
    "Review OAuth server pods: oc get pods -n openshift-authentication",
    "Check OAuth server logs: oc logs -n openshift-authentication <pod>",
    "Verify identity provider configuration in OAuth CR: oc get oauth cluster -o yaml",
    "Check if the OAuth server's route is accessible",
  ],
  severity: "critical",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "OAuth configuration is in the 'oauth' cluster resource: oc edit oauth cluster",
  },
  relatedErrors: ["rbac-token-expired"],
});

_add({
  id: "ocp-imagestream-import-error",
  pattern: "ImageStream import error",
  regex: /(?:ImageStream.*(?:import.*(?:error|fail)|error.*import)|tag.*import.*(?:error|fail))/i,
  rootCause: "OpenShift ImageStream tag import failed",
  explanation:
    "OpenShift failed to import an image tag into an ImageStream. This can be due to registry connectivity, authentication, or the source image not existing.",
  remediation: [
    "Check ImageStream status: oc describe is/<name>",
    "Verify the source registry is accessible",
    "Check registry credentials: oc get secret <pull-secret> -o yaml",
    "Manually trigger import: oc import-image <is>:<tag> --from=<registry/image:tag> --confirm",
    "Check for x509 certificate errors if using private registries",
  ],
  severity: "warning",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "Scheduled imports run periodically; check oc describe is/<name> for last import attempt",
  },
  relatedErrors: ["image-unauthorized", "image-x509"],
});

// --- EKS-specific ---

_add({
  id: "eks-iam-role-assumption",
  pattern: "EKS IAM role assumption failure",
  regex: /(?:Unable\s+to\s+assume\s+role|AssumeRoleWithWebIdentity.*(?:error|denied|fail)|iam.*role.*(?:error|not\s+authorized))/i,
  rootCause: "IAM role for service account (IRSA) assumption failed",
  explanation:
    "The pod's ServiceAccount cannot assume the configured IAM role via IRSA or EKS Pod Identity. This is typically a trust policy or annotation mismatch.",
  remediation: [
    "Verify the SA annotation: kubectl get sa <name> -o jsonpath='{.metadata.annotations.eks\\.amazonaws\\.com/role-arn}'",
    "Check the IAM role trust policy includes the OIDC provider and service account",
    "Ensure the OIDC provider is configured for the cluster",
    "Verify the condition in the trust policy matches ns:sa format",
    "Check if the AWS STS regional endpoint is accessible from the pod",
  ],
  severity: "critical",
  category: "platform-eks",
  reasons: [],
  platformNotes: {
    eks: "Use eksctl create iamserviceaccount to automate IRSA setup; verify with aws sts get-caller-identity from the pod",
  },
  relatedErrors: ["rbac-cannot-create"],
});

_add({
  id: "eks-vpc-cni-error",
  pattern: "EKS vpc-cni / aws-node error",
  regex: /(?:vpc-cni.*(?:error|fail)|aws-node.*(?:error|not\s+ready|CrashLoop)|ipamd.*(?:error|fail)|ENI.*(?:error|fail|exhaust))/i,
  rootCause: "AWS VPC CNI plugin error — pod networking affected",
  explanation:
    "The AWS VPC CNI plugin (aws-node DaemonSet) is experiencing errors. This affects pod IP allocation, ENI management, and potentially all pod networking on the affected node.",
  remediation: [
    "Check aws-node pods: kubectl get ds aws-node -n kube-system",
    "Review aws-node logs: kubectl logs -n kube-system -l k8s-app=aws-node",
    "Check if the node's ENI limit was reached (depends on instance type)",
    "Verify the VPC CNI addon version is compatible: aws eks describe-addon --cluster-name <cluster> --addon-name vpc-cni",
    "Check subnet IP availability if using secondary CIDR",
    "Enable prefix delegation for more IPs: kubectl set env ds/aws-node -n kube-system ENABLE_PREFIX_DELEGATION=true",
  ],
  severity: "critical",
  category: "platform-eks",
  reasons: [],
  platformNotes: {
    eks: "Max pods per node depends on instance type and CNI config; use the max-pods-calculator",
  },
  relatedErrors: ["net-pod-cidr-exhaustion", "sched-too-many-pods"],
});

_add({
  id: "eks-alb-target-health",
  pattern: "EKS ALB target group unhealthy",
  regex: /(?:ALB.*target.*(?:unhealthy|draining|unused)|target\s+group.*(?:no\s+healthy|all\s+unhealthy)|TargetHealth.*unhealthy)/i,
  rootCause: "ALB target group has no healthy targets",
  explanation:
    "The AWS ALB (Application Load Balancer) target group reports unhealthy targets. The ALB health check is failing against the pods, so traffic is not being routed.",
  remediation: [
    "Check ALB target group health in AWS console",
    "Verify the health check path returns 200: curl http://<pod-ip>:<port><health-path>",
    "Ensure the targetPort in the Ingress matches the pod's listening port",
    "Check security group allows ALB to reach pod ports",
    "Adjust health check settings (interval, threshold, timeout)",
  ],
  severity: "critical",
  category: "platform-eks",
  reasons: [],
  platformNotes: {
    eks: "AWS ALB Ingress Controller uses alb.ingress.kubernetes.io annotations for health check config",
  },
  relatedErrors: ["net-service-unavailable", "runtime-readiness-probe-failed"],
});

_add({
  id: "eks-ebs-csi-error",
  pattern: "EKS EBS CSI driver error",
  regex: /(?:ebs-csi.*(?:error|fail)|ebs.*csi.*driver.*(?:not\s+found|unavailable)|AttachVolume.*ebs.*(?:error|fail))/i,
  rootCause: "EBS CSI driver error — volume operations failing",
  explanation:
    "The Amazon EBS CSI driver is not working correctly. Volume attach, detach, or provisioning operations are failing.",
  remediation: [
    "Check EBS CSI controller: kubectl get pods -n kube-system -l app=ebs-csi-controller",
    "Review CSI driver logs: kubectl logs -n kube-system -l app=ebs-csi-controller -c ebs-plugin",
    "Verify the EBS CSI addon: aws eks describe-addon --cluster-name <cluster> --addon-name aws-ebs-csi-driver",
    "Check IAM role permissions for the CSI driver",
    "Verify the StorageClass references the ebs.csi.aws.com provisioner",
  ],
  severity: "critical",
  category: "platform-eks",
  reasons: [],
  relatedErrors: ["storage-provisioning-failed", "storage-mount-timeout"],
});

// --- AKS-specific ---

_add({
  id: "aks-msi-error",
  pattern: "AKS Azure MSI / managed identity error",
  regex: /(?:managed\s+(?:service\s+)?identity.*(?:error|fail)|MSI.*(?:error|fail|denied)|aad.*pod.*identity.*(?:error|fail)|DefaultAzureCredential.*(?:error|fail))/i,
  rootCause: "Azure Managed Identity error — workload cannot authenticate",
  explanation:
    "The pod cannot authenticate to Azure services using its Managed Identity (MSI/Workload Identity). This is often a misconfigured identity binding or missing Azure role assignment.",
  remediation: [
    "Check AKS Workload Identity setup: kubectl get azureidentity,azureidentitybinding -A",
    "Verify the pod has the correct identity label: azure.workload.identity/use: 'true'",
    "Check the federated credential on the Azure User Assigned Identity",
    "Verify Azure RBAC role assignments for the identity",
    "Test from the pod: curl -H 'Metadata: true' 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/'",
  ],
  severity: "critical",
  category: "platform-aks",
  reasons: [],
  platformNotes: {
    aks: "AAD Pod Identity is deprecated; migrate to AKS Workload Identity (federated credentials)",
  },
  relatedErrors: ["rbac-cannot-create"],
});

_add({
  id: "aks-node-pool-scaling",
  pattern: "AKS node pool scaling failure",
  regex: /(?:node\s+pool\s+scal.*(?:fail|error)|VMSS.*scal.*(?:fail|error)|Azure.*scaling.*(?:quota|limit|fail))/i,
  rootCause: "AKS node pool scaling failed",
  explanation:
    "AKS failed to scale the node pool (VMSS). This can be due to Azure subscription quota limits, availability zone capacity, or VM SKU constraints.",
  remediation: [
    "Check AKS cluster events: az aks show --resource-group <rg> --name <cluster>",
    "Verify Azure subscription quotas: az vm list-usage --location <region>",
    "Check VMSS status in the Azure portal for detailed error",
    "Try a different VM SKU if the current one is capacity-constrained",
    "Request Azure quota increase if needed",
  ],
  severity: "critical",
  category: "platform-aks",
  reasons: [],
  platformNotes: {
    aks: "AKS cluster autoscaler works with VMSS; check az aks nodepool show for pool status",
  },
  relatedErrors: ["sched-insufficient-cpu", "sched-insufficient-memory"],
});

_add({
  id: "aks-aad-auth-error",
  pattern: "AKS AAD authentication error",
  regex: /(?:AAD.*(?:auth.*(?:error|fail)|denied)|AzureAD.*(?:error|token)|AADSTS\d+)/i,
  rootCause: "Azure Active Directory authentication failure",
  explanation:
    "Authentication to AKS via Azure Active Directory failed. This can be due to expired tokens, misconfigured AAD integration, or missing group memberships.",
  remediation: [
    "Re-authenticate: az login && az aks get-credentials --resource-group <rg> --name <cluster>",
    "Check AAD integration: az aks show --resource-group <rg> --name <cluster> --query aadProfile",
    "Verify group memberships in Azure AD",
    "Check if the AAD application registration is still valid",
    "Clear kubeconfig and re-fetch credentials",
  ],
  severity: "critical",
  category: "platform-aks",
  reasons: [],
  relatedErrors: ["rbac-token-expired"],
});

// --- GKE-specific ---

_add({
  id: "gke-workload-identity-missing",
  pattern: "GKE Workload Identity annotation missing",
  regex: /(?:Workload\s+Identity.*(?:missing|not\s+configured)|iam\.gke\.io\/gcp-service-account.*missing|metadata.*gke-metadata-server.*error)/i,
  rootCause: "GKE Workload Identity not configured on service account",
  explanation:
    "The Kubernetes ServiceAccount is missing the Workload Identity annotation, so pods cannot authenticate as the intended GCP service account. API calls to GCP services will fail with permission errors.",
  remediation: [
    "Annotate the KSA: kubectl annotate sa <name> iam.gke.io/gcp-service-account=<gsa>@<project>.iam.gserviceaccount.com",
    "Ensure the GSA has the roles/iam.workloadIdentityUser binding for the KSA",
    "Verify Workload Identity is enabled on the node pool",
    "Test: kubectl exec <pod> -- gcloud auth list",
  ],
  severity: "critical",
  category: "platform-gke",
  reasons: [],
  platformNotes: {
    gke: "Workload Identity replaces node SA for fine-grained IAM; enable per-pool: gcloud container node-pools update --workload-metadata=GKE_METADATA",
  },
  relatedErrors: ["rbac-cannot-create"],
});

_add({
  id: "gke-autopilot-restrictions",
  pattern: "GKE Autopilot restriction violation",
  regex: /(?:Autopilot.*(?:restrict|not\s+allow|denied|violat)|GKE\s+Autopilot.*(?:error|reject))/i,
  rootCause: "Pod violates GKE Autopilot restrictions",
  explanation:
    "GKE Autopilot enforces security and resource constraints. The pod may be requesting hostNetwork, privileged mode, hostPath volumes, or other features not allowed in Autopilot.",
  remediation: [
    "Review GKE Autopilot restrictions documentation",
    "Remove hostNetwork, hostPID, hostIPC if set",
    "Remove hostPath volumes (use PVCs instead)",
    "Remove privileged: true (use specific capabilities instead)",
    "Ensure resource requests are set (Autopilot requires them)",
    "Consider using GKE Standard if Autopilot restrictions are too limiting",
  ],
  severity: "critical",
  category: "platform-gke",
  reasons: [],
  platformNotes: {
    gke: "Autopilot auto-sets resources if not specified; hostPath, privileged, and DaemonSets are restricted",
  },
  relatedErrors: ["rbac-admission-webhook-denied"],
});

_add({
  id: "gke-binary-authorization-deny",
  pattern: "GKE Binary Authorization denied",
  regex: /(?:Binary\s+Authorization.*(?:denied|blocked|rejected)|binauthz.*(?:denied|violat)|attestation.*(?:not\s+found|missing))/i,
  rootCause: "Binary Authorization policy denied the image deployment",
  explanation:
    "GKE Binary Authorization denied the pod because the container image does not have the required attestations, or the image is not from an allowed registry.",
  remediation: [
    "Check Binary Authorization policy: gcloud container binauthz policy export",
    "Verify the image has required attestations: gcloud container binauthz attestations list --artifact-url=<image>",
    "Add the image to the allowlist if appropriate",
    "Create the required attestation for the image",
    "Check if the image digest matches (tags may have been re-pushed)",
  ],
  severity: "critical",
  category: "platform-gke",
  reasons: [],
  platformNotes: {
    gke: "Binary Authorization works on image digests, not tags; always use digest references for attested images",
  },
  relatedErrors: ["rbac-admission-webhook-denied"],
});

_add({
  id: "gke-node-auto-provisioning-failed",
  pattern: "GKE node auto-provisioning failed",
  regex: /(?:node\s+auto[- ]provisioning.*(?:fail|error)|NAP.*(?:fail|error)|cannot\s+create\s+node\s+pool.*auto)/i,
  rootCause: "GKE node auto-provisioning cannot create a suitable node pool",
  explanation:
    "GKE's node auto-provisioning (NAP) failed to create a new node pool for the pending pods. This may be due to resource limits, zone constraints, or GPU availability.",
  remediation: [
    "Check NAP resource limits: gcloud container clusters describe <cluster> --format='value(autoscaling)'",
    "Increase NAP resource limits (CPU, memory, GPU) if too low",
    "Check GCP quota for the needed machine types",
    "Verify the required zones have capacity for the machine type",
  ],
  severity: "warning",
  category: "platform-gke",
  reasons: [],
  relatedErrors: ["sched-insufficient-cpu", "sched-insufficient-gpu"],
});

// --- Cross-platform additional patterns ---

_add({
  id: "platform-node-not-ready",
  pattern: "Node condition NotReady",
  regex: /(?:Node.*condition.*NotReady|NodeNotReady|node.*not\s+ready)/i,
  rootCause: "Node is not ready — kubelet or runtime issue",
  explanation:
    "A node's Ready condition is False or Unknown. This means the kubelet is not reporting healthy status. Common causes: kubelet crash, container runtime failure, disk pressure, network issues, or kernel panic.",
  remediation: [
    "Check node conditions: kubectl describe node <node>",
    "SSH to the node and check kubelet: systemctl status kubelet",
    "Check container runtime: systemctl status containerd or crio",
    "Review kubelet logs: journalctl -u kubelet -f",
    "Check for disk pressure, memory pressure, or PID pressure conditions",
    "If the node is unrecoverable, drain and replace it",
  ],
  severity: "critical",
  category: "platform",
  reasons: ["NodeNotReady"],
  relatedErrors: ["sched-nodes-unschedulable"],
});

_add({
  id: "platform-evicted-pod",
  pattern: "Pod evicted",
  regex: /(?:pod.*evicted|Evicted|eviction.*triggered|The\s+node\s+was\s+low\s+on\s+resource)/i,
  rootCause: "Pod evicted due to node resource pressure",
  explanation:
    "The pod was evicted by the kubelet because the node was under resource pressure (memory, disk, or PID). Pods with the lowest QoS class (BestEffort) are evicted first.",
  remediation: [
    "Check the eviction reason: kubectl describe pod <pod> | grep -i evict",
    "Set resource requests and limits to get Guaranteed QoS class",
    "Add more nodes or larger nodes to reduce resource pressure",
    "Configure eviction thresholds on kubelet if defaults are too aggressive",
    "Clean up completed/failed pods that consume disk space",
  ],
  severity: "warning",
  category: "platform",
  reasons: ["Evicted"],
  relatedErrors: ["storage-disk-pressure", "runtime-oomkilled"],
});

_add({
  id: "platform-etcd-slow",
  pattern: "etcd slow / high latency",
  regex: /(?:etcd.*(?:slow|latency|took\s+too\s+long|overloaded)|apply\s+request\s+took\s+too\s+long|etcdserver.*(?:timeout|deadline))/i,
  rootCause: "etcd performance degraded — cluster operations slow",
  explanation:
    "etcd is experiencing high latency. This affects all cluster operations as etcd is the backing store for all Kubernetes state. Common causes: slow disk I/O, high load, or network issues between etcd members.",
  remediation: [
    "Check etcd disk latency: etcdctl check perf",
    "Monitor etcd metrics: etcd_disk_wal_fsync_duration_seconds, etcd_disk_backend_commit_duration_seconds",
    "Use SSD/NVMe storage for etcd data directory",
    "Reduce API server request rate if etcd is overloaded",
    "Ensure etcd members are on low-latency network links",
    "Consider defragmenting etcd: etcdctl defrag --cluster",
  ],
  severity: "critical",
  category: "platform",
  reasons: [],
  platformNotes: {
    openshift: "etcd performance is critical for OpenShift; check oc logs -n openshift-etcd and prometheus etcd dashboard",
  },
  relatedErrors: ["upgrade-etcd-unhealthy"],
});

_add({
  id: "platform-api-server-timeout",
  pattern: "API server timeout / unavailable",
  regex: /(?:api\s*server.*(?:timeout|unavailable|refused)|Unable\s+to\s+connect\s+to\s+the\s+server|connection\s+to\s+the\s+server.*(?:timed?\s*out|refused))/i,
  rootCause: "Kubernetes API server unreachable",
  explanation:
    "The API server is not responding. This can be caused by API server pod crash, etcd unavailability, network issues, or certificate problems. All cluster operations are blocked.",
  remediation: [
    "Check if API server pods are running (from a master node): crictl pods | grep apiserver",
    "Check API server logs on the master node",
    "Verify etcd health as API server depends on it",
    "Check network connectivity to the API server endpoint",
    "Verify API server certificates are valid",
    "If using managed Kubernetes, check the provider's status page",
  ],
  severity: "critical",
  category: "platform",
  reasons: [],
  relatedErrors: ["platform-etcd-slow"],
});

// ---------------------------------------------------------------------------
// 12. ADDITIONAL PATTERNS — image pull, scheduling, networking, platform
// ---------------------------------------------------------------------------

// --- Additional image pull patterns ---

_add({
  id: "image-manifest-unknown",
  pattern: "manifest unknown / not found in registry",
  regex: /(?:manifest\s+(?:unknown|not\s+found)|manifest\s+for\s+.*\s+not\s+found)/i,
  rootCause: "Image manifest not found — tag may not exist",
  explanation:
    "The requested image manifest does not exist in the registry. The tag may have been deleted, never pushed, or the architecture is not available.",
  remediation: [
    "Verify the exact image tag exists: skopeo inspect docker://<image>:<tag>",
    "Check if the image supports the node's architecture (amd64, arm64)",
    "List available tags: skopeo list-tags docker://<image>",
    "Confirm the tag was not garbage-collected by the registry",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff", "ErrImagePull"],
  relatedErrors: ["image-pull-backoff"],
});

_add({
  id: "image-manifest-list-no-match",
  pattern: "no matching manifest for platform",
  regex: /(?:no\s+matching\s+manifest\s+for.*(?:linux|arm|amd)|platform.*not\s+found\s+in\s+manifest\s+list)/i,
  rootCause: "Multi-arch image does not support node platform",
  explanation:
    "The image is a multi-arch manifest list but does not include a variant for the node's OS/architecture. Common when running arm64 nodes with amd64-only images.",
  remediation: [
    "Check supported platforms: docker manifest inspect <image>",
    "Build and push a multi-arch image using docker buildx",
    "Schedule the pod to a node with a matching architecture using nodeSelector",
    "Use a different image that supports the required architecture",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ErrImagePull"],
  relatedErrors: ["image-manifest-unknown"],
});

_add({
  id: "image-rate-limit",
  pattern: "Docker Hub / registry rate limit",
  regex: /(?:rate\s+limit|too\s+many\s+requests|429\s+Too\s+Many|toomanyrequests)/i,
  rootCause: "Container registry rate limit exceeded",
  explanation:
    "The registry is returning HTTP 429 (too many requests). Docker Hub has pull rate limits for anonymous (100/6h) and free authenticated (200/6h) users.",
  remediation: [
    "Authenticate to Docker Hub with a paid account: kubectl create secret docker-registry",
    "Set up a registry mirror/cache to reduce direct pulls",
    "Use a private registry (ECR, GCR, ACR, Quay) for frequently used images",
    "Wait for the rate limit window to reset",
  ],
  severity: "warning",
  category: "image",
  reasons: ["ImagePullBackOff"],
  platformNotes: {
    eks: "Use ECR as a pull-through cache for Docker Hub: aws ecr create-pull-through-cache-rule",
  },
  relatedErrors: ["image-pull-backoff"],
});

_add({
  id: "image-invalid-reference",
  pattern: "invalid image reference format",
  regex: /(?:invalid\s+(?:image|reference)\s+(?:format|name)|couldn't\s+parse\s+image\s+(?:reference|name))/i,
  rootCause: "Container image reference is malformed",
  explanation:
    "The image reference in the pod spec is not valid. This can be caused by typos, invalid characters, missing tag or digest, or incorrect registry URL format.",
  remediation: [
    "Check the image field in the pod spec for typos",
    "Ensure the format is: [registry/][namespace/]repository[:tag|@digest]",
    "Remove any extra whitespace or special characters",
    "Use a digest reference for immutable deployments: image@sha256:...",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ErrImagePull", "InvalidImageName"],
  relatedErrors: [],
});

_add({
  id: "image-registry-timeout",
  pattern: "registry connection timeout",
  regex: /(?:registry.*(?:timeout|timed?\s*out|deadline\s+exceeded)|dial\s+tcp.*(?:i\/o\s+timeout|connection\s+timed?\s*out).*(?:registry|\.io|\.com))/i,
  rootCause: "Cannot reach the container registry — network timeout",
  explanation:
    "The node cannot connect to the container registry within the timeout period. This is usually a DNS, firewall, or proxy issue preventing outbound connectivity to the registry.",
  remediation: [
    "Check DNS resolution from the node: nslookup <registry>",
    "Verify firewall rules allow outbound HTTPS (443) to the registry",
    "Check HTTP proxy configuration if the cluster uses a proxy",
    "Test connectivity: curl -v https://<registry>/v2/",
    "Use a registry mirror if the primary registry is unreachable",
  ],
  severity: "critical",
  category: "image",
  reasons: ["ImagePullBackOff"],
  relatedErrors: ["net-dns-resolution-failure", "image-pull-backoff"],
});

// --- Additional scheduling patterns ---

_add({
  id: "sched-pod-topology-mismatch",
  pattern: "topology spread constraint not satisfiable",
  regex: /(?:topology\s+spread\s+constraint.*(?:not\s+satisf|cannot\s+be\s+satisfied)|doesn't\s+match\s+pod\s+topology\s+spread\s+constraints)/i,
  rootCause: "Topology spread constraints cannot be satisfied",
  explanation:
    "The pod's topologySpreadConstraints cannot be met with the available nodes. The constraints may require spreading across zones or nodes that don't have enough capacity.",
  remediation: [
    "Check topology spread constraints in the pod spec",
    "List node topology labels: kubectl get nodes --show-labels | grep topology",
    "Consider using whenUnsatisfiable: ScheduleAnyway instead of DoNotSchedule",
    "Ensure there are enough nodes in each topology domain",
    "Add nodes in under-represented zones",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-pod-affinity-conflict"],
});

_add({
  id: "sched-preemption-failed",
  pattern: "preemption not possible for scheduling",
  regex: /(?:preemption.*(?:fail|not\s+possible|not\s+helpful)|cannot\s+preempt|no\s+preemption\s+victims)/i,
  rootCause: "Scheduler cannot preempt lower-priority pods",
  explanation:
    "The scheduler tried to preempt lower-priority pods to make room, but preemption was not possible. Either no lower-priority pods exist, or preempting them would not free enough resources.",
  remediation: [
    "Check PriorityClass of the pending pod: kubectl get pod <name> -o jsonpath='{.spec.priorityClassName}'",
    "List PriorityClasses: kubectl get priorityclass",
    "Ensure lower-priority pods exist to preempt",
    "Add more nodes if preemption cannot free enough resources",
    "Review if PodDisruptionBudget is preventing preemption",
  ],
  severity: "warning",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["sched-insufficient-cpu", "sched-insufficient-memory"],
});

_add({
  id: "sched-volume-zone-conflict",
  pattern: "volume node affinity conflict / zone mismatch",
  regex: /(?:volume\s+node\s+affinity\s+conflict|volume.*zone.*(?:mismatch|conflict)|PV.*(?:zone|topology).*(?:conflict|mismatch))/i,
  rootCause: "Persistent Volume is in a different zone than available nodes",
  explanation:
    "The pod requires a PersistentVolume bound to a specific zone, but no schedulable node exists in that zone. Volumes in cloud environments are zone-scoped.",
  remediation: [
    "Check PV topology: kubectl describe pv <pv-name> | grep -A5 'Node Affinity'",
    "Ensure nodes exist in the same zone as the PV",
    "Use a StorageClass with volumeBindingMode: WaitForFirstConsumer to avoid zone mismatches",
    "Delete the PVC and let it rebind in the correct zone (data loss warning)",
    "Consider using cross-zone storage solutions (e.g., EFS, Azure Files, GCP Filestore)",
  ],
  severity: "critical",
  category: "scheduling",
  reasons: ["FailedScheduling"],
  relatedErrors: ["storage-mount-timeout"],
});

// --- Additional networking patterns ---

_add({
  id: "net-ingress-class-not-found",
  pattern: "IngressClass not found",
  regex: /(?:IngressClass.*(?:not\s+found|does\s+not\s+exist)|unknown\s+IngressClass|ingress.*class.*(?:missing|invalid))/i,
  rootCause: "IngressClass resource not found in cluster",
  explanation:
    "The Ingress references an IngressClass that does not exist. The ingress controller cannot process the Ingress resource without a matching IngressClass.",
  remediation: [
    "List available IngressClasses: kubectl get ingressclass",
    "Set the correct ingressClassName in the Ingress spec",
    "Install the required ingress controller if missing",
    "Set a default IngressClass with the annotation: ingressclass.kubernetes.io/is-default-class: 'true'",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-service-unavailable"],
});

_add({
  id: "net-connection-reset",
  pattern: "connection reset by peer",
  regex: /(?:connection\s+reset\s+by\s+peer|ECONNRESET)/i,
  rootCause: "Connection forcibly closed by remote side",
  explanation:
    "TCP connections are being reset. This can indicate network policy enforcement, pod restarts during active connections, aggressive idle timeouts on load balancers, or service mesh sidecar issues.",
  remediation: [
    "Check if NetworkPolicy is blocking the traffic",
    "Verify the target pod is healthy and not restarting",
    "Increase load balancer idle timeout if connections are long-lived",
    "Enable connection draining on services for graceful shutdown",
    "Check for service mesh (Istio/Envoy) proxy errors",
  ],
  severity: "warning",
  category: "networking",
  reasons: [],
  relatedErrors: ["net-connection-refused"],
});

_add({
  id: "net-endpoint-not-ready",
  pattern: "endpoints not ready / no ready addresses",
  regex: /(?:endpoints?.*(?:not\s+ready|no\s+ready|0\s+ready)|has\s+no\s+ready\s+endpoints|EndpointsNotReady)/i,
  rootCause: "Service has no ready endpoints",
  explanation:
    "The Service endpoints are not ready, meaning no backend pod is passing its readiness probe. Traffic to this Service will fail with connection refused or timeout.",
  remediation: [
    "Check endpoint status: kubectl get endpoints <svc-name>",
    "Verify pod readiness: kubectl get pods -l <selector> -o wide",
    "Check readiness probe configuration and responses",
    "Ensure the pod's container is listening on the correct port",
    "Check if the Service selector matches the pod labels",
  ],
  severity: "critical",
  category: "networking",
  reasons: [],
  relatedErrors: ["runtime-readiness-probe-failed", "net-service-unavailable"],
});

// --- Additional storage patterns ---

_add({
  id: "storage-read-only-filesystem",
  pattern: "read-only file system error",
  regex: /(?:read[- ]only\s+file\s*system|EROFS|cannot\s+write.*read[- ]?only)/i,
  rootCause: "Container filesystem or volume mounted read-only",
  explanation:
    "The container is trying to write to a read-only filesystem. This can be caused by readOnlyRootFilesystem in the security context, a read-only volume mount, or a corrupted filesystem that remounted read-only.",
  remediation: [
    "Check securityContext.readOnlyRootFilesystem in the pod spec",
    "Use emptyDir volumes for writeable directories (e.g., /tmp, /var/run)",
    "Verify volume mount mode: check readOnly flag in volumeMounts",
    "For PVs, check if the access mode is ReadWriteOnce vs ReadOnlyMany",
    "Check underlying storage health if filesystem went read-only unexpectedly",
  ],
  severity: "warning",
  category: "storage",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "storage-pvc-resize-failed",
  pattern: "PVC resize / volume expansion failed",
  regex: /(?:(?:volume|pvc)\s+(?:expansion|resize).*(?:fail|error)|cannot\s+resize|FailedResizeVolume|FileSystemResizePending)/i,
  rootCause: "PersistentVolumeClaim resize operation failed",
  explanation:
    "The PVC expansion failed. The StorageClass may not support volume expansion, the underlying storage provider may have hit a limit, or the filesystem resize is pending pod restart.",
  remediation: [
    "Verify StorageClass allows expansion: kubectl get sc <name> -o jsonpath='{.allowVolumeExpansion}'",
    "Check PVC conditions: kubectl describe pvc <name>",
    "For filesystem resize pending: restart the pod using the PVC",
    "Check cloud provider volume size limits",
    "Ensure the PVC is not in use by multiple pods when resizing",
  ],
  severity: "warning",
  category: "storage",
  reasons: [],
  relatedErrors: ["storage-provisioning-failed"],
});

// --- Additional RBAC/security patterns ---

_add({
  id: "rbac-certificate-expired",
  pattern: "certificate has expired or is not yet valid",
  regex: /(?:certificate\s+(?:has\s+expired|not\s+yet\s+valid|expired)|x509.*(?:expired|not\s+yet\s+valid)|TLS.*(?:expired|invalid\s+cert))/i,
  rootCause: "TLS certificate has expired or is not yet valid",
  explanation:
    "A TLS certificate in the cluster has expired or the system clock is out of sync. This can affect API server connections, webhooks, etcd, and service-to-service communication.",
  remediation: [
    "Check certificate expiry: openssl x509 -enddate -noout -in <cert>",
    "For kubeadm clusters: kubeadm certs check-expiration",
    "Rotate certificates if expired: kubeadm certs renew all",
    "Verify system clock is synchronized: timedatectl status",
    "For webhook certificates, check cert-manager or the issuer",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  platformNotes: {
    openshift: "OpenShift auto-rotates most certs; check: oc get co | grep -i cert",
  },
  relatedErrors: ["rbac-token-expired"],
});

_add({
  id: "rbac-audit-policy-violation",
  pattern: "audit policy violation detected",
  regex: /(?:audit.*policy.*(?:violat|denied|blocked)|(?:falco|sysdig|tetragon).*(?:alert|violation|deny))/i,
  rootCause: "Runtime security policy violation detected",
  explanation:
    "A runtime security tool (Falco, Sysdig, Tetragon, etc.) detected a policy violation. The workload may be performing an unauthorized action like executing a shell, reading sensitive files, or making unexpected network connections.",
  remediation: [
    "Review the security alert details in the monitoring tool",
    "Check if the workload behavior is expected or a compromise",
    "Update the security policy to allow the action if it is legitimate",
    "Investigate the container image for unexpected binaries or scripts",
    "Consider adding seccomp or AppArmor profiles to restrict the workload",
  ],
  severity: "critical",
  category: "rbac",
  reasons: [],
  relatedErrors: ["rbac-pod-security-violation"],
});

// --- Additional operator/controller patterns ---

_add({
  id: "operator-leader-election-lost",
  pattern: "leader election lost / renewed",
  regex: /(?:leader\s+election.*(?:lost|expired|failed\s+to\s+renew)|lost\s+leadership|failed\s+to\s+renew\s+lease)/i,
  rootCause: "Controller lost leader election — temporary control plane disruption",
  explanation:
    "A controller lost its leader election lease. During the failover period, the controller is not processing resources. This is normal during upgrades but may indicate issues if it happens repeatedly.",
  remediation: [
    "Check if this is during a planned upgrade or rollout",
    "Verify the controller pod is healthy and not OOM-killed",
    "Check API server latency — slow API server can cause lease renewal failures",
    "Review lease objects: kubectl get lease -n <namespace>",
    "Check for excessive leader election churn in controller logs",
  ],
  severity: "warning",
  category: "operator",
  reasons: [],
  relatedErrors: ["platform-etcd-slow", "platform-api-server-timeout"],
});

_add({
  id: "operator-webhook-timeout",
  pattern: "webhook call timed out",
  regex: /(?:webhook.*(?:timed?\s*out|deadline\s+exceeded|timeout)|calling\s+webhook.*timeout|admission\s+webhook.*timeout)/i,
  rootCause: "Admission webhook is timing out",
  explanation:
    "A validating or mutating admission webhook is not responding within the timeout period. This can block all resource creation/updates in the affected scope. Common culprit: the webhook service is down or overloaded.",
  remediation: [
    "Check the webhook service pods: kubectl get pods -n <webhook-ns>",
    "Review webhook configurations: kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations",
    "Increase the webhook timeout if the operation is legitimately slow",
    "Add failurePolicy: Ignore temporarily if the webhook is non-critical",
    "Check if the webhook has a namespaceSelector excluding kube-system",
  ],
  severity: "critical",
  category: "operator",
  reasons: [],
  relatedErrors: ["rbac-admission-webhook-denied"],
});

// --- Additional upgrade/version patterns ---

_add({
  id: "upgrade-deprecated-api-removed",
  pattern: "deprecated API version removed in this release",
  regex: /(?:(?:api|apiVersion).*(?:removed|no\s+longer\s+served)|resource\s+mapping\s+not\s+found|unable\s+to\s+recognize.*no\s+matches\s+for\s+kind)/i,
  rootCause: "API version has been removed from the cluster",
  explanation:
    "The manifest references an API version that has been removed (e.g., extensions/v1beta1, apps/v1beta2). This commonly happens after Kubernetes upgrades when deprecated APIs are removed.",
  remediation: [
    "Identify affected resources: kubectl convert or use kubent (kube-no-trouble)",
    "Update manifests to use the current API version",
    "For Helm charts, update the templates and chart version",
    "Run pluto or kubent to scan for deprecated APIs before upgrading",
    "Check Kubernetes deprecation guide for API migration paths",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  relatedErrors: ["upgrade-helm-manifest-invalid"],
});

_add({
  id: "upgrade-node-drain-failed",
  pattern: "node drain failed during upgrade",
  regex: /(?:drain.*(?:fail|error|timed?\s*out)|cannot\s+evict\s+pod|eviction.*blocked|PodDisruptionBudget.*(?:prevent|block).*(?:evict|drain))/i,
  rootCause: "Node drain blocked — pods cannot be evicted",
  explanation:
    "During upgrade or maintenance, draining the node failed because pods could not be evicted. This is usually caused by PodDisruptionBudgets or pods without controllers (bare pods).",
  remediation: [
    "Check which pods are blocking: kubectl get pods --field-selector spec.nodeName=<node>",
    "Review PDBs: kubectl get pdb -A",
    "Temporarily adjust PDB minAvailable/maxUnavailable during maintenance",
    "Delete bare pods (not managed by a controller) manually",
    "Use --delete-emptydir-data and --ignore-daemonsets flags with kubectl drain",
    "Use --force as a last resort for unmanaged pods",
  ],
  severity: "warning",
  category: "upgrade",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "upgrade-skew-policy-violation",
  pattern: "version skew policy violated",
  regex: /(?:version\s+skew|kubelet.*version.*(?:too\s+old|unsupported|skew)|control\s+plane.*(?:skew|version\s+mismatch))/i,
  rootCause: "Kubernetes version skew policy violated",
  explanation:
    "The version difference between control plane and node components exceeds the supported skew. Kubernetes supports kubelet up to 3 minor versions behind the API server, and other components must match.",
  remediation: [
    "Check component versions: kubectl get nodes -o wide",
    "Upgrade nodes to be within the supported skew",
    "Follow the upgrade order: control plane first, then nodes",
    "Do not skip minor versions during upgrade",
    "Check: kubectl version --short for API server version",
  ],
  severity: "critical",
  category: "upgrade",
  reasons: [],
  relatedErrors: [],
});

// --- Additional quota patterns ---

_add({
  id: "quota-limitrange-violation",
  pattern: "LimitRange constraint violated",
  regex: /(?:LimitRange.*(?:violat|exceeded|forbidden)|(?:minimum|maximum)\s+(?:cpu|memory)\s+(?:usage|constraint).*(?:exceeded|violated)|must\s+be\s+less\s+than\s+or\s+equal\s+to)/i,
  rootCause: "Pod resource request/limit violates namespace LimitRange",
  explanation:
    "The pod's resource requests or limits violate the LimitRange constraints in the namespace. LimitRanges enforce minimum/maximum/default resource requirements.",
  remediation: [
    "Check LimitRange: kubectl describe limitrange -n <namespace>",
    "Adjust pod resource requests/limits to be within the LimitRange",
    "Contact the cluster admin to adjust the LimitRange if needed",
    "Set both requests and limits explicitly to avoid defaulting issues",
  ],
  severity: "warning",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

_add({
  id: "quota-object-count-exceeded",
  pattern: "object count quota exceeded",
  regex: /(?:(?:count|number)\s+(?:of|quota).*(?:exceeded|limit)|(?:pods|services|configmaps|secrets|persistentvolumeclaims).*quota.*exceeded)/i,
  rootCause: "Object count quota exceeded in namespace",
  explanation:
    "The namespace has reached its object count quota limit for this resource type (pods, services, configmaps, secrets, etc.). No more objects of this type can be created.",
  remediation: [
    "Check quota usage: kubectl describe resourcequota -n <namespace>",
    "Clean up unused resources to free quota",
    "Request a quota increase from the cluster admin",
    "Check for leaked resources (completed jobs, orphaned pods, etc.)",
  ],
  severity: "warning",
  category: "quota",
  reasons: [],
  relatedErrors: ["quota-exceeded"],
});

// --- Additional autoscaling patterns ---

_add({
  id: "hpa-behavior-scale-limited",
  pattern: "HPA scaling limited by behavior policy",
  regex: /(?:scaling\s+(?:limited|constrained)\s+by\s+(?:behavior|policy)|stabilization\s+window|scale\s+down.*(?:disabled|limited))/i,
  rootCause: "HPA behavior policy is limiting scaling speed",
  explanation:
    "The HPA's scaling behavior configuration is limiting how fast it can scale up or down. The stabilization window or scaling policies may be too conservative.",
  remediation: [
    "Check HPA behavior: kubectl describe hpa <name>",
    "Adjust scaleUp/scaleDown behavior policies for faster scaling",
    "Reduce stabilization window if quicker reactions are needed",
    "Consider using Percent or Pods policy type for burst scaling",
  ],
  severity: "info",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-failed-compute-metrics"],
});

_add({
  id: "vpa-eviction-loop",
  pattern: "VPA causing pod eviction loop",
  regex: /(?:VPA.*(?:evict|restart|update).*(?:loop|repeated)|VerticalPodAutoscaler.*(?:evict|restart)|vpa-updater.*evict)/i,
  rootCause: "VPA is repeatedly evicting pods to apply new resource recommendations",
  explanation:
    "The Vertical Pod Autoscaler is caught in a loop, continuously evicting pods because its recommendations keep changing. This can cause service disruption.",
  remediation: [
    "Check VPA recommendations: kubectl describe vpa <name>",
    "Set updateMode to 'Off' or 'Initial' instead of 'Auto' to stop evictions",
    "Use minAllowed/maxAllowed to constrain recommendation ranges",
    "Check PodDisruptionBudget to limit concurrent evictions",
    "Ensure the workload has stable resource usage patterns",
  ],
  severity: "warning",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-failed-compute-metrics"],
});

_add({
  id: "cluster-autoscaler-scale-down-blocked",
  pattern: "Cluster autoscaler scale-down blocked",
  regex: /(?:scale[- ]?down.*(?:blocked|prevented|disabled)|cannot\s+(?:scale\s+down|remove)\s+node|node.*not\s+eligible.*scale[- ]?down)/i,
  rootCause: "Cluster autoscaler cannot scale down nodes",
  explanation:
    "The cluster autoscaler wants to remove underutilized nodes but is blocked. Common reasons: pods with local storage, pods without controllers, PDBs preventing eviction, or scale-down annotations.",
  remediation: [
    "Check CA status: kubectl get cm cluster-autoscaler-status -n kube-system -o yaml",
    "Look for pods blocking scale-down: pods with local storage, system pods",
    "Add cluster-autoscaler.kubernetes.io/safe-to-evict: 'true' annotation to blocking pods",
    "Ensure PDBs allow at least one pod to be evicted",
    "Review CA logs for specific scale-down block reasons",
  ],
  severity: "info",
  category: "autoscaling",
  reasons: [],
  relatedErrors: ["hpa-max-replicas-reached"],
});

// --- Additional OpenShift patterns ---

_add({
  id: "ocp-scc-restricted",
  pattern: "OpenShift SCC restricted / denied",
  regex: /(?:SCC.*(?:restricted|denied|forbid|prevent)|security\s+context\s+constraint.*(?:deny|reject|not\s+allow)|unable\s+to\s+validate.*scc)/i,
  rootCause: "Pod denied by OpenShift Security Context Constraints",
  explanation:
    "The pod does not satisfy any available SCC. OpenShift SCCs control what security contexts a pod can use (user IDs, capabilities, volumes, etc.).",
  remediation: [
    "Check which SCCs the ServiceAccount can use: oc get scc --as=system:serviceaccount:<ns>:<sa>",
    "Describe the pod to see the SCC validation error",
    "Grant the appropriate SCC: oc adm policy add-scc-to-user <scc> -z <sa> -n <ns>",
    "Modify the pod to comply with the restricted SCC (non-root, no capabilities, no hostPath)",
    "Use oc adm policy who-can use scc/<scc-name> to audit access",
  ],
  severity: "critical",
  category: "platform-openshift",
  reasons: ["FailedCreate"],
  platformNotes: {
    openshift: "OpenShift 4.x defaults to restricted-v2 SCC; use 'oc describe scc restricted-v2' to see constraints",
  },
  relatedErrors: ["rbac-pod-security-violation"],
});

_add({
  id: "ocp-cluster-operator-degraded",
  pattern: "OpenShift ClusterOperator degraded",
  regex: /(?:ClusterOperator.*(?:Degraded|degraded\s*=\s*True)|operator.*condition.*Degraded)/i,
  rootCause: "OpenShift ClusterOperator in Degraded state",
  explanation:
    "One or more OpenShift ClusterOperators are in Degraded state. This means the operator is running but not fully functional. Upgrades are blocked when operators are degraded.",
  remediation: [
    "List operator statuses: oc get co",
    "Check the degraded operator: oc describe co <operator-name>",
    "Review operator logs: oc logs -n openshift-<operator>-operator <pod>",
    "Check for prerequisite resources or permissions the operator needs",
    "Review events in the operator namespace",
  ],
  severity: "critical",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "All ClusterOperators must be Available=True, Degraded=False before starting an upgrade",
  },
  relatedErrors: ["ocp-machine-config-render-failure"],
});

_add({
  id: "ocp-catalog-source-error",
  pattern: "OpenShift CatalogSource / OLM error",
  regex: /(?:CatalogSource.*(?:error|fail|unavailable|TRANSIENT_FAILURE)|OLM.*(?:error|fail)|operator\s+(?:catalog|subscription).*(?:error|fail))/i,
  rootCause: "OLM CatalogSource unavailable — operator installs/updates blocked",
  explanation:
    "An OLM CatalogSource is failing, which prevents installing or updating operators via subscriptions. The catalog pod may be crashlooping or unable to pull the catalog image.",
  remediation: [
    "Check CatalogSource status: oc get catalogsource -n openshift-marketplace",
    "Review catalog pod logs: oc logs -n openshift-marketplace <catalog-pod>",
    "Verify the catalog image is accessible",
    "Delete and recreate the CatalogSource if it is stuck",
    "Check for ImageContentSourcePolicy if using a disconnected/mirror registry",
  ],
  severity: "warning",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "Use oc get sub -A to list operator subscriptions depending on this catalog",
  },
  relatedErrors: ["image-pull-backoff"],
});

_add({
  id: "ocp-console-unavailable",
  pattern: "OpenShift web console unavailable",
  regex: /(?:console.*(?:unavailable|error|not\s+reachable)|openshift-console.*(?:fail|crash|error)|console-operator.*(?:degraded|error))/i,
  rootCause: "OpenShift web console is not accessible",
  explanation:
    "The OpenShift web console is down or unreachable. This may be due to console-operator issues, authentication problems, or networking/route issues.",
  remediation: [
    "Check console operator: oc get co console",
    "Review console pods: oc get pods -n openshift-console",
    "Check console route: oc get route console -n openshift-console",
    "Review console operator logs: oc logs -n openshift-console-operator <pod>",
    "Verify OAuth is working as the console depends on it",
  ],
  severity: "warning",
  category: "platform-openshift",
  reasons: [],
  platformNotes: {
    openshift: "Console route URL: oc whoami --show-console",
  },
  relatedErrors: ["ocp-oauth-error", "ocp-route-admission-error"],
});

_add({
  id: "ocp-etcd-member-unhealthy",
  pattern: "OpenShift etcd member unhealthy/degraded",
  regex: /(?:etcd.*member.*(?:unhealthy|degraded|not\s+started)|openshift-etcd.*(?:degraded|error|crash)|etcd\s+cluster.*(?:unhealthy|degraded))/i,
  rootCause: "OpenShift etcd cluster has an unhealthy member",
  explanation:
    "One or more etcd members in the OpenShift cluster are unhealthy. This can cause cluster instability, slow API responses, and blocked upgrades.",
  remediation: [
    "Check etcd operator: oc get co etcd",
    "Check etcd pods: oc get pods -n openshift-etcd",
    "Review etcd logs: oc logs -n openshift-etcd <etcd-pod>",
    "Check etcd member health: oc rsh -n openshift-etcd <pod> etcdctl member list",
    "If a member is permanently lost, follow the etcd member replacement procedure",
  ],
  severity: "critical",
  category: "platform-openshift",
  reasons: [],
  relatedErrors: ["platform-etcd-slow"],
});

// --- Additional EKS patterns ---

_add({
  id: "eks-fargate-scheduling-error",
  pattern: "EKS Fargate pod scheduling error",
  regex: /(?:Fargate.*(?:schedul.*(?:fail|error)|profile.*(?:not\s+match|missing))|no\s+Fargate\s+profile\s+match)/i,
  rootCause: "Pod does not match any Fargate profile selector",
  explanation:
    "The pod cannot be scheduled on Fargate because it does not match any Fargate profile's namespace/label selectors. The pod needs to match at least one profile to run on Fargate.",
  remediation: [
    "List Fargate profiles: aws eks describe-fargate-profile --cluster-name <cluster> --fargate-profile-name <name>",
    "Verify the pod's namespace matches a Fargate profile selector",
    "Check if the pod has labels matching the profile's label selectors",
    "Create a new Fargate profile for the namespace/labels",
    "If Fargate is not needed, ensure EC2 node groups have capacity",
  ],
  severity: "warning",
  category: "platform-eks",
  reasons: ["FailedScheduling"],
  platformNotes: {
    eks: "Fargate profiles match on namespace + optional labels; DaemonSets cannot run on Fargate",
  },
  relatedErrors: ["sched-insufficient-cpu"],
});

_add({
  id: "eks-addon-conflict",
  pattern: "EKS managed addon conflict",
  regex: /(?:addon.*(?:conflict|incompatible|version\s+mismatch)|eks.*addon.*(?:fail|error|degraded)|ConfigurationConflict)/i,
  rootCause: "EKS managed addon version conflict or configuration issue",
  explanation:
    "An EKS managed addon is in conflict, usually due to manual modifications to addon-managed resources or version incompatibility with the cluster version.",
  remediation: [
    "Check addon status: aws eks describe-addon --cluster-name <cluster> --addon-name <addon>",
    "Resolve conflicts by choosing OVERWRITE or PRESERVE: aws eks update-addon --resolve-conflicts OVERWRITE",
    "Verify addon version compatibility with the cluster version",
    "Check for manual changes to addon resources that may conflict",
  ],
  severity: "warning",
  category: "platform-eks",
  reasons: [],
  relatedErrors: [],
});

_add({
  id: "eks-pod-identity-error",
  pattern: "EKS Pod Identity agent error",
  regex: /(?:pod[- ]identity.*(?:error|fail|denied)|eks-pod-identity-agent.*(?:error|crash)|AssumeRoleForPodIdentity.*(?:error|fail))/i,
  rootCause: "EKS Pod Identity association or agent error",
  explanation:
    "The EKS Pod Identity feature is not working. This can be due to the Pod Identity agent not running, missing pod identity association, or IAM role trust policy issues.",
  remediation: [
    "Check Pod Identity agent: kubectl get ds eks-pod-identity-agent -n kube-system",
    "List associations: aws eks list-pod-identity-associations --cluster-name <cluster>",
    "Verify the IAM role trust policy allows EKS Pod Identity",
    "Check agent logs: kubectl logs -n kube-system -l app=eks-pod-identity-agent",
  ],
  severity: "critical",
  category: "platform-eks",
  reasons: [],
  relatedErrors: ["eks-iam-role-assumption"],
});

// --- Additional AKS patterns ---

_add({
  id: "aks-cni-overlay-error",
  pattern: "AKS Azure CNI overlay / networking error",
  regex: /(?:Azure\s+CNI.*(?:overlay|error|fail)|cilium.*(?:aks|azure).*(?:error|fail)|aks.*network.*(?:plugin|cni).*(?:error|fail))/i,
  rootCause: "AKS network plugin (Azure CNI/overlay) error",
  explanation:
    "The AKS network plugin is experiencing errors. This affects pod networking, IP allocation, and potentially all pod communication on affected nodes.",
  remediation: [
    "Check azure-cni pods: kubectl get pods -n kube-system -l component=azure-cni",
    "Review CNI logs on the node: /var/log/azure-cni.log",
    "Check subnet IP address availability in the Azure portal",
    "Verify NSGs are not blocking required traffic",
    "Check if the VNet/subnet has been modified outside AKS",
  ],
  severity: "critical",
  category: "platform-aks",
  reasons: [],
  platformNotes: {
    aks: "Azure CNI Overlay uses a separate CIDR for pods, reducing VNet IP exhaustion",
  },
  relatedErrors: ["net-pod-cidr-exhaustion"],
});

_add({
  id: "aks-disk-attach-error",
  pattern: "AKS Azure disk attach error",
  regex: /(?:Azure\s*[Dd]isk.*(?:attach.*(?:fail|error)|not\s+found)|ManagedDisk.*(?:error|fail)|cannot\s+attach\s+(?:data\s+)?disk)/i,
  rootCause: "Azure managed disk attach operation failed",
  explanation:
    "AKS failed to attach an Azure managed disk to the node. Common causes: disk already attached to another node, disk in wrong zone, node attach limit reached, or disk SKU incompatibility.",
  remediation: [
    "Check disk state in Azure portal",
    "Verify the disk is in the same zone as the target node",
    "Check if the disk is already attached: az disk show --name <disk> --resource-group <rg> --query managedBy",
    "Check node's disk attach limit (varies by VM SKU)",
    "Force detach from previous node if needed: az vm disk detach",
  ],
  severity: "critical",
  category: "platform-aks",
  reasons: [],
  relatedErrors: ["storage-mount-timeout", "storage-multi-attach-error"],
});

_add({
  id: "aks-kube-proxy-error",
  pattern: "AKS kube-proxy / service routing error",
  regex: /(?:kube-proxy.*(?:aks|azure).*(?:error|fail)|aks.*kube-proxy.*(?:error|crash)|service\s+routing.*(?:fail|aks))/i,
  rootCause: "AKS kube-proxy error affecting service routing",
  explanation:
    "The kube-proxy on AKS nodes is experiencing errors, which can cause service routing failures. Traffic to ClusterIP or NodePort services may not reach the backend pods.",
  remediation: [
    "Check kube-proxy pods: kubectl get ds kube-proxy -n kube-system",
    "Review kube-proxy logs: kubectl logs -n kube-system -l component=kube-proxy",
    "Verify iptables/ipvs rules on the node",
    "Restart kube-proxy pods if configuration is stale",
    "Check if AKS is using kube-proxy or a kube-proxy replacement (Cilium)",
  ],
  severity: "critical",
  category: "platform-aks",
  reasons: [],
  relatedErrors: ["net-service-unavailable"],
});

// --- Additional GKE patterns ---

_add({
  id: "gke-preemptible-node-shutdown",
  pattern: "GKE preemptible/spot node terminated",
  regex: /(?:preemptible.*(?:terminat|shutdown|evict)|spot.*(?:instance|vm).*(?:terminat|reclaim)|PreemptionReason)/i,
  rootCause: "Preemptible/spot node was terminated by the cloud provider",
  explanation:
    "The node was a preemptible or spot instance and was reclaimed by Google Cloud. Pods on this node were evicted. This is expected behavior for preemptible/spot nodes.",
  remediation: [
    "Use PodDisruptionBudgets to maintain availability during terminations",
    "Spread replicas across multiple nodes with topology spread constraints",
    "Use a mix of preemptible and on-demand nodes for critical workloads",
    "Handle SIGTERM gracefully with proper terminationGracePeriodSeconds",
    "Consider using GKE node pool with SPOT provisioning model for non-critical workloads",
  ],
  severity: "info",
  category: "platform-gke",
  reasons: ["Preempting"],
  relatedErrors: ["platform-evicted-pod"],
});

_add({
  id: "gke-network-policy-calico",
  pattern: "GKE network policy enforcement error",
  regex: /(?:(?:network\s+policy|calico|dataplane\s+v2).*(?:error|fail|not\s+enforc)|GKE.*(?:network\s+policy|NetworkPolicy).*(?:error|fail))/i,
  rootCause: "GKE network policy enforcement is not working correctly",
  explanation:
    "Network policies are not being enforced as expected. This can be because network policy enforcement is not enabled on the cluster, or the dataplane/Calico component has errors.",
  remediation: [
    "Verify network policy is enabled: gcloud container clusters describe <cluster> --format='value(networkPolicy)'",
    "Check if Dataplane V2 (Cilium) is enabled instead: gcloud container clusters describe <cluster> --format='value(networkConfig.datapathProvider)'",
    "Review Calico/Cilium pods: kubectl get pods -n kube-system -l k8s-app=calico-node",
    "Enable network policy if not enabled: gcloud container clusters update <cluster> --update-addons NetworkPolicy=ENABLED",
    "Test policy enforcement: deploy a test pod and verify blocking",
  ],
  severity: "warning",
  category: "platform-gke",
  reasons: [],
  relatedErrors: ["net-network-policy-blocking"],
});

_add({
  id: "gke-filestore-csi-error",
  pattern: "GKE Filestore CSI driver error",
  regex: /(?:Filestore.*(?:CSI|csi|driver).*(?:error|fail)|filestore.*(?:provision|mount).*(?:fail|error)|CreateVolume.*(?:filestore|nfs).*(?:error|fail))/i,
  rootCause: "GKE Filestore CSI driver provisioning or mount error",
  explanation:
    "The GKE Filestore CSI driver failed to provision or mount a Filestore volume. This can be due to quota limits, network configuration, or Filestore API issues.",
  remediation: [
    "Check Filestore CSI driver pods: kubectl get pods -n gke-managed-filestorecsi",
    "Verify Filestore API is enabled: gcloud services list | grep file.googleapis.com",
    "Check Filestore quotas: gcloud filestore instances list",
    "Ensure the VPC network allows Filestore access",
    "Review PVC events: kubectl describe pvc <name>",
  ],
  severity: "warning",
  category: "platform-gke",
  reasons: [],
  relatedErrors: ["storage-provisioning-failed"],
});

// --- Additional cross-platform patterns ---

_add({
  id: "platform-kubelet-not-starting",
  pattern: "kubelet failed to start / not running",
  regex: /(?:kubelet.*(?:fail.*start|not\s+(?:starting|running)|crash)|systemd.*kubelet.*(?:fail|error)|Failed\s+to\s+start\s+kubelet)/i,
  rootCause: "Kubelet is not starting on the node",
  explanation:
    "The kubelet service is failing to start. Without kubelet, the node cannot join the cluster or run any pods. Common causes: invalid kubelet configuration, certificate issues, or container runtime not running.",
  remediation: [
    "Check kubelet service: systemctl status kubelet",
    "Review kubelet logs: journalctl -u kubelet --no-pager -n 100",
    "Verify container runtime is running: systemctl status containerd",
    "Check kubelet configuration: /var/lib/kubelet/config.yaml",
    "Verify node certificates are valid and not expired",
    "Ensure swap is disabled (unless --fail-swap-on=false is set)",
  ],
  severity: "critical",
  category: "platform",
  reasons: [],
  relatedErrors: ["platform-node-not-ready"],
});

_add({
  id: "platform-containerd-error",
  pattern: "containerd runtime error",
  regex: /(?:containerd.*(?:error|fail|crash|not\s+running)|container\s+runtime.*(?:not\s+running|error|fail)|rpc\s+error.*containerd)/i,
  rootCause: "Container runtime (containerd) error",
  explanation:
    "The containerd runtime is experiencing errors or has crashed. This prevents pods from being started, stopped, or restarted on the affected node.",
  remediation: [
    "Check containerd status: systemctl status containerd",
    "Review containerd logs: journalctl -u containerd --no-pager -n 100",
    "Check disk space — containerd needs space for image layers: df -h /var/lib/containerd",
    "Restart containerd: systemctl restart containerd (will disrupt all pods on the node)",
    "Verify containerd config: /etc/containerd/config.toml",
  ],
  severity: "critical",
  category: "platform",
  reasons: [],
  relatedErrors: ["platform-kubelet-not-starting", "platform-node-not-ready"],
});

_add({
  id: "platform-coredns-error",
  pattern: "CoreDNS error / DNS service down",
  regex: /(?:coredns.*(?:error|crash|not\s+ready|fail)|kube-dns.*(?:error|down|fail)|dns\s+(?:service|resolution).*(?:fail|down|error))/i,
  rootCause: "CoreDNS service is failing — cluster DNS broken",
  explanation:
    "CoreDNS is experiencing errors or is down. This affects all DNS-based service discovery in the cluster. Pods will not be able to resolve service names or external hostnames.",
  remediation: [
    "Check CoreDNS pods: kubectl get pods -n kube-system -l k8s-app=kube-dns",
    "Review CoreDNS logs: kubectl logs -n kube-system -l k8s-app=kube-dns",
    "Check CoreDNS ConfigMap: kubectl get cm coredns -n kube-system -o yaml",
    "Verify the kube-dns Service has endpoints: kubectl get endpoints kube-dns -n kube-system",
    "Test DNS resolution: kubectl run dnstest --image=busybox --restart=Never -- nslookup kubernetes",
  ],
  severity: "critical",
  category: "platform",
  reasons: [],
  relatedErrors: ["net-dns-resolution-failure"],
});

_add({
  id: "platform-cni-not-initialized",
  pattern: "CNI plugin not initialized / network not ready",
  regex: /(?:CNI.*(?:not\s+(?:initializ|ready)|fail|error)|network\s+(?:plugin|not\s+ready)|runtime\s+network\s+not\s+ready)/i,
  rootCause: "CNI network plugin not initialized on node",
  explanation:
    "The Container Network Interface (CNI) plugin has not been initialized on the node. Pods cannot be scheduled because networking is not available.",
  remediation: [
    "Check if a CNI plugin is installed (Calico, Cilium, Flannel, etc.)",
    "Verify CNI plugin pods are running: kubectl get pods -n kube-system | grep -E 'calico|cilium|flannel'",
    "Check CNI config on the node: ls /etc/cni/net.d/",
    "Review CNI plugin logs on the node",
    "Reinstall the CNI plugin if the configuration is missing",
  ],
  severity: "critical",
  category: "platform",
  reasons: ["NetworkNotReady"],
  relatedErrors: ["platform-node-not-ready"],
});

// --- Additional runtime patterns ---

_add({
  id: "runtime-container-creating-timeout",
  pattern: "container creating timeout / stuck in ContainerCreating",
  regex: /(?:ContainerCreating.*(?:timeout|stuck|waiting)|container.*creating.*(?:too\s+long|timeout)|stuck.*ContainerCreating)/i,
  rootCause: "Pod stuck in ContainerCreating state",
  explanation:
    "The pod is stuck in ContainerCreating for an extended period. This usually means the container runtime is waiting for an image pull, volume mount, or network setup to complete.",
  remediation: [
    "Describe the pod for events: kubectl describe pod <name>",
    "Check for pending image pulls: look for Pulling/ImagePullBackOff events",
    "Check for volume mount issues: look for FailedMount events",
    "Verify the CNI plugin is working on the node",
    "Check container runtime logs on the node",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["ContainerCreating"],
  relatedErrors: ["image-pull-backoff", "storage-mount-timeout", "platform-cni-not-initialized"],
});

_add({
  id: "runtime-init-container-failed",
  pattern: "init container failed / CrashLoopBackOff",
  regex: /(?:init\s+container.*(?:fail|error|crash|exit)|Init:(?:Error|CrashLoopBackOff)|initContainer.*(?:fail|error))/i,
  rootCause: "Init container failed — main containers cannot start",
  explanation:
    "An init container has failed, preventing the pod's main containers from starting. Init containers run sequentially and must all succeed before the main containers begin.",
  remediation: [
    "Check which init container failed: kubectl describe pod <name>",
    "View init container logs: kubectl logs <pod> -c <init-container-name>",
    "Check if the init container depends on a service that is not yet ready",
    "Verify init container image and command are correct",
    "Check if there are resource limits preventing the init container from running",
  ],
  severity: "warning",
  category: "runtime",
  reasons: ["CrashLoopBackOff", "Error"],
  relatedErrors: ["runtime-crashloopbackoff"],
});

// ---------------------------------------------------------------------------
// Index structures for fast lookup
// ---------------------------------------------------------------------------

/** Map<id, entry> for O(1) lookup by ID */
const _byId = new Map();

/** Map<reason, entry[]> for getErrorsForReason */
const _byReason = new Map();

/** Map<category, entry[]> for category lookup */
const _byCategory = new Map();

// Build indices
for (const entry of _entries) {
  _byId.set(entry.id, entry);

  for (const reason of entry.reasons) {
    const key = reason.toLowerCase();
    if (!_byReason.has(key)) _byReason.set(key, []);
    _byReason.get(key).push(entry);
  }

  const cat = entry.category.toLowerCase();
  if (!_byCategory.has(cat)) _byCategory.set(cat, []);
  _byCategory.get(cat).push(entry);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up an error pattern by substring or regex match.
 *
 * @param {string} errorPattern — text to match against the knowledge base
 *   (error message, event reason, log line)
 * @param {string} [platform] — optional platform hint
 *   ("openshift" | "eks" | "aks" | "gke" | "vanilla")
 * @returns {{
 *   pattern: string,
 *   rootCause: string,
 *   explanation: string,
 *   remediation: string[],
 *   severity: "critical"|"warning"|"info",
 *   platformNotes: Record<string, string>,
 *   relatedErrors: string[]
 * } | null}
 */
export function lookupError(errorPattern, platform) {
  if (!errorPattern) return null;

  const text = String(errorPattern);

  // First try: find best match by regex
  let bestMatch = null;
  let bestMatchLength = 0;

  for (const entry of _entries) {
    const m = text.match(entry.regex);
    if (m) {
      // Prefer longer matches (more specific patterns)
      const matchLen = m[0].length;
      if (matchLen > bestMatchLength) {
        bestMatchLength = matchLen;
        bestMatch = entry;
      }
    }
  }

  if (!bestMatch) return null;

  return _formatResult(bestMatch, platform);
}

/**
 * Scan an array of log lines and/or events for known error patterns.
 * Returns all matches with line numbers and match details.
 *
 * @param {string[]} [logLines=[]] — array of log line strings
 * @param {Array<{message?: string, reason?: string}>} [events=[]] — k8s event objects
 * @returns {Array<{
 *   lineNumber: number | null,
 *   source: "log" | "event",
 *   matchedText: string,
 *   entry: ReturnType<typeof lookupError>
 * }>}
 */
export function findMatchingErrors(logLines = [], events = []) {
  const results = [];
  const seen = new Set(); // de-duplicate by entry id per source line

  // Scan log lines
  if (Array.isArray(logLines)) {
    for (let i = 0; i < logLines.length; i++) {
      const line = String(logLines[i]);
      for (const entry of _entries) {
        const m = line.match(entry.regex);
        if (m) {
          const key = `${entry.id}:log:${i}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              lineNumber: i + 1,
              source: "log",
              matchedText: m[0],
              entry: _formatResult(entry),
            });
          }
        }
      }
    }
  }

  // Scan events
  if (Array.isArray(events)) {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const text = [ev.message, ev.reason, ev.note].filter(Boolean).join(" ");
      for (const entry of _entries) {
        const m = text.match(entry.regex);
        if (m) {
          const key = `${entry.id}:event:${i}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              lineNumber: null,
              source: "event",
              matchedText: m[0],
              entry: _formatResult(entry),
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Return all known errors associated with a pod status reason.
 *
 * @param {string} reason — e.g. "CrashLoopBackOff", "OOMKilled", "ImagePullBackOff"
 * @returns {Array<ReturnType<typeof lookupError>>}
 */
export function getErrorsForReason(reason) {
  if (!reason) return [];
  const entries = _byReason.get(reason.toLowerCase()) || [];
  return entries.map((e) => _formatResult(e));
}

/**
 * List all error entries in a category.
 *
 * @param {string} category — e.g. "scheduling", "runtime", "networking"
 * @returns {Array<ReturnType<typeof lookupError>>}
 */
export function getErrorsByCategory(category) {
  if (!category) return [];
  const entries = _byCategory.get(category.toLowerCase()) || [];
  return entries.map((e) => _formatResult(e));
}

/**
 * Get the total number of known error patterns.
 *
 * @returns {number}
 */
export function getPatternCount() {
  return _entries.length;
}

/**
 * Get all known categories.
 *
 * @returns {string[]}
 */
export function getCategories() {
  return [..._byCategory.keys()];
}

/**
 * Look up an error entry by its stable id.
 *
 * @param {string} id
 * @param {string} [platform]
 * @returns {ReturnType<typeof lookupError> | null}
 */
export function lookupById(id, platform) {
  const entry = _byId.get(id);
  if (!entry) return null;
  return _formatResult(entry, platform);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _formatResult(entry, platform) {
  const result = {
    pattern: entry.pattern,
    rootCause: entry.rootCause,
    explanation: entry.explanation,
    remediation: [...entry.remediation],
    severity: entry.severity,
    platformNotes: { ...entry.platformNotes },
    relatedErrors: [...entry.relatedErrors],
  };

  // If a platform is specified and we have a note for it, promote it to the explanation
  if (platform && entry.platformNotes[platform]) {
    result.explanation += `\n\nPlatform note (${platform}): ${entry.platformNotes[platform]}`;
  }

  return result;
}
