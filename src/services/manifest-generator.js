/**
 * Manifest Generator — converts Application Intent Schema (AIS) into
 * platform-specific Kubernetes YAML manifests.
 * Phase 1: OpenShift only. Phase 2 will add EKS/GKE/AKS/K8s/Rancher.
 */

import yaml from "js-yaml";

/**
 * Generate all manifests for a deployment from an AIS.
 * Returns { manifests: [{kind, name, yaml, json}], summary }
 */
export function generateManifests(ais) {
  const platform = (ais.targetPlatform || "openshift").toLowerCase();
  const ns = ais.namespace;
  const manifests = [];

  manifests.push(makeNamespace(ns));

  for (const secret of ais.sharedSecrets || []) {
    manifests.push(makeSecret(secret, ns));
  }

  for (const cm of ais.configMaps || []) {
    manifests.push(makeConfigMap(cm, ns));
  }

  const order = ais.deployOrder || ais.tiers.map((t) => t.name);
  const tierMap = new Map(ais.tiers.map((t) => [t.name, t]));

  for (const tierName of order) {
    const tier = tierMap.get(tierName);
    if (!tier) continue;

    if (tier.storage) {
      manifests.push(makePVC(tier, ns));
    }

    manifests.push(makeDeployment(tier, ais, ns));
    manifests.push(makeService(tier, ns));

    if (tier.role === "database" && tier.initSql) {
      manifests.push(makeInitJob(tier, ais, ns));
    }

    if (tier.expose) {
      if (platform === "openshift") {
        manifests.push(makeRoute(tier, ns));
      } else {
        manifests.push(makeIngress(tier, ns, platform));
      }
    }

    if (tier.replicas && tier.replicas.max > tier.replicas.min && tier.role !== "database") {
      manifests.push(makeHPA(tier, ns));
    }
  }

  for (const np of ais.networkPolicies || []) {
    if (np.allowed) {
      manifests.push(makeNetworkPolicy(np, ais, ns));
    }
  }

  manifests.push(makeDefaultDenyPolicy(ns));

  const summary = {
    platform,
    namespace: ns,
    totalManifests: manifests.length,
    tiers: ais.tiers.map((t) => ({ name: t.name, role: t.role, replicas: t.replicas })),
    hasStorage: ais.tiers.some((t) => t.storage),
    hasHPA: ais.tiers.some((t) => t.replicas?.max > t.replicas?.min),
    hasNetworkPolicies: (ais.networkPolicies || []).length > 0,
  };

  return { manifests, summary };
}

/**
 * Render all manifests as a single multi-document YAML string.
 */
export function renderYaml(manifests) {
  return manifests.map((m) => yaml.dump(m.json, { lineWidth: -1, noRefs: true })).join("---\n");
}

/**
 * Render a single manifest as YAML.
 */
export function renderSingleYaml(manifest) {
  return yaml.dump(manifest.json, { lineWidth: -1, noRefs: true });
}

function makeNamespace(ns) {
  const json = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: ns, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } },
  };
  return { kind: "Namespace", name: ns, yaml: yaml.dump(json), json };
}

function makeSecret(secret, ns) {
  const data = {};
  for (const key of secret.keys) {
    if (secret.autoGenerate) {
      const genVal = key === "password"
        ? generatePassword()
        : key === "database"
        ? "appdb"
        : key === "username"
        ? "appuser"
        : "changeme";
      data[key] = Buffer.from(genVal).toString("base64");
    } else {
      data[key] = Buffer.from("changeme").toString("base64");
    }
  }
  const json = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secret.name,
      namespace: ns,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    type: "Opaque",
    data,
  };
  return { kind: "Secret", name: secret.name, yaml: yaml.dump(json), json };
}

function makeConfigMap(cm, ns) {
  const json = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: cm.name,
      namespace: ns,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    data: cm.data || {},
  };
  return { kind: "ConfigMap", name: cm.name, yaml: yaml.dump(json), json };
}

function makePVC(tier, ns) {
  const s = tier.storage;
  const json = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: `${tier.name}-data`,
      namespace: ns,
      labels: {
        app: tier.name,
        "app.kubernetes.io/managed-by": "tcs-agentic-ai",
      },
    },
    spec: {
      accessModes: [s.accessMode || "ReadWriteOnce"],
      resources: { requests: { storage: s.size || "10Gi" } },
    },
  };
  if (s.storageClass && s.storageClass !== "default") {
    json.spec.storageClassName = s.storageClass;
  }
  return { kind: "PersistentVolumeClaim", name: `${tier.name}-data`, yaml: yaml.dump(json), json };
}

