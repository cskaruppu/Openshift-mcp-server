/**
 * Natural Language Policy Authoring
 *
 * Converts English descriptions into OpenShift SecurityContextConstraints,
 * NetworkPolicies, ResourceQuotas, or LimitRanges. Unique — no competitor
 * converts natural language to K8s/OpenShift security policy.
 */

import { z } from "zod";
import { callLLM } from "../services/llm.js";

const POLICY_SYSTEM_PROMPT = `You are an OpenShift security policy expert. The user will describe a policy in plain English.
Generate the EXACT Kubernetes/OpenShift YAML manifest that implements it.

Rules:
- For container restrictions → generate SecurityContextConstraints (OpenShift) or PodSecurityPolicy
- For network access rules → generate NetworkPolicy
- For resource limits → generate LimitRange or ResourceQuota
- For image restrictions → generate an ImagePolicy or admission webhook config
- Always use proper apiVersion and kind
- Include metadata with a descriptive name
- Add annotations explaining what the policy does
- Output ONLY valid YAML, no explanations before or after
- If the request is ambiguous, generate the strictest reasonable interpretation`;

export function registerPolicyGenTools(server) {
  server.tool(
    "generate_policy",
    "Convert a natural language description into a Kubernetes/OpenShift security policy YAML (SCC, NetworkPolicy, ResourceQuota, LimitRange)",
    {
      description: z.string().describe("Plain English policy description, e.g. 'Block all containers running as root in production namespaces'"),
      namespace: z.string().optional().describe("Target namespace (if applicable)"),
      dryRun: z.boolean().optional().default(true).describe("If true, only generate YAML without applying"),
    },
    async ({ description, namespace, dryRun }) => {
      const prompt = `Generate an OpenShift/Kubernetes policy YAML for: "${description}"${namespace ? ` in namespace: ${namespace}` : ""}`;

      let yaml;
      try {
        yaml = await callLLM([
          { role: "system", content: POLICY_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ]);
      } catch {
        return generateFallbackPolicy(description, namespace);
      }

      if (!yaml || yaml.trim().length < 20) {
        return generateFallbackPolicy(description, namespace);
      }

      const cleanYaml = yaml.replace(/^```ya?ml?\n?/gm, "").replace(/^```\n?/gm, "").trim();

      const lines = [
        "### Generated Policy",
        "",
        `**Request:** ${description}`,
        namespace ? `**Namespace:** ${namespace}` : "",
        "",
        "```yaml",
        cleanYaml,
        "```",
        "",
      ];

      if (dryRun) {
        lines.push("**Mode:** Dry run — review and apply manually:");
        lines.push("```");
        lines.push("# Save to file and review");
        lines.push("cat <<'EOF' > policy.yaml");
        lines.push(cleanYaml);
        lines.push("EOF");
        lines.push("");
        lines.push("# Apply after review");
        lines.push(`oc apply -f policy.yaml${namespace ? " -n " + namespace : ""}`);
        lines.push("```");
      }

      return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
    }
  );

  server.tool(
    "generate_networkpolicy",
    "Generate a NetworkPolicy from a natural language description of allowed traffic",
    {
      namespace: z.string().describe("Namespace to apply the policy"),
      rule: z.string().describe("Traffic rule, e.g. 'allow ingress from namespace monitoring on port 8080'"),
      policyName: z.string().optional().describe("Name for the NetworkPolicy"),
    },
    async ({ namespace, rule, policyName }) => {
      const name = policyName || "generated-" + Date.now().toString(36);
      const ruleLower = rule.toLowerCase();

      let policy;
      if (ruleLower.includes("deny all") || ruleLower.includes("default deny")) {
        policy = buildDefaultDeny(namespace, name);
      } else if (ruleLower.includes("allow") && ruleLower.includes("from namespace")) {
        const nsMatch = rule.match(/from namespace[s]?\s+(\S+)/i);
        const portMatch = rule.match(/port\s+(\d+)/i);
        policy = buildAllowFromNamespace(namespace, name, nsMatch?.[1] || "default", portMatch?.[1] ? parseInt(portMatch[1]) : null);
      } else if (ruleLower.includes("allow") && ruleLower.includes("egress")) {
        const portMatch = rule.match(/port\s+(\d+)/i);
        policy = buildAllowEgress(namespace, name, portMatch?.[1] ? parseInt(portMatch[1]) : null);
      } else {
        policy = buildDefaultDeny(namespace, name);
        policy.metadata.annotations = { "description": `Custom rule: ${rule} — adjust spec as needed` };
      }

      const yaml = toYaml(policy);
      const lines = [
        `### NetworkPolicy: ${name}`,
        `**Rule:** ${rule}`,
        `**Namespace:** ${namespace}`,
        "",
        "```yaml",
        yaml,
        "```",
        "",
        "Apply with:",
        `\`\`\`\noc apply -f - <<'EOF'\n${yaml}\nEOF\n\`\`\``,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "generate_scc",
    "Generate an OpenShift SecurityContextConstraints from requirements description",
    {
      name: z.string().describe("SCC name"),
      requirements: z.string().describe("e.g. 'non-root, drop all caps, read-only rootfs, no privilege escalation'"),
    },
    async ({ name, requirements }) => {
      const req = requirements.toLowerCase();
      const scc = {
        apiVersion: "security.openshift.io/v1",
        kind: "SecurityContextConstraints",
        metadata: { name, annotations: { "description": requirements } },
        allowPrivilegedContainer: false,
        allowHostNetwork: req.includes("host network"),
        allowHostPorts: req.includes("host port"),
        allowHostPID: false,
        allowHostIPC: false,
        allowPrivilegeEscalation: !req.includes("no privilege escalation") && !req.includes("no escalation"),
        readOnlyRootFilesystem: req.includes("read-only") || req.includes("readonly"),
        runAsUser: { type: req.includes("non-root") || req.includes("nonroot") ? "MustRunAsNonRoot" : "RunAsAny" },
        seLinuxContext: { type: "MustRunAs" },
        fsGroup: { type: "MustRunAs" },
        supplementalGroups: { type: "RunAsAny" },
        requiredDropCapabilities: req.includes("drop all") ? ["ALL"] : [],
        defaultAddCapabilities: [],
        volumes: ["configMap", "downwardAPI", "emptyDir", "persistentVolumeClaim", "projected", "secret"],
      };

      const yaml = toYaml(scc);
      return {
        content: [{
          type: "text",
          text: [
            `### SecurityContextConstraints: ${name}`,
            `**Requirements:** ${requirements}`,
            "",
            "```yaml",
            yaml,
            "```",
            "",
            `Apply: \`oc apply -f scc-${name}.yaml\``,
            `Assign: \`oc adm policy add-scc-to-user ${name} -z <serviceaccount> -n <namespace>\``,
          ].join("\n"),
        }],
      };
    }
  );
}

function buildDefaultDeny(ns, name) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: ns },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };
}

