/**
 * Admission parity — the gap between "passed our gate" and "the cluster took it".
 *
 * These are the cases that produced real support calls: a namespace enforcing
 * restricted, a hardcoded UID outside the namespace's SCC range, a
 * ResourceQuota that rejects a container with no limits, and a LimitRange
 * maximum. Plus the one that matters most: a namespace nobody could read must
 * come back UNKNOWN, never as a pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAdmissionParity } from "../../src/services/admission-parity.js";

const hardened = (over = {}) => ({
  apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: "shop" },
  spec: { template: { spec: {
    serviceAccountName: "web-sa",
    securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
    containers: [{
      name: "web", image: "registry.redhat.io/ubi9/nginx@sha256:a", ports: [{ containerPort: 8080 }],
      resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "200m", memory: "256Mi" } },
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      ...over,
    }],
  } } },
});

/**
 * A fake cluster: a map of path SUFFIX → value, or → Error to throw.
 * Matched on the end of the path, not anywhere in it: "/namespaces/shop" is a
 * prefix of "/namespaces/shop/resourcequotas", so a substring match would
 * answer the quota read with the namespace object — which is exactly the bug
 * that made this test lie the first time it was written.
 */
function reader(map) {
  return async (path) => {
    for (const [k, v] of Object.entries(map)) {
      if (path.endsWith(k)) {
        if (v instanceof Error) throw v;
        return v;
      }
    }
    throw new Error("OCP API 404 Not Found");
  };
}
const nsWith = (labels = {}, annotations = {}) => ({ metadata: { name: "shop", labels, annotations } });

