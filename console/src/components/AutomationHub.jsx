import { useState, useEffect, useCallback } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { showToast } from "../store/toastStore";

function clusterUrl(path, cluster) {
  if (!cluster || cluster === "local") return path;
  return `${path}${path.includes("?") ? "&" : "?"}cluster=${encodeURIComponent(cluster)}`;
}

// Minimal object → YAML-ish renderer for preview (display only)
function toYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(obj)) {
    return obj.map((v) => `${pad}- ${typeof v === "object" && v !== null ? "\n" + toYaml(v, indent + 1).replace(/^/gm, "  ") : String(v)}`).join("\n");
  }
  if (obj && typeof obj === "object") {
    return Object.entries(obj).map(([k, v]) => {
      if (v && typeof v === "object") return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      return `${pad}${k}: ${v === null ? "~" : String(v)}`;
    }).join("\n");
  }
  return `${pad}${String(obj)}`;
}

export function AutomationHub({ open, onClose }) {
  const activeCluster = useActiveCluster();
  const [agent, setAgent] = useState("sop"); // sop | snow
  const [clusters, setClusters] = useState([]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/agent/status").then((r) => r.json()).then((d) => {
      const names = new Set(["local"]);
      (d?.agents || d?.clusters || []).forEach((a) => { const n = a.name || a.clusterName || a.cluster; if (n) names.add(n); });
      setClusters([...names]);
    }).catch(() => setClusters(["local"]));
  }, [open]);

  if (!open) return null;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,25,0.55)", backdropFilter: "blur(3px)", zIndex: 1000, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 96vw)", height: "100%", background: "var(--bg, #fff)", borderLeft: "1px solid var(--border, #e4e8f1)", boxShadow: "-8px 0 40px rgba(0,0,0,0.2)", display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--border,#e4e8f1)" }}>
          <span style={{ fontSize: "1.3rem" }}>🤖</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: "1.05rem", color: "var(--fg,#151a29)" }}>Automation Hub</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted,#5a6373)" }}>Agent-driven deployment & incident remediation</div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: "1.4rem", cursor: "pointer", color: "var(--muted,#5a6373)" }}>×</button>
        </div>
        {/* Agent tabs */}
        <div style={{ display: "flex", gap: 8, padding: "12px 20px 0" }}>
          {[["sop", "🧩 SOP Agent"], ["snow", "🎫 ServiceNow Agent"]].map(([k, label]) => (
            <button key={k} onClick={() => setAgent(k)} style={{ padding: "8px 16px", borderRadius: "9px 9px 0 0", border: "1px solid var(--border,#e4e8f1)", borderBottom: agent === k ? "2px solid #3d5afe" : "1px solid var(--border,#e4e8f1)", background: agent === k ? "var(--card-bg,#f6f8fc)" : "transparent", fontWeight: 700, fontSize: "0.86rem", color: agent === k ? "#3d5afe" : "var(--muted,#5a6373)", cursor: "pointer" }}>{label}</button>
          ))}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "18px 20px" }}>
          {agent === "sop" ? <SopAgent clusters={clusters} activeCluster={activeCluster} /> : <SnowAgent activeCluster={activeCluster} />}
        </div>
      </div>
    </div>
  );
}