function buildAllowFromNamespace(ns, name, fromNs, port) {
  const ingress = { from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": fromNs } } }] };
  if (port) ingress.ports = [{ port, protocol: "TCP" }];
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: ns },
    spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [ingress] },
  };
}

function buildAllowEgress(ns, name, port) {
  const egress = {};
  if (port) egress.ports = [{ port, protocol: "TCP" }];
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: ns },
    spec: { podSelector: {}, policyTypes: ["Egress"], egress: [egress] },
  };
}

function toYaml(obj, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${k}: []`); continue; }
      lines.push(`${pad}${k}:`);
      for (const item of v) {
        if (typeof item === "object") {
          const sub = toYaml(item, indent + 4).trimStart();
          lines.push(`${pad}  - ${sub}`);
        } else {
          lines.push(`${pad}  - ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof v === "object") {
      lines.push(`${pad}${k}:`);
      lines.push(toYaml(v, indent + 2));
    } else if (typeof v === "boolean") {
      lines.push(`${pad}${k}: ${v}`);
    } else if (typeof v === "number") {
      lines.push(`${pad}${k}: ${v}`);
    } else {
      lines.push(`${pad}${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

function generateFallbackPolicy(description, namespace) {
  const descLower = description.toLowerCase();
  let yaml;

  if (descLower.includes("root") || descLower.includes("privileged")) {
    yaml = toYaml({
      apiVersion: "security.openshift.io/v1",
      kind: "SecurityContextConstraints",
      metadata: { name: "custom-restricted" },
      allowPrivilegedContainer: false,
      runAsUser: { type: "MustRunAsNonRoot" },
      requiredDropCapabilities: ["ALL"],
      readOnlyRootFilesystem: true,
      volumes: ["configMap", "downwardAPI", "emptyDir", "persistentVolumeClaim", "projected", "secret"],
    });
  } else if (descLower.includes("network") || descLower.includes("traffic") || descLower.includes("deny")) {
    yaml = toYaml(buildDefaultDeny(namespace || "default", "default-deny"));
  } else {
    yaml = toYaml({
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "default-limits", namespace: namespace || "default" },
      spec: { limits: [{ type: "Container", default: { cpu: "500m", memory: "256Mi" }, defaultRequest: { cpu: "100m", memory: "128Mi" } }] },
    });
  }

  return {
    content: [{
      type: "text",
      text: `### Generated Policy (rule-based fallback)\n\n**Request:** ${description}\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\nReview and adjust before applying.`,
    }],
  };
}