test("a hardened set is admitted to a namespace enforcing restricted", async () => {
  const out = await checkAdmissionParity([hardened()], {
    namespace: "shop",
    read: reader({
      "/namespaces/shop": nsWith({ "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "v1.31" }),
      "resourcequotas": { items: [] },
      "limitranges": { items: [] },
    }),
  });
  assert.equal(out.namespaceState, "exists");
  assert.equal(out.psa.enforce, "restricted");
  assert.equal(out.verdict.status, "will-be-admitted");
  assert.equal(out.verdict.critical, 0);
});

test("a root container is reported as rejected by restricted, with the reason", async () => {
  const bad = hardened();
  bad.spec.template.spec.securityContext = {};
  const out = await checkAdmissionParity([bad], {
    namespace: "shop",
    read: reader({ "/namespaces/shop": nsWith({ "pod-security.kubernetes.io/enforce": "restricted" }), "resourcequotas": { items: [] }, "limitranges": { items: [] } }),
  });
  assert.equal(out.verdict.status, "will-be-rejected");
  const f = out.findings.find((x) => x.control === "psa-enforce");
  assert.match(f.title, /REJECTED/);
  assert.match(f.detail, /not runAsNonRoot/);
});

test("a UID outside the namespace's SCC range is flagged against the real range", async () => {
  const out = await checkAdmissionParity([hardened({ securityContext: { runAsUser: 1001, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } } })], {
    namespace: "shop",
    read: reader({
      "/namespaces/shop": nsWith({ "pod-security.kubernetes.io/enforce": "restricted" }, { "openshift.io/sa.scc.uid-range": "1000680000/10000" }),
      "resourcequotas": { items: [] }, "limitranges": { items: [] },
    }),
  });
  const f = out.findings.find((x) => x.control === "scc-uid-range");
  assert.ok(f, "expected a uid-range finding");
  assert.equal(f.severity, "critical");
  assert.match(f.detail, /1000680000–1000689999/);
  assert.equal(out.uidRange.min, 1000680000);
  assert.equal(out.uidRange.max, 1000689999);
});

test("a ResourceQuota rejects a container with no limits, and says so", async () => {
  const noLimits = hardened();
  delete noLimits.spec.template.spec.containers[0].resources;
  const out = await checkAdmissionParity([noLimits], {
    namespace: "shop",
    read: reader({
      "/namespaces/shop": nsWith({ "pod-security.kubernetes.io/enforce": "baseline" }),
      "resourcequotas": { items: [{ metadata: { name: "compute" }, status: { hard: { "limits.cpu": "4", "limits.memory": "8Gi" }, used: { "limits.cpu": "1", "limits.memory": "2Gi" } } }] },
      "limitranges": { items: [] },
    }),
  });
  const f = out.findings.find((x) => x.control === "resourcequota");
  assert.ok(f, "expected a quota finding");
  assert.match(f.title, /no limits\.cpu \/ limits\.memory/);
  assert.equal(out.verdict.status, "will-be-rejected");
});

test("a deploy that does not fit the quota's headroom is caught before it half-applies", async () => {
  const big = hardened();
  big.spec.template.spec.containers[0].resources.limits = { cpu: "4", memory: "8Gi" };
  const out = await checkAdmissionParity([big], {
    namespace: "shop",
    read: reader({
      "/namespaces/shop": nsWith({ "pod-security.kubernetes.io/enforce": "restricted" }),
      "resourcequotas": { items: [{ metadata: { name: "compute" }, status: { hard: { "limits.cpu": "4", "limits.memory": "8Gi" }, used: { "limits.cpu": "3500m", "limits.memory": "7Gi" } } }] },
      "limitranges": { items: [] },
    }),
  });
  const cpu = out.findings.find((x) => /CPU left/.test(x.title));
  assert.ok(cpu, "expected a CPU headroom finding");
  assert.match(cpu.detail, /PARTIAL deploy/);
});

test("a LimitRange maximum is compared against the container's limit", async () => {
  const big = hardened();
  big.spec.template.spec.containers[0].resources.limits = { cpu: "2", memory: "4Gi" };
  const out = await checkAdmissionParity([big], {
    namespace: "shop",
    read: reader({
      "/namespaces/shop": nsWith({ "pod-security.kubernetes.io/enforce": "restricted" }),
      "resourcequotas": { items: [] },
      "limitranges": { items: [{ metadata: { name: "caps" }, spec: { limits: [{ type: "Container", max: { cpu: "1", memory: "1Gi" } }] } }] },
    }),
  });
  assert.ok(out.findings.some((f) => f.control === "limitrange" && /maximum CPU/.test(f.title)));
  assert.ok(out.findings.some((f) => f.control === "limitrange" && /maximum memory/.test(f.title)));
});

test("an unreadable namespace is UNKNOWN, never a pass", async () => {
  const forbidden = new Error("OCP API 403 Forbidden");
  const out = await checkAdmissionParity([hardened()], {
    namespace: "shop",
    read: reader({ "/namespaces/shop": forbidden }),
  });
  assert.equal(out.namespaceState, "unread");
  assert.equal(out.psa.read, false);
  assert.equal(out.verdict.status, "unknown");
  assert.match(out.verdict.summary, /not known to fail/);
  assert.notEqual(out.verdict.status, "will-be-admitted");
});

test("a namespace that does not exist yet is judged on the Namespace manifest in the set", async () => {
  const nsManifest = {
    apiVersion: "v1", kind: "Namespace",
    metadata: { name: "shop", labels: { "pod-security.kubernetes.io/enforce": "restricted" } },
  };
  const out = await checkAdmissionParity([nsManifest, hardened()], { namespace: "shop", read: reader({}) });
  assert.equal(out.namespaceState, "absent");
  assert.equal(out.psa.enforce, "restricted");
  assert.equal(out.psa.source, "the Namespace manifest in this set");
  assert.equal(out.verdict.status, "will-be-admitted");
});

test("a namespace created without pod-security labels is called out", async () => {
  const nsManifest = { apiVersion: "v1", kind: "Namespace", metadata: { name: "shop" } };
  const out = await checkAdmissionParity([nsManifest, hardened()], { namespace: "shop", read: reader({}) });
  const f = out.findings.find((x) => x.control === "psa-enforce");
  assert.match(f.title, /enforces no Pod Security level/);
  assert.match(f.fix, /oc label namespace shop/);
});
