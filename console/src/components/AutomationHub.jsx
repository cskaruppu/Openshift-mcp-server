import { useState, useEffect, useCallback, useRef } from "react";
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
          {agent === "sop" ? <SopAgent clusters={clusters} activeCluster={activeCluster} /> : <SnowAgent clusters={clusters} activeCluster={activeCluster} />}
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
  const [cisChk, setCisChk] = useState(null); // pre-deploy CIS: { phase, data }
  const [imgChk, setImgChk] = useState(null); // pre-deploy image: { phase, data }

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
    setLoading(true); setError(null); setGen(null); setDeploy(null); setCisChk(null); setImgChk(null); setVerify(null);
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

  // Shift-left checks on the GENERATED code (before deploy) — run separately.
  const runCisCheck = async () => {
    setCisChk({ phase: "running" });
    try {
      const res = await fetch("/api/automation/cis-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: editedYaml, manifests: gen?.manifests }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setCisChk({ phase: "done", data: d });
    } catch (e) { setCisChk({ phase: "error", error: e.message }); showToast("CIS check failed: " + e.message, "err"); }
  };

  const runImageCheck = async () => {
    setImgChk({ phase: "running" });
    try {
      const res = await fetch(clusterUrl("/api/automation/image-scan", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: editedYaml, manifests: gen?.manifests }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setImgChk({ phase: "done", data: d });
    } catch (e) { setImgChk({ phase: "error", error: e.message }); showToast("Image scan failed: " + e.message, "err"); }
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

          {/* Pre-deploy (shift-left) checks — run independently on the generated code */}
          <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--border,#e4e8f1)", background: "rgba(61,90,254,0.04)" }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 800, color: "var(--fg,#151a29)", marginBottom: 8 }}>🔎 Pre-deploy checks <span style={{ fontWeight: 500, color: "var(--muted,#5a6373)" }}>· run on the generated code, before deploying</span></div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={runCisCheck} disabled={cisChk?.phase === "running"} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #0ea5a0", background: "rgba(14,165,160,0.08)", color: "#0e8a86", fontWeight: 700, fontSize: "0.84rem", cursor: "pointer", opacity: cisChk?.phase === "running" ? 0.7 : 1 }}>{cisChk?.phase === "running" ? "Checking…" : "🛡 CIS Benchmark check"}</button>
              <button onClick={runImageCheck} disabled={imgChk?.phase === "running"} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #7c3aed", background: "rgba(124,58,237,0.08)", color: "#7c3aed", fontWeight: 700, fontSize: "0.84rem", cursor: "pointer", opacity: imgChk?.phase === "running" ? 0.7 : 1 }}>{imgChk?.phase === "running" ? "Scanning…" : "🐞 Image vulnerability scan"}</button>
            </div>

            {/* CIS result */}
            {cisChk?.phase === "error" && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>CIS check: {cisChk.error}</div>}
            {cisChk?.phase === "done" && (
              cisChk.data.applicable === false
                ? <div style={{ marginTop: 8, fontSize: "0.8rem", color: "var(--muted,#5a6373)" }}>{cisChk.data.note}</div>
                : (
                  <div style={{ marginTop: 10, border: "1px solid var(--border,#e4e8f1)", borderRadius: 9, padding: 11, background: "var(--card-bg,#fff)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 800, fontSize: "0.82rem" }}>🛡 CIS / Pod Security</span>
                      <span style={{ fontSize: "0.72rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: cisChk.data.summary.failed === 0 ? "rgba(22,163,74,0.14)" : "rgba(220,38,38,0.12)", color: cisChk.data.summary.failed === 0 ? "#16a34a" : "#dc2626" }}>{cisChk.data.summary.passed}/{cisChk.data.summary.total} passed · grade {cisChk.data.summary.grade}</span>
                    </div>
                    <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 3 }}>
                      {cisChk.data.controls.map((c) => (
                        <div key={c.id} style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: "0.76rem" }}>
                          <span style={{ color: c.status === "PASS" ? "#16a34a" : "#dc2626", fontWeight: 800 }}>{c.status === "PASS" ? "✓" : "✗"}</span>
                          <span style={{ color: "var(--fg,#151a29)" }}><b>{c.id}</b> {c.title}
                            {c.status === "FAIL" && c.offenders?.length > 0 && <span style={{ color: "var(--muted,#5a6373)" }}> — {c.offenders.join(", ")}</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
            )}

            {/* Image result */}
            {imgChk?.phase === "error" && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>Image scan: {imgChk.error}</div>}
            {imgChk?.phase === "done" && (
              <div style={{ marginTop: 10, border: "1px solid var(--border,#e4e8f1)", borderRadius: 9, padding: 11, background: "var(--card-bg,#fff)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 800, fontSize: "0.82rem" }}>🐞 Image Vulnerabilities</span>
                  <span style={{ fontSize: "0.72rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: "rgba(124,58,237,0.12)", color: "#7c3aed" }}>{imgChk.data.summary?.total || 0} image(s) · grade {imgChk.data.summary?.grade}</span>
                  <span style={{ fontSize: "0.7rem", color: "var(--muted,#5a6373)" }}>{imgChk.data.enriched ? "live CVEs + hygiene" : "hygiene (deploy for live CVEs)"}</span>
                </div>
                {imgChk.data.note && <div style={{ fontSize: "0.78rem", color: "var(--muted,#5a6373)", marginTop: 6 }}>{imgChk.data.note}</div>}
                {(imgChk.data.images || []).map((im, i) => (
                  <div key={i} style={{ marginTop: 7, fontSize: "0.76rem" }}>
                    <div style={{ fontWeight: 600 }}>{im.image} <span style={{ color: "var(--muted,#5a6373)", fontWeight: 400 }}>· {im.source}</span></div>
                    <div style={{ color: "var(--muted,#5a6373)" }}>
                      <span style={{ color: "#dc2626" }}>C {im.critical}</span> · <span style={{ color: "#ea580c" }}>H {im.high}</span> · M {im.medium} · L {im.low}
                    </div>
                    {(im.hygiene || []).slice(0, 3).map((f, j) => <div key={j} style={{ color: "var(--muted,#5a6373)", marginLeft: 8 }}>• <b>{f.id}</b> {f.description} <span style={{ color: "#0e8a86" }}>→ {f.fixedBy}</span></div>)}
                  </div>
                ))}
              </div>
            )}
          </div>

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
              {/* Detect RBAC 403s and show the one-command fix inline */}
              {(deploy.result.failed || []).some((f) => /forbidden|cannot create|is forbidden|\b403\b/i.test(f.error || "")) && (
                <div style={{ marginTop: 10, padding: 11, borderRadius: 9, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)" }}>
                  <div style={{ fontWeight: 800, color: "#b45309", fontSize: "0.8rem" }}>🔑 The agent's ServiceAccount isn't allowed to deploy on this cluster (RBAC 403).</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--fg,#151a29)", margin: "5px 0 7px" }}>Grant the one-time deploy role, then run Dry-run again. Run as a cluster-admin:</div>
                  <pre style={{ margin: 0, padding: 9, borderRadius: 7, background: "#0f172a", color: "#e2e8f0", fontSize: "0.72rem", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>oc apply -f https://raw.githubusercontent.com/cskaruppu/openshift-mcp-server/claude/setup-mcp-openshift-9JUo7/deploy/dashboard/manifests/serviceaccount.yaml</pre>
                  <div style={{ fontSize: "0.72rem", color: "var(--muted,#5a6373)", marginTop: 6 }}>This adds the <code>agentic-ai-server-deployer</code> ClusterRole (create namespaces, workloads, networking, RBAC, monitoring) bound to the agent's service accounts. It's a cluster-side change — no image rebuild needed.</div>
                </div>
              )}
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

/* ── ServiceNow Agent: open incidents → AI correlation/dedup → triage & fix ── */
const SEV_COLOR = (s) => {
  const k = String(s || "").toLowerCase();
  if (/crit|^1$/.test(k)) return "#dc2626";
  if (/high|^2$/.test(k)) return "#ea580c";
  if (/med|^3$/.test(k)) return "#d97706";
  return "#64748b";
};

function SnowAgent({ clusters = [], activeCluster }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState("platform"); // platform | all
  const [rca, setRca] = useState({});
  const [fix, setFix] = useState({}); // keyed by sysId
  const [analysis, setAnalysis] = useState(null); // { phase, data, error }
  const [clusterSel, setClusterSel] = useState({}); // { [sysId]: clusterName }
  const [reconcile, setReconcile] = useState(null); // { running, at, results, resolved[], checked }
  const [autoRecon, setAutoRecon] = useState(false); // periodic reconcile while open
  const [autoClose, setAutoClose] = useState(false); // hands-off: close resolved automatically

  const incidents = data?.incidents || [];
  const byNumber = {};
  for (const i of incidents) byNumber[i.number] = i;

  const clusterList = clusters.length ? clusters : ["local"];
  // Which cluster to act on for an incident: explicit selection > parsed from
  // the incident > active cluster > hub.
  const clusterFor = (inc) => clusterSel[inc.sysId] || inc.cluster || activeCluster || "local";
  // A cluster must be chosen when the incident carries none and there's a real
  // choice (more than just the hub).
  const needsClusterChoice = (inc) => !inc.cluster && !clusterSel[inc.sysId] && clusterList.length > 1;

  const ClusterPicker = ({ inc }) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ fontSize: "0.72rem", color: needsClusterChoice(inc) ? "#dc2626" : "var(--muted,#5a6373)", fontWeight: needsClusterChoice(inc) ? 700 : 400 }}>{inc.cluster ? "cluster:" : "run on:"}</span>
      <select value={clusterFor(inc)} onChange={(e) => setClusterSel((p) => ({ ...p, [inc.sysId]: e.target.value }))}
        style={{ padding: "3px 7px", borderRadius: 6, border: needsClusterChoice(inc) ? "1px solid #dc2626" : "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--fg,#151a29)", fontSize: "0.74rem", fontWeight: 600 }}>
        {clusterList.map((c) => <option key={c} value={c}>{c === "local" ? "Hub (local)" : c}</option>)}
      </select>
    </span>
  );

  const fetchIncidents = useCallback(async (scp) => {
    setLoading(true); setAnalysis(null);
    try {
      const res = await fetch(`/api/servicenow/incidents?limit=40&scope=${scp}`);
      const d = await res.json().catch(() => ({}));
      setData(d);
    } catch (e) { setData({ source: "error", note: e.message, incidents: [] }); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchIncidents(scope); }, [fetchIncidents, scope]);

  const runAnalyze = async () => {
    setAnalysis({ phase: "running" });
    try {
      const res = await fetch("/api/servicenow/incidents/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidents }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setAnalysis({ phase: "done", data: d });
      const grouped = (d.groups || []).reduce((n, g) => n + (g.duplicates?.length || 0) + (g.resolvesOnFix?.length || 0), 0);
      showToast(`Correlated: ${(d.groups || []).length} group(s), ~${grouped} incident(s) collapse into their primary`, "ok");
    } catch (e) { setAnalysis({ phase: "error", error: e.message }); showToast("Analyze failed: " + e.message, "err"); }
  };

  const runRca = async (inc) => {
    setRca((p) => ({ ...p, [inc.sysId]: { loading: true } }));
    try {
      const res = await fetch(clusterUrl("/api/rca/investigate", clusterFor(inc)), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: inc.namespace, pod: inc.resource }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setRca((p) => ({ ...p, [inc.sysId]: { loading: false, data: d } }));
    } catch (e) { setRca((p) => ({ ...p, [inc.sysId]: { loading: false, error: e.message } })); }
  };

  // Fix one incident. `alsoClose` = correlated tickets that this same fix
  // resolves; they are closed in ServiceNow with a note referencing the primary.
  // On dry-run we ALSO run a live pre-flight validation so the user can see
  // whether the issue is still present before applying anything.
  // opts.closeOnly closes the incident(s) without touching the cluster.
  const runFix = async (inc, apply, alsoClose = [], primaryNumber = null, opts = {}) => {
    const cl = clusterFor(inc);
    setFix((p) => ({ ...p, [inc.sysId]: { ...(p[inc.sysId] || {}), phase: apply ? "applying" : "checking" } }));
    try {
      const [fixRes, valRes] = await Promise.all([
        fetch(clusterUrl("/api/servicenow/incidents/fix", cl), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sysId: inc.sysId, namespace: inc.namespace, resource: inc.resource, dryRun: !apply, alsoClose, primaryNumber, closeOnly: opts.closeOnly === true }),
        }).then((r) => r.json()).catch((e) => ({ error: e.message })),
        // Validate live state only during the dry-run preview.
        (!apply && inc.namespace && inc.resource)
          ? fetch(clusterUrl("/api/servicenow/incidents/validate", cl), {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ namespace: inc.namespace, resource: inc.resource }),
            }).then((r) => r.json()).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (fixRes.error) throw new Error(fixRes.error);
      setFix((p) => ({ ...p, [inc.sysId]: { phase: apply ? "done" : "preview", data: fixRes, alsoClose, validation: valRes || (p[inc.sysId] || {}).validation, closeOnly: opts.closeOnly === true } }));
      if (apply) showToast(`${opts.closeOnly ? "Closed" : "Fix applied"}${fixRes.incidentClosed?.success ? " · primary closed" : ""}${fixRes.closedRelated?.length ? " · " + fixRes.closedRelated.filter(x => x.closed).length + " related closed" : ""}`, "ok");
    } catch (e) { setFix((p) => ({ ...p, [inc.sysId]: { phase: "error", error: e.message } })); showToast("Action failed: " + e.message, "err"); }
  };

  // Compute {sysId, number} list for a group's collateral closes.
  const collateralOf = (g) => {
    const nums = [...new Set([...(g.resolvesOnFix || []), ...(g.duplicates || [])])].filter((n) => n !== g.primary);
    return nums.map((n) => byNumber[n]).filter(Boolean).map((i) => ({ sysId: i.sysId, number: i.number }));
  };

  // ── Auto-reconcile: validate every open incident against its cluster and
  // flag the ones already resolved (open in ServiceNow but healthy in-cluster).
  const autoCloseRef = useRef(false);
  autoCloseRef.current = autoClose;

  const runReconcile = async () => {
    const targets = (data?.incidents || []).filter((i) => i.namespace && i.resource);
    if (targets.length === 0) { setReconcile({ running: false, at: new Date().toLocaleTimeString(), results: {}, resolved: [], checked: 0 }); return; }
    setReconcile((p) => ({ ...(p || { results: {}, resolved: [] }), running: true }));
    const entries = await Promise.all(targets.map(async (inc) => {
      try {
        const r = await fetch(clusterUrl("/api/servicenow/incidents/validate", clusterFor(inc)), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace: inc.namespace, resource: inc.resource }),
        }).then((x) => x.json());
        return [inc.sysId, r];
      } catch (e) { return [inc.sysId, { error: e.message }]; }
    }));
    const results = Object.fromEntries(entries);
    const resolved = targets.filter((i) => results[i.sysId] && results[i.sysId].stillAffected === false);
    setReconcile({ running: false, at: new Date().toLocaleTimeString(), results, resolved: resolved.map((i) => i.sysId), checked: targets.length });
    if (autoCloseRef.current && resolved.length) {
      for (const inc of resolved) { await runFix(inc, true, [], null, { closeOnly: true }); }
      showToast(`Auto-closed ${resolved.length} already-resolved incident(s)`, "ok");
      fetchIncidents(scope);
    } else if (resolved.length) {
      showToast(`Reconcile: ${resolved.length} incident(s) already resolved in-cluster — ready to close`, "ok");
    }
  };

  // Periodic reconcile while the toggle is on (runs immediately, then every 90s).
  const reconcileRef = useRef(() => {});
  reconcileRef.current = runReconcile;
  useEffect(() => {
    if (!autoRecon) return;
    reconcileRef.current();
    const id = setInterval(() => reconcileRef.current(), 90000);
    return () => clearInterval(id);
  }, [autoRecon]);

  const closeResolved = async () => {
    const list = (reconcile?.resolved || []).map((id) => (data?.incidents || []).find((i) => i.sysId === id)).filter(Boolean);
    if (!list.length) return;
    if (!window.confirm(`Close ${list.length} incident(s) validated as already resolved in-cluster? No cluster changes are made — this only closes the ServiceNow tickets.`)) return;
    for (const inc of list) { await runFix(inc, true, [], null, { closeOnly: true }); }
    showToast(`Closed ${list.length} already-resolved incident(s)`, "ok");
    fetchIncidents(scope);
  };

  const A = analysis?.data;
  const readyToClose = (reconcile?.resolved || []).map((id) => (data?.incidents || []).find((i) => i.sysId === id)).filter(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)", flex: 1, minWidth: 220 }}>Open incidents this platform is tracking. Let AI de-duplicate and correlate them, then fix the primary to clear the rest.</div>
        <div style={{ display: "inline-flex", gap: 3, padding: 3, borderRadius: 9, background: "var(--card-bg,#f0f2f8)", border: "1px solid var(--border,#e4e8f1)" }}>
          {[["platform", "This platform"], ["all", "All open"]].map(([k, label]) => (
            <button key={k} onClick={() => setScope(k)} style={{ padding: "5px 12px", borderRadius: 7, border: "none", background: scope === k ? "#3d5afe" : "transparent", color: scope === k ? "#fff" : "var(--muted,#5a6373)", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer" }}>{label}</button>
          ))}
        </div>
        <button onClick={() => fetchIncidents(scope)} disabled={loading} style={{ padding: "8px 13px", borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", fontWeight: 700, fontSize: "0.82rem", cursor: "pointer" }}>{loading ? "…" : "↻ Refresh"}</button>
        <button onClick={runAnalyze} disabled={analysis?.phase === "running" || incidents.length === 0} style={{ padding: "8px 15px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#7c3aed,#3d5afe)", color: "#fff", fontWeight: 700, fontSize: "0.82rem", cursor: "pointer", opacity: analysis?.phase === "running" || !incidents.length ? 0.65 : 1 }}>{analysis?.phase === "running" ? "Analyzing…" : "🧠 Analyze & Correlate"}</button>
      </div>

      {/* Status strip */}
      {data && data.source !== "unavailable" && (
        <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: "0.78rem", color: "var(--muted,#5a6373)", flexWrap: "wrap" }}>
          <span><b style={{ color: "var(--fg,#151a29)" }}>{incidents.length}</b> open</span>
          {typeof data.uniqueCount === "number" && <span><b style={{ color: "var(--fg,#151a29)" }}>{data.uniqueCount}</b> unique signature(s)</span>}
          {incidents.length - (data.uniqueCount ?? incidents.length) > 0 && <span style={{ color: "#b45309" }}>{incidents.length - data.uniqueCount} likely duplicate(s)</span>}
          <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(61,90,254,0.1)", color: "#3d5afe", fontWeight: 700 }}>scope: {data.scope || scope}</span>
          <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(22,163,74,0.12)", color: "#16a34a", fontWeight: 700 }}>open only</span>
        </div>
      )}

      {/* Auto-reconcile bar — validates open incidents against the cluster and flags already-resolved ones */}
      {data && data.source !== "unavailable" && incidents.length > 0 && (
        <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: "10px 12px", background: "rgba(14,165,160,0.04)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 800, color: "var(--fg,#151a29)" }}>🔄 Auto-reconcile</span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.78rem", color: "var(--muted,#5a6373)", cursor: "pointer" }}>
              <input type="checkbox" checked={autoRecon} onChange={(e) => setAutoRecon(e.target.checked)} /> Every 90s (while open)
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.78rem", color: "var(--muted,#5a6373)", cursor: "pointer" }} title="Automatically close incidents validated as already resolved — no cluster changes">
              <input type="checkbox" checked={autoClose} onChange={(e) => setAutoClose(e.target.checked)} /> Auto-close resolved
            </label>
            <button onClick={runReconcile} disabled={reconcile?.running} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid #0ea5a0", background: "rgba(14,165,160,0.1)", color: "#0ea5a0", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer" }}>{reconcile?.running ? "Validating…" : "Reconcile now"}</button>
            {reconcile && !reconcile.running && <span style={{ fontSize: "0.74rem", color: "var(--muted,#5a6373)" }}>Checked {reconcile.checked} · {readyToClose.length} already resolved · {reconcile.at}</span>}
          </div>
          {readyToClose.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", borderRadius: 8, background: "rgba(22,163,74,0.08)", border: "1px solid rgba(22,163,74,0.3)" }}>
              <span style={{ fontSize: "0.78rem", color: "#16a34a", fontWeight: 700 }}>✅ {readyToClose.length} incident(s) open in ServiceNow but healthy in-cluster: {readyToClose.slice(0, 6).map((i) => i.number).join(", ")}{readyToClose.length > 6 ? "…" : ""}</span>
              <button onClick={closeResolved} style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: "#16a34a", color: "#fff", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer" }}>Close {readyToClose.length} resolved — no change</button>
            </div>
          )}
        </div>
      )}

      {data?.source === "unavailable" && <div style={{ fontSize: "0.84rem", color: "#b45309", background: "rgba(245,158,11,0.1)", padding: 12, borderRadius: 8 }}>ServiceNow not reachable/configured. Set the connection in Settings → ServiceNow. ({data.note})</div>}
      {data && incidents.length === 0 && data.source !== "unavailable" && <div style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)" }}>No open incidents{scope === "platform" ? " raised by this platform" : ""}.</div>}
      {analysis?.phase === "error" && <div style={{ color: "#dc2626", fontSize: "0.84rem" }}>Analyze error: {analysis.error}</div>}

      {/* ── Correlation view ── */}
      {A && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {A.summary && <div style={{ fontSize: "0.86rem", color: "var(--fg,#151a29)", background: "linear-gradient(90deg, rgba(124,58,237,0.08), rgba(61,90,254,0.05))", padding: 12, borderRadius: 10, borderLeft: "3px solid #7c3aed" }}><b>🧠 AI triage:</b> {A.summary}</div>}

          {/* Fix order */}
          {(A.fixOrder || []).length > 0 && (
            <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: 12, background: "var(--card-bg,#fff)" }}>
              <div style={{ fontWeight: 800, fontSize: "0.8rem", marginBottom: 7 }}>⚑ Recommended fix order</div>
              {(A.fixOrder || []).map((f, i) => (
                <div key={f.number} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: "0.8rem", marginTop: 3 }}>
                  <span style={{ width: 18, height: 18, borderRadius: 999, background: "#3d5afe", color: "#fff", fontSize: "0.68rem", fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0 }}>{i + 1}</span>
                  <span><b>{f.number}</b> <span style={{ color: "var(--muted,#5a6373)" }}>— {f.why}</span></span>
                </div>
              ))}
            </div>
          )}

          {/* Correlated / duplicate groups */}
          {(A.groups || []).map((g, gi) => {
            const primary = byNumber[g.primary];
            const collateral = collateralOf(g);
            const f = primary ? (fix[primary.sysId] || {}) : {};
            const isDup = g.correlationType === "duplicate";
            return (
              <div key={gi} style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 12, padding: 14, background: "var(--card-bg,#fff)", borderTop: `3px solid ${SEV_COLOR(g.severity)}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: isDup ? "rgba(217,119,6,0.14)" : "rgba(124,58,237,0.14)", color: isDup ? "#b45309" : "#7c3aed" }}>{isDup ? "🔁 DUPLICATE CLUSTER" : "🔗 CORRELATED"}</span>
                  <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: SEV_COLOR(g.severity) + "22", color: SEV_COLOR(g.severity) }}>{String(g.severity || "—").toUpperCase()}</span>
                  <span style={{ fontWeight: 750, fontSize: "0.9rem" }}>{g.title}</span>
                  <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>{g.members?.length || 1} ticket(s)</span>
                </div>

                {/* Primary */}
                <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.66rem", fontWeight: 800, padding: "2px 7px", borderRadius: 5, background: "#16a34a", color: "#fff" }}>ROOT / FIX FIRST</span>
                  <b style={{ fontSize: "0.9rem" }}>{g.primary}</b>
                  {primary?.namespace && <span style={{ fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>ns: {primary.namespace}{primary.resource ? " · " + primary.resource : ""}</span>}
                  {primary && <ClusterPicker inc={primary} />}
                </div>
                {primary && needsClusterChoice(primary) && <div style={{ fontSize: "0.74rem", color: "#dc2626", marginTop: 4 }}>⚠ This incident has no cluster on it — choose the target cluster above before fixing.</div>}
                {g.rootCause && <p style={{ fontSize: "0.83rem", margin: "6px 0 3px" }}><b>Root cause:</b> {g.rootCause}</p>}
                {g.recommendedFix && <p style={{ fontSize: "0.83rem", margin: "0 0 4px" }}><b>Recommended fix:</b> {g.recommendedFix}</p>}

                {/* Members / duplicates */}
                {(g.members || []).length > 1 && (
                  <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontSize: "0.74rem", color: "var(--muted,#5a6373)" }}>Collapses:</span>
                    {(g.members || []).filter((n) => n !== g.primary).map((n) => (
                      <span key={n} style={{ fontSize: "0.72rem", fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: (g.duplicates || []).includes(n) ? "rgba(217,119,6,0.12)" : "rgba(100,116,139,0.12)", color: (g.duplicates || []).includes(n) ? "#b45309" : "#475569" }}>{n}{(g.duplicates || []).includes(n) ? " · dup" : ""}</span>
                    ))}
                  </div>
                )}
                {collateral.length > 0 && <div style={{ fontSize: "0.75rem", color: "#16a34a", marginTop: 5 }}>Fixing {g.primary} auto-closes {collateral.length} correlated ticket(s).</div>}

                {/* Actions */}
                {primary && primary.namespace && (
                  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                    <button onClick={() => runFix(primary, false, collateral, g.primary)} disabled={f.phase === "checking" || f.phase === "applying" || needsClusterChoice(primary)} title={needsClusterChoice(primary) ? "Choose a cluster first" : "Dry-run + validate live state"} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(14,165,160,0.4)", background: "rgba(14,165,160,0.1)", color: "#0ea5a0", fontWeight: 700, fontSize: "0.8rem", cursor: needsClusterChoice(primary) ? "not-allowed" : "pointer", opacity: needsClusterChoice(primary) ? 0.5 : 1 }}>{f.phase === "checking" ? "Validating…" : "▷ Dry-run + validate"}</button>
                    <button onClick={() => runRca(primary)} disabled={(rca[primary.sysId] || {}).loading} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(124,58,237,0.4)", background: "rgba(124,58,237,0.1)", color: "#7c3aed", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>{(rca[primary.sysId] || {}).loading ? "Analyzing…" : "🔎 RCA"}</button>
                  </div>
                )}
                {primary && !primary.namespace && <div style={{ fontSize: "0.76rem", color: "#b45309", marginTop: 8 }}>No namespace/workload parsed on the primary — resolve manually.</div>}

                {(() => {
                  if (!primary) return null;
                  const rr = rca[primary.sysId] || {};
                  return rr.data ? (
                    <div style={{ marginTop: 8, borderLeft: "3px solid #7c3aed", paddingLeft: 10, fontSize: "0.82rem" }}>
                      {rr.data.rootCause && <p style={{ margin: "0 0 3px" }}><b>RCA:</b> {rr.data.rootCause}</p>}
                      {rr.data.recommendation && <p style={{ margin: 0 }}><b>Fix:</b> {rr.data.recommendation}</p>}
                    </div>
                  ) : rr.error ? <div style={{ marginTop: 6, color: "#dc2626", fontSize: "0.8rem" }}>RCA: {rr.error}</div> : null;
                })()}

                {f.phase === "preview" && f.data && (() => {
                  const v = f.validation;
                  const alreadyResolved = v && v.stillAffected === false;
                  return (
                  <div style={{ marginTop: 8, borderLeft: "3px solid #0ea5a0", paddingLeft: 10, fontSize: "0.82rem" }}>
                    <b>Planned action:</b> {f.data.action}.
                    {/* Live pre-flight validation verdict */}
                    {v && !v.error && (
                      <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: alreadyResolved ? "rgba(22,163,74,0.08)" : "rgba(220,38,38,0.06)", border: `1px solid ${alreadyResolved ? "rgba(22,163,74,0.3)" : "rgba(220,38,38,0.25)"}` }}>
                        <div style={{ fontWeight: 800, fontSize: "0.76rem", color: alreadyResolved ? "#16a34a" : "#dc2626", marginBottom: 4 }}>{alreadyResolved ? "🩺 Live validation: already resolved" : "🩺 Live validation: still failing"}</div>
                        <div style={{ fontSize: "0.78rem", color: "var(--fg,#151a29)" }}>{v.summary}</div>
                        {(v.evidence || []).map((e, i) => <div key={i} style={{ fontSize: "0.74rem", color: "var(--muted,#5a6373)" }}>• {e}</div>)}
                      </div>
                    )}
                    {v?.error && <div style={{ marginTop: 6, fontSize: "0.74rem", color: "#b45309" }}>Validation skipped: {v.error}</div>}
                    {/* Consolidated close list — everything this action will close */}
                    <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: "rgba(14,165,160,0.06)", border: "1px solid rgba(14,165,160,0.25)" }}>
                      <div style={{ fontWeight: 800, fontSize: "0.76rem", color: "#0e8a86", marginBottom: 6 }}>Will close {collateral.length + 1} incident(s) in ServiceNow:</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.78rem" }}>
                          <span style={{ fontSize: "0.62rem", fontWeight: 800, padding: "1px 6px", borderRadius: 4, background: "#16a34a", color: "#fff" }}>PRIMARY</span>
                          <b>{g.primary}</b>
                          <span style={{ color: "var(--muted,#5a6373)" }}>{primary?.shortDescription?.slice(0, 60)}</span>
                        </div>
                        {collateral.map((c) => {
                          const ci = byNumber[c.number];
                          const isDup = (g.duplicates || []).includes(c.number);
                          return (
                            <div key={c.number} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.78rem" }}>
                              <span style={{ fontSize: "0.62rem", fontWeight: 800, padding: "1px 6px", borderRadius: 4, background: isDup ? "rgba(217,119,6,0.16)" : "rgba(100,116,139,0.16)", color: isDup ? "#b45309" : "#475569" }}>{isDup ? "DUPLICATE" : "RESOLVED-BY"}</span>
                              <span>{c.number}</span>
                              <span style={{ color: "var(--muted,#5a6373)" }}>{ci?.shortDescription?.slice(0, 55)}</span>
                            </div>
                          );
                        })}
                      </div>
                      {collateral.length === 0 && <div style={{ fontSize: "0.74rem", color: "var(--muted,#5a6373)" }}>No correlated tickets — only the primary will close.</div>}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {alreadyResolved ? (
                        <>
                          <button onClick={() => runFix(primary, true, collateral, g.primary, { closeOnly: true })} style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: "#16a34a", color: "#fff", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>✓ Close {collateral.length ? `${collateral.length + 1} incidents` : "incident"} — no change needed</button>
                          <button onClick={() => runFix(primary, true, collateral, g.primary)} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid #0ea5a0", background: "var(--card-bg,#fff)", color: "#0ea5a0", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>Apply fix anyway</button>
                        </>
                      ) : (
                        <button onClick={() => runFix(primary, true, collateral, g.primary)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: "#0ea5a0", color: "#fff", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>✓ Confirm — Apply & Close {collateral.length ? `${collateral.length + 1} incidents` : "Incident"}</button>
                      )}
                      <button onClick={() => setFix((p) => ({ ...p, [primary.sysId]: {} }))} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--muted,#5a6373)", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>Cancel</button>
                    </div>
                  </div>
                  );
                })()}
                {f.phase === "done" && f.data && (
                  <div style={{ marginTop: 8, borderLeft: "3px solid #16a34a", paddingLeft: 10, fontSize: "0.82rem" }}>
                    <b>✓ Applied:</b> {f.data.action}.{f.data.incidentClosed?.success ? " Primary closed." : f.data.incidentClosed?.detailsSaved ? " Details saved — close pending." : ""}
                    {(f.data.closedRelated || []).length > 0 && <div style={{ color: "#16a34a" }}>Closed {f.data.closedRelated.filter((x) => x.closed).length}/{f.data.closedRelated.length} correlated ticket(s).</div>}
                  </div>
                )}
                {f.phase === "error" && <div style={{ marginTop: 6, color: "#dc2626", fontSize: "0.8rem" }}>Fix: {f.error}</div>}
              </div>
            );
          })}

          {(A.standalone || []).length > 0 && (
            <div style={{ fontSize: "0.78rem", color: "var(--muted,#5a6373)" }}>
              <b>Unique / unrelated:</b> {(A.standalone || []).join(", ")} — fix individually below.
            </div>
          )}
        </div>
      )}

      {/* ── Raw incident list (when not analyzed) ── */}
      {!A && incidents.map((inc) => {
        const r = rca[inc.sysId] || {};
        const f = fix[inc.sysId] || {};
        return (
          <div key={inc.sysId} style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: 14, background: "var(--card-bg,#fff)", opacity: inc.duplicateOf ? 0.72 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 750, fontSize: "0.9rem" }}>{inc.number}</span>
              {inc.stateLabel && <span style={{ fontSize: "0.68rem", fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "rgba(100,116,139,0.12)", color: "#475569" }}>{inc.stateLabel}</span>}
              {(() => { const rv = reconcile?.results?.[inc.sysId]; if (!rv || rv.error) return null;
                return rv.stillAffected === false
                  ? <span style={{ fontSize: "0.68rem", fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: "rgba(22,163,74,0.14)", color: "#16a34a" }}>✅ resolved in-cluster</span>
                  : <span style={{ fontSize: "0.68rem", fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: "rgba(220,38,38,0.12)", color: "#dc2626" }}>⚠ still failing</span>;
              })()}
              {inc.duplicateOf && <span style={{ fontSize: "0.68rem", fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: "rgba(217,119,6,0.12)", color: "#b45309" }}>🔁 dup of {inc.duplicateOf}</span>}
              {inc.namespace && <span style={{ fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>ns: {inc.namespace}{inc.resource ? " · " + inc.resource : ""}</span>}
              <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>{inc.createdOn}</span>
            </div>
            <div style={{ fontSize: "0.88rem", margin: "6px 0", color: "var(--fg,#151a29)" }}>{inc.shortDescription}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <ClusterPicker inc={inc} />
              <button onClick={() => runRca(inc)} disabled={r.loading || !inc.namespace} title={inc.namespace ? "" : "No namespace/resource on this incident"} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(124,58,237,0.4)", background: "rgba(124,58,237,0.1)", color: "#7c3aed", fontWeight: 700, fontSize: "0.8rem", cursor: inc.namespace ? "pointer" : "not-allowed", opacity: inc.namespace ? 1 : 0.5 }}>{r.loading ? "Analyzing…" : "🔎 Run RCA"}</button>
              <button onClick={() => runFix(inc, false)} disabled={f.phase === "checking" || f.phase === "applying" || !inc.namespace || needsClusterChoice(inc)} title={needsClusterChoice(inc) ? "Choose a cluster first" : inc.namespace ? "Dry-run + validate, then fix + close" : "No namespace/resource on this incident"} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid rgba(14,165,160,0.4)", background: "rgba(14,165,160,0.1)", color: "#0ea5a0", fontWeight: 700, fontSize: "0.8rem", cursor: (inc.namespace && !needsClusterChoice(inc)) ? "pointer" : "not-allowed", opacity: (inc.namespace && !needsClusterChoice(inc)) ? 1 : 0.5 }}>{f.phase === "checking" ? "Validating…" : f.phase === "applying" ? "Applying…" : "⚡ Fix"}</button>
            </div>
            {needsClusterChoice(inc) && <div style={{ fontSize: "0.74rem", color: "#dc2626", marginTop: 6 }}>⚠ No cluster on this incident — choose the target cluster before fixing.</div>}
            {r.error && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>RCA: {r.error}</div>}
            {r.data && (
              <div style={{ marginTop: 10, borderLeft: "3px solid #7c3aed", paddingLeft: 10, fontSize: "0.84rem" }}>
                {r.data.rootCause && <p style={{ margin: "0 0 4px" }}><b>Root cause:</b> {r.data.rootCause}</p>}
                {r.data.recommendation && <p style={{ margin: "0 0 4px" }}><b>Recommended fix:</b> {r.data.recommendation}</p>}
                {r.data.summary && !r.data.rootCause && <p style={{ margin: 0 }}>{r.data.summary}</p>}
              </div>
            )}
            {f.phase === "preview" && f.data && (() => {
              const v = f.validation;
              const alreadyResolved = v && v.stillAffected === false;
              return (
              <div style={{ marginTop: 10, borderLeft: "3px solid #0ea5a0", paddingLeft: 10, fontSize: "0.84rem" }}>
                <b>Planned fix (dry-run):</b> {f.data.action}
                {v && !v.error && (
                  <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: alreadyResolved ? "rgba(22,163,74,0.08)" : "rgba(220,38,38,0.06)", border: `1px solid ${alreadyResolved ? "rgba(22,163,74,0.3)" : "rgba(220,38,38,0.25)"}` }}>
                    <div style={{ fontWeight: 800, fontSize: "0.76rem", color: alreadyResolved ? "#16a34a" : "#dc2626", marginBottom: 4 }}>{alreadyResolved ? "🩺 Live validation: already resolved" : "🩺 Live validation: still failing"}</div>
                    <div style={{ fontSize: "0.78rem" }}>{v.summary}</div>
                    {(v.evidence || []).map((e, i) => <div key={i} style={{ fontSize: "0.74rem", color: "var(--muted,#5a6373)" }}>• {e}</div>)}
                  </div>
                )}
                {v?.error && <div style={{ marginTop: 6, fontSize: "0.74rem", color: "#b45309" }}>Validation skipped: {v.error}</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  {alreadyResolved ? (
                    <>
                      <button onClick={() => runFix(inc, true, [], null, { closeOnly: true })} style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: "#16a34a", color: "#fff", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>✓ Close incident — no change needed</button>
                      <button onClick={() => runFix(inc, true)} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid #0ea5a0", background: "var(--card-bg,#fff)", color: "#0ea5a0", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>Apply fix anyway</button>
                    </>
                  ) : (
                    <button onClick={() => runFix(inc, true)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: "#0ea5a0", color: "#fff", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>✓ Apply Fix & Close Incident</button>
                  )}
                  <button onClick={() => setFix((p) => ({ ...p, [inc.sysId]: {} }))} style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--muted,#5a6373)", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
              );
            })()}
            {f.phase === "done" && f.data && (
              <div style={{ marginTop: 10, borderLeft: "3px solid #16a34a", paddingLeft: 10, fontSize: "0.84rem" }}>
                <b>✓ Applied:</b> {f.data.action}.{f.data.incidentClosed?.success ? " Incident closed in ServiceNow." : f.data.incidentClosed?.detailsSaved ? " Details saved — close pending." : ""}
              </div>
            )}
            {f.phase === "error" && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>Fix: {f.error}</div>}
          </div>
        );
      })}
    </div>
  );
}
