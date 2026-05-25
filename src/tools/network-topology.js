/**
 * Kubernetes Network Topology / Service Map Generator
 *
 * Builds a graph of services, pods, ingresses, routes, and network policies
 * for a given namespace or across the entire cluster. Useful for understanding
 * traffic flow, identifying externally exposed services, and finding namespaces
 * that lack network policy protection.
 */

import { ocpGet } from "../utils/openshift-client.js";

// Namespaces that belong to the platform and should be excluded from
// user-facing topology views.
const SYSTEM_NS_PREFIXES = ["openshift-", "kube-", "default"];
const SYSTEM_NS_EXACT = new Set([
  "openshift",
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "default",
]);

function isSystemNamespace(name) {
  if (SYSTEM_NS_EXACT.has(name)) return true;
  return SYSTEM_NS_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// getNetworkTopology(namespace)
// ---------------------------------------------------------------------------

/**
 * Build a full network topology graph for a single namespace, including
 * services, endpoints, network policies, ingresses, and OpenShift routes.
 *
 * @param {string} namespace - The namespace to inspect.
 * @returns {Promise<object>} Topology graph with nodes, edges, policies, and stats.
 */
export async function getNetworkTopology(namespace) {
  const ns = namespace;

  // Fetch all relevant resources in parallel.
  const [services, endpoints, networkPolicies, ingresses, routes] =
    await Promise.all([
      ocpGet(`/api/v1/namespaces/${ns}/services`).catch(() => ({ items: [] })),
      ocpGet(`/api/v1/namespaces/${ns}/endpoints`).catch(() => ({ items: [] })),
      ocpGet(
        `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`
      ).catch(() => ({ items: [] })),
      ocpGet(
        `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`
      ).catch(() => ({ items: [] })),
      // Routes are OpenShift-only; silently skip on vanilla Kubernetes.
      ocpGet(
        `/apis/route.openshift.io/v1/namespaces/${ns}/routes`
      ).catch(() => null),
    ]);

  const serviceItems = services.items || [];
  const endpointItems = endpoints.items || [];
  const policyItems = networkPolicies.items || [];
  const ingressItems = ingresses.items || [];
  const routeItems = routes?.items || [];

  // ----- Build nodes -----
  const nodes = [];
  const nodeIdSet = new Set();

  function addNode(node) {
    if (!nodeIdSet.has(node.id)) {
      nodeIdSet.add(node.id);
      nodes.push(node);
    }
  }

  // Service nodes
  for (const svc of serviceItems) {
    const name = svc.metadata.name;
    const ports = (svc.spec.ports || []).map(
      (p) => `${p.port}/${p.protocol || "TCP"}`
    );
    addNode({
      id: `svc/${name}`,
      name,
      type: "service",
      port: ports.join(", "),
      protocol: (svc.spec.ports || [])
        .map((p) => p.protocol || "TCP")
        .join(", "),
      clusterIP: svc.spec.clusterIP || "None",
      selectors: svc.spec.selector || {},
    });
  }

  // Pod nodes — derived from endpoint addresses
  const endpointsByService = new Map();
  for (const ep of endpointItems) {
    const epName = ep.metadata.name;
    const podRefs = [];
    for (const subset of ep.subsets || []) {
      const allAddresses = [
        ...(subset.addresses || []),
        ...(subset.notReadyAddresses || []),
      ];
      for (const addr of allAddresses) {
        if (addr.targetRef && addr.targetRef.kind === "Pod") {
          const podName = addr.targetRef.name;
          const podPorts = (subset.ports || [])
            .map((p) => `${p.port}/${p.protocol || "TCP"}`)
            .join(", ");
          addNode({
            id: `pod/${podName}`,
            name: podName,
            type: "pod",
            port: podPorts,
            protocol: (subset.ports || [])
              .map((p) => p.protocol || "TCP")
              .join(", "),
            clusterIP: addr.ip || "",
            selectors: {},
          });
          podRefs.push(podName);
        }
      }
    }
    endpointsByService.set(epName, podRefs);
  }

  // Ingress nodes
  for (const ing of ingressItems) {
    const name = ing.metadata.name;
    const hosts = (ing.spec.rules || [])
      .map((r) => r.host || "*")
      .join(", ");
    addNode({
      id: `ingress/${name}`,
      name,
      type: "ingress",
      port: "80,443",
      protocol: "TCP",
      clusterIP: "",
      selectors: {},
    });
  }

  // Route nodes
  for (const rt of routeItems) {
    const name = rt.metadata.name;
    addNode({
      id: `route/${name}`,
      name,
      type: "route",
      port: rt.spec.port?.targetPort || "",
      protocol: "TCP",
      clusterIP: "",
      selectors: {},
    });
  }

  // ----- Build edges -----
  const edges = [];

  // Service → Pod edges (via endpoints name matching)
  for (const svc of serviceItems) {
    const svcName = svc.metadata.name;
    const podNames = endpointsByService.get(svcName) || [];
    const svcPorts = (svc.spec.ports || []).map((p) => ({
      port: p.targetPort || p.port,
      protocol: p.protocol || "TCP",
    }));
    for (const podName of podNames) {
      for (const sp of svcPorts) {
        edges.push({
          from: `svc/${svcName}`,
          to: `pod/${podName}`,
          port: String(sp.port),
          protocol: sp.protocol,
        });
      }
    }
  }

  // Ingress → Service edges
  for (const ing of ingressItems) {
    const ingName = ing.metadata.name;
    for (const rule of ing.spec.rules || []) {
      for (const path of rule.http?.paths || []) {
        const backend = path.backend;
        let svcName = null;
        let svcPort = "";
        if (backend?.service) {
          svcName = backend.service.name;
          svcPort =
            backend.service.port?.number ||
            backend.service.port?.name ||
            "";
        }
        if (svcName) {
          edges.push({
            from: `ingress/${ingName}`,
            to: `svc/${svcName}`,
            port: String(svcPort),
            protocol: "TCP",
          });
        }
      }
    }
    // Default backend
    const defaultBackend = ing.spec.defaultBackend;
    if (defaultBackend?.service) {
      edges.push({
        from: `ingress/${ingName}`,
        to: `svc/${defaultBackend.service.name}`,
        port: String(
          defaultBackend.service.port?.number ||
            defaultBackend.service.port?.name ||
            ""
        ),
        protocol: "TCP",
      });
    }
  }

  // Route → Service edges
  for (const rt of routeItems) {
    const rtName = rt.metadata.name;
    const targetSvc = rt.spec.to?.name;
    if (targetSvc) {
      edges.push({
        from: `route/${rtName}`,
        to: `svc/${targetSvc}`,
        port: rt.spec.port?.targetPort || "",
        protocol: "TCP",
      });
    }
    // Alternate backends
    for (const alt of rt.spec.alternateBackends || []) {
      if (alt.kind === "Service" && alt.name) {
        edges.push({
          from: `route/${rtName}`,
          to: `svc/${alt.name}`,
          port: rt.spec.port?.targetPort || "",
          protocol: "TCP",
        });
      }
    }
  }

  // ----- Network policies -----
  const networkPoliciesOut = policyItems.map((np) => {
    const ingressRules = (np.spec.ingress || []).map((rule) => ({
      from: (rule.from || []).map((peer) => {
        if (peer.podSelector) return { podSelector: peer.podSelector };
        if (peer.namespaceSelector)
          return { namespaceSelector: peer.namespaceSelector };
        if (peer.ipBlock) return { ipBlock: peer.ipBlock };
        return peer;
      }),
      ports: (rule.ports || []).map((p) => ({
        port: p.port,
        protocol: p.protocol || "TCP",
      })),
    }));

    const egressRules = (np.spec.egress || []).map((rule) => ({
      to: (rule.to || []).map((peer) => {
        if (peer.podSelector) return { podSelector: peer.podSelector };
        if (peer.namespaceSelector)
          return { namespaceSelector: peer.namespaceSelector };
        if (peer.ipBlock) return { ipBlock: peer.ipBlock };
        return peer;
      }),
      ports: (rule.ports || []).map((p) => ({
        port: p.port,
        protocol: p.protocol || "TCP",
      })),
    }));

    return {
      name: np.metadata.name,
      podSelector: np.spec.podSelector || {},
      ingress: ingressRules,
      egress: egressRules,
    };
  });

  // ----- Exposed services -----
  const exposedServices = [];

  for (const svc of serviceItems) {
    if (svc.spec.type === "LoadBalancer" || svc.spec.type === "NodePort") {
      const ports = (svc.spec.ports || []).map((p) => ({
        port: p.port,
        nodePort: p.nodePort || null,
        protocol: p.protocol || "TCP",
      }));
      const host =
        svc.spec.type === "LoadBalancer"
          ? (svc.status?.loadBalancer?.ingress || [])
              .map((i) => i.hostname || i.ip || "")
              .join(", ") || "pending"
          : "";
      exposedServices.push({
        name: svc.metadata.name,
        type: svc.spec.type,
        ports,
        host,
      });
    }
  }

  for (const ing of ingressItems) {
    const hosts = (ing.spec.rules || []).map((r) => r.host || "*").join(", ");
    const ports = ing.spec.tls?.length ? [{ port: 443, protocol: "HTTPS" }] : [{ port: 80, protocol: "HTTP" }];
    exposedServices.push({
      name: ing.metadata.name,
      type: "Ingress",
      ports,
      host: hosts,
    });
  }

  for (const rt of routeItems) {
    exposedServices.push({
      name: rt.metadata.name,
      type: "Route",
      ports: [{ port: rt.spec.tls ? 443 : 80, protocol: rt.spec.tls ? "HTTPS" : "HTTP" }],
      host: rt.spec.host || "",
    });
  }

  return {
    namespace: ns,
    nodes,
    edges,
    networkPolicies: networkPoliciesOut,
    exposedServices,
    hasNetworkPolicy: policyItems.length > 0,
    stats: {
      services: serviceItems.length,
      endpoints: endpointItems.length,
      policies: policyItems.length,
      ingresses: ingressItems.length,
      routes: routeItems.length,
    },
  };
}

// ---------------------------------------------------------------------------
// getClusterTopology()
// ---------------------------------------------------------------------------

/**
 * Build a high-level cluster topology: for every non-system namespace, gather
 * a summary of services, network policy presence, and exposed services.
 *
 * @returns {Promise<object[]>} Array of namespace summaries.
 */
export async function getClusterTopology() {
  let allNamespaces;
  try {
    allNamespaces = await ocpGet("/api/v1/namespaces");
  } catch (err) {
    return [{ error: `Failed to list namespaces: ${err.message}` }];
  }

  const userNamespaces = (allNamespaces.items || []).filter(
    (ns) => !isSystemNamespace(ns.metadata.name)
  );

  const summaries = await Promise.all(
    userNamespaces.map(async (nsObj) => {
      const ns = nsObj.metadata.name;
      try {
        const [services, policies, ingresses, routes] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${ns}/services`).catch(() => ({
            items: [],
          })),
          ocpGet(
            `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`
          ).catch(() => ({ items: [] })),
          ocpGet(
            `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`
          ).catch(() => ({ items: [] })),
          ocpGet(
            `/apis/route.openshift.io/v1/namespaces/${ns}/routes`
          ).catch(() => null),
        ]);

        const serviceItems = services.items || [];
        const policyItems = policies.items || [];
        const ingressItems = ingresses.items || [];
        const routeItems = routes?.items || [];

        // Identify externally exposed services in this namespace
        const exposed = [];
        for (const svc of serviceItems) {
          if (
            svc.spec.type === "LoadBalancer" ||
            svc.spec.type === "NodePort"
          ) {
            exposed.push({
              name: svc.metadata.name,
              type: svc.spec.type,
            });
          }
        }
        for (const ing of ingressItems) {
          exposed.push({
            name: ing.metadata.name,
            type: "Ingress",
          });
        }
        for (const rt of routeItems) {
          exposed.push({
            name: rt.metadata.name,
            type: "Route",
          });
        }

        return {
          namespace: ns,
          serviceCount: serviceItems.length,
          hasNetworkPolicies: policyItems.length > 0,
          networkPolicyCount: policyItems.length,
          exposedServices: exposed,
          exposedServiceCount: exposed.length,
        };
      } catch (err) {
        return {
          namespace: ns,
          serviceCount: 0,
          hasNetworkPolicies: false,
          networkPolicyCount: 0,
          exposedServices: [],
          exposedServiceCount: 0,
          error: err.message,
        };
      }
    })
  );

  return summaries;
}

// ---------------------------------------------------------------------------
// getExposedServices()
// ---------------------------------------------------------------------------

/**
 * Find all externally accessible services across the cluster: LoadBalancer
 * and NodePort services, Ingress resources, and OpenShift Routes.
 *
 * @returns {Promise<object[]>} List of exposed services with access details.
 */
export async function getExposedServices() {
  const results = [];

  // Fetch cluster-wide resources in parallel
  const [allServices, allIngresses, allRoutes] = await Promise.all([
    ocpGet("/api/v1/services").catch(() => ({ items: [] })),
    ocpGet("/apis/networking.k8s.io/v1/ingresses").catch(() => ({
      items: [],
    })),
    ocpGet("/apis/route.openshift.io/v1/routes").catch(() => null),
  ]);

  // LoadBalancer and NodePort services
  for (const svc of allServices.items || []) {
    const ns = svc.metadata.namespace;
    if (isSystemNamespace(ns)) continue;

    if (svc.spec.type === "LoadBalancer" || svc.spec.type === "NodePort") {
      const ports = (svc.spec.ports || []).map((p) => ({
        port: p.port,
        nodePort: p.nodePort || null,
        targetPort: p.targetPort || p.port,
        protocol: p.protocol || "TCP",
      }));
      const externalHost =
        svc.spec.type === "LoadBalancer"
          ? (svc.status?.loadBalancer?.ingress || [])
              .map((i) => i.hostname || i.ip || "")
              .join(", ") || "pending"
          : "NodePort";

      results.push({
        name: svc.metadata.name,
        namespace: ns,
        type: svc.spec.type,
        ports,
        host: externalHost,
      });
    }
  }

  // Ingress resources
  for (const ing of allIngresses.items || []) {
    const ns = ing.metadata.namespace;
    if (isSystemNamespace(ns)) continue;

    const hosts = (ing.spec.rules || [])
      .map((r) => r.host || "*")
      .join(", ");
    const backends = (ing.spec.rules || []).flatMap((r) =>
      (r.http?.paths || [])
        .filter((p) => p.backend?.service)
        .map((p) => ({
          service: p.backend.service.name,
          port:
            p.backend.service.port?.number ||
            p.backend.service.port?.name ||
            "",
          path: p.path || "/",
        }))
    );

    results.push({
      name: ing.metadata.name,
      namespace: ns,
      type: "Ingress",
      ports: ing.spec.tls?.length
        ? [{ port: 443, protocol: "HTTPS" }]
        : [{ port: 80, protocol: "HTTP" }],
      host: hosts,
      backends,
      ingressClassName: ing.spec.ingressClassName || "",
    });
  }

  // OpenShift Routes
  if (allRoutes?.items) {
    for (const rt of allRoutes.items) {
      const ns = rt.metadata.namespace;
      if (isSystemNamespace(ns)) continue;

      results.push({
        name: rt.metadata.name,
        namespace: ns,
        type: "Route",
        ports: [
          {
            port: rt.spec.tls ? 443 : 80,
            protocol: rt.spec.tls ? "HTTPS" : "HTTP",
          },
        ],
        host: rt.spec.host || "",
        targetService: rt.spec.to?.name || "",
        tlsTermination: rt.spec.tls?.termination || "none",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// getUnprotectedNamespaces()
// ---------------------------------------------------------------------------

/**
 * Find namespaces that have workloads (pods) but no NetworkPolicies defined.
 * These namespaces are potentially open to unrestricted pod-to-pod traffic.
 *
 * @returns {Promise<object[]>} List of unprotected namespaces with workload counts.
 */
export async function getUnprotectedNamespaces() {
  let allNamespaces;
  try {
    allNamespaces = await ocpGet("/api/v1/namespaces");
  } catch (err) {
    return [{ error: `Failed to list namespaces: ${err.message}` }];
  }

  const userNamespaces = (allNamespaces.items || []).filter(
    (ns) => !isSystemNamespace(ns.metadata.name)
  );

  const results = await Promise.all(
    userNamespaces.map(async (nsObj) => {
      const ns = nsObj.metadata.name;
      try {
        const [pods, policies] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${ns}/pods`).catch(() => ({
            items: [],
          })),
          ocpGet(
            `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies`
          ).catch(() => ({ items: [] })),
        ]);

        const podItems = pods.items || [];
        const policyItems = policies.items || [];

        // Only include namespaces that have running workloads but no policies
        const runningPods = podItems.filter(
          (p) => p.status?.phase === "Running"
        );

        if (runningPods.length > 0 && policyItems.length === 0) {
          return {
            namespace: ns,
            workloadCount: runningPods.length,
            hasNetworkPolicies: false,
          };
        }
        return null;
      } catch (err) {
        // On error, still flag it as potentially unprotected
        return {
          namespace: ns,
          workloadCount: -1,
          hasNetworkPolicies: false,
          error: err.message,
        };
      }
    })
  );

  return results.filter((r) => r !== null);
}
