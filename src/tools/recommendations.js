import { z } from "zod";
import { ocpGet } from "../utils/openshift-client.js";

// Parse Kubernetes resource quantities (e.g. "100m" → 0.1, "256Mi" → 268435456)
function parseCpu(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  const str = String(s);
  if (str.endsWith("m")) return parseFloat(str) / 1000;
  if (str.endsWith("n")) return parseFloat(str) / 1e9;
  if (str.endsWith("u")) return parseFloat(str) / 1e6;
  return parseFloat(str) || 0;
}

function parseMem(s) {
  if (!s) return 0;
  if (typeof s === "number") return s;
  const str = String(s);
  const units = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1e6, G: 1e9, T: 1e12 };
  for (const [u, mult] of Object.entries(units)) {
    if (str.endsWith(u)) return parseFloat(str) * mult;
  }
  return parseFloat(str) || 0;
}

function fmtMem(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}Gi`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)}Mi`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)}Ki`;
  return `${bytes}B`;
}

export function registerRecommendationTools(server) {
  // ---------- Resource Rightsizing ----------
  server.tool(
    "recommend_resource_rightsizing",
    "Compare actual CPU/memory usage vs requests/limits and flag over- or under-provisioned pods",
    {
      namespace: z.string().describe("Namespace to analyze"),
    },
    async ({ namespace }) => {
      try {
        const [pods, metricsResp] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/pods`),
          ocpGet(`/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`).catch(() => ({ items: [] })),
        ]);

        const metricsByPod = {};
        for (const m of metricsResp.items || []) {
          metricsByPod[m.metadata.name] = m;
        }

        const findings = [];
        let totalSavedCpu = 0, totalSavedMem = 0;

        for (const pod of (pods.items || []).filter(p => p.status?.phase === "Running")) {
          const podMetric = metricsByPod[pod.metadata.name];
          if (!podMetric) continue;

          for (const c of pod.spec?.containers || []) {
            const cm = (podMetric.containers || []).find(x => x.name === c.name);
            if (!cm) continue;

            const reqCpu = parseCpu(c.resources?.requests?.cpu);
            const limCpu = parseCpu(c.resources?.limits?.cpu);
            const reqMem = parseMem(c.resources?.requests?.memory);
            const limMem = parseMem(c.resources?.limits?.memory);
            const usageCpu = parseCpu(cm.usage?.cpu);
            const usageMem = parseMem(cm.usage?.memory);

            const issues = [];
            if (reqCpu > 0 && usageCpu < reqCpu * 0.2) {
              const saved = reqCpu - Math.max(usageCpu * 1.5, 0.05);
              totalSavedCpu += saved;
              issues.push(`OVER-PROVISIONED CPU: using ${(usageCpu * 1000).toFixed(0)}m of ${(reqCpu * 1000).toFixed(0)}m requested (${((usageCpu / reqCpu) * 100).toFixed(0)}%) — recommend ${Math.max(usageCpu * 1.5 * 1000, 50).toFixed(0)}m`);
            }
            if (reqMem > 0 && usageMem < reqMem * 0.2) {
              const saved = reqMem - usageMem * 1.5;
              totalSavedMem += saved;
              issues.push(`OVER-PROVISIONED MEM: using ${fmtMem(usageMem)} of ${fmtMem(reqMem)} requested (${((usageMem / reqMem) * 100).toFixed(0)}%) — recommend ${fmtMem(usageMem * 1.5)}`);
            }
            if (limCpu > 0 && usageCpu > limCpu * 0.8) {
              issues.push(`UNDER-PROVISIONED CPU: using ${(usageCpu * 1000).toFixed(0)}m of ${(limCpu * 1000).toFixed(0)}m limit (${((usageCpu / limCpu) * 100).toFixed(0)}%) — risk of throttling`);
            }
            if (limMem > 0 && usageMem > limMem * 0.8) {
              issues.push(`UNDER-PROVISIONED MEM: using ${fmtMem(usageMem)} of ${fmtMem(limMem)} limit (${((usageMem / limMem) * 100).toFixed(0)}%) — risk of OOMKill`);
            }
            if (issues.length > 0) {
              findings.push({ pod: pod.metadata.name, container: c.name, issues });
            }
          }
        }

        const lines = [`Resource Rightsizing — namespace: ${namespace}`,
          `${findings.length} container(s) need rightsizing\n`];
        if (totalSavedCpu > 0 || totalSavedMem > 0) {
          lines.push(`Potential savings: ${(totalSavedCpu * 1000).toFixed(0)}m CPU, ${fmtMem(totalSavedMem)} memory\n`);
        }
        for (const f of findings.slice(0, 30)) {
          lines.push(`${f.pod} / ${f.container}:`);
          f.issues.forEach(i => lines.push(`  - ${i}`));
        }
        if (findings.length === 0) lines.push("[OK] All containers are appropriately sized.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Rightsizing error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Capacity Planning ----------
  server.tool(
    "recommend_capacity_planning",
    "Analyze cluster capacity, requested vs allocatable resources, and forecast headroom",
    {},
    async () => {
      try {
        const [nodes, pods] = await Promise.all([ocpGet("/api/v1/nodes"), ocpGet("/api/v1/pods")]);

        let totalCpu = 0, totalMem = 0, allocCpu = 0, allocMem = 0;
        let reqCpu = 0, reqMem = 0;
        const nodeStats = [];

        for (const n of nodes.items || []) {
          const cap = n.status?.capacity || {};
          const alloc = n.status?.allocatable || {};
          totalCpu += parseCpu(cap.cpu);
          totalMem += parseMem(cap.memory);
          allocCpu += parseCpu(alloc.cpu);
          allocMem += parseMem(alloc.memory);
          nodeStats.push({
            name: n.metadata.name,
            cpu: parseCpu(alloc.cpu),
            mem: parseMem(alloc.memory),
            usedCpu: 0, usedMem: 0,
          });
        }

        for (const p of pods.items || []) {
          if (p.status?.phase !== "Running" && p.status?.phase !== "Pending") continue;
          for (const c of p.spec?.containers || []) {
            const cpuR = parseCpu(c.resources?.requests?.cpu);
            const memR = parseMem(c.resources?.requests?.memory);
            reqCpu += cpuR;
            reqMem += memR;
            const node = nodeStats.find(n => n.name === p.spec?.nodeName);
            if (node) { node.usedCpu += cpuR; node.usedMem += memR; }
          }
        }

        const cpuPct = allocCpu > 0 ? (reqCpu / allocCpu * 100).toFixed(1) : "0";
        const memPct = allocMem > 0 ? (reqMem / allocMem * 100).toFixed(1) : "0";

        const hotNodes = nodeStats.filter(n => (n.usedCpu / n.cpu > 0.8) || (n.usedMem / n.mem > 0.8));
        const lines = [
          `Cluster Capacity Planning`,
          `\nNodes: ${nodes.items?.length || 0}`,
          `Total CPU:    ${totalCpu.toFixed(1)} cores  (allocatable: ${allocCpu.toFixed(1)})`,
          `Total Memory: ${fmtMem(totalMem)}  (allocatable: ${fmtMem(allocMem)})`,
          `\nRequested CPU:    ${reqCpu.toFixed(1)} cores (${cpuPct}% of allocatable)`,
          `Requested Memory: ${fmtMem(reqMem)} (${memPct}% of allocatable)`,
          `\nHeadroom CPU:    ${(allocCpu - reqCpu).toFixed(1)} cores`,
          `Headroom Memory: ${fmtMem(Math.max(0, allocMem - reqMem))}`,
        ];

        if (hotNodes.length > 0) {
          lines.push(`\n[WARNING] ${hotNodes.length} node(s) over 80% utilization:`);
          hotNodes.slice(0, 10).forEach(n => lines.push(
            `  - ${n.name}: CPU ${(n.usedCpu / n.cpu * 100).toFixed(0)}%, Mem ${(n.usedMem / n.mem * 100).toFixed(0)}%`
          ));
        }

        if (parseFloat(cpuPct) > 80 || parseFloat(memPct) > 80) {
          lines.push(`\n[CRITICAL] Cluster is approaching capacity. Add nodes or reduce requests.`);
        } else if (parseFloat(cpuPct) < 30 && parseFloat(memPct) < 30) {
          lines.push(`\n[INFO] Cluster is over-provisioned. Consider scaling down.`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Capacity planning error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Pod Disruption Budget ----------
  server.tool(
    "recommend_pod_disruption",
    "Analyze PodDisruptionBudget coverage — flag workloads without PDBs and risky PDB configs",
    {
      namespace: z.string().optional().describe("Namespace to analyze (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const pdbPath = namespace ? `/apis/policy/v1/namespaces/${namespace}/poddisruptionbudgets` : "/apis/policy/v1/poddisruptionbudgets";
        const depPath = namespace ? `/apis/apps/v1/namespaces/${namespace}/deployments` : "/apis/apps/v1/deployments";
        const stsPath = namespace ? `/apis/apps/v1/namespaces/${namespace}/statefulsets` : "/apis/apps/v1/statefulsets";

        const [pdbs, deps, sts] = await Promise.all([
          ocpGet(pdbPath).catch(() => ({ items: [] })),
          ocpGet(depPath),
          ocpGet(stsPath),
        ]);

        const workloads = [
          ...(deps.items || []).map(d => ({ kind: "Deployment", ...d })),
          ...(sts.items || []).map(s => ({ kind: "StatefulSet", ...s })),
        ];

        const noPdb = [];
        const riskyPdbs = [];

        for (const w of workloads) {
          const replicas = w.spec?.replicas ?? 0;
          if (replicas < 2) continue;
          const labels = w.spec?.selector?.matchLabels || {};
          const matchedPdb = (pdbs.items || []).find(p => {
            if (p.metadata.namespace !== w.metadata.namespace) return false;
            const sel = p.spec?.selector?.matchLabels || {};
            return Object.entries(sel).every(([k, v]) => labels[k] === v);
          });
          if (!matchedPdb) {
            noPdb.push({ kind: w.kind, name: w.metadata.name, namespace: w.metadata.namespace, replicas });
          }
        }

        for (const p of pdbs.items || []) {
          const minAvail = p.spec?.minAvailable;
          const maxUnavail = p.spec?.maxUnavailable;
          if (minAvail === 1 || minAvail === "1") {
            riskyPdbs.push({
              name: p.metadata.name,
              namespace: p.metadata.namespace,
              issue: `minAvailable=1 — blocks node drain if only 1 replica`,
            });
          }
          if (maxUnavail === 0 || maxUnavail === "0") {
            riskyPdbs.push({
              name: p.metadata.name,
              namespace: p.metadata.namespace,
              issue: `maxUnavailable=0 — blocks all voluntary disruptions`,
            });
          }
        }

        const lines = [`PodDisruptionBudget Audit${namespace ? ` (${namespace})` : ""}`,
          `${pdbs.items?.length || 0} PDBs, ${workloads.length} multi-replica workloads\n`];

        if (noPdb.length > 0) {
          lines.push(`[WARNING] ${noPdb.length} multi-replica workload(s) without PDB:`);
          noPdb.slice(0, 25).forEach(w => lines.push(`  - ${w.kind}/${w.name} (${w.namespace}) — ${w.replicas} replicas`));
          lines.push("");
        }
        if (riskyPdbs.length > 0) {
          lines.push(`[WARNING] ${riskyPdbs.length} PDB(s) with risky configuration:`);
          riskyPdbs.slice(0, 20).forEach(p => lines.push(`  - ${p.namespace}/${p.name}: ${p.issue}`));
        }
        if (noPdb.length === 0 && riskyPdbs.length === 0) {
          lines.push("[OK] All multi-replica workloads have safe PDB coverage.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `PDB analysis error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Health Trends ----------
  server.tool(
    "recommend_health_trends",
    "Identify pods with high restart counts, group failures by type, rank top problem workloads",
    {
      namespace: z.string().optional().describe("Namespace to analyze (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";
        const data = await ocpGet(path);
        const pods = data.items || [];

        const failureTypes = {};
        const restartLeaders = [];
        const ownerStats = {};

        for (const p of pods) {
          let restarts = 0;
          for (const c of p.status?.containerStatuses || []) {
            restarts += c.restartCount || 0;
            const reason = c.state?.waiting?.reason || c.state?.terminated?.reason || c.lastState?.terminated?.reason;
            if (reason && reason !== "Completed") {
              failureTypes[reason] = (failureTypes[reason] || 0) + 1;
            }
          }
          if (restarts >= 3) {
            restartLeaders.push({ pod: p.metadata.name, namespace: p.metadata.namespace, restarts });
          }
          const owner = p.metadata?.ownerReferences?.[0];
          if (owner && restarts > 0) {
            const key = `${owner.kind}/${owner.name} (${p.metadata.namespace})`;
            ownerStats[key] = (ownerStats[key] || 0) + restarts;
          }
        }

        restartLeaders.sort((a, b) => b.restarts - a.restarts);
        const topOwners = Object.entries(ownerStats).sort((a, b) => b[1] - a[1]).slice(0, 10);

        const lines = [`Health Trends${namespace ? ` (${namespace})` : ""}`,
          `${pods.length} pod(s) scanned\n`];

        if (Object.keys(failureTypes).length > 0) {
          lines.push("Failure breakdown:");
          Object.entries(failureTypes).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
            lines.push(`  - ${k}: ${v}`));
          lines.push("");
        }
        if (restartLeaders.length > 0) {
          lines.push(`Top restart offenders (≥3 restarts):`);
          restartLeaders.slice(0, 15).forEach(r =>
            lines.push(`  - ${r.pod} (${r.namespace}): ${r.restarts} restarts`));
          lines.push("");
        }
        if (topOwners.length > 0) {
          lines.push("Top problem workloads (by total restarts):");
          topOwners.forEach(([owner, count]) => lines.push(`  - ${owner}: ${count} restarts`));
        }
        if (restartLeaders.length === 0 && Object.keys(failureTypes).length === 0) {
          lines.push("[OK] No restart trends or failure patterns detected.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Health trends error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Topology Spread ----------
  server.tool(
    "recommend_topology_spread",
    "Analyze workload distribution across nodes, identify single-points-of-failure",
    {
      namespace: z.string().optional().describe("Namespace to analyze (omit for all)"),
    },
    async ({ namespace }) => {
      try {
        const path = namespace ? `/api/v1/namespaces/${namespace}/pods` : "/api/v1/pods";
        const pods = (await ocpGet(path)).items || [];

        const groups = {};
        for (const p of pods.filter(p => p.status?.phase === "Running")) {
          const owner = p.metadata?.ownerReferences?.[0];
          if (!owner) continue;
          const key = `${owner.kind}/${owner.name} (${p.metadata.namespace})`;
          if (!groups[key]) groups[key] = { nodes: {}, total: 0 };
          const node = p.spec?.nodeName || "unscheduled";
          groups[key].nodes[node] = (groups[key].nodes[node] || 0) + 1;
          groups[key].total++;
        }

        const spofs = [];
        const hotNodes = [];

        for (const [name, g] of Object.entries(groups)) {
          if (g.total < 2) continue;
          const nodeCount = Object.keys(g.nodes).length;
          if (nodeCount === 1) {
            spofs.push({ workload: name, replicas: g.total, node: Object.keys(g.nodes)[0] });
          }
          for (const [node, count] of Object.entries(g.nodes)) {
            if (count > g.total * 0.5 && g.total >= 4) {
              hotNodes.push({ workload: name, node, count, total: g.total });
            }
          }
        }

        const lines = [`Topology Spread Analysis${namespace ? ` (${namespace})` : ""}`,
          `${Object.keys(groups).length} workload(s) analyzed\n`];

        if (spofs.length > 0) {
          lines.push(`[CRITICAL] ${spofs.length} workload(s) with all replicas on single node:`);
          spofs.slice(0, 20).forEach(s => lines.push(`  - ${s.workload}: ${s.replicas} replicas all on node '${s.node}'`));
          lines.push("");
        }
        if (hotNodes.length > 0) {
          lines.push(`[WARNING] ${hotNodes.length} workload(s) with >50% replicas on one node:`);
          hotNodes.slice(0, 20).forEach(h => lines.push(`  - ${h.workload}: ${h.count}/${h.total} on '${h.node}'`));
          lines.push("");
        }
        if (spofs.length > 0 || hotNodes.length > 0) {
          lines.push(`Recommend adding topologySpreadConstraints or podAntiAffinity to spec.template.spec.`);
        } else {
          lines.push("[OK] Workloads are well-distributed across nodes.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Topology error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Quota Optimization ----------
  server.tool(
    "recommend_quota_optimization",
    "Analyze ResourceQuota and LimitRange usage, recommend optimal values",
    {
      namespace: z.string().describe("Namespace to analyze"),
    },
    async ({ namespace }) => {
      try {
        const [quotas, ranges] = await Promise.all([
          ocpGet(`/api/v1/namespaces/${namespace}/resourcequotas`).catch(() => ({ items: [] })),
          ocpGet(`/api/v1/namespaces/${namespace}/limitranges`).catch(() => ({ items: [] })),
        ]);

        const lines = [`Quota Optimization — namespace: ${namespace}\n`];

        if ((quotas.items || []).length === 0) {
          lines.push(`[WARNING] No ResourceQuota in namespace. Recommend creating one to prevent runaway resource use.`);
        } else {
          for (const q of quotas.items) {
            lines.push(`ResourceQuota: ${q.metadata.name}`);
            const hard = q.status?.hard || {};
            const used = q.status?.used || {};
            for (const [k, hv] of Object.entries(hard)) {
              const uv = used[k];
              if (!uv) continue;
              const usedNum = k.includes("memory") || k.includes("storage")
                ? parseMem(uv) : parseCpu(uv);
              const hardNum = k.includes("memory") || k.includes("storage")
                ? parseMem(hv) : parseCpu(hv);
              const pct = hardNum > 0 ? (usedNum / hardNum * 100).toFixed(0) : "0";
              const label = parseFloat(pct) > 80 ? "[WARNING] near exhaustion" :
                            parseFloat(pct) < 20 ? "[INFO] over-provisioned" : "[OK]";
              lines.push(`  ${k}: ${uv} / ${hv} (${pct}%) ${label}`);
            }
            lines.push("");
          }
        }

        if ((ranges.items || []).length === 0) {
          lines.push(`[INFO] No LimitRange in namespace. Recommend setting default container limits.`);
        } else {
          for (const r of ranges.items) {
            lines.push(`LimitRange: ${r.metadata.name}`);
            for (const limit of r.spec?.limits || []) {
              lines.push(`  Type: ${limit.type}`);
              if (limit.default) lines.push(`    Default: ${JSON.stringify(limit.default)}`);
              if (limit.defaultRequest) lines.push(`    DefaultRequest: ${JSON.stringify(limit.defaultRequest)}`);
              if (limit.max) lines.push(`    Max: ${JSON.stringify(limit.max)}`);
              if (limit.min) lines.push(`    Min: ${JSON.stringify(limit.min)}`);
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Quota optimization error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- Cluster Summary ----------
  server.tool(
    "recommend_cluster_summary",
    "Overall cluster optimization summary with health score and top recommendations",
    {},
    async () => {
      try {
        const [nodes, pods, ops, pvcs] = await Promise.all([
          ocpGet("/api/v1/nodes"),
          ocpGet("/api/v1/pods"),
          ocpGet("/apis/config.openshift.io/v1/clusteroperators").catch(() => ({ items: [] })),
          ocpGet("/api/v1/persistentvolumeclaims").catch(() => ({ items: [] })),
        ]);

        const allNodes = nodes.items || [];
        const allPods = pods.items || [];
        const allOps = ops.items || [];
        const allPvcs = pvcs.items || [];

        const notReady = allNodes.filter(n => !(n.status?.conditions || []).some(c => c.type === "Ready" && c.status === "True"));
        const degraded = allOps.filter(o => (o.status?.conditions || []).some(c => c.type === "Degraded" && c.status === "True"));
        const problemPods = allPods.filter(p => {
          if (p.status?.phase === "Succeeded" || p.status?.phase === "Running") {
            return (p.status?.containerStatuses || []).some(c => {
              const r = c.state?.waiting?.reason;
              return r === "CrashLoopBackOff" || r === "ImagePullBackOff" || r === "ErrImagePull";
            });
          }
          return p.status?.phase === "Failed" || p.status?.phase === "Pending";
        });
        const orphanedPvcs = allPvcs.filter(p => p.status?.phase === "Lost" || p.status?.phase === "Pending");
        const totalRestarts = allPods.reduce((s, p) =>
          s + (p.status?.containerStatuses || []).reduce((s2, c) => s2 + (c.restartCount || 0), 0), 0);

        let score = 100;
        if (notReady.length > 0) score -= notReady.length * 10;
        if (degraded.length > 0) score -= degraded.length * 5;
        if (problemPods.length > 0) score -= Math.min(20, problemPods.length);
        if (orphanedPvcs.length > 0) score -= Math.min(10, orphanedPvcs.length * 2);
        score = Math.max(0, score);
        const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

        const recs = [];
        if (notReady.length > 0) recs.push({ pri: 1, txt: `Investigate ${notReady.length} NotReady node(s): ${notReady.slice(0, 3).map(n => n.metadata.name).join(", ")}` });
        if (degraded.length > 0) recs.push({ pri: 1, txt: `Fix ${degraded.length} degraded operator(s): ${degraded.slice(0, 3).map(o => o.metadata.name).join(", ")}` });
        if (problemPods.length > 0) recs.push({ pri: 2, txt: `Address ${problemPods.length} problem pod(s) — run security_pod_security_audit for details` });
        if (orphanedPvcs.length > 0) recs.push({ pri: 3, txt: `Resolve ${orphanedPvcs.length} unbound PVC(s)` });
        if (totalRestarts > allPods.length * 2) recs.push({ pri: 3, txt: `Cluster has ${totalRestarts} total restarts — investigate flapping workloads with recommend_health_trends` });
        if (recs.length === 0) recs.push({ pri: 0, txt: "Cluster is healthy. Consider running recommend_resource_rightsizing for cost optimization." });

        const lines = [
          `Cluster Optimization Summary`,
          `\n  Score: ${score}/100  Grade: ${grade}\n`,
          `Nodes:    ${allNodes.length} total, ${notReady.length} not ready`,
          `Operators: ${allOps.length} total, ${degraded.length} degraded`,
          `Pods:     ${allPods.length} total, ${problemPods.length} problem`,
          `PVCs:     ${allPvcs.length} total, ${orphanedPvcs.length} unbound`,
          `Restarts: ${totalRestarts} total\n`,
          `Top recommendations:`,
        ];
        recs.sort((a, b) => a.pri - b.pri).forEach((r, i) => lines.push(`  ${i + 1}. ${r.txt}`));

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Cluster summary error: ${err.message}` }], isError: true };
      }
    }
  );
}
