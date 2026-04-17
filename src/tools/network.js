/**
 * Network diagnostics toolset — DNS, endpoints, routes, ingresses,
 * network policies, CoreDNS config, and service health checks.
 */

import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

export function registerNetworkTools(server) {
  server.tool(
    "net_check_endpoints",
    "Check service endpoints and endpoint slices",
    { serviceName: z.string(), namespace: z.string() },
    async ({ serviceName, namespace }) => {
      try {
        const [ep, slices] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/endpoints/${serviceName}`).catch(() => null),
          ocpGet(`/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices?labelSelector=kubernetes.io/service-name=${serviceName}`).catch(() => null),
        ]);
        const lines = [`### Endpoints for service \`${serviceName}\` in \`${namespace}\``];
        if (ep) {
          const addrs = (ep.subsets || []).flatMap(s =>
            (s.addresses || []).map(a => ({
              ip: a.ip,
              nodeName: a.nodeName || "-",
              targetRef: a.targetRef ? `${a.targetRef.kind}/${a.targetRef.name}` : "-",
              ports: (s.ports || []).map(p => `${p.port}/${p.protocol}`).join(", "),
            }))
          );
          if (addrs.length === 0) {
            lines.push("\n**[WARNING] No ready endpoints found.** The service has no backing pods or all pods are unhealthy.");
            lines.push("\n**Troubleshooting:**");
            lines.push("- Check that pods matching the service selector are running");
            lines.push("- Verify readiness probes are passing");
            lines.push(`- Run: \`oc get pods -l <selector> -n ${namespace}\``);
          } else {
            lines.push(`\n| IP | Node | Target | Ports |`);
            lines.push(`|---|---|---|---|`);
            for (const a of addrs) {
              lines.push(`| ${a.ip} | ${a.nodeName} | ${a.targetRef} | ${a.ports} |`);
            }
          }
        }
        if (slices?.items?.length) {
          lines.push(`\n**EndpointSlices:** ${slices.items.length}`);
          for (const s of slices.items) {
            const ready = (s.endpoints || []).filter(e => e.conditions?.ready !== false).length;
            const total = (s.endpoints || []).length;
            lines.push(`- \`${s.metadata.name}\` — ${ready}/${total} ready`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error checking endpoints: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "net_get_routes",
    "List OpenShift routes",
    {
      namespace: z.string().optional(),
      allNamespaces: z.boolean().optional(),
    },
    async ({ namespace, allNamespaces }) => {
      try {
        const path = allNamespaces || !namespace
          ? "/apis/route.openshift.io/v1/routes"
          : `/apis/route.openshift.io/v1/namespaces/${namespace}/routes`;
        const data = await ocpGet(path);
        const routes = (data.items || []).map(r => ({
          name: r.metadata.name,
          namespace: r.metadata.namespace,
          host: r.spec.host,
          path: r.spec.path || "/",
          service: r.spec.to?.name || "-",
          tls: r.spec.tls ? r.spec.tls.termination : "none",
          admitted: (r.status?.ingress || []).some(i =>
            (i.conditions || []).some(c => c.type === "Admitted" && c.status === "True")
          ),
        }));
        if (routes.length === 0) {
          return { content: [{ type: "text", text: "No routes found." }] };
        }
        const lines = ["### OpenShift Routes", "", "| Name | Namespace | Host | Service | TLS | Admitted |", "|---|---|---|---|---|---|"];
        for (const r of routes) {
          const icon = r.admitted ? "[OK]" : "[WARN]";
          lines.push(`| ${r.name} | ${r.namespace} | ${r.host}${r.path} | ${r.service} | ${r.tls} | ${icon} |`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing routes: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "net_get_ingresses",
    "List Kubernetes ingresses",
    { namespace: z.string().optional() },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`
          : "/apis/networking.k8s.io/v1/ingresses";
        const data = await ocpGet(path);
        const items = (data.items || []).map(i => ({
          name: i.metadata.name,
          namespace: i.metadata.namespace,
          hosts: (i.spec.rules || []).map(r => r.host || "*").join(", "),
          paths: (i.spec.rules || []).flatMap(r => (r.http?.paths || []).map(p => p.path)).join(", "),
          className: i.spec.ingressClassName || "-",
        }));
        if (items.length === 0) return { content: [{ type: "text", text: "No ingresses found." }] };
        const lines = ["### Ingresses", "", "| Name | Namespace | Hosts | Paths | Class |", "|---|---|---|---|---|"];
        for (const i of items) lines.push(`| ${i.name} | ${i.namespace} | ${i.hosts} | ${i.paths} | ${i.className} |`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing ingresses: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "net_get_networkpolicies",
    "List network policies in a namespace",
    { namespace: z.string() },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`);
        const items = (data.items || []).map(np => ({
          name: np.metadata.name,
          podSelector: JSON.stringify(np.spec.podSelector || {}),
          ingress: (np.spec.ingress || []).length,
          egress: (np.spec.egress || []).length,
          policyTypes: (np.spec.policyTypes || []).join(", "),
        }));
        if (items.length === 0) return { content: [{ type: "text", text: `No network policies in \`${namespace}\`.` }] };
        const lines = [`### Network Policies in \`${namespace}\``, "", "| Name | Pod Selector | Ingress Rules | Egress Rules | Types |", "|---|---|---|---|---|"];
        for (const i of items) lines.push(`| ${i.name} | \`${i.podSelector}\` | ${i.ingress} | ${i.egress} | ${i.policyTypes} |`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "net_get_coredns_config",
    "Get CoreDNS / DNS operator configuration",
    {},
    async () => {
      try {
        let config = null;
        try {
          config = await ocpGet("/api/v1/namespaces/openshift-dns/configmaps/dns-default");
        } catch {
          config = await ocpGet("/api/v1/namespaces/kube-system/configmaps/coredns");
        }
        const corefile = config?.data?.Corefile || config?.data?.corefile || JSON.stringify(config?.data || {}, null, 2);
        return { content: [{ type: "text", text: `### CoreDNS Configuration\n\n\`\`\`\n${corefile}\n\`\`\`` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `DNS config unavailable: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "net_check_service",
    "Check if a service is healthy (service + endpoints + pods)",
    { serviceName: z.string(), namespace: z.string() },
    async ({ serviceName, namespace }) => {
      try {
        const lines = [`### Service health: \`${serviceName}\` in \`${namespace}\``];
        const svc = await ocpGet(`/api/v1/namespaces/${namespace}/services/${serviceName}`).catch(() => null);
        if (!svc) {
          lines.push("\n**[CRITICAL] Service not found.**");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        lines.push(`\n**Type:** ${svc.spec.type} | **ClusterIP:** ${svc.spec.clusterIP}`);
        lines.push(`**Ports:** ${(svc.spec.ports || []).map(p => `${p.port}/${p.protocol}→${p.targetPort}`).join(", ")}`);
        const selector = svc.spec.selector || {};
        const selectorStr = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
        lines.push(`**Selector:** \`${selectorStr || "(none)"}\``);

        if (selectorStr) {
          const pods = await ocpGet(`/api/v1/namespaces/${namespace}/pods?labelSelector=${selectorStr}`).catch(() => ({ items: [] }));
          const podList = pods.items || [];
          const running = podList.filter(p => p.status?.phase === "Running").length;
          const icon = running === podList.length && running > 0 ? "[OK]" : running > 0 ? "[WARNING]" : "[CRITICAL]";
          lines.push(`\n**Backing pods:** ${icon} ${running}/${podList.length} running`);
          for (const p of podList.slice(0, 10)) {
            const ready = (p.status?.containerStatuses || []).every(c => c.ready) ? "Ready" : "NotReady";
            lines.push(`  - \`${p.metadata.name}\` — ${p.status?.phase} (${ready})`);
          }
        }

        const ep = await ocpGet(`/api/v1/namespaces/${namespace}/endpoints/${serviceName}`).catch(() => null);
        const addrCount = (ep?.subsets || []).reduce((n, s) => n + (s.addresses || []).length, 0);
        const notReady = (ep?.subsets || []).reduce((n, s) => n + (s.notReadyAddresses || []).length, 0);
        lines.push(`\n**Endpoints:** ${addrCount} ready, ${notReady} not ready`);
        if (addrCount === 0) {
          lines.push("\n**[CRITICAL] No ready endpoints — traffic to this service will fail.**");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "net_get_route_detail",
    "Get detailed info about a specific OpenShift route",
    { name: z.string(), namespace: z.string() },
    async ({ name, namespace }) => {
      try {
        const r = await ocpGet(`/apis/route.openshift.io/v1/namespaces/${namespace}/routes/${name}`);
        const admitted = (r.status?.ingress || []).some(i =>
          (i.conditions || []).some(c => c.type === "Admitted" && c.status === "True")
        );
        const lines = [
          `### Route \`${name}\` in \`${namespace}\``,
          `\n**Host:** ${r.spec.host}`,
          `**Path:** ${r.spec.path || "/"}`,
          `**Service:** ${r.spec.to?.name} (weight: ${r.spec.to?.weight ?? 100})`,
          `**TLS:** ${r.spec.tls ? `${r.spec.tls.termination} (insecure: ${r.spec.tls.insecureEdgeTerminationPolicy || "None"})` : "none"}`,
          `**Admitted:** ${admitted ? "[OK] Yes" : "[WARNING] No"}`,
        ];
        if (r.spec.alternateBackends?.length) {
          lines.push(`\n**Alternate backends:**`);
          for (const b of r.spec.alternateBackends) lines.push(`  - ${b.name} (weight: ${b.weight})`);
        }
        for (const ing of r.status?.ingress || []) {
          lines.push(`\n**Router:** ${ing.routerName} — host: ${ing.host}`);
          for (const c of ing.conditions || []) {
            lines.push(`  - ${c.type}: ${c.status} (${c.reason || ""})`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );
}
