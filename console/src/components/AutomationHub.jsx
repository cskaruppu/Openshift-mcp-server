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
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,14,25,0.62)", backdropFilter: "blur(7px)", WebkitBackdropFilter: "blur(7px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", animation: "ah-fade .16s ease" }}>
      <style>{`@keyframes ah-fade{from{opacity:0}to{opacity:1}}@keyframes ah-pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}`}</style>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(1040px, 96vw)", height: "min(760px, 90vh)", minHeight: 520, background: "var(--bg, #fff)", border: "1px solid var(--border, #e4e8f1)", borderRadius: 18, boxShadow: "0 24px 70px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column", overflow: "hidden", animation: "ah-pop .2s cubic-bezier(.2,.7,.3,1)" }}>
        {/* Header with gradient accent */}
        <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "18px 22px", borderBottom: "1px solid var(--border,#e4e8f1)", background: "linear-gradient(90deg, rgba(61,90,254,0.07), rgba(14,165,160,0.05))" }}>
          <span style={{ width: 40, height: 40, borderRadius: 11, background: "linear-gradient(135deg,#3d5afe,#7a3dff 55%,#0ea5a0)", display: "grid", placeItems: "center", fontSize: "1.25rem", boxShadow: "0 6px 16px rgba(61,90,254,0.35)" }}>🤖</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: "1.12rem", color: "var(--fg,#151a29)", letterSpacing: "-0.01em" }}>Automation Hub</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted,#5a6373)" }}>Fleet-wide agent-driven deployment &amp; incident remediation</div>
          </div>
          <button onClick={onClose} title="Close" style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", fontSize: "1.15rem", cursor: "pointer", color: "var(--muted,#5a6373)", lineHeight: 1 }}>×</button>
        </div>
        {/* Segmented agent switcher */}
        <div style={{ padding: "16px 22px 0" }}>
          <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 11, background: "var(--card-bg,#f0f2f8)", border: "1px solid var(--border,#e4e8f1)" }}>
            {[["sop", "🚀 App Deployment Agent"], ["snow", "🎫 ServiceNow Agent"]].map(([k, label]) => (
              <button key={k} onClick={() => setAgent(k)} style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: agent === k ? "linear-gradient(135deg,#3d5afe,#5b6cff)" : "transparent", fontWeight: 700, fontSize: "0.86rem", color: agent === k ? "#fff" : "var(--muted,#5a6373)", cursor: "pointer", boxShadow: agent === k ? "0 3px 10px rgba(61,90,254,0.3)" : "none", transition: "all .15s" }}>{label}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "18px 22px 24px" }}>
          {agent === "sop" ? <SopAgent clusters={clusters} activeCluster={activeCluster} /> : <SnowAgent activeCluster={activeCluster} />}
        </div>
      </div>
    </div>
  );
}

