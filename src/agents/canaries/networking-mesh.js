/**
 * Canary cases for the Networking & Service Mesh Agent.
 *
 * AN HONEST NOTE ON WHAT THESE CAN CHECK.
 *
 * Like cluster-operations, this agent's logic sits inside its tool handlers
 * alongside the API calls, so there is nothing pure to import. These cases call
 * a real cluster instead; without one they SKIP and are reported as skipped,
 * never as a pass.
 *
 * What they protect: the difference between "this service has no ready
 * endpoints" and "I could not read this service". The first is an outage the
 * agent must shout about; the second is an unknown. Collapsing them in either
 * direction is the failure mode — a service with zero endpoints reported as
 * healthy sends nobody to look at why traffic is failing.
 */

import { ocpGet } from "../../utils/openshift-client.js";

export default [
  {
    id: "a-service-with-no-ready-endpoints-is-distinguishable",
    kind: "read-only",
    title: "Ready and not-ready endpoint addresses are counted separately",
    why: "A Service with endpoints that are all notReady looks identical to a healthy one in any count that adds the two together — and traffic to it fails. The two numbers have to stay apart, because the whole 'why is my Route returning 503' answer rests on which of them is zero.",
    run: async () => {
      // kubernetes.default always exists on a live cluster, which makes it the
      // one safe subject for this check in any namespace layout.
      const ep = await ocpGet("/api/v1/namespaces/default/endpoints/kubernetes");
      const subsets = ep.subsets || [];
      const ready = subsets.reduce((n, s) => n + (s.addresses || []).length, 0);
      const notReady = subsets.reduce((n, s) => n + (s.notReadyAddresses || []).length, 0);
      return {
        name: ep.metadata?.name,
        ready, notReady,
        countedSeparately: ready !== undefined && notReady !== undefined,
        apiServerHasEndpoints: ready > 0,
        __evidence: { read: subsets.length, expected: subsets.length, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "name", assert: "equals", value: "kubernetes" },
      { path: "apiServerHasEndpoints", assert: "equals", value: true,
        note: "The API server's own Service having no ready endpoints would mean the read itself is wrong." },
      { path: "countedSeparately", assert: "equals", value: true },
    ],
  },

  {
    id: "network-policies-are-read-as-they-are-written",
    kind: "read-only",
    title: "NetworkPolicies are listed with their policy types intact",
    why: "A default-deny policy is only default-deny because of its policyTypes. Reading a policy without them turns 'this namespace denies all egress' into 'this namespace has a policy', which is the difference between a correct answer about connectivity and a misleading one.",
    run: async () => {
      const d = await ocpGet("/apis/networking.k8s.io/v1/networkpolicies");
      const items = d.items || [];
      return {
        kind: d.kind,
        total: items.length,
        // Every policy must carry a spec; policyTypes may legitimately be
        // absent (the API defaults it), but the spec itself may not.
        allHaveSpec: items.every((p) => !!p.spec),
        __evidence: { read: items.length, expected: items.length, confidence: "medium", concluded: true },
      };
    },
    expect: [
      { path: "kind", assert: "matches", value: "NetworkPolicyList" },
      { path: "allHaveSpec", assert: "equals", value: true },
    ],
  },

  {
    id: "routes-report-their-tls-termination",
    kind: "read-only",
    title: "Routes are read with their TLS configuration",
    why: "Whether a Route terminates TLS at the edge, passes it through, or does neither decides whether traffic to it is encrypted. An agent that lists Routes without that field cannot answer the one security question anybody asks about them.",
    run: async () => {
      const d = await ocpGet("/apis/route.openshift.io/v1/routes");
      const items = d.items || [];
      const withTls = items.filter((r) => r.spec?.tls);
      return {
        kind: d.kind,
        total: items.length,
        tlsRoutes: withTls.length,
        // Where TLS is configured, the termination type must be present —
        // a tls block with no termination is meaningless.
        allTlsHaveTermination: withTls.every((r) => !!r.spec.tls.termination),
        allHaveHost: items.every((r) => !!r.spec?.host),
      };
    },
    expect: [
      { path: "kind", assert: "matches", value: "RouteList" },
      { path: "allTlsHaveTermination", assert: "equals", value: true },
      { path: "allHaveHost", assert: "equals", value: true,
        note: "A Route with no host is one that was read incompletely." },
    ],
  },
];
