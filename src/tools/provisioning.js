import { z } from "zod";
import { ocpGet, ocpPost } from "../utils/openshift-client.js";

export function registerProvisioningTools(server) {
  // ---------- Create Deployment ----------
  server.tool(
    "create_deployment",
    "Create a Kubernetes Deployment with specified image, replicas, resource limits, and ports.",
    {
      name: z.string().describe("Deployment name"),
      namespace: z.string().default("default").describe("Target namespace"),
      image: z.string().describe("Container image (e.g. nginx:latest)"),
      replicas: z.number().min(1).max(100).default(1).describe("Number of replicas"),
      cpuRequest: z.string().default("100m").describe("CPU request"),
      memoryRequest: z.string().default("128Mi").describe("Memory request"),
      cpuLimit: z.string().default("500m").describe("CPU limit"),
      memoryLimit: z.string().default("512Mi").describe("Memory limit"),
      ports: z.array(z.number()).default([]).describe("Container ports to expose"),
      envVars: z.record(z.string()).default({}).describe("Environment variables as key-value pairs"),
    },
    async ({ name, namespace, image, replicas, cpuRequest, memoryRequest, cpuLimit, memoryLimit, ports, envVars }) => {
      try {
        await ensureNamespace(namespace);
        const env = Object.entries(envVars).map(([k, v]) => ({ name: k, value: v }));
        const containerPorts = ports.map(p => ({ containerPort: p, protocol: "TCP" }));

        const deployment = {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name,
            namespace,
            labels: { app: name, "managed-by": "tcs-agentic-ai" },
          },
          spec: {
            replicas,
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels: { app: name } },
              spec: {
                containers: [{
                  name,
                  image,
                  ports: containerPorts.length > 0 ? containerPorts : undefined,
                  env: env.length > 0 ? env : undefined,
                  resources: {
                    requests: { cpu: cpuRequest, memory: memoryRequest },
                    limits: { cpu: cpuLimit, memory: memoryLimit },
                  },
                }],
              },
            },
          },
        };

        await ocpPost(`/apis/apps/v1/namespaces/${namespace}/deployments`, deployment);
        return {
          content: [{
            type: "text",
            text: `Deployment created.\n\nName: ${name}\nNamespace: ${namespace}\nImage: ${image}\nReplicas: ${replicas}\nPorts: ${ports.length > 0 ? ports.join(", ") : "none"}\n\nMonitor:\n  oc rollout status deployment/${name} -n ${namespace}\n  oc get pods -l app=${name} -n ${namespace}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Deploy Database ----------
  server.tool(
    "deploy_database",
    "Deploy a database instance (PostgreSQL, MySQL, MongoDB, or Redis) with a Service and optional persistent storage.",
    {
      dbType: z.enum(["postgresql", "mysql", "mongodb", "redis"]).describe("Database type"),
      name: z.string().describe("Database instance name"),
      namespace: z.string().default("default").describe("Target namespace"),
      storageSize: z.string().default("10Gi").describe("Persistent volume size (empty string for emptyDir)"),
      storageClass: z.string().default("").describe("Storage class name (empty = default)"),
      cpuRequest: z.string().default("250m"),
      memoryRequest: z.string().default("512Mi"),
      cpuLimit: z.string().default("1000m"),
      memoryLimit: z.string().default("1Gi"),
    },
    async ({ dbType, name, namespace, storageSize, storageClass, cpuRequest, memoryRequest, cpuLimit, memoryLimit }) => {
      try {
        await ensureNamespace(namespace);

        const dbConfigs = {
          postgresql: {
            image: "postgres:16-alpine",
            port: 5432,
            env: [
              { name: "POSTGRES_DB", value: name },
              { name: "POSTGRES_USER", value: "postgres" },
              { name: "POSTGRES_PASSWORD", value: "changeme" },
              { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
            ],
            mountPath: "/var/lib/postgresql/data",
            subPath: "pgdata",
          },
          mysql: {
            image: "mysql:8.0",
            port: 3306,
            env: [
              { name: "MYSQL_DATABASE", value: name },
              { name: "MYSQL_ROOT_PASSWORD", value: "changeme" },
            ],
            mountPath: "/var/lib/mysql",
          },
          mongodb: {
            image: "mongo:7",
            port: 27017,
            env: [{ name: "MONGO_INITDB_DATABASE", value: name }],
            mountPath: "/data/db",
          },
          redis: {
            image: "redis:7-alpine",
            port: 6379,
            env: [],
            mountPath: "/data",
          },
        };

        const cfg = dbConfigs[dbType];
        const volumeName = `${name}-data`;

        const volumeMount = { name: volumeName, mountPath: cfg.mountPath };
        if (cfg.subPath) volumeMount.subPath = cfg.subPath;

        const volume = storageSize
          ? { name: volumeName, persistentVolumeClaim: { claimName: `${name}-pvc` } }
          : { name: volumeName, emptyDir: {} };

        if (storageSize) {
          const pvc = {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: { name: `${name}-pvc`, namespace, labels: { app: name, "managed-by": "tcs-agentic-ai" } },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: storageSize } },
              ...(storageClass ? { storageClassName: storageClass } : {}),
            },
          };
          await ocpPost(`/api/v1/namespaces/${namespace}/persistentvolumeclaims`, pvc);
        }

        const deployment = {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name, namespace, labels: { app: name, "db-type": dbType, "managed-by": "tcs-agentic-ai" } },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels: { app: name, "db-type": dbType } },
              spec: {
                containers: [{
                  name: dbType,
                  image: cfg.image,
                  ports: [{ containerPort: cfg.port }],
                  env: cfg.env,
                  volumeMounts: [volumeMount],
                  resources: {
                    requests: { cpu: cpuRequest, memory: memoryRequest },
                    limits: { cpu: cpuLimit, memory: memoryLimit },
                  },
                  readinessProbe: { tcpSocket: { port: cfg.port }, initialDelaySeconds: 15, periodSeconds: 5 },
                  livenessProbe: { tcpSocket: { port: cfg.port }, initialDelaySeconds: 60, periodSeconds: 10 },
                }],
                volumes: [volume],
              },
            },
          },
        };
        await ocpPost(`/apis/apps/v1/namespaces/${namespace}/deployments`, deployment);

        const svc = {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: `${name}-svc`, namespace, labels: { app: name, "managed-by": "tcs-agentic-ai" } },
          spec: {
            selector: { app: name },
            ports: [{ port: cfg.port, targetPort: cfg.port, protocol: "TCP" }],
          },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/services`, svc);

        return {
          content: [{
            type: "text",
            text: `Database deployed.\n\nType: ${dbType}\nName: ${name}\nNamespace: ${namespace}\nImage: ${cfg.image}\nPort: ${cfg.port}\nService: ${name}-svc:${cfg.port}\nStorage: ${storageSize || "emptyDir (ephemeral)"}\n\n⚠ Change default password: env var ${dbType === "postgresql" ? "POSTGRES_PASSWORD" : dbType === "mysql" ? "MYSQL_ROOT_PASSWORD" : ""}\n\nMonitor:\n  oc rollout status deployment/${name} -n ${namespace}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Create Horizontal Pod Autoscaler ----------
  server.tool(
    "create_hpa",
    "Create a Horizontal Pod Autoscaler (HPA v2) for a Deployment with CPU and memory targets.",
    {
      targetDeployment: z.string().describe("Name of the Deployment to scale"),
      namespace: z.string().default("default").describe("Namespace of the target Deployment"),
      minReplicas: z.number().min(1).default(1).describe("Minimum replicas"),
      maxReplicas: z.number().min(1).default(10).describe("Maximum replicas"),
      cpuTarget: z.number().min(1).max(100).default(70).describe("Target CPU utilization percentage"),
      memoryTarget: z.number().min(1).max(100).default(80).describe("Target memory utilization percentage"),
    },
    async ({ targetDeployment, namespace, minReplicas, maxReplicas, cpuTarget, memoryTarget }) => {
      try {
        await ocpGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${targetDeployment}`);

        const hpa = {
          apiVersion: "autoscaling/v2",
          kind: "HorizontalPodAutoscaler",
          metadata: {
            name: `${targetDeployment}-hpa`,
            namespace,
            labels: { app: targetDeployment, "managed-by": "tcs-agentic-ai" },
          },
          spec: {
            scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: targetDeployment },
            minReplicas,
            maxReplicas,
            metrics: [
              { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: cpuTarget } } },
              { type: "Resource", resource: { name: "memory", target: { type: "Utilization", averageUtilization: memoryTarget } } },
            ],
          },
        };

        await ocpPost(`/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers`, hpa);
        return {
          content: [{
            type: "text",
            text: `HPA created.\n\nName: ${targetDeployment}-hpa\nTarget: ${targetDeployment}\nNamespace: ${namespace}\nMin/Max Replicas: ${minReplicas}/${maxReplicas}\nCPU Target: ${cpuTarget}%\nMemory Target: ${memoryTarget}%\n\nMonitor:\n  oc get hpa ${targetDeployment}-hpa -n ${namespace} -w`,
          }],
        };
      } catch (e) {
        if (e.message.includes("404") || e.message.includes("not found")) {
          return { content: [{ type: "text", text: `Deployment '${targetDeployment}' not found in namespace '${namespace}'.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Create Service ----------
  server.tool(
    "create_service",
    "Create a Kubernetes Service (ClusterIP, NodePort, or LoadBalancer) for a set of pods.",
    {
      name: z.string().describe("Service name"),
      namespace: z.string().default("default").describe("Target namespace"),
      selector: z.record(z.string()).describe("Pod selector labels (e.g. {app: 'myapp'})"),
      port: z.number().describe("Service port"),
      targetPort: z.number().describe("Container target port"),
      protocol: z.enum(["TCP", "UDP"]).default("TCP").describe("Protocol"),
      serviceType: z.enum(["ClusterIP", "NodePort", "LoadBalancer"]).default("ClusterIP").describe("Service type"),
    },
    async ({ name, namespace, selector, port, targetPort, protocol, serviceType }) => {
      try {
        await ensureNamespace(namespace);
        const svc = {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name, namespace, labels: { "managed-by": "tcs-agentic-ai" } },
          spec: {
            type: serviceType,
            selector,
            ports: [{ port, targetPort, protocol }],
          },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/services`, svc);
        return {
          content: [{
            type: "text",
            text: `Service created.\n\nName: ${name}\nNamespace: ${namespace}\nType: ${serviceType}\nPort: ${port} → ${targetPort} (${protocol})\nSelector: ${JSON.stringify(selector)}\n\nVerify:\n  oc get svc ${name} -n ${namespace}\n  oc get endpoints ${name} -n ${namespace}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Create Network Policy ----------
  server.tool(
    "create_network_policy",
    "Create a Kubernetes NetworkPolicy to control pod-to-pod traffic. With no rules, creates a deny-all policy.",
    {
      name: z.string().describe("NetworkPolicy name"),
      namespace: z.string().default("default").describe("Target namespace"),
      podSelector: z.record(z.string()).default({}).describe("Labels to select target pods (empty = all pods)"),
      allowIngressFrom: z.array(z.object({
        podLabels: z.record(z.string()).optional().describe("Allow from pods with these labels"),
        namespaceLabels: z.record(z.string()).optional().describe("Allow from namespaces with these labels"),
        port: z.number().optional().describe("Allow on this port"),
        protocol: z.enum(["TCP", "UDP"]).default("TCP"),
      })).default([]).describe("Ingress allow rules"),
      allowEgressTo: z.array(z.object({
        podLabels: z.record(z.string()).optional().describe("Allow to pods with these labels"),
        namespaceLabels: z.record(z.string()).optional().describe("Allow to namespaces with these labels"),
        port: z.number().optional().describe("Allow on this port"),
        protocol: z.enum(["TCP", "UDP"]).default("TCP"),
      })).default([]).describe("Egress allow rules"),
    },
    async ({ name, namespace, podSelector, allowIngressFrom, allowEgressTo }) => {
      try {
        await ensureNamespace(namespace);

        const policyTypes = [];
        const spec = {
          podSelector: Object.keys(podSelector).length > 0 ? { matchLabels: podSelector } : {},
        };

        if (allowIngressFrom.length > 0) {
          policyTypes.push("Ingress");
          spec.ingress = [{
            from: allowIngressFrom.map(r => {
              const peer = {};
              if (r.podLabels) peer.podSelector = { matchLabels: r.podLabels };
              if (r.namespaceLabels) peer.namespaceSelector = { matchLabels: r.namespaceLabels };
              return peer;
            }).filter(p => Object.keys(p).length > 0),
            ports: allowIngressFrom.filter(r => r.port).map(r => ({ port: r.port, protocol: r.protocol })),
          }];
          if (spec.ingress[0].from.length === 0) delete spec.ingress[0].from;
          if (spec.ingress[0].ports.length === 0) delete spec.ingress[0].ports;
        } else {
          policyTypes.push("Ingress");
          spec.ingress = [];
        }

        if (allowEgressTo.length > 0) {
          policyTypes.push("Egress");
          spec.egress = [{
            to: allowEgressTo.map(r => {
              const peer = {};
              if (r.podLabels) peer.podSelector = { matchLabels: r.podLabels };
              if (r.namespaceLabels) peer.namespaceSelector = { matchLabels: r.namespaceLabels };
              return peer;
            }).filter(p => Object.keys(p).length > 0),
            ports: allowEgressTo.filter(r => r.port).map(r => ({ port: r.port, protocol: r.protocol })),
          }];
          if (spec.egress[0].to.length === 0) delete spec.egress[0].to;
          if (spec.egress[0].ports.length === 0) delete spec.egress[0].ports;
        } else {
          policyTypes.push("Egress");
          spec.egress = [];
        }

        spec.policyTypes = policyTypes;

        const netpol = {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name, namespace, labels: { "managed-by": "tcs-agentic-ai" } },
          spec,
        };

        await ocpPost(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`, netpol);

        const isDefaultDeny = allowIngressFrom.length === 0 && allowEgressTo.length === 0;
        return {
          content: [{
            type: "text",
            text: `NetworkPolicy created${isDefaultDeny ? " (default deny-all)" : ""}.\n\nName: ${name}\nNamespace: ${namespace}\nPod Selector: ${JSON.stringify(podSelector) || "{} (all pods)"}\nPolicy Types: ${policyTypes.join(", ")}\nIngress Rules: ${allowIngressFrom.length || "deny all"}\nEgress Rules: ${allowEgressTo.length || "deny all"}\n\nVerify:\n  oc describe networkpolicy ${name} -n ${namespace}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}

async function ensureNamespace(ns) {
  try {
    await ocpGet(`/api/v1/namespaces/${ns}`);
  } catch {
    await ocpPost("/api/v1/namespaces", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: ns, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } },
    });
  }
}