function makeDeployment(tier, ais, ns) {
  const labels = {
    app: tier.name,
    "app.kubernetes.io/name": tier.name,
    "app.kubernetes.io/part-of": ais.appName,
    "app.kubernetes.io/component": tier.role,
    "app.kubernetes.io/managed-by": "tcs-agentic-ai",
  };

  const container = {
    name: tier.name,
    image: tier.image,
    ports: [{ containerPort: tier.port, protocol: tier.protocol || "TCP" }],
  };

  if (tier.resources) {
    container.resources = {
      requests: {},
      limits: {},
    };
    if (tier.resources.cpuReq) container.resources.requests.cpu = tier.resources.cpuReq;
    if (tier.resources.memReq) container.resources.requests.memory = tier.resources.memReq;
    if (tier.resources.cpuLim) container.resources.limits.cpu = tier.resources.cpuLim;
    if (tier.resources.memLim) container.resources.limits.memory = tier.resources.memLim;
  }

  container.env = [];
  for (const ev of tier.envVars || []) {
    if (ev.fromSecret) {
      container.env.push({
        name: ev.name,
        valueFrom: { secretKeyRef: { name: ev.fromSecret, key: ev.secretKey || ev.name } },
      });
    } else {
      container.env.push({ name: ev.name, value: String(ev.value) });
    }
  }

  const cmUsed = (ais.configMaps || []).filter((c) => (c.usedBy || []).includes(tier.name));
  for (const cm of cmUsed) {
    container.envFrom = container.envFrom || [];
    container.envFrom.push({ configMapRef: { name: cm.name } });
  }

  if (tier.probes) {
    if (tier.probes.liveness) {
      container.livenessProbe = buildProbe(tier.probes.liveness);
    }
    if (tier.probes.readiness) {
      container.readinessProbe = buildProbe(tier.probes.readiness);
    }
  }

  const volumeMounts = [];
  const volumes = [];
  if (tier.storage) {
    volumeMounts.push({ name: "data", mountPath: tier.storage.mountPath || "/data" });
    volumes.push({ name: "data", persistentVolumeClaim: { claimName: `${tier.name}-data` } });
  }
  if (volumeMounts.length > 0) container.volumeMounts = volumeMounts;

  const podSpec = {
    containers: [container],
  };
  if (volumes.length > 0) podSpec.volumes = volumes;

  const sec = tier.security || {};
  podSpec.securityContext = {};
  if (sec.runAsNonRoot) podSpec.securityContext.runAsNonRoot = true;
  if (sec.runAsNonRoot) container.securityContext = { allowPrivilegeEscalation: false };
  if (sec.readOnlyRootFs) {
    container.securityContext = container.securityContext || {};
    container.securityContext.readOnlyRootFilesystem = true;
  }
  if (sec.dropCapabilities) {
    container.securityContext = container.securityContext || {};
    container.securityContext.capabilities = { drop: ["ALL"] };
  }

  const json = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: tier.name, namespace: ns, labels },
    spec: {
      replicas: tier.replicas?.min || 1,
      selector: { matchLabels: { app: tier.name } },
      strategy: tier.role === "database"
        ? { type: "Recreate" }
        : { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: 0 } },
      template: {
        metadata: { labels },
        spec: podSpec,
      },
    },
  };

  return { kind: "Deployment", name: tier.name, yaml: yaml.dump(json, { lineWidth: -1, noRefs: true }), json };
}

function makeService(tier, ns) {
  const json = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: tier.name,
      namespace: ns,
      labels: { app: tier.name, "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec: {
      selector: { app: tier.name },
      ports: [{ port: tier.port, targetPort: tier.port, protocol: tier.protocol || "TCP" }],
      type: "ClusterIP",
    },
  };
  return { kind: "Service", name: tier.name, yaml: yaml.dump(json), json };
}

function makeRoute(tier, ns) {
  const json = {
    apiVersion: "route.openshift.io/v1",
    kind: "Route",
    metadata: {
      name: tier.name,
      namespace: ns,
      labels: { app: tier.name, "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec: {
      host: tier.hostname || "",
      to: { kind: "Service", name: tier.name, weight: 100 },
      port: { targetPort: tier.port },
    },
  };
  if (tier.tls) {
    json.spec.tls = { termination: tier.tls, insecureEdgeTerminationPolicy: "Redirect" };
  }
  return { kind: "Route", name: tier.name, yaml: yaml.dump(json), json };
}

function makeIngress(tier, ns, platform) {
  const annotations = {};
  if (platform === "eks") annotations["kubernetes.io/ingress.class"] = "alb";
  else if (platform === "gke") annotations["kubernetes.io/ingress.class"] = "gce";
  else annotations["kubernetes.io/ingress.class"] = "nginx";

  const json = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: tier.name,
      namespace: ns,
      labels: { app: tier.name, "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
      annotations,
    },
    spec: {
      rules: [
        {
          host: tier.hostname || "",
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: { service: { name: tier.name, port: { number: tier.port } } },
              },
            ],
          },
        },
      ],
    },
  };
  if (tier.tls && tier.hostname) {
    json.spec.tls = [{ hosts: [tier.hostname], secretName: `${tier.name}-tls` }];
  }
  return { kind: "Ingress", name: tier.name, yaml: yaml.dump(json), json };
}

