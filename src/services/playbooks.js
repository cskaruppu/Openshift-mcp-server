/**
 * Remediation playbooks — curated, declarative responses to known failure
 * patterns. The chat layer calls `suggestPlaybook(rootCause)` after the
 * correlator identifies a likely cause and renders the matching steps.
 *
 * Each playbook is a list of steps:
 *   { kind: "explain" | "command" | "action", ... }
 *
 * "action" steps include an `actionIntent` that can be queued via the
 * approval workflow so the user can confirm with one click.
 */

export const PLAYBOOKS = {
  // -------------------------------------------------------------------------
  CrashLoopBackOff: {
    title: "CrashLoopBackOff recovery",
    description: "Container is crashing repeatedly — investigate logs, fix config/code, then restart.",
    steps: (ctx) => [
      { kind: "explain", text: "Fetch the previous container's logs to see why it crashed." },
      {
        kind: "command",
        cmd: `oc logs ${ctx.pod} -n ${ctx.namespace} --previous`,
      },
      {
        kind: "command",
        cmd: `oc describe pod ${ctx.pod} -n ${ctx.namespace} | grep -A20 Events`,
      },
      { kind: "explain", text: "If the fix is a config change, update the ConfigMap/Secret then restart the pod (owning controller will recreate it)." },
      {
        kind: "action",
        label: `Restart pod ${ctx.pod}`,
        actionIntent: {
          action: "delete",
          resourceType: "pod",
          resourceName: ctx.pod,
          namespace: ctx.namespace,
        },
      },
    ],
  },
  // -------------------------------------------------------------------------
  ImagePullBackOff: {
    title: "ImagePullBackOff recovery",
    description: "Container image cannot be pulled — verify the tag and registry credentials.",
    steps: (ctx) => [
      { kind: "explain", text: "Confirm the image reference exists and the pull secret is valid." },
      {
        kind: "command",
        cmd: `oc get pod ${ctx.pod} -n ${ctx.namespace} -o jsonpath='{.spec.containers[*].image}'`,
      },
      {
        kind: "command",
        cmd: `oc describe pod ${ctx.pod} -n ${ctx.namespace} | grep -A5 Events`,
      },
      {
        kind: "command",
        cmd: `oc get secrets -n ${ctx.namespace} --field-selector type=kubernetes.io/dockerconfigjson`,
      },
      { kind: "explain", text: "Once the image or pull secret is fixed, delete the pod to trigger a re-pull." },
      {
        kind: "action",
        label: `Restart pod ${ctx.pod}`,
        actionIntent: {
          action: "delete",
          resourceType: "pod",
          resourceName: ctx.pod,
          namespace: ctx.namespace,
        },
      },
    ],
  },
  // -------------------------------------------------------------------------
  OOMKilled: {
    title: "OOMKilled remediation",
    description: "Container exceeded its memory limit — raise the limit or fix the leak.",
    steps: (ctx) => [
      { kind: "explain", text: "Review current limits and historical memory usage." },
      {
        kind: "command",
        cmd: `oc get pod ${ctx.pod} -n ${ctx.namespace} -o jsonpath='{.spec.containers[*].resources}'`,
      },
      { kind: "explain", text: "If limits are too low, bump them on the owning deployment; otherwise profile the app for leaks." },
      {
        kind: "command",
        cmd: `oc set resources deployment/<deployment> -n ${ctx.namespace} --limits=memory=1Gi`,
      },
    ],
  },
  // -------------------------------------------------------------------------
  CreateContainerConfigError: {
    title: "CreateContainerConfigError",
    description: "A referenced ConfigMap, Secret, or volume does not exist.",
    steps: (ctx) => [
      {
        kind: "command",
        cmd: `oc describe pod ${ctx.pod} -n ${ctx.namespace} | grep -A10 Events`,
      },
      {
        kind: "command",
        cmd: `oc get configmap,secret -n ${ctx.namespace}`,
      },
      { kind: "explain", text: "Create the missing resource or correct the reference in the deployment." },
    ],
  },
  // -------------------------------------------------------------------------
  NodeNotReady: {
    title: "Node NotReady",
    description: "A node is not Ready — investigate kubelet and node conditions.",
    steps: (ctx) => [
      { kind: "command", cmd: `oc describe node ${ctx.node}` },
      { kind: "command", cmd: `oc adm top node ${ctx.node}` },
      { kind: "explain", text: "Check DiskPressure, MemoryPressure, PIDPressure, or network-related conditions and cordon/drain if needed." },
    ],
  },
};

/**
 * Pick the best matching playbook for a correlator root cause.
 * Returns {title, description, steps} or null if no match.
 */
export function suggestPlaybook(rootCause, ctx = {}) {
  if (!rootCause) return null;
  const pb = PLAYBOOKS[rootCause];
  if (!pb) return null;
  return {
    key: rootCause,
    title: pb.title,
    description: pb.description,
    steps: pb.steps(ctx),
  };
}

/** Render a playbook as markdown for the chat reply. */
export function renderPlaybookMarkdown(pb) {
  if (!pb) return "";
  const lines = [];
  lines.push(`### Playbook: ${pb.title}`);
  lines.push(pb.description);
  lines.push("");
  let stepNum = 1;
  for (const s of pb.steps) {
    if (s.kind === "explain") {
      lines.push(`**${stepNum}.** ${s.text}`);
    } else if (s.kind === "command") {
      lines.push(`**${stepNum}.** Run:`);
      lines.push("```");
      lines.push(s.cmd);
      lines.push("```");
    } else if (s.kind === "action") {
      lines.push(`**${stepNum}.** ${s.label} — use the approval panel to confirm.`);
    }
    stepNum++;
  }
  return lines.join("\n");
}
