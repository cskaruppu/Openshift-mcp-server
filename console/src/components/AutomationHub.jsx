import { useState, useEffect, useCallback, useRef } from "react";
import { useActiveCluster } from "../store/clusterStore";
import { showToast } from "../store/toastStore";
import FleetAnalysis from "./FleetAnalysis";
import MigrationSelect from "./MigrationSelect";

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
  // Presentation mode: this panel gets demoed on a shared screen, where 0.78rem
  // inside a 1320px modal inside the dashboard chrome is unreadable.
  const [presenting, setPresenting] = useState(() => {
    try { return localStorage.getItem("ah-presenting") === "1"; } catch { return false; }
  });
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("ah-presenting", presenting ? "1" : "0"); } catch { /* private window */ }
  }, [presenting]);

  useEffect(() => {
    if (!open || !presenting) return undefined;
    // Everything here is sized in rem, and rem is relative to <html> — not to a
    // parent — so the scale has to be applied there. Restored on exit, and the
    // dashboard chrome is hidden while it applies, so nothing else is affected.
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = "19.2px";     // 120% of the 16px default
    // Escape leaves presentation mode rather than closing the panel — losing
    // your place mid-demo because you wanted normal text would be worse.
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setPresenting(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.documentElement.style.fontSize = previous;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, presenting]);

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
    <div onClick={presenting ? undefined : onClose} style={{ position: "fixed", inset: 0,
      background: presenting ? "var(--bg,#fff)" : "rgba(10,14,25,0.62)",
      backdropFilter: presenting ? "none" : "blur(7px)", WebkitBackdropFilter: presenting ? "none" : "blur(7px)",
      zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      padding: presenting ? 0 : "24px", animation: "ah-fade .16s ease" }}>
      <style>{`@keyframes ah-fade{from{opacity:0}to{opacity:1}}@keyframes ah-pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
        /* Explanatory prose is essential in the printed pack and noise on a
           screen someone is talking over. Hidden by default while presenting,
           one click away. */
        .ah-terse [data-prose]{display:none !important}`}</style>
      {/* ah-ink re-steps the secondary text token for this subtree only — see
          styles.css. Everything inside the hub reads var(--text2), so one
          class fixes the whole agent rather than sixty inline colours. */}
      <div onClick={(e) => e.stopPropagation()} className={`ah-ink${presenting && !showNotes ? " ah-terse" : ""}`}
        style={{ width: presenting ? "100vw" : agent === "mig" ? "min(1320px, 97vw)" : "min(1040px, 96vw)",
        height: presenting ? "100vh" : "min(760px, 90vh)", minHeight: presenting ? 0 : 520,
        background: "var(--bg, #fff)", border: presenting ? "none" : "1px solid var(--border, #e4e8f1)",
        borderRadius: presenting ? 0 : 18, boxShadow: presenting ? "none" : "0 24px 70px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        animation: presenting ? "none" : "ah-pop .2s cubic-bezier(.2,.7,.3,1)" }}>
        {/* Header with gradient accent */}
        <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "18px 22px", borderBottom: "1px solid var(--border,#e4e8f1)", background: "linear-gradient(90deg, rgba(61,90,254,0.07), rgba(14,165,160,0.05))" }}>
          <span style={{ width: 40, height: 40, borderRadius: 11, background: "linear-gradient(135deg,#3d5afe,#7a3dff 55%,#0ea5a0)", display: "grid", placeItems: "center", fontSize: "1.25rem", boxShadow: "0 6px 16px rgba(61,90,254,0.35)" }}>🤖</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: "1.12rem", color: "var(--fg,#151a29)", letterSpacing: "-0.01em" }}>Automation Hub</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted,#5a6373)" }}>Fleet-wide agent-driven deployment &amp; incident remediation</div>
          </div>
          {presenting && (
            <button onClick={() => setShowNotes((v) => !v)} title="Show or hide the explanatory notes"
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)",
                fontSize: "0.78rem", fontWeight: 700, cursor: "pointer", color: "var(--muted,#5a6373)", fontFamily: "inherit" }}>
              {showNotes ? "Hide notes" : "ⓘ Show notes"}
            </button>
          )}
          <button onClick={() => setPresenting((v) => !v)}
            title={presenting ? "Leave presentation mode (Esc)" : "Full screen, larger text, fewer notes — for screen sharing"}
            style={{ padding: "6px 12px", borderRadius: 8, fontSize: "0.78rem", fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
              border: presenting ? "none" : "1px solid var(--border,#e4e8f1)",
              background: presenting ? "#3d5afe" : "var(--card-bg,#fff)",
              color: presenting ? "#fff" : "var(--muted,#5a6373)" }}>
            {presenting ? "⤢ Exit presentation" : "⤢ Present"}
          </button>
          <button onClick={onClose} title="Close" style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", fontSize: "1.15rem", cursor: "pointer", color: "var(--muted,#5a6373)", lineHeight: 1 }}>×</button>
        </div>
        {/* Segmented agent switcher */}
        <div style={{ padding: "16px 22px 0" }}>
          <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 11, background: "var(--card-bg,#f0f2f8)", border: "1px solid var(--border,#e4e8f1)" }}>
            {[["sop", "🚀 App Deployment Agent"], ["snow", "🎫 ServiceNow Agent"], ["mig", "🚚 VM Migration Agent"]].map(([k, label]) => (
              <button key={k} onClick={() => setAgent(k)} style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: agent === k ? "linear-gradient(135deg,#3d5afe,#5b6cff)" : "transparent", fontWeight: 700, fontSize: "0.86rem", color: agent === k ? "#fff" : "var(--muted,#5a6373)", cursor: "pointer", boxShadow: agent === k ? "0 3px 10px rgba(61,90,254,0.3)" : "none", transition: "all .15s" }}>{label}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "18px 22px 24px" }}>
          {agent === "sop" ? <SopAgent clusters={clusters} activeCluster={activeCluster} />
            : agent === "snow" ? <SnowAgent clusters={clusters} activeCluster={activeCluster} />
            : <MigrationAgent clusters={clusters} activeCluster={activeCluster} />}
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
  const [watch, setWatch] = useState(null);   // terminal pod watch: { on, done, data, error }
  const [pyramid, setPyramid] = useState(null); // production verification: { phase, data, error }
  const [gitUrl, setGitUrl] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [docSource, setDocSource] = useState(null); // { url, fetchedAt } — deploy provenance

  const loadFromGit = async () => {
    setGitBusy(true); setError(null);
    try {
      const res = await fetch("/api/automation/fetch-doc", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: gitUrl.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setRequirement(d.text || "");
      setDocSource(d.source || null);
      setUploadedName(null);
      showToast(`Loaded ${d.chars} chars from Git (${d.format}) — review & generate`, "ok");
    } catch (e) { setError("Git fetch: " + e.message); showToast("Git fetch failed: " + e.message, "err"); }
    finally { setGitBusy(false); }
  };

  // Live pod watch — polls the deployed namespace every 4s while "on",
  // stops automatically once everything is ready.
  const watchNs = namespace || gen?.namespace;
  useEffect(() => {
    if (!watch?.on || !watchNs) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(clusterUrl(`/api/automation/app-status?namespace=${encodeURIComponent(watchNs)}`, cluster));
        const d = await res.json();
        if (stopped) return;
        if (d.error) { setWatch((w) => (w ? { ...w, error: d.error } : w)); return; }
        if (d.allReady) setWatch((w) => (w ? { ...w, on: false, done: true, data: d, error: null } : w));
        else setWatch((w) => (w?.on ? { ...w, data: d, error: null } : w));
      } catch (e) { if (!stopped) setWatch((w) => (w ? { ...w, error: e.message } : w)); }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { stopped = true; clearInterval(id); };
  }, [watch?.on, watchNs, cluster]);

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
    setLoading(true); setError(null); setGen(null); setDeploy(null); setCisChk(null); setImgChk(null); setVerify(null); setWatch(null);
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
    setPyramid(null);
    try {
      const res = await fetch(clusterUrl("/api/automation/deploy", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: editedYaml, manifests: gen.manifests, namespace: namespace || gen.namespace, dryRun, sourceUrl: docSource?.url || null }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.error) throw new Error(d.error);
      setDeploy({ phase: "done", dryRun, result: d });
      setVerify(null);
      // Real deploy → auto-start the terminal pod watch below the result.
      if (!dryRun && (d.applied || []).length > 0) setWatch({ on: true });
      showToast(dryRun ? "Dry-run complete" : `Deployed ${d.applied?.length || 0} object(s)`, d.failed?.length ? "err" : "ok");
    } catch (e) { setDeploy({ phase: "error", error: e.message }); showToast("Deploy failed: " + e.message, "err"); }
  };

  // Production verification pyramid — rollout completion, workload stability,
  // Service→pod wiring, and an HTTP probe of every Route. The last level is
  // the user's acceptance test: the URL they will actually open.
  const runPyramid = useCallback(async () => {
    const ns = namespace || gen?.namespace;
    if (!ns) return;
    setPyramid({ phase: "running" });
    try {
      const res = await fetch(clusterUrl("/api/automation/verify", cluster), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: ns, deployId: deploy?.result?.deployId }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      setPyramid({ phase: "done", data: d });
    } catch (e) { setPyramid({ phase: "error", error: e.message }); }
  }, [namespace, gen?.namespace, cluster, deploy?.result?.deployId]);

  // All pods came up → run the pyramid on its own, so the flow ends at a
  // verified, clickable application rather than at "pods are Ready".
  useEffect(() => {
    if (watch?.done && !pyramid) runPyramid();
  }, [watch?.done, pyramid, runPyramid]);

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

  // The journey strip: where the user is in the flow, derived from live state.
  // Seven stations, ending at the acceptance test — the URL.
  const journey = (() => {
    const dryDone = deploy?.phase === "done" && deploy.dryRun;
    const depDone = deploy?.phase === "done" && !deploy.dryRun;
    const verDone = pyramid?.phase === "done";
    const verOk = verDone && pyramid.data?.passed;
    const steps = [
      { label: "Document", done: !!requirement.trim(), hint: "upload · paste · Git" },
      { label: "Generate", done: !!gen, hint: "doc → manifests" },
      { label: "Review + checks", done: !!gen && (cisChk?.phase === "done" || imgChk?.phase === "done" || dryDone || depDone), hint: "YAML · CIS · CVE" },
      { label: "Dry-run", done: dryDone || depDone, hint: "server validates" },
      { label: "Deploy", done: depDone, hint: "the gate" },
      { label: "Verify", done: verOk, failed: verDone && !verOk, hint: "4-level proof" },
      { label: "Open app", done: verOk && (pyramid?.data?.access || []).some((a) => a.ok), hint: "the URL" },
    ];
    const idx = steps.findIndex((s) => !s.done && !s.failed);
    return { steps, current: idx === -1 ? steps.length - 1 : idx };
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)" }}>Upload a requirement document, or describe/paste the requirement. The agent generates <b>security-hardened, standards-aligned</b> Kubernetes/OpenShift manifests — namespace isolation, least-privilege RBAC, Pod Security "restricted", PVCs, NetworkPolicies and Prometheus monitoring baked in — which you can <b>edit</b>, dry-run, and deploy to any connected cluster.</div>

      {/* Journey strip — always tells the user where they are and what's next */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 0, flexWrap: "wrap", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)" }}>
        {journey.steps.map((st, i) => {
          const isCurrent = i === journey.current && !st.done && !st.failed;
          const c = st.failed ? { fg: "#dc2626", bg: "rgba(220,38,38,0.10)", bd: "#dc2626" }
            : st.done ? { fg: "#16a34a", bg: "rgba(22,163,74,0.10)", bd: "rgba(22,163,74,0.45)" }
            : isCurrent ? { fg: "#3d5afe", bg: "rgba(61,90,254,0.10)", bd: "#3d5afe" }
            : { fg: "var(--muted,#5a6373)", bg: "transparent", bd: "var(--border,#e4e8f1)" };
          return (
            <div key={st.label} style={{ display: "flex", alignItems: "center" }}>
              <div title={st.hint} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 10px", borderRadius: 8, border: `1.5px ${isCurrent ? "solid" : "solid"} ${c.bd}`, background: c.bg, minWidth: 86 }}>
                <span style={{ fontSize: "0.72rem", fontWeight: 800, color: c.fg }}>
                  {st.failed ? "✗" : st.done ? "✓" : i + 1}&nbsp;{st.label}
                </span>
                <span style={{ fontSize: "0.6rem", color: "var(--muted,#5a6373)" }}>{st.hint}</span>
              </div>
              {i < journey.steps.length - 1 && <span style={{ margin: "0 4px", color: "var(--muted,#94a3b8)", fontSize: "0.7rem" }}>▸</span>}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 9, border: "1px dashed #3d5afe", background: "rgba(61,90,254,0.06)", color: "#3d5afe", fontWeight: 700, fontSize: "0.84rem", cursor: uploading ? "wait" : "pointer" }}>
          {uploading ? "Reading…" : "📎 Upload requirement doc"}
          <input type="file" accept=".pdf,.docx,.txt,.md,.markdown,.yaml,.yml,.json,.csv,.log" hidden disabled={uploading} onChange={onUpload} />
        </label>
        {uploadedName && <span style={{ fontSize: "0.8rem", color: "var(--muted,#5a6373)" }}>📄 {uploadedName} loaded ✓</span>}
        <span style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)" }}>.pdf / .docx / .txt / .md supported</span>
      </div>
      {/* Docs-as-code: pull the requirement straight from version control. The
          URL travels with the deploy as provenance. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)}
          placeholder="or load from Git — https://github.com/you/repo/blob/main/requirement.md (.docx works too)"
          style={{ flex: "1 1 340px", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--fg,#151a29)", fontSize: "0.8rem", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace" }} />
        <button onClick={loadFromGit} disabled={gitBusy || !gitUrl.trim()}
          style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #0ea5a0", background: "rgba(14,165,160,0.08)", color: "#0e8a86", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer", opacity: gitBusy || !gitUrl.trim() ? 0.6 : 1 }}>
          {gitBusy ? "Fetching…" : "⤓ Load from Git"}
        </button>
        {docSource && <span style={{ fontSize: "0.74rem", color: "#0e8a86" }}>⎇ versioned source loaded — the deploy record will cite it</span>}
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
              {(deploy.result.deployId || deploy.result.changeRequest) && (
                <span style={{ marginLeft: 8, fontSize: "0.72rem", color: "var(--muted,#5a6373)" }}>
                  {deploy.result.deployId && <>record <code>{deploy.result.deployId}</code></>}
                  {deploy.result.changeRequest && <> · change <b style={{ color: "#7c3aed" }}>{deploy.result.changeRequest}</b></>}
                </span>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
                {(deploy.result.applied || []).map((a, i) => {
                  const isObj = a && typeof a === "object";
                  const label = isObj ? `${a.kind}/${a.name}` : String(a);
                  const action = isObj ? a.action : null;
                  const c = action === "created" ? { bg: "rgba(22,163,74,0.12)", fg: "#16a34a" }
                    : action === "configured" ? { bg: "rgba(61,90,254,0.10)", fg: "#3d5afe" }
                    : { bg: "rgba(100,116,139,0.12)", fg: "#64748b" };
                  return (
                    <span key={i} style={{ fontSize: "0.7rem", fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg }}>
                      {label}{action ? ` · ${action}` : ""}
                    </span>
                  );
                })}
              </div>
              {deploy.result.note && <div style={{ marginTop: 6, fontSize: "0.74rem", color: "#b45309" }}>ℹ {deploy.result.note}</div>}
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

          {/* Live pod status — terminal-style watch (real deploy only) */}
          {deploy?.phase === "done" && !deploy.dryRun && (
            <div style={{ marginTop: 12 }}>
              <style>{`@keyframes ah-blink{0%,49%{opacity:1}50%,100%{opacity:0}}`}</style>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.8rem", fontWeight: 800, color: "var(--fg,#151a29)" }}>🖥 Live application status</span>
                <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: watch?.done ? "rgba(22,163,74,0.14)" : watch?.on ? "rgba(61,90,254,0.12)" : "rgba(100,116,139,0.12)", color: watch?.done ? "#16a34a" : watch?.on ? "#3d5afe" : "#64748b" }}>
                  {watch?.done ? "● complete — all pods ready" : watch?.on ? "● watching (4s)" : "● paused"}
                </span>
                {watch?.on
                  ? <button onClick={() => setWatch((w) => ({ ...w, on: false }))} style={{ padding: "4px 11px", borderRadius: 7, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--muted,#5a6373)", fontWeight: 700, fontSize: "0.74rem", cursor: "pointer" }}>⏸ Pause</button>
                  : <button onClick={() => setWatch((w) => ({ ...(w || {}), on: true, done: false }))} style={{ padding: "4px 11px", borderRadius: 7, border: "1px solid #3d5afe", background: "rgba(61,90,254,0.08)", color: "#3d5afe", fontWeight: 700, fontSize: "0.74rem", cursor: "pointer" }}>{watch?.done ? "↻ Watch again" : "▶ Watch"}</button>}
              </div>
              <div style={{ background: "#0b1120", borderRadius: 10, border: "1px solid #1e293b", padding: "12px 14px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.74rem", lineHeight: 1.7, maxHeight: 320, overflow: "auto", whiteSpace: "pre" }}>
                <div style={{ color: "#7dd3fc" }}>$ oc get pods -n {watchNs} --watch</div>
                {watch?.error && <div style={{ color: "#f87171" }}>error: {watch.error}</div>}
                {!watch?.data && !watch?.error && <div style={{ color: "#94a3b8" }}>connecting to cluster{cluster !== "local" ? ` ${cluster}` : ""}…</div>}
                {watch?.data?.pods && (() => {
                  const rows = watch.data.pods;
                  const nameW = Math.max(4, ...rows.map((r) => r.name.length)) + 3;
                  const statusW = Math.max(6, ...rows.map((r) => r.status.length)) + 3;
                  const color = (s) => /Running|Completed/.test(s) ? "#4ade80" : /BackOff|Err|Error|Failed|OOM|Invalid|CreateContainer|Unschedulable/.test(s) ? "#f87171" : /Terminating/.test(s) ? "#94a3b8" : "#fbbf24";
                  return (
                    <>
                      <div style={{ color: "#cbd5e1", fontWeight: 700 }}>{"NAME".padEnd(nameW)}{"READY".padEnd(8)}{"STATUS".padEnd(statusW)}{"RESTARTS".padEnd(10)}AGE</div>
                      {rows.length === 0 && <div style={{ color: "#94a3b8" }}>No pods yet — waiting for the scheduler…</div>}
                      {rows.map((r) => (
                        <div key={r.name} style={{ color: "#e2e8f0" }}>
                          {r.name.padEnd(nameW)}
                          <span style={{ color: r.ready.split("/")[0] === r.ready.split("/")[1] ? "#4ade80" : "#fbbf24" }}>{r.ready.padEnd(8)}</span>
                          <span style={{ color: color(r.status) }}>{r.status.padEnd(statusW)}</span>
                          <span style={{ color: r.restarts > 3 ? "#f87171" : "#94a3b8" }}>{String(r.restarts).padEnd(10)}</span>
                          <span style={{ color: "#94a3b8" }}>{r.age}</span>
                        </div>
                      ))}
                      {(watch.data.workloads || []).length > 0 && (
                        <div style={{ color: "#64748b", marginTop: 6 }}>{watch.data.workloads.map((w) => `${w.kind}/${w.name} ${w.ready}/${w.desired}`).join("   ")}</div>
                      )}
                      {watch.data.allReady && (watch.data.routes || []).map((rt) => (
                        <div key={rt.name} style={{ color: "#7dd3fc" }}>↗ <a href={`http${rt.tls ? "s" : ""}://${rt.host}`} target="_blank" rel="noreferrer" style={{ color: "#7dd3fc" }}>http{rt.tls ? "s" : ""}://{rt.host}</a></div>
                      ))}
                      <div style={{ marginTop: 6, color: watch.data.allReady ? "#4ade80" : watch.data.failing ? "#f87171" : "#fbbf24" }}>
                        {watch.data.allReady
                          ? `🟢 All pods ready — application is up.`
                          : watch.data.failing
                            ? `🔴 ${watch.data.failing} pod(s) failing — waiting for recovery…`
                            : `🟡 Rolling out — waiting for pods to become ready…`}
                        {watch.on && <span style={{ animation: "ah-blink 1s step-end infinite" }}> █</span>}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Production verification pyramid — runs automatically once all pods
              are ready, and ends at the user's acceptance test: the URL. */}
          {deploy?.phase === "done" && !deploy.dryRun && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--border,#e4e8f1)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>✅ Production verification</span>
                {pyramid?.phase === "done" && (
                  <span style={{ fontSize: "0.72rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: pyramid.data.passed ? "rgba(22,163,74,0.14)" : "rgba(220,38,38,0.12)", color: pyramid.data.passed ? "#16a34a" : "#dc2626" }}>
                    {pyramid.data.passed ? "ALL LEVELS PASSED" : "NOT YET PASSING"}
                  </span>
                )}
                <button onClick={runPyramid} disabled={pyramid?.phase === "running"} style={{ padding: "6px 13px", borderRadius: 8, border: "1px solid #16a34a", background: "rgba(22,163,74,0.08)", color: "#16a34a", fontWeight: 700, fontSize: "0.78rem", cursor: "pointer", opacity: pyramid?.phase === "running" ? 0.7 : 1 }}>
                  {pyramid?.phase === "running" ? "Verifying…" : pyramid ? "↻ Re-verify" : "▶ Verify now"}
                </button>
                <span style={{ fontSize: "0.74rem", color: "var(--muted,#5a6373)" }}>Rollout → stability → service wiring → live URL check{watch?.done ? " (auto-ran when pods came up)" : ""}</span>
              </div>
              {pyramid?.phase === "error" && <div style={{ marginTop: 8, color: "#dc2626", fontSize: "0.82rem" }}>Verification error: {pyramid.error}</div>}
              {pyramid?.phase === "done" && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 8, marginTop: 10 }}>
                    {(pyramid.data.levels || []).map((l, i) => (
                      <div key={l.id} style={{ border: `1px solid ${l.passed ? "rgba(22,163,74,0.35)" : "rgba(220,38,38,0.35)"}`, borderRadius: 10, padding: "9px 11px", background: "var(--card-bg,#fff)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{ fontWeight: 800, fontSize: "0.9rem", color: l.passed ? "#16a34a" : "#dc2626" }}>{l.passed ? "✓" : "✗"}</span>
                          <span style={{ fontWeight: 800, fontSize: "0.76rem" }}>{i + 1}. {l.title}</span>
                        </div>
                        {(l.checks || []).map((c, j) => (
                          <div key={j} style={{ fontSize: "0.75rem", color: c.passed ? "var(--muted,#5a6373)" : "#dc2626", marginTop: 3, lineHeight: 1.4 }}>
                            {c.passed ? "•" : "✗"} <b>{c.name}</b> — {c.detail}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  {/* Final touch: the application, as the user will reach it */}
                  {(pyramid.data.access || []).length > 0 && (
                    <div style={{ marginTop: 10, border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: "11px 13px", background: "var(--card-bg,#fff)" }}>
                      <div style={{ fontWeight: 800, fontSize: "0.8rem", marginBottom: 7 }}>🌐 Your application</div>
                      {pyramid.data.access.map((a) => (
                        <div key={a.url} style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginTop: 5 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 999, background: a.ok ? "#16a34a" : "#dc2626", flex: "0 0 auto" }} />
                          <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.8rem", fontWeight: 700, color: "#3d5afe", textDecoration: "none", wordBreak: "break-all" }}>{a.url}</a>
                          <span style={{ fontSize: "0.7rem", color: a.ok ? "var(--muted,#5a6373)" : "#dc2626" }}>{a.label}{a.latencyMs != null && a.statusCode != null ? ` · ${a.latencyMs}ms` : ""}</span>
                          {a.ok && (
                            <a href={a.url} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", padding: "4px 12px", borderRadius: 7, background: "#16a34a", color: "#fff", fontWeight: 700, fontSize: "0.72rem", textDecoration: "none" }}>Open application ↗</a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

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
          body: JSON.stringify({ sysId: inc.sysId, namespace: inc.namespace, resource: inc.resource, dryRun: !apply, alsoClose, primaryNumber, closeOnly: opts.closeOnly === true, symptom: inc.shortDescription }),
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
                  <span style={{ width: 18, height: 18, borderRadius: 999, background: "#3d5afe", color: "#fff", fontSize: "0.73rem", fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0 }}>{i + 1}</span>
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
                  <span style={{ fontSize: "0.72rem", fontWeight: 800, padding: "2px 7px", borderRadius: 5, background: "#16a34a", color: "#fff" }}>ROOT / FIX FIRST</span>
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
                          <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "1px 6px", borderRadius: 4, background: "#16a34a", color: "#fff" }}>PRIMARY</span>
                          <b>{g.primary}</b>
                          <span style={{ color: "var(--muted,#5a6373)" }}>{primary?.shortDescription?.slice(0, 60)}</span>
                        </div>
                        {collateral.map((c) => {
                          const ci = byNumber[c.number];
                          const isDup = (g.duplicates || []).includes(c.number);
                          return (
                            <div key={c.number} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "0.78rem" }}>
                              <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "1px 6px", borderRadius: 4, background: isDup ? "rgba(217,119,6,0.16)" : "rgba(100,116,139,0.16)", color: isDup ? "#b45309" : "#475569" }}>{isDup ? "DUPLICATE" : "RESOLVED-BY"}</span>
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
              {inc.stateLabel && <span style={{ fontSize: "0.73rem", fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "rgba(100,116,139,0.12)", color: "#475569" }}>{inc.stateLabel}</span>}
              {(() => { const rv = reconcile?.results?.[inc.sysId]; if (!rv || rv.error) return null;
                return rv.stillAffected === false
                  ? <span style={{ fontSize: "0.73rem", fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: "rgba(22,163,74,0.14)", color: "#16a34a" }}>✅ resolved in-cluster</span>
                  : <span style={{ fontSize: "0.73rem", fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: "rgba(220,38,38,0.12)", color: "#dc2626" }}>⚠ still failing</span>;
              })()}
              {inc.duplicateOf && <span style={{ fontSize: "0.73rem", fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: "rgba(217,119,6,0.12)", color: "#b45309" }}>🔁 dup of {inc.duplicateOf}</span>}
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

/* ── VM Migration Agent (UC-10): MTV readiness → discover → plan → migrate ──
   Migration is list-driven and bulk, which is why it lives here as a workbench
   rather than as a chat card: you pick six VMs out of forty, not one VM out of
   a sentence. The gate chain mirrors the VM Request card so an operator who
   knows one already knows the other.                                        */
/* ── Where this plan is, end to end ───────────────────────────────────────────
   Warm and cold are drawn as different routes because they are different
   routes. A cold migration powers the guest off at the start and the outage is
   the whole transfer; a warm one keeps it serving users and spends the outage
   at the very end. One stepper with a flag would promise a cutover step on a
   plan that never has one. */
function Journey({ j }) {
  return (
    <div style={{ marginTop: 7 }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 4, flexWrap: "wrap" }}>
        {j.steps.map((s, i) => {
          const done = i < j.at, here = i === j.at;
          const bad = j.failed && here;
          return (
            <div key={s.key} title={s.detail} style={{
              flex: "1 1 110px", minWidth: 96, padding: "5px 8px", borderRadius: 7, fontSize: "0.74rem",
              background: bad ? "rgba(220,38,38,.1)" : done ? "rgba(22,163,74,.1)" : here ? "rgba(61,90,254,.1)" : "rgba(127,127,127,.07)",
              border: `1px solid ${bad ? "rgba(220,38,38,.4)" : done ? "rgba(22,163,74,.3)" : here ? "rgba(61,90,254,.4)" : "transparent"}`,
            }}>
              <div style={{ fontWeight: 700, color: bad ? "#dc2626" : done ? "#16a34a" : here ? "#3d5afe" : "var(--text2)" }}>
                {bad ? "✖" : done ? "✓" : here ? "▸" : "·"} {s.label}
              </div>
              {/* The step in front of you is the only one worth explaining
                  in place; the rest are a tooltip away. */}
              {here && <div data-prose style={{ color: "var(--text2)", marginTop: 1, lineHeight: 1.35 }}>{s.detail}</div>}
            </div>
          );
        })}
      </div>
      {j.next && <div style={{ fontSize: "0.76rem", marginTop: 4, fontWeight: 600 }}>{j.next}</div>}
    </div>
  );
}

/* ── Post-migration verification ──────────────────────────────────────────────
   The Plan saying "Succeeded" means the copy finished. It says nothing about
   whether the guest booted, kept its address, kept its disks, or — the one that
   actually costs money — whether the source is switched off.

   An unrun check is shown as unrun. A verification that could not reach the
   source platform reports "not confirmed", never "powered off": the whole value
   of this panel is that it can be believed. */
function VerifyPanel({ planName, result, busy, onRun }) {
  const loadedFor = useRef(null);
  useEffect(() => {
    if (loadedFor.current !== planName) { loadedFor.current = planName; onRun(); }
  }, [planName]);   // eslint-disable-line react-hooks/exhaustive-deps

  const TONE = {
    pass:      { icon: "✓", color: "#16a34a" },
    warn:      { icon: "⚠", color: "#b45309" },
    fail:      { icon: "✖", color: "#dc2626" },
    unchecked: { icon: "?", color: "#64748b" },
  };
  const VERDICT = {
    passed:                 { color: "#16a34a", bg: "rgba(22,163,74,.08)", border: "rgba(22,163,74,.35)" },
    "passed-with-warnings": { color: "#b45309", bg: "rgba(245,158,11,.08)", border: "rgba(245,158,11,.35)" },
    incomplete:             { color: "#64748b", bg: "rgba(100,116,139,.08)", border: "rgba(100,116,139,.35)" },
    failed:                 { color: "#dc2626", bg: "rgba(220,38,38,.08)", border: "rgba(220,38,38,.35)" },
  };
  const v = VERDICT[result?.verdict] || VERDICT.incomplete;

  return (
    <div style={{ marginTop: 7, padding: "9px 11px", borderRadius: 8, background: v.bg, border: `1px solid ${v.border}` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <b style={{ color: v.color, fontSize: "0.79rem" }}>
          {result ? `Verification — ${result.verdict?.replace(/-/g, " ")}` : "Verifying…"}
        </b>
        {result?.coverage && (
          <span style={{ color: "var(--text2)", fontSize: "0.75rem" }}>
            {result.coverage.ran} of {result.coverage.total} checks ran
          </span>
        )}
        <button onClick={onRun} disabled={busy} style={{ marginLeft: "auto", padding: "3px 10px", borderRadius: 7,
          border: "1px solid var(--border,#e4e8f1)", background: "transparent", color: "var(--text2)",
          fontFamily: "inherit", fontSize: "0.75rem", fontWeight: 700, cursor: busy ? "wait" : "pointer" }}>
          {busy ? "…" : "↻ Re-check"}
        </button>
      </div>
      {result?.headline && <div style={{ fontSize: "0.78rem", marginTop: 3, fontWeight: 600 }}>{result.headline}</div>}
      {result?.error && <div style={{ fontSize: "0.77rem", marginTop: 3, color: "#dc2626" }}>{result.error}</div>}

      {(result?.vmChecks || []).map((vm) => (
        <div key={vm.name} style={{ marginTop: 7, paddingTop: 6, borderTop: "1px solid var(--border,#e4e8f1)" }}>
          <b style={{ fontSize: "0.78rem" }}>{vm.name}</b>
          {vm.checks.map((c) => {
            const t = TONE[c.state] || TONE.unchecked;
            return (
              <div key={c.id} style={{ display: "flex", gap: 7, marginTop: 3, fontSize: "0.76rem" }}>
                <span aria-hidden style={{ color: t.color, fontWeight: 800 }}>{t.icon}</span>
                <div>
                  <span style={{ fontWeight: 600 }}>{c.label}</span>{" "}
                  <span style={{ color: "var(--text2)" }}>{c.detail || c.why}</span>
                  {c.action && <div style={{ marginTop: 1 }}>→ {c.action}</div>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ── Decommission ─────────────────────────────────────────────────────────────
   The last step, and the only irreversible one. Everything up to here can be
   undone by powering the source VMs back on — MTV switched them off and never
   deleted them. Once they are gone, that is no longer true.

   So this panel is deliberately reluctant. It refuses while verification is
   failed or incomplete, it counts out a soak period rather than offering a
   button the day the copy finished, and what it produces is a REQUEST, not a
   deletion: the agent has read-only access to VMware and the audit trail for an
   irreversible act belongs with whoever owns the platform. */
function DecommissionPanel({ planName, posture, busy, onLoad, onRaise }) {
  const loadedFor = useRef(null);
  useEffect(() => {
    if (loadedFor.current !== planName) { loadedFor.current = planName; onLoad(); }
  }, [planName]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!posture?.found) return null;

  const { gate, blockers = [], soak, ready } = posture;
  const box = (bg, br) => ({ marginTop: 7, padding: "9px 11px", borderRadius: 8, background: bg, border: `1px solid ${br}` });

  if (gate?.raised) {
    const good = gate.approved;
    return (
      <div style={box(good ? "rgba(22,163,74,.07)" : "rgba(100,116,139,.07)", good ? "rgba(22,163,74,.3)" : "rgba(100,116,139,.3)")}>
        <b style={{ fontSize: "0.79rem", color: good ? "#16a34a" : "#64748b" }}>
          {good ? "✓" : "◷"} Decommission — {gate.number} · {gate.state}
        </b>
        <div style={{ fontSize: "0.77rem", color: "var(--text2)", marginTop: 2 }}>{gate.next}</div>
      </div>
    );
  }

  return (
    <div style={box("rgba(100,116,139,.06)", "rgba(100,116,139,.3)")}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: "0.79rem" }}>Retire the source VMs</b>
        <span style={{ fontSize: "0.76rem", color: "var(--text2)" }}>{posture.next}</span>
      </div>
      {blockers.map((b) => (
        <div key={b.code} style={{ fontSize: "0.76rem", color: "#b45309", marginTop: 3 }}>⚠ {b.message}</div>
      ))}
      {!blockers.length && soak && (
        <div style={{ fontSize: "0.76rem", color: "var(--text2)", marginTop: 3 }}>{soak.note}</div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button disabled={busy || blockers.length > 0} onClick={() => onRaise(false)}
          title={blockers.length ? blockers[0].message : "Raises a second change request. Deletes nothing."}
          style={{ padding: "5px 13px", borderRadius: 8, border: "none", fontWeight: 700, fontSize: "0.79rem",
            fontFamily: "inherit", background: blockers.length ? "#9ca3af" : "#3d5afe", color: "#fff",
            cursor: busy ? "wait" : blockers.length ? "not-allowed" : "pointer" }}>
          ⤴ Raise decommission request
        </button>
        {/* The soak is a policy, not a safety interlock — it can be waived,
            and the waiver is named in the change record. A failed or
            incomplete verification cannot be waived from here at all. */}
        {!ready && !blockers.length && !soak?.soaked && (
          <button disabled={busy} onClick={() => onRaise(true)}
            style={{ padding: "5px 11px", borderRadius: 8, fontWeight: 700, fontSize: "0.76rem", fontFamily: "inherit",
              background: "transparent", color: "#b45309", border: "1px solid rgba(245,158,11,.5)", cursor: "pointer" }}>
            Waive the {soak?.days}-day soak
          </button>
        )}
        <span data-prose style={{ fontSize: "0.74rem", color: "var(--text2)" }}>
          This raises a change request. It deletes nothing — the VMware team carries it out, and until they do,
          powering the source back on is still the way back.
        </span>
      </div>
    </div>
  );
}

/* ── The cutover stage ────────────────────────────────────────────────────────
   A warm migration stops here on purpose. The copy is done; the guest is still
   serving users; nothing else happens until someone says the guest may go down.

   Every other tool in this space puts a "Cutover" button here and lets you press
   it whenever. That is how a VM gets taken down at 3pm on a Tuesday. The outage
   is what the change request asked the board to approve, so this panel answers
   in that order — what is waiting, what was approved, and only then what may be
   done — and the two things it offers are "now" and "when the window opens",
   because scheduling is what stops someone having to sit up until midnight. */
/** datetime-local speaks local wall-clock with no zone, so the value has to be
    built in local time — toISOString() would silently shift it by the offset. */
function forInput(ms) {
  const dt = new Date(ms);
  return new Date(ms - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function CutoverPanel({ planName, posture, busy, onLoad, onGo }) {
  const loadedFor = useRef(null);
  // EVERY hook runs before the early return below. Putting the picker's state
  // after it meant this component ran two hooks while the posture was loading
  // and three once it arrived — React #310, a blank screen with a minified
  // error, on the first click into the agent.
  const [override, setOverride] = useState("");
  useEffect(() => {
    if (loadedFor.current !== planName) {
      loadedFor.current = planName;
      // A new plan's picker starts from that plan's own default, not from
      // whatever was typed for the last one.
      setOverride("");
      onLoad();
    }
  }, [planName]);   // eslint-disable-line react-hooks/exhaustive-deps

  const box = { marginTop: 7, padding: "9px 11px", borderRadius: 8,
    background: "rgba(245,158,11,.07)", border: "1px solid rgba(245,158,11,.35)" };
  if (!posture) return <div style={{ ...box, fontSize: "0.77rem", color: "var(--text2)" }}>Reading the approved change window…</div>;

  const { state, window: win, decision: d, scheduled } = posture;
  const when = (t) => (t ? new Date(t).toLocaleString() : "—");
  // The state holds only what the operator typed. The value shown falls back to
  // the moment the panel would choose on its own, so "Schedule" with no edit
  // does exactly what the button beside it says — and no effect is needed to
  // keep the two in sync once the posture arrives.
  const pick = override || (d?.at ? forInput(Date.parse(d.at)) : "");
  const chosenBudget = pick && posture.budget
    ? snapshotCost(posture.precopyDoneAt, new Date(pick).getTime(), posture.budget.max)
    : posture.budget;
  const btn = (bg) => ({ padding: "5px 13px", borderRadius: 8, border: "none", fontWeight: 700,
    fontSize: "0.79rem", fontFamily: "inherit", cursor: busy ? "wait" : "pointer", background: bg, color: "#fff" });

  // Already stamped on the Migration: MTV will do it with nobody present, so
  // the panel stops asking for anything and just says when.
  if (scheduled) {
    return (
      <div style={{ ...box, background: "rgba(14,165,160,.07)", borderColor: "rgba(14,165,160,.35)" }}>
        <b style={{ color: "#0ea5a0", fontSize: "0.79rem" }}>◷ Cutover scheduled — {when(scheduled)}</b>
        <div data-prose style={{ fontSize: "0.76rem", color: "var(--text2)", marginTop: 3 }}>
          MTV performs the cutover at that moment on its own. Nobody needs to be watching this screen, and the
          change record carries the same timestamp.
        </div>
      </div>
    );
  }

  return (
    <div style={box}>
      <b style={{ color: "#b45309", fontSize: "0.79rem" }}>
        ◷ Waiting for cutover · {state.vms.map((v) => v.name).join(", ")}
      </b>
      <div data-prose style={{ fontSize: "0.76rem", color: "var(--text2)", marginTop: 3 }}>{state.reason}</div>

      {/* What the board approved. Stated even when it is nothing, because
          "no window recorded" and "outside the window" are different facts and
          must never look the same. */}
      <div style={{ fontSize: "0.76rem", marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, color: win.known ? (win.open ? "#16a34a" : "#b45309") : "#64748b" }}>
          {win.known ? (win.open ? "✓ Inside the approved window" : win.expired ? "✖ Window closed" : "◷ Window not open yet") : "• No window on the change record"}
        </span>
        {win.known && <span style={{ color: "var(--text2)" }}>{when(win.start)} → {when(win.end)}</span>}
        {/* The window and the outage are different promises and are shown as
            two numbers. A four-hour window in which the service is down for
            seven minutes is a normal change request; conflating them makes it
            read as a four-hour outage. */}
        {win.known && win.start && win.end && (
          <span style={{ color: "var(--text2)" }}>
            · {(Math.round((Date.parse(win.end) - Date.parse(win.start)) / 60000) / 60).toFixed(1)}h authorised
          </span>
        )}
      </div>
      <div style={{ fontSize: "0.76rem", color: "var(--text2)", marginTop: 2 }}>{d.reason}</div>
      {d.fix && <div style={{ fontSize: "0.76rem", marginTop: 2 }}>→ {d.fix}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button disabled={busy || !d.allowed || d.mode !== "now"} onClick={() => onGo(null)}
          title={d.mode === "now" ? "Shut the guests down and finish the migration" : d.reason}
          style={{ ...btn(d.allowed && d.mode === "now" ? "#dc2626" : "#9ca3af"),
            cursor: d.allowed && d.mode === "now" ? btn().cursor : "not-allowed" }}>
          ⏻ Power off &amp; cut over now
        </button>
        {d.mode === "schedule" && (
          <button disabled={busy} onClick={() => onGo(d.at)} style={btn("#3d5afe")}>
            ◷ At the window opening — {when(d.at)}
          </button>
        )}
      </div>

      {/* ── Or a moment of your choosing ─────────────────────────────────────
          "Now" and "when the window opens" are the two common answers; they are
          not the only ones. A person who knows their traffic drops at 02:00
          should be able to say so without waiting up for it.

          The picker is CLAMPED to the approved window rather than validated
          after the fact, so the out-of-window choice is not offered in the
          first place. The server checks both ends again regardless — an input
          attribute is a convenience, never the gate. */}
      {d.allowed && win.known && win.start && win.end && (
        <div style={{ display: "flex", gap: 8, marginTop: 7, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: "0.77rem", fontWeight: 600 }}>Or cut over at</label>
          <input
            type="datetime-local"
            value={pick}
            min={forInput(Math.max(Date.now(), Date.parse(win.start)))}
            max={forInput(Date.parse(win.end))}
            onChange={(e) => setOverride(e.target.value)}
            style={{ padding: "4px 8px", borderRadius: 7, fontFamily: "inherit", fontSize: "0.78rem",
              border: "1px solid var(--border,#e4e8f1)", background: "var(--card,#fff)", color: "inherit" }}
          />
          <button disabled={busy || !pick} onClick={() => onGo(new Date(pick).toISOString())}
            style={{ ...btn(pick ? "#3d5afe" : "#9ca3af"), cursor: pick ? btn().cursor : "not-allowed" }}>
            ◷ Schedule
          </button>
          <span style={{ fontSize: "0.75rem", color: "var(--text2)" }}>
            within {when(win.start)} → {when(win.end)}
          </span>
        </div>
      )}

      {/* Waiting is not free on a warm migration, and the cost is invisible
          until it bites. Shown against the moment currently chosen. */}
      {chosenBudget?.known && chosenBudget.risk !== "fine" && (
        <div style={{ marginTop: 6, fontSize: "0.77rem",
          color: chosenBudget.risk === "over" ? "#dc2626" : "#b45309" }}>
          {chosenBudget.risk === "over" ? "✖" : "⚠"} {chosenBudget.note}
        </div>
      )}

      <div data-prose style={{ fontSize: "0.74rem", color: "var(--text2)", marginTop: 6 }}>
        The guest shuts down, the last changed blocks copy, the VM starts on OpenShift. Until then it keeps serving users.
      </div>
    </div>
  );
}

/* The work the assessment does, in the order it does it. Named steps rather
   than a percentage: the request is a single call, so a progress bar would be
   inventing a number. What a waiting person actually wants to know is what it
   is doing and whether it has stopped, and a named step answers both. */
const ANALYSIS_PHASES = [
  "Reading the source inventory",
  "Matching guest operating systems against the Red Hat support matrix",
  "Running the source-side readiness checks",
  "Checking whether the target cluster has room",
  "Comparing resource guarantees before and after",
  "Asking the model for a migration method per machine",
  "Assembling the report",
];

/* Shown while the assessment runs. A spinner says "wait"; this says what it is
   doing, how much of it there is, and — if it takes long enough to worry
   about — that it is the model that is slow, not the tool that is broken. */
export function AnalysisProgress({ count, phase, slow }) {
  return (
    <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span aria-hidden style={{ width: 14, height: 14, borderRadius: 999, border: "2px solid rgba(61,90,254,.25)",
          borderTopColor: "#3d5afe", display: "inline-block", animation: "ah-spin .8s linear infinite" }} />
        <b style={{ fontSize: "0.88rem" }}>Analysing {count} virtual machine{count === 1 ? "" : "s"}…</b>
        <span style={{ color: "var(--text2)", fontSize: "0.78rem" }}>
          This runs against the source inventory and the target cluster, so it takes a moment.
        </span>
      </div>
      <style>{"@keyframes ah-spin{to{transform:rotate(360deg)}}"}</style>

      <div style={{ marginTop: 11 }}>
        {ANALYSIS_PHASES.map((label, i) => {
          const done = i < phase, here = i === phase;
          return (
            <div key={label} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0",
              fontSize: "0.79rem", color: done ? "var(--text)" : here ? "var(--text)" : "var(--text2)",
              opacity: done || here ? 1 : 0.55 }}>
              <span aria-hidden style={{ color: done ? "#16a34a" : here ? "#3d5afe" : "var(--text2)", fontWeight: 800 }}>
                {done ? "✓" : here ? "▸" : "·"}
              </span>
              <span style={{ fontWeight: here ? 700 : 400 }}>{label}</span>
            </div>
          );
        })}
      </div>

      {/* Never leave someone waiting with no explanation and no way out. */}
      {slow && (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: "0.78rem",
          background: "rgba(245,158,11,.09)", border: "1px solid rgba(245,158,11,.35)" }}>
          <b style={{ color: "#b45309" }}>This is taking longer than usual.</b>{" "}
          <span style={{ color: "var(--text2)" }}>
            The assessment itself is rules-based and fast; the wait is almost always the language model being asked for a
            migration method per machine. The report will arrive with rules-only recommendations if the model does not answer.
          </span>
        </div>
      )}

      {/* A skeleton of what is coming, so the page does not jump when it lands. */}
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 9 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ height: 74, borderRadius: 10, background: "rgba(127,127,127,.07)",
            border: "1px solid var(--border,#e4e8f1)" }} />
        ))}
      </div>
    </div>
  );
}

/** The states a plan can be in, named the same way everywhere they appear. */
const PHASE = {
  validating:         { label: "validating", bg: "rgba(100,116,139,.12)", fg: "#64748b" },
  ready:              { label: "ready",      bg: "rgba(61,90,254,.12)",   fg: "#3d5afe" },
  transferring:       { label: "transferring", bg: "rgba(245,158,11,.14)", fg: "#b45309" },
  "awaiting-cutover": { label: "awaiting cutover", bg: "rgba(245,158,11,.18)", fg: "#b45309" },
  migrated:           { label: "migrated",   bg: "rgba(22,163,74,.14)",   fg: "#16a34a" },
  failed:             { label: "failed",     bg: "rgba(220,38,38,.12)",   fg: "#dc2626" },
};

/* Mirrors cbtSnapshotBudget on the server so the warning tracks the picker as
   it is edited. The server's answer is the one that counts; this only decides
   whether to show a caution before anyone commits to a time. */
function snapshotCost(precopyDoneAt, atMs, max = 28) {
  const from = precopyDoneAt ? Date.parse(precopyDoneAt) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(atMs)) return null;
  const waitHours = Math.max(0, (atMs - from) / 3600000);
  const used = Math.ceil(waitHours);
  const risk = used >= max ? "over" : used >= max * 0.75 ? "tight" : "fine";
  return {
    known: true, waitHours: Math.round(waitHours * 10) / 10, snapshotsUsed: used, max, risk,
    note: risk === "over"
      ? `Waiting ${Math.round(waitHours)}h needs about ${used} changed-block snapshots and a VM supports ${max}. The migration is likely to fail after having copied everything. Cut over sooner.`
      : risk === "tight"
        ? `Waiting ${Math.round(waitHours)}h uses roughly ${used} of the ${max} changed-block snapshots this VM can hold. It will probably work, with little margin.`
        : null,
  };
}

/* Choosing the change window.
   Blank means "use the proposal", which is the common case and stays one
   click. Filling it in is for the person who knows the maintenance calendar —
   a freeze period, a month-end, a window the board has already agreed. The
   server validates whatever arrives, so this form is a convenience and never
   the check. */
function CrWindowPicker({ value, warm, onChange }) {
  const [open, setOpen] = useState(false);
  const fmt = (ms) => {
    const d = new Date(ms);
    return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const set = (k, v) => onChange({ ...(value || {}), [k]: v ? new Date(v).toISOString() : "" });

  if (!open) {
    return (
      <div style={{ fontSize: "0.76rem", marginTop: 5, color: "var(--text2)" }}>
        The change request will be raised with a window sized from this plan
        {warm ? " — a same-day cutover, because a warm precopy spends a changed-block snapshot for every hour it waits" : ""}.{" "}
        <button onClick={() => setOpen(true)} style={{ background: "none", border: "none", padding: 0,
          font: "inherit", color: "#3d5afe", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>
          Choose the window myself
        </button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6,
      padding: "7px 9px", borderRadius: 8, background: "rgba(61,90,254,.06)", border: "1px solid rgba(61,90,254,.3)" }}>
      <span style={{ fontSize: "0.77rem", fontWeight: 700 }}>Change window</span>
      <input type="datetime-local" min={fmt(Date.now())}
        value={value?.start ? fmt(Date.parse(value.start)) : ""}
        onChange={(e) => set("start", e.target.value)}
        style={{ padding: "4px 8px", borderRadius: 7, fontFamily: "inherit", fontSize: "0.78rem",
          border: "1px solid var(--border,#e4e8f1)", background: "var(--card,#fff)", color: "inherit" }} />
      <span style={{ color: "var(--text2)" }}>→</span>
      <input type="datetime-local" min={value?.start ? fmt(Date.parse(value.start)) : fmt(Date.now())}
        value={value?.end ? fmt(Date.parse(value.end)) : ""}
        onChange={(e) => set("end", e.target.value)}
        style={{ padding: "4px 8px", borderRadius: 7, fontFamily: "inherit", fontSize: "0.78rem",
          border: "1px solid var(--border,#e4e8f1)", background: "var(--card,#fff)", color: "inherit" }} />
      <button onClick={() => { onChange(null); setOpen(false); }}
        style={{ background: "none", border: "none", padding: 0, font: "inherit",
          color: "var(--text2)", cursor: "pointer", textDecoration: "underline", fontSize: "0.76rem" }}>
        use the proposal instead
      </button>
      {value?.start && value?.end && (
        <span style={{ fontSize: "0.75rem", color: "var(--text2)" }}>
          {((Date.parse(value.end) - Date.parse(value.start)) / 3600000).toFixed(1)}h authorised
        </span>
      )}
    </div>
  );
}

/** Megabytes, the unit MTV's own console reports a disk transfer in. */
function mib(n) { return Math.round((n || 0) / 1048576).toLocaleString(); }

function MigrationAgent({ clusters, activeCluster }) {
  const [cluster, setCluster] = useState(activeCluster || "local");
  const [ready, setReady] = useState(null);            // readiness report
  const [showReady, setShowReady] = useState(true);
  const [provider, setProvider] = useState("");
  const [vms, setVms] = useState(null);                // discovered inventory
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState({});                  // vmId -> "warm" | "cold"
  const [target, setTarget] = useState({ storageMap: "", networkMap: "", targetNamespace: "", targetProvider: "" });
  const [preview, setPreview] = useState(null);        // plan grouping
  const [plans, setPlans] = useState([]);              // created plans
  const [status, setStatus] = useState({});            // planName -> status
  const [rollback, setRollback] = useState(null);      // { planName, decision }
  const [cutovers, setCutovers] = useState({});        // planName -> cutover posture
  const [verifs, setVerifs] = useState({});            // planName -> verification result
  const [decoms, setDecoms] = useState({});            // planName -> decommission posture
  const [crWindow, setCrWindow] = useState({});        // planName -> { start, end } chosen by the operator
  const [advice, setAdvice] = useState(null);          // { source, advice[] }
  const [history, setHistory] = useState(null);        // every plan on the cluster
  const [phase, setPhase] = useState(0);               // which analysis step is showing
  const [slowAnalysis, setSlowAnalysis] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(null);
  // The workbench is a three-step wizard: pick what moves, understand whether
  // it CAN move, then move it. Each step is a decision the next one depends on,
  // so they are pages rather than one long scroll.
  // Four steps, because they are four decisions: what is out there, can it
  // move, what goes in this wave, and may we start.
  const [step, setStep] = useState(1);                 // 1 discover | 2 analyse | 3 select | 4 plan
  const [analysis, setAnalysis] = useState(null);      // roll-up of everything discovered
  const [estimate, setEstimate] = useState(null);      // measured transfer estimate for the wave

  const cUrl = (p) => clusterUrl(p, cluster);
  const get = async (p) => (await fetch(cUrl(p))).json();
  const post = async (p, body) => (await fetch(cUrl(p), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  })).json();

  // Readiness first — everything below is meaningless if MTV is not usable.
  const loadReadiness = useCallback(async () => {
    setBusy("ready");
    try {
      const d = await get("/api/migration/readiness");
      setReady(d);
      setShowReady(!d.ok);                 // collapse once green
      const src = (d.sources || [])[0], tgt = (d.targets || [])[0];
      if (src && !provider) setProvider(src.uid);
      setTarget((t) => ({
        ...t,
        targetProvider: t.targetProvider || tgt?.name || "",
        storageMap: t.storageMap || (d.storageMaps || [])[0]?.name || "",
        networkMap: t.networkMap || (d.networkMaps || [])[0]?.name || "",
      }));
    } catch (e) { setReady({ ok: false, blocking: [{ message: e.message }] }); }
    finally { setBusy(null); }
  }, [cluster]);            // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadReadiness(); }, [loadReadiness]);

  const discover = async () => {
    if (!provider) return;
    setBusy("discover"); setVms(null);
    try {
      const d = await get(`/api/migration/vms?provider=${encodeURIComponent(provider)}&search=${encodeURIComponent(search)}`);
      setVms(d.vms || []);
      if (d.error) showToast(d.error, "err");
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const selection = (vms || [])
    .filter((v) => sel[v.id || v.name])
    .map((v) => ({
      vm: v, strategy: sel[v.id || v.name],
      sourceProvider: (ready?.sources || []).find((p) => p.uid === provider)?.name || "",
      storageMap: target.storageMap, networkMap: target.networkMap, targetNamespace: target.targetNamespace,
    }));

  // Show the grouping MTV will actually enforce, as the selection changes.
  useEffect(() => {
    if (selection.length === 0) { setPreview(null); return; }
    let stop = false;
    post("/api/migration/plan-preview", { selection })
      .then((d) => { if (!stop) setPreview(d); })
      .catch(() => {});
    return () => { stop = true; };
  }, [JSON.stringify(selection.map((s) => [s.vm.id, s.strategy])), target.storageMap, target.networkMap, target.targetNamespace]); // eslint-disable-line

  // Step 1 → 2. Everything the report shows is computed server-side from the
  // same assessment the plan gate uses, so the chart cannot flatter a selection
  // that MTV will later reject. The per-VM method and power-state call come
  // back with it — reading the report and reading the recommendation are the
  // same act, so they are not two buttons.
  // Step 1 → 2. EVERY discovered VM is analysed, not a pre-picked subset: the
  // point of the report is to decide what belongs in the wave, which you cannot
  // do from an assessment of the machines you already chose.
  const runAnalysis = async () => {
    if (!vms?.length) { showToast("Discover the VMs first", "err"); return; }
    setBusy("analyse"); setStep(2); setAnalysis(null);
    // The request is one call, so these are the steps it is KNOWN to work
    // through rather than measured progress, and they are labelled that way:
    // an honest "this is what it is doing" beats a bar that pretends to know
    // how far along it is. What they buy is the answer to the only question a
    // waiting person has — is it stuck.
    setPhase(0);
    const ticker = setInterval(() => setPhase((i) => Math.min(i + 1, ANALYSIS_PHASES.length - 1)), 2600);
    const slow = setTimeout(() => setSlowAnalysis(true), 45000);
    try {
      const d = await post("/api/migration/analyse", { vms, provider });
      setAnalysis(d);
      setAdvice({ source: d.adviceSource, advice: d.advice || [], note: d.adviceNote });
    } catch (e) { showToast(e.message, "err"); setStep(1); }
    finally { clearInterval(ticker); clearTimeout(slow); setSlowAnalysis(false); setBusy(null); }
  };

  // The evidence pack. Generated server-side so it carries the report id,
  // timestamp and matrix version the console merely displays — a document a
  // change board will read a year from now should not be assembled by whatever
  // the browser happened to be holding.
  const exportAssessment = async (format) => {
    try {
      const r = await fetch(cUrl("/api/migration/assessment/export"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, analysis, advice: advice?.advice || [] }),
      });
      if (!r.ok) { showToast(`Export failed (${r.status})`, "err"); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${analysis?.reportId || "assessment"}.${format === "csv" ? "csv" : "html"}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { showToast(e.message, "err"); }
  };

  // Step 2 → 3. Pre-tick the machines the report says can go, with the method
  // it recommends. A starting point the operator edits — not a decision made
  // for them, which is why they land on the selection page and not the plan.
  const toSelection = () => {
    const next = {};
    for (const r of analysis?.rows || []) {
      if (r.level !== "supported" && r.level !== "caveats") continue;
      const rec = (advice?.advice || []).find((a) => a.name === r.name);
      next[r.id || r.name] = rec?.strategy === "warm" && r.warmEligible ? "warm" : "cold";
    }
    setSel(next);
    setStep(3);
  };

  // Step 3 → 4. The estimate is measured from migrations this cluster has
  // already run, so the number on the change request is this platform's, not a
  // vendor's.
  const toPlan = async () => {
    setBusy("estimate"); setStep(4);
    try {
      const strategies = {};
      for (const { vm, strategy } of selection) strategies[vm.name] = strategy;
      setEstimate(await post("/api/migration/assess", { vms: selection.map((s) => s.vm), strategies, provider }));
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  // ── Change request: raise, then poll for the CAB's answer ────────────────
  // The verdict is written onto the Plan itself, so a console refresh — or a
  // different person tomorrow — sees the same gate.
  // The window is the operator's to choose; everything else about the request
  // is computed from the plan. Passing nothing keeps the proposal.
  const raiseCR = async (planName, window = null) => {
    setBusy(planName);
    try {
      // No estimate is sent: the server computes it from the plan's own
      // recorded footprint, so the CAB sees the number for the machines in
      // front of it rather than for the whole wave.
      const d = await post(`/api/migration/plans/${encodeURIComponent(planName)}/change-request`, window ? { window } : {});
      if (d.ok) {
        showToast(d.alreadyRaised ? d.message
          : `${d.number} raised${d.attached ? " with the migration record attached" : ""} — awaiting approval`, "ok");
        // A window shorter than the work is allowed but never silent.
        if (d.warning) showToast(d.warning, "err");
        setCrWindow((w) => ({ ...w, [planName]: null }));
        refreshStatus([planName]);
      } else showToast(d.error || "Could not raise the change request", "err");
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const checkApproval = async (planName) => {
    setBusy(planName);
    try {
      const d = await get(`/api/migration/plans/${encodeURIComponent(planName)}/change-request`);
      showToast(d.ok ? (d.note || d.gate?.next || "Checked") : (d.error || "Could not read the change request"), d.ok ? "ok" : "err");
      refreshStatus([planName]);
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  // On open, rebuild from the cluster rather than from whatever this tab
  // happened to remember. Closing the window during a migration lost the view
  // of work that was still running — the Plans were always there.
  const loadPlans = useCallback(async () => {
    try {
      const [d, past] = await Promise.all([
        get("/api/migration/plans"),
        // Finished migrations outlive the Plans that ran them, so they come
        // from the durable store rather than from the cluster.
        get("/api/migration/history?limit=25").catch(() => ({ migrations: [] })),
      ]);
      setHistory({ ...d, archived: past.migrations || [], durable: past.durable, retentionDays: past.retentionDays, archiveNote: past.note });
      const live = (d.plans || []).filter((p) => p.active);
      if (live.length) {
        setPlans(live.map((p) => ({ planName: p.planName, strategy: p.strategy, vms: p.vms })));
        refreshStatus(live.map((p) => p.planName));
        // Land the operator on the plans, not on a discovery form, when
        // something is already moving.
        setStep(4);
      }
    } catch { /* an unreachable cluster is reported by the panels themselves */ }
  }, [cluster]);      // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const createPlans = async () => {
    setBusy("plan");
    try {
      // The AI record travels with the plan so the change request can state
      // what a model touched, even when raised days later from a fresh session.
      const d = await post("/api/migration/plans", { selection, targetProvider: target.targetProvider, ai: analysis?.ai || null });
      if (d.ok) { setPlans(d.created || []); loadPlans(); showToast(`${d.created.length} plan(s) created — nothing has moved yet`, "ok"); }
      else showToast(d.errors?.[0]?.message || d.error || "Could not create plans", "err");
      if (d.created?.length) refreshStatus(d.created.map((p) => p.planName));
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const refreshStatus = useCallback(async (names) => {
    const list = names || plans.map((p) => p.planName);
    const out = {};
    for (const n of list) { try { out[n] = await get(`/api/migration/plans/${encodeURIComponent(n)}`); } catch { /* transient */ } }
    setStatus((s) => ({ ...s, ...out }));
  }, [plans, cluster]);      // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while anything is executing — a cold migration runs for hours.
  useEffect(() => {
    if (!plans.length) return;
    const live = plans.some((p) => status[p.planName]?.executing);
    const id = setInterval(() => refreshStatus(), live ? 10000 : 30000);
    return () => clearInterval(id);
  }, [plans, status, refreshStatus]);

  const migrate = async (planName) => {
    if (!window.confirm(`Start the migration for ${planName}?\n\nThis moves data. The source VMs are powered off for a cold migration and are never deleted.`)) return;
    setBusy(planName);
    try {
      const d = await post(`/api/migration/plans/${encodeURIComponent(planName)}/migrate`, {});
      if (d.ok) { showToast(`Migration started for ${planName}`, "ok"); refreshStatus([planName]); }
      else showToast(d.error || "Could not start", "err");
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  // Reads where the cutover stands: whether the plan is waiting, what window
  // the change board approved, and whether we are inside it. Read-only.
  const loadCutover = async (planName) => {
    try {
      const d = await get(`/api/migration/plans/${encodeURIComponent(planName)}/cutover`);
      setCutovers((c) => ({ ...c, [planName]: d }));
    } catch (e) { showToast(e.message, "err"); }
  };

  // The outage. Confirmed in the words of what actually happens, not "are you
  // sure?" — and the server checks the window again regardless of what the
  // console offered, because a UI state is not an authorisation.
  const doCutover = async (planName, at) => {
    const posture = cutovers[planName];
    const names = (posture?.state?.vms || []).map((v) => v.name).join(", ") || "the migrated VM(s)";
    const when = at ? `at ${new Date(at).toLocaleString()}` : "now";
    if (!window.confirm(
      `Cut over ${planName} ${when}?\n\n${names} will be shut down on VMware, the final changed blocks copied, and the VM(s) started on OpenShift Virtualization.\n\nThis is the outage ${posture?.gate?.number || "the change request"} approved.`
    )) return;
    setBusy(planName);
    try {
      const d = await post(`/api/migration/plans/${encodeURIComponent(planName)}/cutover`, at ? { at } : {});
      if (d.ok) { showToast(d.message || "Cutover set", "ok"); loadCutover(planName); refreshStatus([planName]); }
      else showToast(d.error || "Could not set the cutover", "err");
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const runVerify = async (planName) => {
    setBusy(planName);
    try {
      const d = await get(`/api/migration/plans/${encodeURIComponent(planName)}/verify`);
      setVerifs((v) => ({ ...v, [planName]: d }));
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const loadDecom = async (planName) => {
    try {
      const d = await get(`/api/migration/plans/${encodeURIComponent(planName)}/decommission`);
      setDecoms((c) => ({ ...c, [planName]: d }));
    } catch (e) { showToast(e.message, "err"); }
  };

  // Raises a change request; deletes nothing. The confirm says so, because the
  // word "decommission" beside a button is exactly where someone assumes the
  // opposite.
  const raiseDecom = async (planName, force) => {
    const names = (plans.find((x) => x.planName === planName)?.vms || []).length;
    if (!window.confirm(
      `Raise a decommission request for ${planName}?\n\nThis asks the VMware team to DELETE the ${names || ""} source VM(s). It deletes nothing itself, and nothing happens until the change request is approved and carried out.${force ? "\n\nThe soak period has NOT elapsed. Waiving it will be recorded on the change request." : ""}`
    )) return;
    setBusy(planName);
    try {
      const d = await post(`/api/migration/plans/${encodeURIComponent(planName)}/decommission`, force ? { force: true } : {});
      if (d.ok) { showToast(d.message || "Decommission request raised", "ok"); loadDecom(planName); refreshStatus([planName]); }
      else showToast(d.error || "Could not raise it", "err");
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const askRollback = async (planName) => {
    setBusy(planName);
    try { setRollback({ planName, ...(await get(`/api/migration/plans/${encodeURIComponent(planName)}/rollback-preview`)) }); }
    catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const doRollback = async () => {
    const planName = rollback?.planName;
    if (!planName) return;
    setBusy(planName);
    try {
      const d = await post(`/api/migration/plans/${encodeURIComponent(planName)}/rollback`, {});
      setRollback((r) => ({ ...r, result: d }));
      showToast(d.ok ? "Rolled back" : (d.error || "Rollback incomplete"), d.ok ? "ok" : "err");
      setPlans((p) => p.filter((x) => x.planName !== planName));
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const S = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", color: "var(--fg,#151a29)", fontSize: "0.84rem" };
  const gb = (v) => (v == null ? "—" : `${v} GiB`);
  // Hours once it stops being a number anyone can hold in their head.
  const mins = (n) => (n == null ? "—" : n < 90 ? `${n} min` : `${(n / 60).toFixed(1)} h`);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div data-prose style={{ fontSize: "0.86rem", color: "var(--muted,#5a6373)" }}>
        Migrate virtual machines into OpenShift Virtualization with the <b>Migration Toolkit for Virtualization</b>.
        Discover what is on the source platform, choose a strategy per machine, and the agent groups the selection into the
        plans MTV accepts. Nothing moves until a plan is created, validated and started — and <b>the source VM is never deleted</b>.
      </div>

      {/* ── Readiness ─────────────────────────────────────────────────────── */}
      <div style={{ border: `1px solid ${ready?.ok ? "rgba(22,163,74,.4)" : "rgba(220,38,38,.4)"}`, borderRadius: 10, background: "var(--card-bg,#fff)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", cursor: "pointer" }} onClick={() => setShowReady((v) => !v)}>
          <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>{ready?.ok ? "✅" : "⚠"} MTV readiness</span>
          <span style={{ fontSize: "0.72rem", fontWeight: 800, padding: "2px 9px", borderRadius: 999,
            background: ready?.ok ? "rgba(22,163,74,.14)" : "rgba(220,38,38,.12)", color: ready?.ok ? "#16a34a" : "#dc2626" }}>
            {busy === "ready" ? "checking…" : ready?.ok ? "ready to migrate" : `${ready?.blocking?.length || 0} blocker(s)`}
          </span>
          <select value={cluster} onChange={(e) => { e.stopPropagation(); setCluster(e.target.value); }} onClick={(e) => e.stopPropagation()} style={{ ...S, padding: "4px 8px", fontSize: "0.78rem" }}>
            {clusters.map((c) => <option key={c} value={c}>{c === "local" ? "Hub Cluster (local)" : c}</option>)}
          </select>
          <button onClick={(e) => { e.stopPropagation(); loadReadiness(); }} style={{ ...S, padding: "3px 10px", fontSize: "0.75rem", fontWeight: 700, cursor: "pointer" }}>↻ Re-check</button>
          <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--muted,#5a6373)" }}>{showReady ? "▲" : "▼"}</span>
        </div>
        {showReady && ready && (
          <div style={{ padding: "0 12px 11px", fontSize: "0.8rem" }}>
            {(ready.blocking || []).map((b, i) => (
              <div key={"b" + i} style={{ marginTop: 3 }}>
                <div style={{ color: "#dc2626" }}>✖ {b.message}</div>
                {/* A blocker with a known one-command fix shows it inline —
                    an RBAC denial is a grant away, not a reinstall. */}
                {b.fix && (
                  <div style={{ marginTop: 4 }}>
                    <pre style={{ margin: 0, padding: 8, borderRadius: 7, background: "#0f172a", color: "#e2e8f0",
                      fontSize: "0.7rem", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace",
                      whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{b.fix}</pre>
                    <div style={{ fontSize: "0.7rem", color: "var(--muted,#5a6373)", marginTop: 3 }}>
                      Run as cluster-admin, then press Re-check. Cluster-side only — no image rebuild, no restart.
                    </div>
                  </div>
                )}
              </div>
            ))}
            {(ready.warnings || []).map((w, i) => <div key={"w" + i} style={{ color: "#b45309", marginTop: 3 }}>⚠ {w.message}</div>)}
            {ready.ok && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 8, marginTop: 6 }}>
                {[["Providers", (ready.providers || []).map((p) => `${p.name} (${p.type})${p.connected ? "" : " ✖"}`)],
                  ["Storage maps", (ready.storageMaps || []).map((m) => `${m.name} · ${m.entries} entr${m.entries === 1 ? "y" : "ies"}`)],
                  ["Network maps", (ready.networkMaps || []).map((m) => `${m.name} · ${m.entries} entr${m.entries === 1 ? "y" : "ies"}`)]].map(([label, items]) => (
                  <div key={label}>
                    <div style={{ fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--muted,#5a6373)" }}>{label}</div>
                    {items.length === 0 ? <div style={{ opacity: .6 }}>none</div>
                      : items.map((x, i) => <div key={i} style={{ marginTop: 2 }}>{x}</div>)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Step strip ───────────────────────────────────────────────────────
          Steps are only clickable backwards. Going forward is a gate: you reach
          the analysis by analysing, and migration by accepting the analysis. */}
      {ready?.ok && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {[[1, "Discover"], [2, "Analyse support"], [3, "Select & strategy"], [4, "Plan & migrate"]].map(([n, label], i) => (
            <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span style={{ color: "var(--text2)", opacity: .5 }}>→</span>}
              <button
                onClick={() => { if (n < step) setStep(n); }}
                disabled={n > step}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999,
                  fontFamily: "inherit", fontSize: "0.78rem", fontWeight: 700,
                  border: `1px solid ${n === step ? "rgba(61,90,254,.55)" : "var(--border)"}`,
                  background: n === step ? "rgba(61,90,254,.12)" : "transparent",
                  color: n === step ? "#7c8cff" : "var(--text2)",
                  cursor: n < step ? "pointer" : "default",
                }}>
                <span style={{
                  width: 17, height: 17, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: "0.72rem", fontWeight: 800,
                  background: n < step ? "var(--st-good)" : n === step ? "#3d5afe" : "var(--border)",
                  color: n <= step ? "#fff" : "var(--text2)",
                }}>{n < step ? "✓" : n}</span>
                {label}
              </button>
            </span>
          ))}
        </div>
      )}

      {ready?.ok && step === 1 && (
        <>
          {/* ── Discover ──────────────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: "0.8rem", color: "var(--muted,#5a6373)" }}>Source</label>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setVms(null); setSel({}); }} style={S}>
              <option value="">— choose a provider —</option>
              {(ready.sources || []).map((p) => <option key={p.uid} value={p.uid}>{p.name} ({p.type})</option>)}
            </select>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="filter by name" style={{ ...S, minWidth: 180 }} />
            <button onClick={discover} disabled={!provider || busy === "discover"}
              style={{ ...S, background: "#3d5afe", color: "#fff", border: "none", fontWeight: 700, cursor: provider ? "pointer" : "not-allowed", opacity: provider ? 1 : .5 }}>
              {busy === "discover" ? "Discovering…" : "🔍 Discover VMs"}
            </button>
            {vms && <span style={{ fontSize: "0.78rem", color: "var(--muted,#5a6373)" }}>{vms.length} VM(s) found in this vCenter</span>}
          </div>

          {/* ── Inventory table ───────────────────────────────────────────── */}
          {vms?.length > 0 && (
            <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, overflow: "auto", maxHeight: 320 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.79rem" }}>
                <thead>
                  <tr style={{ background: "var(--card-bg,#f6f8fc)", position: "sticky", top: 0 }}>
                    {["VM", "Power", "Guest OS", "IP address", "vCPU", "Memory", "Storage"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "7px 9px", fontWeight: 800, borderBottom: "1px solid var(--border,#e4e8f1)", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {vms.map((v) => {
                    const key = v.id || v.name;
                    return (
                      <tr key={key} style={{ borderBottom: "1px solid var(--border,#eef1f6)" }}>
                        <td style={{ padding: "6px 9px", fontWeight: 700 }}>{v.name}</td>
                        <td style={{ padding: "6px 9px", color: v.poweredOn ? "#16a34a" : "var(--muted,#5a6373)" }}>{v.poweredOn ? "on" : "off"}</td>
                        {/* The classified guest sits above the raw string: the
                            classification is what the support matrix keys off,
                            so showing only vCenter's label would hide the thing
                            the next step actually decides on. */}
                        <td style={{ padding: "6px 9px", color: "var(--muted,#5a6373)", maxWidth: 210 }} title={v.guestOS || ""}>
                          <div style={{ color: "var(--text,#151a29)" }}>{v.os?.distro || v.guestOS || "—"}</div>
                          {v.os?.family && v.os.family !== "unknown" && (
                            <div style={{ fontSize: "0.73rem", textTransform: "capitalize" }}>{v.os.family}</div>
                          )}
                        </td>
                        <td style={{ padding: "6px 9px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem" }}
                          title={v.toolsStatus ? `VMware Tools: ${v.toolsStatus}` : ""}>
                          {v.ips?.length ? v.ips.slice(0, 2).join(", ") + (v.ips.length > 2 ? ` +${v.ips.length - 2}` : "") : "—"}
                        </td>
                        <td style={{ padding: "6px 9px" }}>{v.cpuCount ?? "—"}</td>
                        <td style={{ padding: "6px 9px" }}>{v.memoryGiB != null ? `${v.memoryGiB} GiB` : v.memoryMB ? `${Math.round(v.memoryMB / 1024)} GiB` : "—"}</td>
                        {/* Per-disk detail on hover — a 4-disk VM with one RDM
                            migrates very differently from a 4-disk VM without. */}
                        <td style={{ padding: "6px 9px", whiteSpace: "nowrap" }}
                          title={(v.disks || []).map((d) => `${d.name || "disk"} · ${d.capacityGiB ?? "?"} GiB${d.datastore ? ` · ${d.datastore}` : ""}${d.rdm ? " · RDM" : ""}${d.shared ? " · shared" : ""}`).join("\n") || undefined}>
                          {v.diskCount} disk{v.diskCount === 1 ? "" : "s"} · {gb(v.diskGiB)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {vms?.length === 0 && <div style={{ fontSize: "0.82rem", color: "var(--muted,#5a6373)" }}>No VMs returned for that provider.</div>}

          {/* ── Gate to step 2 ───────────────────────────────────────────── */}
          {vms?.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button onClick={runAnalysis} disabled={busy === "analyse"}
                style={{ ...S, background: "#3d5afe", color: "#fff", border: "none", fontWeight: 700, cursor: "pointer", padding: "8px 16px" }}>
                {busy === "analyse" ? "Analysing…" : `Analyse all ${vms.length} VM(s) →`}
              </button>
              <span data-prose style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)" }}>
                Checks every guest against the OpenShift Virtualization support matrix and MTV's own validation. Read-only — you choose what migrates after reading the report.
              </span>
            </div>
          )}
        </>
      )}

      {/* ── Step 2 · Analysis ─────────────────────────────────────────────── */}
      {/* FleetAnalysis renders nothing without an analysis, which left a blank
          screen for the length of the assessment. */}
      {ready?.ok && step === 2 && !analysis && (
        <AnalysisProgress count={vms?.length || 0} phase={phase} slow={slowAnalysis} />
      )}
      {ready?.ok && step === 2 && analysis && (
        <FleetAnalysis
          analysis={analysis}
          suggestions={analysis?.suggestions || []}
          suggestionSource={analysis?.suggestionSource}
          note={analysis?.note || analysis?.error}
          advice={advice?.advice || []}
          adviceSource={advice?.source}
          adviceNote={advice?.note}
          busy={busy === "analyse"}
          onBack={() => setStep(1)}
          onProceed={toSelection}
          onExport={exportAssessment}
        />
      )}

      {/* ── Step 3 · Choose the wave ──────────────────────────────────────── */}
      {ready?.ok && step === 3 && (
        <MigrationSelect
          analysis={analysis}
          advice={advice?.advice || []}
          selected={sel}
          onChange={setSel}
          ready={ready}
          target={target}
          onTarget={setTarget}
          onBack={() => setStep(2)}
          onProceed={toPlan}
        />
      )}

      {ready?.ok && step === 4 && (
        <>
          {/* ── How long this will take ─────────────────────────────────────
              Measured from migrations this cluster has already run, not from a
              vendor figure. With no history yet it says so, and the live ETA on
              each plan replaces it with real numbers once bytes move. */}
          <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: "11px 13px", background: "var(--card-bg,#fff)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 800, fontSize: "0.86rem" }}>Estimated transfer time</span>
              <span style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)" }}>
                {busy === "estimate" ? "measuring…" : estimate?.throughput?.mbps
                  ? `Based on ${estimate.throughput.samples} completed migration(s) on this cluster — ${estimate.throughput.mbps} MiB/s`
                  : "No completed migrations on this cluster yet, so this uses a conservative default"}
              </span>
            </div>
            {/* Both paths, always. The VDDK image is the single biggest lever
                on transfer speed, and "configure it" lands very differently as
                a number than as a documentation link. */}
            {["cold", "warm"].map((kind) => {
              const cmp = estimate?.vddkComparison?.[kind];
              const est = estimate?.estimate?.[kind];
              if (!est?.vmCount) return null;
              const configured = estimate?.vddk?.configured;
              const cell = (label, e, inUse) => (
                <div style={{
                  border: `1px solid ${inUse ? "rgba(61,90,254,.5)" : "var(--border,#e4e8f1)"}`,
                  background: inUse ? "rgba(61,90,254,.06)" : "transparent",
                  borderRadius: 9, padding: "9px 11px", flex: "1 1 220px", minWidth: 200,
                }}>
                  <div style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em",
                    color: inUse ? "#7c8cff" : "var(--muted,#5a6373)" }}>
                    {label}{inUse ? " · in use" : ""}
                  </div>
                  <div style={{ fontSize: "1.35rem", fontWeight: 800, marginTop: 2 }}>
                    {mins(e?.wallClockMinutes?.likely)}
                    <span style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--muted,#5a6373)" }}>
                      {" "}transfer ({mins(e?.wallClockMinutes?.low)}–{mins(e?.wallClockMinutes?.high)})
                    </span>
                  </div>
                  {/* Downtime is the number people actually schedule around,
                      and for warm it is nothing like the transfer time. */}
                  <div style={{ fontSize: "0.77rem", marginTop: 2 }}>
                    Downtime: <b>{mins(e?.downtimeMinutes?.likely)}</b>
                    <span style={{ color: "var(--muted,#5a6373)" }}> ({mins(e?.downtimeMinutes?.low)}–{mins(e?.downtimeMinutes?.high)})</span>
                  </div>
                </div>
              );
              return (
                <div key={kind} style={{ marginTop: 11 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 800, fontSize: "0.82rem", textTransform: "capitalize" }}>{kind}</span>
                    <span style={{ fontSize: "0.76rem", color: "var(--muted,#5a6373)" }}>
                      {est.vmCount} VM{est.vmCount === 1 ? "" : "s"} · {gb(est.totalGiB)}
                    </span>
                    {configured != null && (
                      <span style={{ fontSize: "0.72rem", fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                        background: configured ? "var(--st-good-bg)" : "var(--st-warn-bg)",
                        color: configured ? "var(--st-good)" : "var(--st-warn)" }}>
                        {configured ? "✓ VDDK configured" : "⚠ no VDDK image"}
                      </span>
                    )}
                  </div>
                  {cmp ? (
                    <>
                      <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                        {cell("With VDDK", cmp.withVddk, cmp.configured === true)}
                        {cell("Without VDDK", cmp.withoutVddk, cmp.configured === false)}
                      </div>
                      {configured === false && (
                        <div style={{ fontSize: "0.78rem", color: "var(--st-warn)", marginTop: 5 }}>
                          ⚠ Configuring the VDDK image would take this from {mins(cmp.withoutVddk?.wallClockMinutes?.likely)} to{" "}
                          {mins(cmp.withVddk?.wallClockMinutes?.likely)} — and a VM backed by vSAN will not migrate without it at all.
                        </div>
                      )}
                      <div data-prose style={{ fontSize: "0.75rem", color: "var(--muted,#5a6373)", marginTop: 4 }}>
                        {cmp.basis} {cmp.assumption} {est.note}
                      </div>
                    </>
                  ) : (
                    <div style={{ display: "flex", gap: 10, marginTop: 6 }}>{cell("Estimate", est, true)}</div>
                  )}
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 9, marginTop: 10 }}>
              <button onClick={() => setStep(3)} style={{ ...S, padding: "6px 12px", fontSize: "0.78rem", fontWeight: 700, cursor: "pointer" }}>
                ← Change the wave
              </button>
            </div>
          </div>

          {/* ── Grouping preview: what MTV will actually accept ───────────── */}
          {preview && (
            <div style={{ border: "1px solid rgba(56,189,248,.4)", borderRadius: 10, padding: "10px 12px", background: "rgba(56,189,248,.05)" }}>
              <div style={{ fontWeight: 800, fontSize: "0.82rem", marginBottom: 5 }}>
                {preview.groups.length} migration plan{preview.groups.length === 1 ? "" : "s"} from your selection of {Object.keys(sel).length}
              </div>
              {preview.groups.map((g) => (
                <div key={g.key} style={{ fontSize: "0.79rem", marginTop: 3 }}>
                  <b>{g.planName}</b> · <span style={{ color: g.warm ? "#0891b2" : "#64748b", fontWeight: 700 }}>{g.strategy}</span>
                  {g.osFamily && g.osFamily !== "unknown" && (
                    <> · <span style={{ textTransform: "capitalize", fontWeight: 700 }}>{g.osFamily}</span></>
                  )} · {g.totalVMs} VM{g.totalVMs === 1 ? "" : "s"} · {gb(g.totalGiB)} · {g.storageMap} / {g.networkMap} → {g.targetNamespace}
                  <div style={{ color: "var(--muted,#5a6373)", fontSize: "0.72rem" }}>{g.vms.map((v) => v.name).join(", ")}</div>
                </div>
              ))}
              {(preview.errors || []).map((e, i) => <div key={i} style={{ color: "#dc2626", fontSize: "0.78rem", marginTop: 3 }}>✖ {e.message}</div>)}
              <div data-prose style={{ fontSize: "0.75rem", color: "var(--muted,#5a6373)", marginTop: 6 }}>
                Warm/cold, the provider, both maps and the target namespace are plan-level in MTV, so a mixed selection becomes several plans.
                Windows and Linux are split as well — they need different preparation and verification, and are almost always cut over in
                separate windows, so a plan that mixed them could not be handed to either team.
              </div>
              <button onClick={createPlans} disabled={busy === "plan" || (preview.errors || []).length > 0 || preview.groups.length === 0}
                style={{ ...S, marginTop: 8, background: (preview.errors || []).length ? "rgba(148,163,184,.3)" : "#0ea5a0", color: (preview.errors || []).length ? "inherit" : "#fff",
                  border: "none", fontWeight: 700, cursor: (preview.errors || []).length ? "not-allowed" : "pointer" }}>
                {busy === "plan" ? "Creating…" : "1. Create plan(s) — validates, moves nothing"}
              </button>
            </div>
          )}

          {/* ── What has run here before ───────────────────────────────────
              A migration outlives the browser tab that started it. This is
              read from the Plans on the cluster, so it survives closing the
              window, a refresh, and a different person opening it tomorrow. */}
          {history?.available && history.plans.length > 0 && (
            <div style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: "9px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <b style={{ fontSize: "0.82rem" }}>Migration history</b>
                <span style={{ fontSize: "0.77rem", color: "var(--muted,#5a6373)" }}>{history.note}</span>
                <button onClick={() => setShowHistory((v) => !v)} style={{ ...S, marginLeft: "auto",
                  padding: "3px 10px", fontSize: "0.75rem", fontWeight: 700, cursor: "pointer" }}>
                  {showHistory ? "Hide" : `Show all ${history.plans.length + (history.archived?.length || 0)}`}
                </button>
              </div>
              {/* Finished migrations, from the durable store. These survive the
                  Plan being deleted — which a rollback does — so this is the
                  only place a rolled-back migration can still be seen. */}
              {showHistory && (history.archived || []).map((a) => (
                <div key={a.id} style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap",
                  fontSize: "0.77rem", marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--border,#e4e8f1)" }}>
                  <span style={{ fontSize: "0.72rem", padding: "1px 8px", borderRadius: 999, fontWeight: 700,
                    background: a.outcome === "migrated" ? "rgba(22,163,74,.14)" : "rgba(220,38,38,.12)",
                    color: a.outcome === "migrated" ? "#16a34a" : "#dc2626" }}>
                    {a.outcome === "rolled-back" ? "rolled back" : a.outcome}
                  </span>
                  <b>{a.planName}</b>
                  <span style={{ color: "var(--text2)" }}>
                    {a.strategy} · {a.vmCount} VM{a.vmCount === 1 ? "" : "s"}
                    {a.totalGiB ? ` · ${a.totalGiB} GiB` : ""}
                    {a.vmNames?.length ? ` · ${a.vmNames.slice(0, 3).join(", ")}${a.vmNames.length > 3 ? ` +${a.vmNames.length - 3}` : ""}` : ""}
                  </span>
                  {a.changeRequest && <span style={{ color: "var(--text2)" }}>{a.changeRequest}</span>}
                  {/* Promised against measured — the pair worth keeping, because
                      the next estimate is only as good as this measurement. */}
                  {a.actualMinutes != null && (
                    <span style={{ color: "var(--text2)" }}>
                      took {a.actualMinutes} min{a.estimatedMinutes != null ? ` (estimated ${a.estimatedMinutes})` : ""}
                    </span>
                  )}
                  {a.verification?.verdict && (
                    <span style={{ color: "var(--text2)" }}>verification {a.verification.verdict.replace(/-/g, " ")}</span>
                  )}
                  {/* What the model cost THIS migration, kept with the run
                      rather than in the session that produced it. */}
                  {a.ai?.consulted && (
                    <span style={{ color: "var(--text2)" }}>
                      AI {a.ai.calls} call{a.ai.calls === 1 ? "" : "s"}
                      {a.ai.totalTokens != null ? ` · ${a.ai.tokensPartial ? "≥" : ""}${a.ai.totalTokens.toLocaleString()} tokens` : ""}
                      {a.ai.costUsd != null ? ` · $${a.ai.costUsd < 0.01 ? a.ai.costUsd.toFixed(4) : a.ai.costUsd.toFixed(2)}` : ""}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", color: "var(--text2)", fontSize: "0.74rem" }}>
                    {a.finishedAt ? new Date(a.finishedAt).toLocaleString() : ""}
                  </span>
                  {a.note && <div style={{ width: "100%", color: "var(--text2)", fontSize: "0.75rem" }}>{a.note}</div>}
                </div>
              ))}
              {showHistory && history.archiveNote && (
                <div data-prose style={{ marginTop: 6, fontSize: "0.75rem", color: "var(--text2)" }}>
                  ⚠ {history.archiveNote}
                </div>
              )}
              {showHistory && history.durable && (
                <div data-prose style={{ marginTop: 6, fontSize: "0.75rem", color: "var(--text2)" }}>
                  Finished migrations are kept for {history.retentionDays} days. The change requests in ServiceNow
                  remain the durable record beyond that, with the migration document attached to each.
                </div>
              )}
              {showHistory && history.plans.map((h) => (
                <div key={h.planName} style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap",
                  fontSize: "0.77rem", marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--border,#e4e8f1)" }}>
                  <span style={{ fontSize: "0.72rem", padding: "1px 8px", borderRadius: 999, fontWeight: 700,
                    background: PHASE[h.phase]?.bg || "rgba(100,116,139,.12)", color: PHASE[h.phase]?.fg || "#64748b" }}>
                    {PHASE[h.phase]?.label || h.phase}
                  </span>
                  <b>{h.planName}</b>
                  <span style={{ color: "var(--muted,#5a6373)" }}>
                    {h.strategy} · {h.vms} VM{h.vms === 1 ? "" : "s"}{h.totalGiB ? ` · ${h.totalGiB} GiB` : ""}
                    {h.targetNamespace ? ` → ${h.targetNamespace}` : ""}
                  </span>
                  {h.gate?.number && <span style={{ color: "var(--muted,#5a6373)" }}>{h.gate.number}</span>}
                  <span style={{ marginLeft: "auto", color: "var(--muted,#5a6373)", fontSize: "0.74rem" }}>
                    {h.finishedAt ? `finished ${new Date(h.finishedAt).toLocaleString()}`
                      : h.createdAt ? `started ${new Date(h.createdAt).toLocaleString()}` : ""}
                  </span>
                  {/* Anything still moving can be opened again from here —
                      that is the whole point of the panel. */}
                  {h.active && !plans.some((p) => p.planName === h.planName) && (
                    <button onClick={() => { setPlans((ps) => [...ps, { planName: h.planName, strategy: h.strategy, vms: h.vms }]); refreshStatus([h.planName]); }}
                      style={{ ...S, padding: "2px 9px", fontSize: "0.73rem", fontWeight: 700, cursor: "pointer" }}>
                      Reopen
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Plans + progress ─────────────────────────────────────────── */}
          {plans.map((p) => {
            const st = status[p.planName] || {};
            return (
              <div key={p.planName} style={{ border: "1px solid var(--border,#e4e8f1)", borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <b style={{ fontSize: "0.84rem" }}>{p.planName}</b>
                  <span style={{ fontSize: "0.72rem", padding: "2px 9px", borderRadius: 999, fontWeight: 700,
                    background: st.failed ? "rgba(220,38,38,.12)" : st.succeeded ? "rgba(22,163,74,.14)" : st.executing ? "rgba(245,158,11,.14)" : "rgba(100,116,139,.12)",
                    color: st.failed ? "#dc2626" : st.succeeded ? "#16a34a" : st.executing ? "#b45309" : "#64748b" }}>
                    {st.failed ? "failed" : st.succeeded ? "migrated" : st.executing ? "transferring" : st.ready ? "validated — ready" : "validating…"}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted,#5a6373)" }}>
                    {p.strategy} · {p.vms} VM(s){st.totalGiB ? ` · ${gb(st.totalGiB)}` : ""}
                  </span>
                  <button onClick={() => refreshStatus([p.planName])} style={{ ...S, marginLeft: "auto", padding: "3px 10px", fontSize: "0.74rem", cursor: "pointer" }}>↻</button>
                  {/* The gate: validated → approved → migrate. The button is
                      enabled from the plan's own annotations, and the server
                      re-checks them — an enabled button is not authorisation. */}
                  {!st.gate?.number && st.gate?.required !== false && (
                    <button onClick={() => raiseCR(p.planName, crWindow[p.planName] || null)} disabled={!st.ready || busy === p.planName}
                      title={!st.ready ? "MTV has not validated this plan yet" : "Raise the ServiceNow change request for this migration"}
                      style={{ ...S, padding: "4px 12px", fontWeight: 700, border: "none",
                        background: st.ready ? "#7c3aed" : "rgba(148,163,184,.3)", color: st.ready ? "#fff" : "inherit",
                        cursor: st.ready ? "pointer" : "not-allowed" }}>
                      {busy === p.planName ? "…" : "2. Raise change request"}
                    </button>
                  )}
                  {st.gate?.number && !st.gate?.approved && (
                    <button onClick={() => checkApproval(p.planName)} disabled={busy === p.planName}
                      style={{ ...S, padding: "4px 12px", fontWeight: 700, cursor: "pointer",
                        borderColor: "rgba(124,58,237,.45)", color: "#a78bfa" }}>
                      {busy === p.planName ? "…" : `↻ Check ${st.gate.number}`}
                    </button>
                  )}
                  <button onClick={() => migrate(p.planName)}
                    disabled={!st.ready || st.executing || st.succeeded || busy === p.planName
                      || (st.gate?.required !== false && !st.gate?.approved)}
                    title={!st.ready ? "MTV has not validated this plan yet"
                      : (st.gate?.required !== false && !st.gate?.approved) ? st.gate?.next || "Not approved yet" : ""}
                    style={{ ...S, padding: "4px 12px", fontWeight: 700, border: "none",
                      background: st.ready && !st.executing && !st.succeeded && (st.gate?.required === false || st.gate?.approved) ? "#22c55e" : "rgba(148,163,184,.3)",
                      color: st.ready && !st.executing && !st.succeeded && (st.gate?.required === false || st.gate?.approved) ? "#052e16" : "inherit",
                      cursor: st.ready && !st.executing && !st.succeeded && (st.gate?.required === false || st.gate?.approved) ? "pointer" : "not-allowed" }}>
                    {busy === p.planName ? "…" : st.succeeded ? "✅ Migrated" : "3. Migrate"}
                  </button>
                  <button onClick={() => askRollback(p.planName)} style={{ ...S, padding: "4px 11px", fontSize: "0.76rem", fontWeight: 700, color: "#dc2626", borderColor: "rgba(220,38,38,.4)", cursor: "pointer" }}>
                    ↩ Roll back
                  </button>
                </div>
                {(st.critical || []).map((c, i) => <div key={i} style={{ color: "#dc2626", fontSize: "0.76rem", marginTop: 4 }}>✖ {c}</div>)}
                {/* The window on the change request. Everything else about the
                    request is computed from the plan — the machines, the
                    estimate, the downtime, the backout — but the WINDOW belongs
                    to whoever knows the change calendar, the freeze periods and
                    the business, and that is never this tool. Left blank it
                    uses the proposal sized from this plan's own footprint. */}
                {!st.gate?.number && st.gate?.required !== false && st.ready && (
                  <CrWindowPicker
                    value={crWindow[p.planName] || null}
                    warm={st.warm}
                    onChange={(w) => setCrWindow((c) => ({ ...c, [p.planName]: w }))}
                  />
                )}
                {/* Where this plan is, on the route this plan is actually on. */}
                {st.journey && <Journey j={st.journey} />}
                {st.gate && st.gate.required !== false && (
                  <div style={{ marginTop: 5, fontSize: "0.77rem", display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                    <span style={{ color: st.gate.approved ? "var(--st-good)" : st.gate.state === "rejected" || st.gate.state === "cancelled" ? "var(--st-crit)" : "var(--st-warn)", fontWeight: 700 }}>
                      {st.gate.approved ? "✓" : st.gate.state === "rejected" || st.gate.state === "cancelled" ? "✖" : "◷"}{" "}
                      {st.gate.number ? `${st.gate.number} — ${st.gate.state}` : "no change request"}
                    </span>
                    <span style={{ color: "var(--muted,#5a6373)" }}>{st.gate.next}</span>
                    {st.gate.checkedAt && (
                      <span style={{ color: "var(--muted,#5a6373)", fontSize: "0.75rem", marginLeft: "auto" }}>
                        last checked {new Date(st.gate.checkedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}

                {/* Live ETA — measured from bytes actually moving, so it
                    sharpens as the transfer runs and says "stalled" rather
                    than quoting a number that keeps growing. */}
                {st.eta && st.eta.state !== "measuring" && (
                  <div style={{ marginTop: 7, padding: "7px 9px", borderRadius: 8,
                    background: st.eta.state === "stalled" ? "rgba(220,38,38,.07)" : st.eta.state === "awaiting-cutover" ? "rgba(245,158,11,.09)" : "rgba(14,165,160,.07)",
                    border: `1px solid ${st.eta.state === "stalled" ? "rgba(220,38,38,.3)" : st.eta.state === "awaiting-cutover" ? "rgba(245,158,11,.4)" : "rgba(14,165,160,.3)"}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: "0.79rem" }}>
                      <b style={{ color: st.eta.state === "stalled" || st.eta.state === "crawling" ? "#dc2626"
                        : st.eta.state === "awaiting-cutover" ? "#b45309" : "#0ea5a0" }}>
                        {st.eta.state === "stalled" ? "⚠ Transfer stalled"
                          : st.eta.state === "crawling" ? "⚠ Barely moving"
                          : st.eta.state === "awaiting-cutover" ? "◷ Copied — waiting for cutover"
                          : st.eta.state === "complete" ? "✅ Transfer complete"
                          : `⏱ About ${st.eta.etaMinutes.likely} min remaining`}
                      </b>
                      {st.eta.state === "transferring" && (
                        <>
                          <span style={{ color: "var(--muted,#5a6373)" }}>
                            ({st.eta.etaMinutes.low}–{st.eta.etaMinutes.high} min)
                          </span>
                          <span style={{ fontSize: "0.72rem", padding: "1px 8px", borderRadius: 999, fontWeight: 700,
                            background: st.eta.confidence === "high" ? "rgba(22,163,74,.14)" : st.eta.confidence === "medium" ? "rgba(245,158,11,.14)" : "rgba(100,116,139,.14)",
                            color: st.eta.confidence === "high" ? "#16a34a" : st.eta.confidence === "medium" ? "#b45309" : "#64748b" }}>
                            {st.eta.confidence} confidence
                          </span>

                        </>
                      )}
                    </div>
                    {/* The same three numbers MTV's own console shows, in the
                        same units, so the two screens can be read side by side
                        without anyone reconciling them. Shown for every moving
                        state, not only the one that happens to have an ETA. */}
                    {st.progress?.total > 0 && (
                      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
                        marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                        <span style={{ fontSize: "0.95rem", fontWeight: 800 }}>
                          {mib(st.progress.bytes)} <span style={{ fontWeight: 400, color: "var(--text2)" }}>of</span> {mib(st.progress.total)} MB
                        </span>
                        <span style={{ fontSize: "0.86rem", fontWeight: 700,
                          color: st.eta.mbps > 0 ? "#0ea5a0" : "#dc2626" }}>
                          {st.eta.mbps == null ? "—" : st.eta.mbps} MiB/s
                        </span>
                        <span style={{ fontSize: "0.79rem", color: "var(--text2)" }}>{st.eta.percent}%</span>
                        {st.progress.activeVMs > 0 && (
                          <span style={{ fontSize: "0.79rem", color: "var(--text2)" }}>
                            {st.progress.activeVMs} VM{st.progress.activeVMs === 1 ? "" : "s"} copying
                          </span>
                        )}
                      </div>
                    )}
                    {st.progress?.total > 0 && (
                      <div style={{ height: 6, borderRadius: 999, background: "rgba(127,127,127,.15)", marginTop: 4, overflow: "hidden" }}>
                        <div style={{ width: `${st.eta.percent}%`, height: "100%",
                          background: st.eta.state === "stalled" || st.eta.state === "crawling" ? "#dc2626" : "#0ea5a0" }} />
                      </div>
                    )}
                    <div style={{ fontSize: "0.75rem", color: "var(--text2)", marginTop: 3 }}>{st.eta.basis}</div>
                    {/* The forecast, judged against the transfer actually
                        happening. The useful moment to learn the estimate was
                        wrong is now, while someone can still say so. */}
                    {st.vsEstimate && (
                      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border,#e4e8f1)", fontSize: "0.78rem" }}>
                        <span style={{ fontWeight: 700, color:
                          st.vsEstimate.verdict === "far-behind" ? "var(--st-crit)"
                          : st.vsEstimate.verdict === "behind" ? "var(--st-warn)"
                          : st.vsEstimate.verdict === "ahead" ? "var(--st-good)" : "var(--text2)" }}>
                          {st.vsEstimate.verdict === "on-track" ? "✓ On plan"
                            : st.vsEstimate.verdict === "ahead" ? "✓ Ahead of plan"
                            : st.vsEstimate.verdict === "behind" ? "⚠ Behind plan" : "✖ Far behind plan"}
                        </span>{" "}
                        <span style={{ color: "var(--muted,#5a6373)" }}>{st.vsEstimate.message}</span>
                        {/* Only once the measurement has earned it — rewriting a
                            cluster default from four samples would be worse
                            than the default. */}
                        {st.vsEstimate.calibration && (
                          <div style={{ marginTop: 4, fontSize: "0.75rem" }}>
                            → <code style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem",
                              background: "var(--bg2,#f1f5f9)", padding: "1px 5px", borderRadius: 4 }}>
                              {st.vsEstimate.calibration.setting}={st.vsEstimate.calibration.value}
                            </code>{" "}
                            <span data-prose style={{ color: "var(--muted,#5a6373)" }}>{st.vsEstimate.calibration.reason}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* The approved outage, judged against the rate this
                        precopy is measuring. Surfaced here as well as on the
                        change request, because the person watching this screen
                        is the one who can still do something about it. */}
                    {st.windowFit?.known && !st.windowFit.fits && (
                      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border,#e4e8f1)", fontSize: "0.77rem" }}>
                        <b style={{ color: "#b45309" }}>⚠ The approved window no longer fits</b>
                        <div style={{ color: "var(--muted,#5a6373)", marginTop: 2 }}>{st.windowFit.note}</div>
                        <div style={{ marginTop: 1 }}>→ {st.windowFit.action}</div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Post-migration verification ──────────────────────────
                    "Succeeded" on a Plan describes the transfer, not the
                    machine. Offered as soon as the plan succeeds, and run
                    again on demand — the source being switched off is worth
                    re-checking after someone has been near it. */}
                {st.succeeded && (
                  <VerifyPanel
                    planName={p.planName}
                    result={verifs[p.planName]}
                    busy={busy === p.planName}
                    onRun={() => runVerify(p.planName)}
                  />
                )}

                {/* ── Retire the source ────────────────────────────────────
                    Offered only once the plan has succeeded, and refused by
                    the server until verification passes and the soak elapses. */}
                {st.succeeded && (
                  <DecommissionPanel
                    planName={p.planName}
                    posture={decoms[p.planName]}
                    busy={busy === p.planName}
                    onLoad={() => loadDecom(p.planName)}
                    onRaise={(force) => raiseDecom(p.planName, force)}
                  />
                )}

                {/* ── The cutover ──────────────────────────────────────────
                    The second gate, and the one that costs an outage. The
                    disks moved at "Migrate"; this is where the guests go
                    down. It is deliberately not a button that is always
                    available: what is offered here depends on what the change
                    board approved and on whether we are inside the window
                    they approved it for. */}
                {st.cutover?.awaitingCutover && (
                  <CutoverPanel
                    planName={p.planName}
                    posture={cutovers[p.planName]}
                    busy={busy === p.planName}
                    onLoad={() => loadCutover(p.planName)}
                    onGo={(at) => doCutover(p.planName, at)}
                  />
                )}
                {(st.vms || []).map((v) => (
                  <div key={v.name} style={{ marginTop: 6, fontSize: "0.77rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: v.failed ? "#dc2626" : v.phase === "Completed" ? "#16a34a" : "#f59e0b" }} />
                      <b>{v.name}</b> <span style={{ color: "var(--muted,#5a6373)" }}>{v.phase}</span>
                      <span style={{ marginLeft: "auto", color: "var(--muted,#5a6373)", fontSize: "0.72rem" }}>{v.stepsDone}/{v.stepsTotal} steps</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 999, background: "rgba(127,127,127,.15)", marginTop: 3, overflow: "hidden" }}>
                      <div style={{ width: `${v.percent}%`, height: "100%", background: v.failed ? "#dc2626" : "#0ea5a0" }} />
                    </div>
                    {v.error && <div style={{ color: "#dc2626", fontSize: "0.72rem", marginTop: 2 }}>{v.error}</div>}
                  </div>
                ))}
              </div>
            );
          })}

          {/* ── Rollback confirmation: what it MEANS, before it is done ───── */}
          {rollback && (
            <div style={{ border: "1px solid rgba(220,38,38,.45)", borderRadius: 10, padding: "11px 13px", background: "rgba(220,38,38,.05)" }}>
              <div style={{ fontWeight: 800, fontSize: "0.85rem", color: "#dc2626" }}>↩ Roll back {rollback.planName}</div>
              <div style={{ fontSize: "0.78rem", marginTop: 4 }}>Stage: <b>{rollback.decision?.stage}</b></div>
              {(rollback.decision?.actions || []).map((a, i) => <div key={i} style={{ fontSize: "0.78rem", marginTop: 2 }}>· {a}</div>)}
              {rollback.decision?.warning && <div style={{ fontSize: "0.78rem", color: "#b45309", marginTop: 5 }}>⚠ {rollback.decision.warning}</div>}
              {rollback.decision?.sourceAction && (
                <div style={{ fontSize: "0.78rem", marginTop: 5, padding: "6px 9px", borderRadius: 7, background: "rgba(245,158,11,.10)", color: "#92400e" }}>
                  <b>Manual step this platform cannot do for you:</b> {rollback.decision.sourceAction}
                </div>
              )}
              {rollback.result ? (
                <div style={{ fontSize: "0.78rem", marginTop: 7 }}>
                  <div style={{ color: rollback.result.ok ? "#16a34a" : "#dc2626", fontWeight: 700 }}>{rollback.result.message || (rollback.result.ok ? "Rolled back" : "Rollback incomplete")}</div>
                  {(rollback.result.deleted || []).map((x, i) => <div key={i} style={{ color: "var(--muted,#5a6373)" }}>removed {x}</div>)}
                  {(rollback.result.failed || []).map((x, i) => <div key={i} style={{ color: "#dc2626" }}>✖ {x.target}: {x.error}</div>)}
                  <button onClick={() => setRollback(null)} style={{ ...S, marginTop: 7, padding: "4px 12px", cursor: "pointer" }}>Close</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
                  <button onClick={doRollback} disabled={busy === rollback.planName}
                    style={{ ...S, background: "#dc2626", color: "#fff", border: "none", fontWeight: 700, cursor: "pointer" }}>
                    {busy === rollback.planName ? "Rolling back…" : "Confirm rollback"}
                  </button>
                  <button onClick={() => setRollback(null)} style={{ ...S, cursor: "pointer" }}>Cancel</button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