function makeHPA(tier, ns) {
  const json = {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: {
      name: tier.name,
      namespace: ns,
      labels: { app: tier.name, "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec: {
      scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: tier.name },
      minReplicas: tier.replicas.min,
      maxReplicas: tier.replicas.max,
      metrics: [
        { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
      ],
    },
  };
  return { kind: "HorizontalPodAutoscaler", name: tier.name, yaml: yaml.dump(json), json };
}

function makeNetworkPolicy(rule, ais, ns) {
  const tierMap = new Map(ais.tiers.map((t) => [t.name, t]));
  const toTier = ais.tiers.find(
    (t) => t.name === rule.to || t.role === rule.to
  );
  const fromTier = ais.tiers.find(
    (t) => t.name === rule.from || t.role === rule.from
  );

  const policyName = `allow-${(rule.from || "any").replace(/[^a-z0-9]/g, "-")}-to-${(rule.to || "any").replace(/[^a-z0-9]/g, "-")}`;

  const spec = {
    podSelector: { matchLabels: { app: toTier?.name || rule.to } },
    policyTypes: ["Ingress"],
    ingress: [
      {
        ports: [{ port: rule.port, protocol: rule.protocol || "TCP" }],
      },
    ],
  };

  if (rule.from === "internet" || rule.from === "external") {
    spec.ingress[0].from = [{}];
  } else if (fromTier) {
    spec.ingress[0].from = [{ podSelector: { matchLabels: { app: fromTier.name } } }];
  }

  const json = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: policyName,
      namespace: ns,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec,
  };
  return { kind: "NetworkPolicy", name: policyName, yaml: yaml.dump(json), json };
}

function makeDefaultDenyPolicy(ns) {
  const json = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "default-deny-all",
      namespace: ns,
      labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
    },
  };
  return { kind: "NetworkPolicy", name: "default-deny-all", yaml: yaml.dump(json), json };
}

function makeInitJob(tier, ais, ns) {
  const secret = (ais.sharedSecrets || []).find((s) => (s.usedBy || []).includes(tier.name));
  const envVars = [];
  if (secret) {
    for (const key of secret.keys) {
      envVars.push({
        name: `PGPASSWORD`,
        valueFrom: { secretKeyRef: { name: secret.name, key: "password" } },
      });
    }
  }
  envVars.push(
    { name: "PGHOST", value: `${tier.name}.${ns}.svc.cluster.local` },
    { name: "PGUSER", valueFrom: secret ? { secretKeyRef: { name: secret.name, key: "username" } } : undefined },
    { name: "PGDATABASE", valueFrom: secret ? { secretKeyRef: { name: secret.name, key: "database" } } : undefined },
  );

  const json = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `${tier.name}-init`,
      namespace: ns,
      labels: { app: tier.name, "app.kubernetes.io/managed-by": "tcs-agentic-ai" },
    },
    spec: {
      backoffLimit: 3,
      template: {
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "init-sql",
              image: tier.image,
              command: ["sh", "-c", `until pg_isready -h $PGHOST; do sleep 2; done && psql -h $PGHOST -U $PGUSER -d $PGDATABASE -c "${escapeSql(tier.initSql)}"`],
              env: envVars.filter((e) => e.value !== undefined || e.valueFrom !== undefined),
            },
          ],
        },
      },
    },
  };
  return { kind: "Job", name: `${tier.name}-init`, yaml: yaml.dump(json, { lineWidth: -1, noRefs: true }), json };
}

function buildProbe(probe) {
  const p = {};
  if (probe.type === "http" || probe.type === "httpGet") {
    p.httpGet = { path: probe.path || "/", port: probe.port };
  } else if (probe.type === "tcp") {
    p.tcpSocket = { port: probe.port };
  } else if (probe.type === "exec") {
    p.exec = { command: Array.isArray(probe.command) ? probe.command : ["sh", "-c", probe.command || "true"] };
  }
  if (probe.initialDelay) p.initialDelaySeconds = probe.initialDelay;
  if (probe.period) p.periodSeconds = probe.period;
  return p;
}

function escapeSql(sql) {
  return (sql || "").replace(/"/g, '\\"').replace(/'/g, "'\\''");
}

function generatePassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let pw = "";
  for (let i = 0; i < 20; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}