/* ── App Deployment Agent: requirement → hardened manifests → edit → deploy ── */
function SopAgent({ clusters, activeCluster }) {
  const [requirement, setRequirement] = useState("");
  const [namespace, setNamespace] = useState("");
  const [gen, setGen] = useState(null); // { appName, namespace, manifests, yaml, summary, notes, image }
  const [editedYaml, setEditedYaml] = useState(""); // user-editable manifest YAML
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cluster, setCluster] = useState(activeCluster || "local");
  const [deploy, setDeploy] = useState(null); // { phase, result }
  const [uploading, setUploading] = useState(false);
  const [uploadedName, setUploadedName] = useState(null);
  const [verify, setVerify] = useState(null); // { phase, cis, image, error }

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/automation/extract-doc", { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setRequirement((prev) => (prev ? prev + "\n\n" : "") + (d.text || ""));
      setUploadedName(d.filename);
      showToast(`Loaded ${d.filename} (${d.chars} chars) — review & generate`, "ok");
    } catch (err) { setError("Upload: " + err.message); showToast("Upload failed: " + err.message, "err"); }
    finally { setUploading(false); e.target.value = ""; }
  };

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
      // Seed the editable YAML from the generated manifests (fallback to a
      // best-effort render if the server didn't return a yaml string).
      setEditedYaml(d.yaml || (d.manifests || []).map((m) => toYaml(m)).join("\n---\n") + "\n");
      if (d.namespace && !namespace) setNamespace(d.namespace);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const runDeploy = async (dryRun) => {
    setDeploy({ phase: dryRun ? "dry" : "apply" });
    try {
      const res = await fetch(clusterUrl("/api/automation/deploy", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: editedYaml, manifests: gen.manifests, namespace: namespace || gen.namespace, dryRun }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setDeploy({ phase: "done", dryRun, result: d });
      setVerify(null);
      showToast(dryRun ? "Dry-run complete" : `Deployed ${d.applied?.length || 0} object(s)`, d.failed?.length ? "err" : "ok");
    } catch (e) { setDeploy({ phase: "error", error: e.message }); showToast("Deploy failed: " + e.message, "err"); }
  };

  // Closed-loop security check: run the CIS scan + image vulnerability scan
  // against the namespace we just deployed to, on the same cluster.
  const runVerify = async () => {
    const ns = namespace || gen?.namespace;
    if (!ns) return;
    setVerify({ phase: "running" });
    try {
      const [cisRes, imgRes] = await Promise.all([
        fetch(clusterUrl("/api/compliance/scan-namespace", cluster), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace: ns }),
        }).then((r) => r.json()).catch((e) => ({ error: e.message })),
        fetch(clusterUrl(`/api/dashboard/image-vulns?namespace=${encodeURIComponent(ns)}`, cluster))
          .then((r) => r.json()).catch((e) => ({ error: e.message })),
      ]);
      setVerify({ phase: "done", cis: cisRes, image: imgRes });
      const crit = (cisRes?.severity?.critical || 0) + (imgRes?.critical || 0);
      showToast(crit ? `Verify: ${crit} critical finding(s)` : "Verify: no critical findings", crit ? "err" : "ok");
    } catch (e) { setVerify({ phase: "error", error: e.message }); showToast("Verify failed: " + e.message, "err"); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)" }}>Upload a requirement document, or describe/paste the requirement. The agent generates <b>security-hardened, standards-aligned</b> Kubernetes/OpenShift manifests — namespace isolation, least-privilege RBAC, Pod Security "restricted", PVCs, NetworkPolicies and Prometheus monitoring baked in — which you can <b>edit</b>, dry-run, and deploy to any connected cluster.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 9, border: "1px dashed #3d5afe", background: "rgba(61,90,254,0.06)", color: "#3d5afe", fontWeight: 700, fontSize: "0.84rem", cursor: uploading ? "wait" : "pointer" }}>
          {uploading ? "Reading…" : "📎 Upload requirement doc"}
          <input type="file" accept=".pdf,.docx,.txt,.md,.markdown,.yaml,.yml,.json,.csv,.log" hidden disabled={uploading} onChange={onUpload} />
        </label>
        {uploadedName && <span style={{ fontSize: "0.8rem", color: "var(--muted,#5a6373)" }}>📄 {uploadedName} loaded ✓</span>}
        <span style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)" }}>.pdf / .docx / .txt / .md supported</span>
      </div>
      <textarea value={requirement} onChange={(e) => setRequirement(e.target.value)} rows={7}
        placeholder="e.g. Deploy a web app (nginx, 2 replicas) with a PostgreSQL database in a dedicated, restricted namespace. Add least-privilege RBAC, a default-deny NetworkPolicy, a 10Gi PVC for the DB, DB creds from a Secret, Prometheus monitoring, and expose the web tier via an edge-TLS Route."
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

          {/* Security & monitoring controls baked into the generated manifests */}
          {(Array.isArray(gen.securityApplied) && gen.securityApplied.length > 0) && (
            <div style={{ margin: "8px 0 2px" }}>
              <div style={{ fontSize: "0.74rem", fontWeight: 800, color: "#0ea5a0", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 4 }}>🛡 Security controls</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {gen.securityApplied.slice(0, 10).map((s, i) => <span key={i} style={{ fontSize: "0.73rem", padding: "3px 9px", borderRadius: 999, background: "rgba(14,165,160,0.12)", color: "#0e8a86", fontWeight: 600 }}>{s}</span>)}
              </div>
            </div>
          )}
          {(Array.isArray(gen.monitoringApplied) && gen.monitoringApplied.length > 0) && (
            <div style={{ margin: "8px 0 2px" }}>
              <div style={{ fontSize: "0.74rem", fontWeight: 800, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 4 }}>📈 Observability</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {gen.monitoringApplied.slice(0, 10).map((s, i) => <span key={i} style={{ fontSize: "0.73rem", padding: "3px 9px", borderRadius: 999, background: "rgba(124,58,237,0.12)", color: "#7c3aed", fontWeight: 600 }}>{s}</span>)}
              </div>
            </div>
          )}

          {/* Editable YAML — review and tweak values before deploying */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 5px" }}>
            <label style={{ fontSize: "0.78rem", fontWeight: 800, color: "var(--fg,#151a29)" }}>✎ Manifests (editable YAML)</label>
            <button onClick={() => setEditedYaml(gen.yaml || (gen.manifests || []).map((m) => toYaml(m)).join("\n---\n") + "\n")}
              style={{ fontSize: "0.72rem", padding: "3px 10px", borderRadius: 7, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--muted,#5a6373)", fontWeight: 700, cursor: "pointer" }}>↺ Reset to generated</button>
          </div>
          <textarea value={editedYaml} onChange={(e) => setEditedYaml(e.target.value)} spellCheck={false} rows={14}
            style={{ width: "100%", maxHeight: 340, background: "#0f172a", color: "#e2e8f0", padding: 12, borderRadius: 8, fontSize: "0.75rem", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", lineHeight: 1.5, border: "1px solid var(--border,#e4e8f1)", resize: "vertical", whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto" }} />
          <div style={{ fontSize: "0.72rem", color: "var(--muted,#5a6373)", marginTop: 3 }}>Edit any value above (image tags, replicas, sizes, limits). Your edits are what gets dry-run and deployed.</div>
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

          {/* Closed-loop security verification — only after a real deploy */}
          {deploy?.phase === "done" && !deploy.dryRun && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--border,#e4e8f1)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button onClick={runVerify} disabled={verify?.phase === "running"} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#7c3aed,#3d5afe)", color: "#fff", fontWeight: 700, fontSize: "0.84rem", cursor: "pointer", opacity: verify?.phase === "running" ? 0.7 : 1 }}>
                  {verify?.phase === "running" ? "Scanning…" : "🔍 Verify security (CIS + image scan)"}
                </button>
                <span style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)" }}>Runs the CIS benchmark + image vulnerability scan on <b>{namespace || gen.namespace}</b></span>
              </div>
              {verify?.phase === "error" && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.84rem" }}>Verify error: {verify.error}</div>}
              {verify?.phase === "done" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
                  {/* CIS card */}
                  <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: 12, background: "var(--card-bg,#fff)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 800, fontSize: "0.82rem" }}>🛡 CIS Benchmark</span>
                      {verify.cis?.error ? <span style={{ fontSize: "0.72rem", color: "#dc2626" }}>error</span> :
                        <span style={{ fontSize: "0.72rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: verify.cis?.clean ? "rgba(22,163,74,0.14)" : "rgba(220,38,38,0.12)", color: verify.cis?.clean ? "#16a34a" : "#dc2626" }}>{verify.cis?.clean ? "PASS · grade " + verify.cis.grade : (verify.cis?.issueCount || 0) + " issue(s)"}</span>}
                    </div>
                    {verify.cis?.error ? <div style={{ fontSize: "0.78rem", color: "#dc2626", marginTop: 6 }}>{verify.cis.error}</div> : (
                      <>
                        <div style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)", margin: "6px 0" }}>Critical {verify.cis?.severity?.critical || 0} · Warning {verify.cis?.severity?.warning || 0} · Info {verify.cis?.severity?.info || 0}</div>
                        {(verify.cis?.findings || []).slice(0, 4).map((f, i) => <div key={i} style={{ fontSize: "0.74rem", color: "var(--fg,#151a29)", marginTop: 2 }}>• <b>{f.id}</b> {f.title}</div>)}
                        {verify.cis?.clean && <div style={{ fontSize: "0.78rem", color: "#16a34a", marginTop: 4 }}>No CIS violations in this namespace ✓</div>}
                      </>
                    )}
                  </div>
                  {/* Image scan card */}
                  <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: 12, background: "var(--card-bg,#fff)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 800, fontSize: "0.82rem" }}>🐞 Image Vulnerabilities</span>
                      {verify.image?.error ? <span style={{ fontSize: "0.72rem", color: "#dc2626" }}>error</span> :
                        <span style={{ fontSize: "0.72rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: "rgba(61,90,254,0.12)", color: "#3d5afe" }}>grade {verify.image?.grade || "?"}</span>}
                    </div>
                    {verify.image?.error ? <div style={{ fontSize: "0.78rem", color: "#dc2626", marginTop: 6 }}>{verify.image.error}</div> : (
                      <>
                        <div style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)", margin: "6px 0" }}>{verify.image?.totalImages || 0} image(s) · C {verify.image?.critical || 0} · H {verify.image?.high || 0} · M {verify.image?.medium || 0} · L {verify.image?.low || 0}</div>
                        {verify.image?.scannerType && verify.image.scannerType !== "unknown" ? <div style={{ fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>scanner: {verify.image.scannerType}</div> : <div style={{ fontSize: "0.72rem", color: "#b45309" }}>No live scanner data yet — images may still be scanning.</div>}
                        {(verify.image?.topImages || []).slice(0, 3).map((im, i) => <div key={i} style={{ fontSize: "0.74rem", marginTop: 2 }}>• {im.image} <span style={{ color: "#dc2626" }}>{im.critical ? im.critical + "C" : ""}</span> <span style={{ color: "#ea580c" }}>{im.high ? im.high + "H" : ""}</span></div>)}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
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
  const [fix, setFix] = useState({}); // { [sysId]: { phase, data, error } }

  const runFix = async (inc, apply) => {
    setFix((p) => ({ ...p, [inc.sysId]: { phase: apply ? "applying" : "checking" } }));
    try {
      const res = await fetch(clusterUrl("/api/servicenow/incidents/fix", inc.cluster || activeCluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sysId: inc.sysId, namespace: inc.namespace, resource: inc.resource, dryRun: !apply }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setFix((p) => ({ ...p, [inc.sysId]: { phase: apply ? "done" : "preview", data: d } }));
      if (apply) showToast(`Fix applied${d.incidentClosed?.success ? " · incident closed" : ""}`, "ok");
    } catch (e) { setFix((p) => ({ ...p, [inc.sysId]: { phase: "error", error: e.message } })); showToast("Fix failed: " + e.message, "err"); }
  };

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
              {(() => { const f = fix[inc.sysId] || {}; return (
                <button onClick={() => runFix(inc, false)} disabled={f.phase === "checking" || f.phase === "applying" || !inc.namespace} title={inc.namespace ? "Fix (rolling restart) + close incident" : "No namespace/resource on this incident"} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(14,165,160,0.4)", background: "rgba(14,165,160,0.1)", color: "#0ea5a0", fontWeight: 700, fontSize: "0.8rem", cursor: inc.namespace ? "pointer" : "not-allowed", opacity: inc.namespace ? 1 : 0.5 }}>{f.phase === "checking" ? "Checking…" : f.phase === "applying" ? "Applying…" : "⚡ Fix"}</button>
              ); })()}
            </div>
            {r.error && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>RCA: {r.error}</div>}
            {r.data && (
              <div style={{ marginTop: 10, borderLeft: "3px solid #7c3aed", paddingLeft: 10, fontSize: "0.84rem" }}>
                {r.data.rootCause && <p style={{ margin: "0 0 4px" }}><b>Root cause:</b> {r.data.rootCause}</p>}
                {r.data.recommendation && <p style={{ margin: "0 0 4px" }}><b>Recommended fix:</b> {r.data.recommendation}</p>}
                {r.data.summary && !r.data.rootCause && <p style={{ margin: 0 }}>{r.data.summary}</p>}
              </div>
            )}
            {(() => {
              const f = fix[inc.sysId] || {};
              if (f.phase === "preview" && f.data) return (
                <div style={{ marginTop: 10, borderLeft: "3px solid #0ea5a0", paddingLeft: 10, fontSize: "0.84rem" }}>
                  <b>Planned fix (dry-run):</b> {f.data.action}
                  <div><button onClick={() => runFix(inc, true)} style={{ marginTop: 6, padding: "6px 14px", borderRadius: 7, border: "none", background: "#0ea5a0", color: "#fff", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>✓ Apply Fix & Close Incident</button></div>
                </div>
              );
              if (f.phase === "done" && f.data) return (
                <div style={{ marginTop: 10, borderLeft: "3px solid #16a34a", paddingLeft: 10, fontSize: "0.84rem" }}>
                  <b>✓ Applied:</b> {f.data.action}.{f.data.incidentClosed?.success ? " Incident closed in ServiceNow." : f.data.incidentClosed?.detailsSaved ? " Details saved — close pending." : ""}
                </div>
              );
              if (f.phase === "error") return <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>Fix: {f.error}</div>;
              return null;
            })()}
          </div>
        );
      })}
    </div>
  );
}