/* ── SOP Agent: requirement → manifests → choose cluster → deploy ── */
function SopAgent({ clusters, activeCluster }) {
  const [requirement, setRequirement] = useState("");
  const [namespace, setNamespace] = useState("");
  const [gen, setGen] = useState(null); // { appName, namespace, manifests, summary, notes, image }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cluster, setCluster] = useState(activeCluster || "local");
  const [deploy, setDeploy] = useState(null); // { phase, result }

  const generate = async () => {
    setLoading(true); setError(null); setGen(null); setDeploy(null);
    try {
      const res = await fetch("/api/automation/generate-manifest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirement, namespace }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setGen(d);
      if (d.namespace && !namespace) setNamespace(d.namespace);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const runDeploy = async (dryRun) => {
    setDeploy({ phase: dryRun ? "dry" : "apply" });
    try {
      const res = await fetch(clusterUrl("/api/automation/deploy", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifests: gen.manifests, namespace: namespace || gen.namespace, dryRun }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setDeploy({ phase: "done", dryRun, result: d });
      showToast(dryRun ? "Dry-run complete" : `Deployed ${d.applied?.length || 0} object(s)`, d.failed?.length ? "err" : "ok");
    } catch (e) { setDeploy({ phase: "error", error: e.message }); showToast("Deploy failed: " + e.message, "err"); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)" }}>Describe the application to deploy (or paste requirement text). The agent generates Kubernetes/OpenShift manifests you can review, dry-run, and deploy to any connected cluster.</div>
      <textarea value={requirement} onChange={(e) => setRequirement(e.target.value)} rows={5}
        placeholder="e.g. Deploy an nginx web app with 2 replicas, expose it via a Route, and set 256Mi memory limit."
        style={{ width: "100%", padding: 12, borderRadius: 10, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--fg,#151a29)", fontSize: "0.9rem", resize: "vertical" }} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="namespace (optional)"
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--fg,#151a29)", fontSize: "0.86rem" }} />
        <button onClick={generate} disabled={loading || !requirement.trim()} style={{ padding: "9px 18px", borderRadius: 9, border: "none", background: "#3d5afe", color: "#fff", fontWeight: 700, fontSize: "0.88rem", cursor: "pointer", opacity: loading || !requirement.trim() ? 0.6 : 1 }}>
          {loading ? "Generating…" : "✨ Generate Manifests"}
        </button>
      </div>
      {error && <div style={{ color: "#dc2626", fontSize: "0.86rem" }}>⚠ {error}</div>}

      {gen && (
        <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 12, padding: 16, background: "var(--card-bg,#f6f8fc)" }}>
          <div style={{ fontWeight: 750 }}>{gen.appName} <span style={{ color: "var(--muted,#5a6373)", fontWeight: 500 }}>· {gen.manifests?.length} manifests · image: {gen.image || "—"}</span></div>
          {gen.summary && <p style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)", margin: "6px 0" }}>{gen.summary}</p>}
          <pre style={{ maxHeight: 260, overflow: "auto", background: "rgba(15,23,42,0.06)", padding: 12, borderRadius: 8, fontSize: "0.74rem", whiteSpace: "pre-wrap" }}>{gen.manifests.map((m) => toYaml(m)).join("\n---\n")}</pre>
          {gen.notes && <p style={{ fontSize: "0.8rem", color: "var(--muted,#5a6373)" }}>📝 {gen.notes}</p>}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <label style={{ fontSize: "0.82rem", color: "var(--muted,#5a6373)" }}>Deploy to cluster:</label>
            <select value={cluster} onChange={(e) => setCluster(e.target.value)} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--fg,#151a29)", fontSize: "0.84rem" }}>
              {clusters.map((c) => <option key={c} value={c}>{c === "local" ? "Hub Cluster (local)" : c}</option>)}
            </select>
            <button onClick={() => runDeploy(true)} disabled={deploy?.phase === "dry" || deploy?.phase === "apply"} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #3d5afe", background: "rgba(61,90,254,0.08)", color: "#3d5afe", fontWeight: 700, fontSize: "0.84rem", cursor: "pointer" }}>▷ Dry-run</button>
            <button onClick={() => runDeploy(false)} disabled={deploy?.phase === "dry" || deploy?.phase === "apply"} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#0ea5a0", color: "#fff", fontWeight: 700, fontSize: "0.84rem", cursor: "pointer" }}>🚀 Deploy</button>
          </div>
          {deploy?.phase === "done" && (
            <div style={{ marginTop: 10, fontSize: "0.84rem", borderLeft: "3px solid #16a34a", paddingLeft: 10 }}>
              <b>{deploy.dryRun ? "Dry-run" : "Deploy"} result:</b> {deploy.result.applied?.length || 0} ok{deploy.result.failed?.length ? `, ${deploy.result.failed.length} failed` : ""}.
              <div style={{ color: "var(--muted,#5a6373)" }}>{(deploy.result.applied || []).join(", ")}</div>
              {(deploy.result.failed || []).map((f, i) => <div key={i} style={{ color: "#dc2626" }}>✗ {f.kind}/{f.name}: {f.error}</div>)}
            </div>
          )}
          {deploy?.phase === "error" && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.84rem" }}>Deploy error: {deploy.error}</div>}
        </div>
      )}
    </div>
  );
}

/* ── ServiceNow Agent: fetch platform incidents → RCA per incident ── */
function SnowAgent({ activeCluster }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rca, setRca] = useState({}); // { [sysId]: { loading, data, error } }

  const fetchIncidents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/servicenow/incidents?limit=25");
      const d = await res.json().catch(() => ({}));
      setData(d);
    } catch (e) { setData({ source: "error", note: e.message, incidents: [] }); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchIncidents(); }, [fetchIncidents]);

  const runRca = async (inc) => {
    setRca((p) => ({ ...p, [inc.sysId]: { loading: true } }));
    try {
      const res = await fetch(clusterUrl("/api/rca/investigate", inc.cluster || activeCluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: inc.namespace, pod: inc.resource }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setRca((p) => ({ ...p, [inc.sysId]: { loading: false, data: d } }));
    } catch (e) { setRca((p) => ({ ...p, [inc.sysId]: { loading: false, error: e.message } })); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)", flex: 1 }}>Incidents the platform raised in ServiceNow — with the cluster they came from. Run RCA and see the fix per incident.</div>
        <button onClick={fetchIncidents} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", fontWeight: 700, fontSize: "0.84rem", cursor: "pointer" }}>{loading ? "Fetching…" : "↻ Refresh"}</button>
      </div>
      {data?.source === "unavailable" && <div style={{ fontSize: "0.84rem", color: "#b45309", background: "rgba(245,158,11,0.1)", padding: 12, borderRadius: 8 }}>ServiceNow not reachable/configured. Set the connection in Settings → ServiceNow. ({data.note})</div>}
      {data && data.incidents?.length === 0 && data.source !== "unavailable" && <div style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)" }}>No open incidents found.</div>}
      {(data?.incidents || []).map((inc) => {
        const r = rca[inc.sysId] || {};
        return (
          <div key={inc.sysId} style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: 14, background: "var(--card-bg,#fff)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 750, fontSize: "0.9rem" }}>{inc.number}</span>
              {inc.cluster && <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "2px 8px", borderRadius: 999, background: "rgba(61,90,254,0.13)", color: "#3d5afe" }}>🗄 {inc.cluster}</span>}
              {inc.namespace && <span style={{ fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>ns: {inc.namespace}</span>}
              <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>{inc.createdOn}</span>
            </div>
            <div style={{ fontSize: "0.88rem", margin: "6px 0", color: "var(--fg,#151a29)" }}>{inc.shortDescription}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => runRca(inc)} disabled={r.loading || !inc.namespace} title={inc.namespace ? "" : "No namespace/resource on this incident"} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(124,58,237,0.4)", background: "rgba(124,58,237,0.1)", color: "#7c3aed", fontWeight: 700, fontSize: "0.8rem", cursor: inc.namespace ? "pointer" : "not-allowed", opacity: inc.namespace ? 1 : 0.5 }}>{r.loading ? "Analyzing…" : "🔎 Run RCA"}</button>
            </div>
            {r.error && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>RCA: {r.error}</div>}
            {r.data && (
              <div style={{ marginTop: 10, borderLeft: "3px solid #7c3aed", paddingLeft: 10, fontSize: "0.84rem" }}>
                {r.data.rootCause && <p style={{ margin: "0 0 4px" }}><b>Root cause:</b> {r.data.rootCause}</p>}
                {r.data.recommendation && <p style={{ margin: "0 0 4px" }}><b>Recommended fix:</b> {r.data.recommendation}</p>}
                {r.data.summary && !r.data.rootCause && <p style={{ margin: 0 }}>{r.data.summary}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
