import { useState, useEffect, useCallback } from "react";
import { clusterUrl } from "../api/client";
import { showToast } from "../store/toastStore";

/**
 * Containerization Agent — should this machine still be a machine?
 *
 * The deliberate difference from the Migration Agent, which sits beside it:
 * that one answers whether a VM can move, this one answers whether it should
 * remain a VM at all, and the two are allowed to disagree. One discovery pass,
 * two destinations, both landing on this cluster.
 *
 * Two things this screen does that assessment tools usually do not:
 *
 *  1. It shows the candidate rate TWICE — against the whole selection and
 *     against the machines that actually answered. The second number is the
 *     one every competitor quotes, and putting them side by side is the
 *     argument. Ninety percent of the tenth that responded is the statistic
 *     that ends a pilot.
 *
 *  2. A machine it could not read is displayed as NOT ASSESSED, in its own
 *     band, never folded in with the ones that passed. Silence is not a clean
 *     bill of health.
 */

const VERDICT_STYLE = {
  "container-ready":      { fg: "#15803d", bg: "rgba(22,163,74,.10)",  bd: "rgba(22,163,74,.28)" },
  "container-with-work":  { fg: "#b45309", bg: "rgba(217,119,6,.10)",  bd: "rgba(217,119,6,.28)" },
  "vm-only":              { fg: "#3730a3", bg: "rgba(67,56,202,.09)",  bd: "rgba(67,56,202,.24)" },
  inconclusive:           { fg: "#475569", bg: "rgba(71,85,105,.08)",  bd: "rgba(71,85,105,.22)" },
  unreadable:             { fg: "#64748b", bg: "transparent",          bd: "rgba(100,116,139,.35)", dashed: true },
  "powered-off":          { fg: "#64748b", bg: "transparent",          bd: "rgba(100,116,139,.35)", dashed: true },
};
const NOT_ASSESSED = new Set(["unreadable", "powered-off"]);

const card = {
  border: "1px solid var(--border,#e4e8f1)", borderRadius: 12,
  background: "var(--card-bg,#fff)", padding: 16, marginBottom: 12,
};
const label = { display: "block", fontSize: ".72rem", fontWeight: 700, letterSpacing: ".6px",
  textTransform: "uppercase", color: "var(--muted,#5a6373)", marginBottom: 6 };
const input = { width: "100%", padding: "9px 12px", borderRadius: 8, fontFamily: "inherit",
  border: "1px solid var(--border,#e4e8f1)", background: "var(--card-bg,#fff)", fontSize: ".88rem", boxSizing: "border-box" };
const btn = (primary) => ({
  padding: "9px 18px", borderRadius: 8, fontWeight: 700, fontSize: ".86rem", fontFamily: "inherit",
  cursor: "pointer", border: primary ? "none" : "1px solid var(--border,#e4e8f1)",
  background: primary ? "#3d5afe" : "transparent", color: primary ? "#fff" : "var(--muted,#5a6373)",
});

export default function ContainerizationAgent({ cluster, clusters = [] }) {
  const [scope, setScope] = useState("cluster");   // cluster | fleet
  const [fleet, setFleet] = useState(null);
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [vms, setVms] = useState(null);
  const [sel, setSel] = useState({});
  const [creds, setCreds] = useState({ username: "", password: "" });
  const [result, setResult] = useState(null);
  const [posture, setPosture] = useState(null);
  const [busy, setBusy] = useState(null);

  const cUrl = (p) => clusterUrl(p, cluster);
  const get = async (p) => (await fetch(cUrl(p))).json();
  const post = async (p, body) => (await fetch(cUrl(p), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  })).json();

  // The source providers MTV already holds, so a vCenter never has to be
  // configured twice and the two credentials cannot drift apart.
  const loadProviders = useCallback(async () => {
    try {
      const d = await get("/api/migration/readiness");
      const src = d.sources || [];
      setProviders(src);
      if (src[0] && !provider) setProvider(src[0].uid);
    } catch { /* the discover button reports it */ }
  }, [cluster]);            // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadProviders(); }, [loadProviders]);

  const [tc, setTc] = useState(null);
  useEffect(() => {
    let live = true;
    const names = clusters.map((c) => c.name || c.id || c).filter(Boolean);
    get(`/api/containerize/toolchain${names.length ? `?clusters=${encodeURIComponent(names.join(","))}` : ""}`)
      .then((d) => { if (live) setTc(d); })
      .catch(() => { if (live) setTc({ components: [], capabilities: {}, unreachable: true }); });
    return () => { live = false; };
  }, [cluster, clusters.length]);            // eslint-disable-line react-hooks/exhaustive-deps

  // Discovery needs MTV and nothing else. Gating it on the build or pipeline
  // tooling would invent a dependency that does not exist — those gate their
  // own steps, further down, where they actually bite.
  const canDiscover = tc?.capabilities?.discover?.ready !== false;
  const discoverBlockers = tc?.capabilities?.discover?.blockedBy || [];

  const discover = async () => {
    if (!provider) return;
    setBusy("discover"); setVms(null); setResult(null);
    try {
      const d = await post("/api/containerize/inventory", { provider: provider || undefined, search });
      setVms(d.vms || []);
      setInventorySource(d);
      if (d.error) showToast(d.error, "err");
      else if (!d.vms?.length && d.reason) showToast(d.reason, "err");
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const selection = (vms || []).filter((v) => sel[v.id || v.name]);

  const [assessError, setAssessError] = useState(null);
  const [inventorySource, setInventorySource] = useState(null);
  const assess = async () => {
    if (!selection.length) return;
    setBusy("assess"); setAssessError(null);
    try {
      const d = await post("/api/containerize/assess", {
        vms: selection, provider,
        guestUsername: creds.username || undefined,
        guestPassword: creds.password || undefined,
      });
      if (d.error) {
        setAssessError(/unknown api endpoint/i.test(d.error)
          ? "This server build does not have the assessment endpoint. The console is newer than the server serving it — redeploy the server image."
          : d.error);
        showToast(d.error, "err");
        return;
      }
      setResult(d);
      // The OS and platform picture for the same machines. Separate call so a
      // slow cluster read cannot delay the verdicts, and a failure here loses
      // a panel rather than the assessment.
      post("/api/containerize/os-support", { vms: selection, advise: true })
        .then((o) => { if (!o.error) setPosture(o); })
        .catch(() => { /* the panel simply does not appear */ });
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  /**
   * Re-read only the machines whose guest credential was rejected.
   *
   * A fleet where most machines share one account and a handful have their own
   * is the normal case. Re-running everything to pick those up wastes a long
   * read and, worse, invites someone to run the whole thing again with the
   * second credential and keep the wrong half.
   */
  const retryRejected = async (names, extra) => {
    if (!names.length || !extra.username || !extra.password) return;
    setBusy("assess");
    try {
      const perMachine = Object.fromEntries(names.map((n) => [n, { username: extra.username, password: extra.password }]));
      const d = await post("/api/containerize/assess", {
        vms: selection.filter((v) => names.includes(v.name)),
        provider,
        guestCredentials: perMachine,
      });
      if (d.error) { showToast(d.error, "err"); return; }
      // Merge: the retried machines replace their old rows, everything else stands.
      setResult((prev) => {
        const replaced = new Map(d.results.map((r) => [r.name, r]));
        const results = prev.results.map((r) => replaced.get(r.name) || r);
        return { ...prev, results, funnel: recount(results, prev.funnel) };
      });
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  // ── The wizard ───────────────────────────────────────────────────────────
  // This screen used to be one long scroll: toolchain, scope, source, machines,
  // credential, results, proposal, build. Everything was visible at once, which
  // reads as a settings page rather than a procedure, and left no way to tell
  // what had been done from what was merely available. An assessment IS a
  // procedure — each step is a decision the next one depends on — so it is
  // presented as one, with the same step rail the migration agent uses.
  //
  // Steps go backwards freely and forwards only by doing the work, which is
  // what makes the rail an honest record of progress rather than navigation.
  const [step, setStep] = useState(1);
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);

  const fleetMode = scope === "fleet";
  // What the propose and report steps operate on, whichever scope produced it.
  const assessedResults = fleetMode ? (fleet?.machines || []).map((m) => m.result).filter(Boolean) : (result?.results || []);
  const candidateCount = assessedResults.filter((r) => ["container-ready", "container-with-work"].includes(r.verdict)).length;
  const hasAssessment = fleetMode ? Boolean(fleet) : Boolean(result);

  // Proposing is a separate, explicit act. The assessment is the thing a
  // customer argues with; generating a scaffold before they have agreed the
  // verdict puts YAML in front of a decision nobody has made yet.
  const propose = async () => {
    setPlanning(true);
    try {
      const d = await post("/api/containerize/plan", { results: assessedResults });
      if (d.error) { showToast(d.error, "err"); return; }
      setPlan(d);
    } catch (e) { showToast(e.message, "err"); }
    finally { setPlanning(false); }
  };

  const restart = () => {
    setStep(1); setVms(null); setSel({}); setResult(null); setPosture(null);
    setFleet(null); setPlan(null); setCreds({ username: "", password: "" });
  };

  // A step is reachable once the work it depends on exists. Nothing is gated on
  // a step being "visited" — walking back and forth must not lose a result.
  const done = {
    1: canDiscover,
    2: fleetMode ? Boolean(fleet) || Boolean(clusters.length) : selection.length > 0,
    3: hasAssessment,
    4: Boolean(plan),
    5: false,
  };
  const furthest = hasAssessment ? (plan ? 5 : 4) : (fleetMode ? 3 : (vms ? 3 : (canDiscover ? 2 : 1)));

  return (
    <div>
      <Intro />

      <Steps step={step} setStep={setStep} furthest={furthest} onRestart={restart} />

      {/* ── 1 · Prerequisites ───────────────────────────────────────────── */}
      {step === 1 && (
        <>
          {fleetMode && tc?.perCluster ? <ToolchainMatrix tc={tc} /> : <Toolchain tc={tc} />}
          <ScopeSwitch scope={scope} setScope={setScope} clusters={clusters} cluster={cluster} />
          <StepFooter
            ready={canDiscover}
            blockedBy={discoverBlockers.map((b) => `${b.tool} — ${b.reason}`)}
            next="Choose what to assess"
            onNext={() => setStep(2)}
          />
        </>
      )}

      {/* ── 2 · Discover · 3 · Assess (estate) ──────────────────────────
          Rendered unconditionally in fleet mode and gated INSIDE, so stepping
          back and forth does not unmount it and lose the per-cluster
          credentials somebody has just typed. */}
      {fleetMode && (step === 2 || step === 3) && (
        <FleetView clusters={clusters} fleet={fleet} setFleet={setFleet} post={post}
          creds={creds} setCreds={setCreds} step={step} setStep={setStep} />
      )}

      {step === 2 && !fleetMode && (<>

      {/* ── Pick the machines ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 240, flex: "1 1 240px" }}>
            <label style={label}>Source</label>
            <select style={input} value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">vCenter configured on this product</option>
              {providers.map((p) => <option key={p.uid} value={p.uid}>{p.name} (via MTV)</option>)}
            </select>
          </div>
          <div style={{ minWidth: 200, flex: "1 1 200px" }}>
            <label style={label}>Filter by name</label>
            <input style={input} value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="optional" onKeyDown={(e) => e.key === "Enter" && discover()} />
          </div>
          <button style={btn(true)} onClick={discover}
            disabled={busy === "discover"}
            title={canDiscover ? "" : discoverBlockers.map((b) => b.tool).join(", ") + " is not usable on this cluster"}>
            {busy === "discover" ? "Reading inventory…" : "Discover"}
          </button>
        </div>

        {discoverBlockers.length > 0 && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border,#eef1f7)" }}>
            {discoverBlockers.map((b) => (
              <p key={b.id} style={{ margin: "0 0 6px", fontSize: ".82rem", lineHeight: 1.6, color: "#b45309" }}>
                <strong>{b.tool} must be installed first.</strong> {b.reason}
              </p>
            ))}
          </div>
        )}

        <ProviderScope providers={providers} provider={provider} cluster={cluster} />
        {inventorySource && (
          <p style={{ margin: "8px 0 0", fontSize: ".79rem", lineHeight: 1.55, color: inventorySource.vms?.length ? "var(--muted,#5a6373)" : "#b45309" }}>
            {inventorySource.vms?.length
              ? `${inventorySource.total ?? inventorySource.vms.length} machines read from ${inventorySource.vcenter || "vCenter"}${inventorySource.via ? ` via ${inventorySource.via}` : ""}. Templates are excluded.`
              : inventorySource.reason}
          </p>
        )}
      </div>

      {vms && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <strong style={{ fontSize: ".92rem" }}>{vms.length} machines · {selection.length} selected</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn(false)} onClick={() => setSel(Object.fromEntries(vms.map((v) => [v.id || v.name, true])))}>Select all</button>
              <button style={btn(false)} onClick={() => setSel({})}>Clear</button>
            </div>
          </div>
          <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border,#e4e8f1)", borderRadius: 8 }}>
            {vms.map((v) => {
              const k = v.id || v.name;
              return (
                <label key={k} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 12px",
                  borderBottom: "1px solid var(--border,#eef1f7)", fontSize: ".85rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={!!sel[k]} onChange={(e) => setSel((s) => ({ ...s, [k]: e.target.checked }))} />
                  <span style={{ fontWeight: 600 }}>{v.name}</span>
                  <span style={{ color: "var(--muted,#5a6373)" }}>{v.guestOS || v.osType || ""}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <StepFooter
        ready={selection.length > 0}
        blockedBy={selection.length ? [] : ["Select at least one machine."]}
        next={`Read inside ${selection.length || ""} machine${selection.length === 1 ? "" : "s"}`}
        onNext={() => setStep(3)}
      />
      </>)}

      {/* ── 3 · Assess ──────────────────────────────────────────────────── */}
      {step === 3 && !fleetMode && (
        <>
          <GuestCredential creds={creds} setCreds={setCreds} />
          <div style={{ marginBottom: 16 }}>
            <button style={btn(true)} onClick={assess} disabled={!selection.length || busy === "assess"}>
              {busy === "assess" ? "Reading inside the guests…"
                : result ? "Read them again" : `Assess ${selection.length || ""} machine${selection.length === 1 ? "" : "s"}`}
            </button>
          </div>
          {assessError && (
            <div style={{ ...card, borderColor: "rgba(185,28,28,.35)" }}>
              <div style={{ ...label, color: "#b91c1c" }}>The machines could not be read</div>
              <p style={{ margin: 0, fontSize: ".84rem", lineHeight: 1.6 }}>{assessError}</p>
            </div>
          )}
          {posture && <OsSupport posture={posture} />}
          {result && <Results result={result} onRetry={retryRejected} />}
          {result && (
            <StepFooter
              ready={candidateCount > 0}
              blockedBy={candidateCount ? [] : ["No machine was assessed as a containerisation candidate, so there is nothing to propose a build for."]}
              next={`Propose a build for ${candidateCount} candidate${candidateCount === 1 ? "" : "s"}`}
              onNext={() => setStep(4)}
            />
          )}
        </>
      )}

      {/* ── 4 · Propose ─────────────────────────────────────────────────── */}
      {step === 4 && (
        <>
          <div style={card}>
            <strong style={{ fontSize: ".93rem" }}>A Containerfile and the manifests that would run it</strong>
            <p style={{ margin: "8px 0 12px", fontSize: ".85rem", lineHeight: 1.6, color: "var(--muted,#5a6373)" }}>
              For the {candidateCount} machine{candidateCount === 1 ? "" : "s"} the assessment cleared. Nothing is
              built, tagged, pushed or deployed — every artefact here is a proposal for a human to read.
            </p>
            <button style={btn(true)} onClick={propose} disabled={planning || !candidateCount}>
              {planning ? "Proposing…" : plan ? "Propose again" : "Propose the build"}
            </button>
          </div>
          {plan && <Plans plan={plan} caps={tc?.capabilities} />}
          {plan && (
            <StepFooter ready blockedBy={[]} next="Take the evidence pack" onNext={() => setStep(5)} />
          )}
        </>
      )}

      {/* ── 5 · Report ──────────────────────────────────────────────────── */}
      {step === 5 && (
        <ReportStep fleetMode={fleetMode} fleet={fleet} result={result} cluster={cluster}
          clusters={clusters} creds={creds} onRestart={restart} />
      )}
    </div>
  );
}

/**
 * The step rail.
 *
 * Backwards is free, forwards is earned: you reach the assessment by assessing.
 * That is what makes the rail a record of what has happened rather than a menu,
 * and it is the same contract the migration agent's rail keeps.
 */
function Steps({ step, setStep, furthest, onRestart }) {
  const STEPS = [[1, "Prerequisites"], [2, "Discover"], [3, "Assess"], [4, "Propose"], [5, "Report"]];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
      {STEPS.map(([n, lbl], i) => {
        const reachable = n <= Math.max(step, furthest);
        return (
          <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {i > 0 && <span style={{ color: "var(--muted,#5a6373)", opacity: 0.5 }}>→</span>}
            <button onClick={() => { if (reachable) setStep(n); }} disabled={!reachable}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999,
                fontFamily: "inherit", fontSize: ".78rem", fontWeight: 700,
                border: `1px solid ${n === step ? "rgba(61,90,254,.55)" : "var(--border,#e4e8f1)"}`,
                background: n === step ? "rgba(61,90,254,.12)" : "transparent",
                color: n === step ? "#3d5afe" : "var(--muted,#5a6373)",
                cursor: reachable && n !== step ? "pointer" : "default", opacity: reachable ? 1 : 0.45 }}>
              <span style={{ width: 17, height: 17, borderRadius: 999, display: "inline-flex", alignItems: "center",
                justifyContent: "center", fontSize: ".72rem", fontWeight: 800,
                background: n < step ? "#16a34a" : n === step ? "#3d5afe" : "var(--border,#e4e8f1)",
                color: n <= step ? "#fff" : "var(--muted,#5a6373)" }}>{n < step ? "✓" : n}</span>
              {lbl}
            </button>
          </span>
        );
      })}
      {step > 1 && (
        <button onClick={onRestart} title="Clear this assessment and start again from Prerequisites."
          style={{ ...btn(false), marginLeft: "auto", padding: "5px 12px", fontSize: ".77rem" }}>
          + New assessment
        </button>
      )}
    </div>
  );
}

/**
 * The bottom of a step: what it is waiting for, or the way on.
 *
 * The reason a step cannot advance is printed rather than left to a disabled
 * button, because a control that is grey for an unstated reason is the single
 * most common way a wizard wastes somebody's afternoon.
 */
function StepFooter({ ready, blockedBy = [], next, onNext }) {
  return (
    <div style={{ ...card, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <button style={btn(true)} onClick={onNext} disabled={!ready}>{next} →</button>
      {!ready && blockedBy.map((b, i) => (
        <span key={i} style={{ fontSize: ".82rem", lineHeight: 1.55, color: "#b45309" }}>{b}</span>
      ))}
    </div>
  );
}

/**
 * The document the assessment ends in — available from either scope.
 *
 * A single-cluster run is shaped into the same record the fleet export expects,
 * so one cluster and an estate produce the same document rather than one of
 * them producing nothing.
 */
function ReportStep({ fleetMode, fleet, result, cluster, clusters, creds, onRestart }) {
  const payload = fleetMode ? fleet : result && {
    machines: (result.results || []).map((r) => ({
      name: r.name, result: r, clusters: [cluster], seenIn: [{ cluster, verdict: r.verdict }],
      duplicated: false, conflicting: false, identity: { basis: "single cluster", confidence: "certain" },
    })),
    funnel: result.funnel, portfolio: null, conflicts: [], possible: [], duplicates: [],
    dependencies: { supplied: false, crossings: [], note: "No dependency data was supplied." },
    observations: (result.results || []).length, distinct: (result.results || []).length,
    note: `Assessed on cluster ${cluster}.`,
  };

  const download = (format) => {
    fetch("/api/containerize/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fleet: payload, format,
        clusters: fleetMode ? (fleet?.scope || clusters.map((c) => c.name || c)) : [cluster],
        credentialSupplied: Boolean(creds.username && creds.password) }),
    })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `containerisation-assessment.${format}`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => showToast(e.message, "err"));
  };

  if (!payload) {
    return <div style={card}><p style={{ margin: 0, fontSize: ".85rem" }}>Nothing has been assessed yet.</p></div>;
  }

  return (
    <div style={card}>
      <strong style={{ fontSize: ".93rem" }}>Take the evidence pack</strong>
      <p style={{ margin: "8px 0 12px", fontSize: ".85rem", lineHeight: 1.6, color: "var(--muted,#5a6373)" }}>
        {payload.distinct} machine{payload.distinct === 1 ? "" : "s"}, with the ones that could not be read
        included rather than omitted. The pack states how everything was read and what was not read, so it
        survives being opened a year later by somebody asking why a machine stayed a VM.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button style={btn(true)} onClick={() => download("html")}>Download the pack (HTML / print to PDF)</button>
        <button style={btn(false)} onClick={() => download("csv")}>Download the register (CSV)</button>
        <button style={{ ...btn(false), marginLeft: "auto" }} onClick={onRestart}>Start another assessment</button>
      </div>
    </div>
  );
}

/**
 * One cluster, or the estate.
 *
 * Offered rather than defaulted: a fleet run touches every cluster's vCenter
 * and is a much heavier request than looking at one, so it is a choice the
 * operator makes knowingly.
 */
function ScopeSwitch({ scope, setScope, clusters, cluster }) {
  if (!clusters.length) return null;
  const tab = (k, lbl) => (
    <button key={k} onClick={() => setScope(k)} style={{
      padding: "7px 14px", borderRadius: 8, border: "none", fontFamily: "inherit",
      fontWeight: 700, fontSize: ".82rem", cursor: "pointer",
      background: scope === k ? "#3d5afe" : "transparent", color: scope === k ? "#fff" : "var(--muted,#5a6373)",
    }}>{lbl}</button>
  );
  return (
    <div style={{ ...card, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 10,
        background: "var(--card-bg,#f0f2f8)", border: "1px solid var(--border,#e4e8f1)" }}>
        {tab("cluster", `This cluster — ${cluster}`)}
        {tab("fleet", `Whole estate — ${clusters.length} clusters`)}
      </div>
      <span style={{ fontSize: ".8rem", color: "var(--muted,#5a6373)" }}>
        The same vCenter is often registered in more than one cluster. Across the estate, machines are
        merged on their BIOS UUID so none is counted twice.
      </span>
    </div>
  );
}

/**
 * The estate view.
 *
 * The numbers here are the ones that go on a slide, which is exactly why they
 * are computed over de-duplicated machines and why disagreements between
 * clusters are shown rather than resolved quietly.
 */
function FleetView({ clusters, fleet, setFleet, post, creds, setCreds, step, setStep }) {
  const [busy, setBusy] = useState(false);
  const names = clusters.map((c) => c.name || c.id || c);
  // Per cluster: whether it is in this run, and the account to use inside its
  // guests. A fleet where production, DR and a lab each have their own service
  // account is the ordinary case, and one credential for the estate means the
  // run silently fails on every cluster but one.
  const [rows, setRows] = useState(() => Object.fromEntries(names.map((n) => [n, { include: true, username: "", password: "" }])));
  const [showCreds, setShowCreds] = useState(false);
  const set = (n, patch) => setRows((r) => ({ ...r, [n]: { ...r[n], ...patch } }));
  const inScope = names.filter((n) => rows[n]?.include);

  const [failure, setFailure] = useState(null);
  const run = async () => {
    setBusy(true); setFailure(null);
    try {
      const d = await post("/api/containerize/fleet", {
        clusters: inScope.map((n) => ({
          cluster: n,
          ...(rows[n].username && rows[n].password
            ? { guestUsername: rows[n].username, guestPassword: rows[n].password } : {}),
        })),
        guestUsername: creds.username || undefined,
        guestPassword: creds.password || undefined,
      });
      if (d.error) {
        // "Unknown API endpoint" is not a user error: it means the server
        // serving this console is older than the console itself, which a toast
        // that vanishes in three seconds will never communicate.
        const stale = /unknown api endpoint/i.test(d.error);
        setFailure(stale
          ? "This server build does not have the estate endpoint. The console is newer than the server it is being served by — redeploy the server image, then try again."
          : d.error);
        showToast(d.error, "err");
        return false;
      }
      setFleet({ ...d, scope: inScope });
      return true;
    } catch (e) { setFailure(e.message); showToast(e.message, "err"); return false; }
    finally { setBusy(false); }
  };

  const download = (format) => {
    const body = JSON.stringify({ fleet, format, clusters: fleet?.scope || inScope,
      credentialSupplied: Boolean(creds.username && creds.password) || inScope.some((n) => rows[n].username) });
    fetch("/api/containerize/export", { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `containerisation-assessment.${format}`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => showToast(e.message, "err"));
  };

  const partial = fleet && fleet.scope && fleet.scope.length < names.length;

  return (
    <>
      {step === 2 && <GuestCredential creds={creds} setCreds={setCreds} />}

      <div style={{ ...card, display: step === 2 ? "block" : "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={label}>Clusters in this run — {inScope.length} of {names.length}</div>
          <button onClick={() => setShowCreds((v) => !v)} style={{ background: "none", border: "none", padding: 0,
            cursor: "pointer", fontSize: ".8rem", fontWeight: 600, color: "#3d5afe", fontFamily: "inherit" }}>
            {showCreds ? "Hide" : "Set"} a different account per cluster
          </button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem", marginTop: 8 }}>
          <tbody>
            {names.map((n) => (
              <tr key={n} style={{ borderTop: "1px solid var(--border,#eef1f7)" }}>
                <td style={{ padding: "7px 8px 7px 0", width: 26 }}>
                  <input type="checkbox" checked={!!rows[n]?.include} onChange={(e) => set(n, { include: e.target.checked })} />
                </td>
                <td style={{ padding: "7px 8px", fontWeight: 600, whiteSpace: "nowrap" }}>{n}</td>
                {showCreds ? (
                  <td style={{ padding: "5px 0" }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input style={{ ...input, padding: "6px 10px", fontSize: ".8rem" }} placeholder="username in these guests"
                        value={rows[n]?.username || ""} onChange={(e) => set(n, { username: e.target.value })} autoComplete="off" />
                      <input style={{ ...input, padding: "6px 10px", fontSize: ".8rem" }} type="password" placeholder="password"
                        value={rows[n]?.password || ""} onChange={(e) => set(n, { password: e.target.value })} autoComplete="new-password" />
                    </div>
                  </td>
                ) : (
                  <td style={{ padding: "7px 0", color: "var(--muted,#5a6373)" }}>
                    {rows[n]?.username ? "its own account" : creds.username ? "the account above" : "no credential — nothing inside will be read"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ margin: "10px 0 0", fontSize: ".79rem", lineHeight: 1.55, color: "var(--muted,#5a6373)" }}>
          A cluster with its own account uses it; the rest fall back to the account above. Untick a cluster to
          leave it out — useful for re-reading just the one whose credential was wrong, though the result is then
          a view of those clusters and not of the estate.
        </p>
      </div>

      {failure && step === 2 && (
        <div style={{ ...card, borderColor: "rgba(185,28,28,.35)" }}>
          <div style={{ ...label, color: "#b91c1c" }}>The estate could not be read</div>
          <p style={{ margin: 0, fontSize: ".84rem", lineHeight: 1.6 }}>{failure}</p>
        </div>
      )}

      <div style={{ marginBottom: 16, display: step === 2 ? "block" : "none" }}>
        <button style={btn(true)} onClick={async () => { if (await run()) setStep(3); }} disabled={busy || !inScope.length}>
          {busy ? `Reading ${inScope.length} cluster${inScope.length === 1 ? "" : "s"}…`
            : inScope.length === names.length ? "Assess the whole estate" : `Assess ${inScope.length} cluster${inScope.length === 1 ? "" : "s"}`}
        </button>
        <span style={{ marginLeft: 12, fontSize: ".8rem", color: "var(--muted,#5a6373)" }}>
          Reads each cluster's vCenter in turn. Slower than one cluster, and the only number worth quoting.
        </span>
      </div>

      {!fleet && step === 3 && (
        <div style={card}>
          <div style={label}>Nothing to show yet</div>
          <p style={{ margin: "0 0 12px", fontSize: ".84rem", lineHeight: 1.6 }}>
            {failure || "The estate has not been read yet. Go back to Discover, choose the clusters and run the assessment."}
          </p>
          <button style={btn(true)} onClick={() => setStep(2)}>← Back to Discover</button>
        </div>
      )}

      {fleet && step === 3 && (
        <>
          {partial && (
            <div style={{ ...card, borderColor: "rgba(217,119,6,.3)" }}>
              <p style={{ margin: 0, fontSize: ".83rem", lineHeight: 1.6, color: "#b45309" }}>
                <strong>This is {fleet.scope.length} of {names.length} clusters, not the estate.</strong> The percentages
                below describe {fleet.scope.join(", ")} only. Re-run with every cluster ticked before quoting them.
              </p>
            </div>
          )}

          <div style={{ ...card, borderColor: "rgba(61,90,254,.25)" }}>
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "baseline" }}>
              <Figure n={fleet.funnel.candidates} of={fleet.funnel.total} pct={fleet.funnel.candidatePctOfEstate} title={partial ? "of the clusters read" : "of the estate"} strong />
              <Figure n={fleet.funnel.candidates} of={fleet.funnel.assessed} pct={fleet.funnel.candidatePctOfAssessed} title="of what answered" />
              <Figure n={fleet.distinct} of={fleet.observations} pct={Math.round((fleet.distinct / Math.max(1, fleet.observations)) * 100)} title="distinct machines, after de-duplication" />
            </div>
            <p style={{ margin: "12px 0 0", fontSize: ".84rem", lineHeight: 1.6, color: "var(--muted,#5a6373)" }}>
              {fleet.note} {fleet.funnel.note}
            </p>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button style={btn(false)} onClick={() => download("html")}>Download the pack (HTML / print to PDF)</button>
              <button style={btn(false)} onClick={() => download("csv")}>Download the register (CSV)</button>
            </div>
          </div>

          <div style={card}>
            <div style={label}>Where the work sits</div>
            <p style={{ margin: "0 0 10px", fontSize: ".84rem", color: "var(--muted,#5a6373)" }}>{fleet.portfolio.note}</p>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem" }}>
              <tbody>
                {fleet.portfolio.topBlockers.map((b) => (
                  <tr key={b.id} style={{ borderTop: "1px solid var(--border,#eef1f7)" }}>
                    <td style={{ padding: "6px 8px 6px 0", fontWeight: 600 }}>{b.title}</td>
                    <td style={{ padding: "6px 8px", width: 60 }}>{b.count}</td>
                    <td style={{ padding: "6px 0", color: "var(--muted,#5a6373)" }}>{b.machines.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {fleet.conflicts.length > 0 && (
            <div style={{ ...card, borderColor: "rgba(217,119,6,.3)" }}>
              <div style={{ ...label, color: "#b45309" }}>The same machine scored differently in two clusters — {fleet.conflicts.length}</div>
              {fleet.conflicts.map((c) => (
                <p key={c.key} style={{ margin: "0 0 8px", fontSize: ".83rem", lineHeight: 1.6 }}>
                  <strong>{c.name}</strong> — {c.seenIn.map((x) => `${x.cluster}: ${x.verdict}`).join(" · ")}.
                  <br /><span style={{ color: "var(--muted,#5a6373)" }}>{c.why}</span>
                </p>
              ))}
            </div>
          )}

          {fleet.possible.length > 0 && (
            <div style={card}>
              <div style={label}>Possible duplicates — confirm before trusting the count</div>
              {fleet.possible.map((x) => (
                <p key={x.name} style={{ margin: "0 0 6px", fontSize: ".82rem" }}>
                  <strong>{x.name}</strong> matched on {x.basis} ({x.confidence}) across {x.seenIn.map((y) => y.cluster).join(", ")}. {x.note}
                </p>
              ))}
            </div>
          )}

          <div style={{ ...card, background: "var(--card-bg,#f7f9fc)" }}>
            <div style={label}>Dependencies</div>
            <p style={{ margin: 0, fontSize: ".83rem", lineHeight: 1.6, color: "var(--muted,#5a6373)" }}>{fleet.dependencies.note}</p>
          </div>

          <div style={card}>
            <div style={label}>Per cluster</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem" }}>
              <tbody>
                {fleet.perCluster.map((c) => (
                  <tr key={c.cluster} style={{ borderTop: "1px solid var(--border,#eef1f7)" }}>
                    <td style={{ padding: "6px 8px 6px 0", fontWeight: 600, whiteSpace: "nowrap" }}>{c.cluster}</td>
                    <td style={{ padding: "6px 8px", color: "var(--muted,#5a6373)" }}>
                      {c.provider || "—"}{c.vcenter ? ` · ${c.vcenter}` : ""}
                      {c.credential ? <span style={{ display: "block", fontSize: ".76rem" }}>credential: {c.credential}</span> : null}
                    </td>
                    <td style={{ padding: "6px 0", color: c.reason ? "#b45309" : "var(--muted,#5a6373)" }}>
                      {c.reason || `${c.machines} machine${c.machines === 1 ? "" : "s"} read${c.read != null ? `, ${c.read} answered inside` : ""}`}
                      {/* Which cluster's credential was wrong, named, so one is
                          fixed rather than the estate re-run blindly. */}
                      {(c.rejected || []).length > 0 && (
                        <span style={{ display: "block", color: "#b45309", fontWeight: 600 }}>
                          {c.rejected.length} rejected this cluster's credential: {c.rejected.slice(0, 6).join(", ")}
                          {c.rejected.length > 6 ? ` +${c.rejected.length - 6} more` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}



/**
 * Where each layer comes from.
 *
 * Shown before anything is discovered, because "why should I trust this" is the
 * first question an architect asks and the honest answer is that most of this
 * is their own toolchain. The MTA row reports its real state — a customer
 * seeing "not installed" here and installing it is the integration working.
 */

/**
 * The toolchain across every cluster.
 *
 * The single-cluster table is honest about one cluster and silent about the
 * rest, which on a fleet is the same as wrong: an operator reads five green
 * dots and does not learn that three of their clusters have no OpenShift
 * Virtualization to land a VM on. Rows are clusters, columns are layers, and
 * every cell that is not green carries its reason underneath.
 */
function ToolchainMatrix({ tc }) {
  const rows = tc.perCluster || [];
  const layers = (rows[0]?.components || tc.components || []).filter((c) => !c.self);
  const dot = (c) => (c?.usable ? "#16a34a" : c?.present === null || c === undefined ? "#94a3b8" : "#b45309");
  const gaps = [];
  for (const r of rows) {
    for (const c of r.components || []) {
      if (!c.self && !c.usable) gaps.push({ cluster: r.cluster, tool: c.tool, reason: c.reason });
    }
    if (r.error) gaps.push({ cluster: r.cluster, tool: "this cluster", reason: r.error });
  }

  return (
    <div style={card}>
      <div style={label}>Toolchain — checked on every cluster</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".8rem" }}>
          <thead><tr>
            <th style={{ textAlign: "left", padding: "5px 10px 5px 0", fontSize: ".7rem", textTransform: "uppercase",
              letterSpacing: ".6px", color: "var(--muted,#5a6373)" }}>Cluster</th>
            {layers.map((l) => (
              <th key={l.id} style={{ textAlign: "left", padding: "5px 10px", fontSize: ".7rem", textTransform: "uppercase",
                letterSpacing: ".6px", color: "var(--muted,#5a6373)", whiteSpace: "nowrap" }}>{l.layer}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cluster} style={{ borderTop: "1px solid var(--border,#eef1f7)" }}>
                <td style={{ padding: "7px 10px 7px 0", fontWeight: 600, whiteSpace: "nowrap" }}>{r.cluster}</td>
                {layers.map((l) => {
                  const c = (r.components || []).find((x) => x.id === l.id);
                  return (
                    <td key={l.id} style={{ padding: "7px 10px" }}>
                      <span title={c?.usable ? "usable" : (c?.reason || "not usable")}
                        style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: dot(c) }} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {gaps.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border,#eef1f7)" }}>
          {gaps.map((g, i) => (
            <p key={i} style={{ margin: "0 0 6px", fontSize: ".81rem", lineHeight: 1.6, color: "#b45309" }}>
              <strong>{g.cluster} — {g.tool}.</strong> {g.reason || "Not usable on this cluster."}
            </p>
          ))}
        </div>
      )}
      <p style={{ margin: "10px 0 0", fontSize: ".79rem", lineHeight: 1.55, color: "var(--muted,#5a6373)" }}>
        Every layer but this product is Red Hat or CNCF, and every cell is a live API check against that cluster.
        A cluster missing OpenShift Virtualization has nowhere to land the machines this assessment says to keep as VMs.
      </p>
    </div>
  );
}

function Toolchain({ tc }) {
  const dot = { ok: "#16a34a", bad: "#b45309", unknown: "#94a3b8", own: "#3d5afe" };
  const state = (c) => (c.self ? "own" : c.usable ? "ok" : c.present === null ? "unknown" : "bad");

  if (!tc) return <div style={{ ...card, color: "var(--muted,#5a6373)", fontSize: ".84rem" }}>Checking the toolchain on this cluster…</div>;

  return (
    <div style={card}>
      <div style={label}>Toolchain — checked on this cluster</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem" }}>
        <tbody>
          {(tc.components || []).map((c) => (
            <tr key={c.id} style={{ borderTop: "1px solid var(--border,#eef1f7)" }}>
              <td style={{ padding: "6px 8px 6px 0", color: "var(--muted,#5a6373)", whiteSpace: "nowrap", verticalAlign: "top" }}>{c.layer}</td>
              <td style={{ padding: "6px 8px", fontWeight: 600, verticalAlign: "top" }}>
                <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%",
                  background: dot[state(c)], marginRight: 8, verticalAlign: "middle" }} />
                {c.tool}
              </td>
              <td style={{ padding: "6px 0", color: c.usable || c.self ? "var(--muted,#5a6373)" : "#b45309", verticalAlign: "top" }}>
                {/* The reason a layer is unusable is the useful half. A red dot
                    with no sentence beside it is a support ticket. */}
                {c.usable || c.self ? c.provenance : (c.reason || "Not usable on this cluster.")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: "10px 0 0", fontSize: ".8rem", lineHeight: 1.55, color: "var(--muted,#5a6373)" }}>
        Every layer but the last is Red Hat or CNCF, and each row above is a live API check against this
        cluster rather than a claim. This product decides which machines go where, records why, and hands
        the work to those tools — it does not reimplement them.
      </p>
    </div>
  );
}

/**
 * Which vCenter, and whose.
 *
 * The source list comes from MTV's Provider objects, which are resources IN the
 * active cluster — so it is already scoped correctly for a fleet with many
 * clusters and many vCenters. What it was not doing was SAYING so, which left
 * an operator with several vCenters unable to tell which one a name referred
 * to. The URL is what disambiguates two providers both called "vsphere".
 */
function ProviderScope({ providers, provider, cluster }) {
  const p = providers.find((x) => x.uid === provider);
  if (!providers.length) return null;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border,#eef1f7)", fontSize: ".8rem", lineHeight: 1.6 }}>
      <span style={{ color: "var(--muted,#5a6373)" }}>
        {providers.length} source provider{providers.length === 1 ? "" : "s"} registered in MTV on cluster <strong>{cluster}</strong>.
        Switch cluster to see the vCenters attached to another one.
      </span>
      {p && (
        <div style={{ marginTop: 4 }}>
          <strong>{p.name}</strong>
          {p.url && <span style={{ color: "var(--muted,#5a6373)" }}> · {p.url}</span>}
          {p.type && <span style={{ color: "var(--muted,#5a6373)" }}> · {p.type}</span>}
          {p.connected === false && (
            <span style={{ color: "#b45309", fontWeight: 600 }}> · not connected{p.reason ? ` — ${p.reason}` : ""}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Intro() {
  return (
    <div style={{ ...card, background: "var(--card-bg,#f7f9fc)" }}>
      <strong style={{ fontSize: ".95rem" }}>Which of these should stop being machines?</strong>
      <p style={{ margin: "8px 0 0", fontSize: ".86rem", lineHeight: 1.6, color: "var(--muted,#5a6373)" }}>
        vCenter describes the box. It does not say the box is a Tomcat serving one war file, or a
        Postgres nobody documented — and that difference is the whole decision. This reads what is
        actually running inside each guest through VMware Tools, and scores it. Nothing is executed
        in the guest and nothing is written to it.
      </p>
    </div>
  );
}

/**
 * Credentials are asked for here rather than stored in settings, and the screen
 * says so. A saved credential that can log in to every machine in an estate is
 * a larger liability than this assessment is worth.
 */
function GuestCredential({ creds, setCreds }) {
  return (
    <div style={card}>
      <label style={label}>Guest credential — optional</label>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <input style={{ ...input, flex: "1 1 200px" }} placeholder="Username inside the guest"
          value={creds.username} onChange={(e) => setCreds((c) => ({ ...c, username: e.target.value }))} autoComplete="off" />
        <input style={{ ...input, flex: "1 1 200px" }} type="password" placeholder="Password"
          value={creds.password} onChange={(e) => setCreds((c) => ({ ...c, password: e.target.value }))} autoComplete="new-password" />
      </div>
      <p style={{ margin: 0, fontSize: ".8rem", lineHeight: 1.55, color: "var(--muted,#5a6373)" }}>
        A local or domain account <em>on the machines themselves</em> — not a vCenter login. Used for this
        request only and never stored. Without it you still get guest OS, power state and Tools status,
        and every machine comes back <strong>not assessed</strong> — which is not the same as having no blockers.
      </p>
    </div>
  );
}

function Results({ result, onRetry }) {
  const { funnel, results, discovery, verdictLabels = {} } = result;
  const assessed = results.filter((r) => !NOT_ASSESSED.has(r.verdict));
  const notAssessed = results.filter((r) => NOT_ASSESSED.has(r.verdict));

  return (
    <div>
      {/* The funnel, both ways round. */}
      <div style={{ ...card, borderColor: "rgba(61,90,254,.25)" }}>
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "baseline" }}>
          <Figure n={funnel.candidates} of={funnel.total} pct={funnel.candidatePctOfEstate}
            title="of the machines you asked about" strong />
          <Figure n={funnel.candidates} of={funnel.assessed} pct={funnel.candidatePctOfAssessed}
            title="of the machines that answered" />
        </div>
        <p style={{ margin: "12px 0 0", fontSize: ".84rem", lineHeight: 1.6, color: "var(--muted,#5a6373)" }}>
          {funnel.note} The second figure is the one an assessment tool usually quotes. Both are shown
          because they are the same estate.
        </p>
        {!discovery.credentialSupplied && (
          <p style={{ margin: "10px 0 0", fontSize: ".84rem", lineHeight: 1.6, color: "#b45309", fontWeight: 600 }}>
            No guest credential was supplied, so nothing inside these machines was read.
          </p>
        )}
        {discovery.reason && (
          <p style={{ margin: "10px 0 0", fontSize: ".82rem", color: "var(--muted,#5a6373)" }}>{discovery.reason}</p>
        )}
        {discovery.vcenter && (
          <p style={{ margin: "8px 0 0", fontSize: ".78rem", color: "var(--muted,#8b93a3)" }}>
            Read from {discovery.vcenter}
            {discovery.credential === "mtv-secret" ? " using MTV's own provider credential" : ""}
            {discovery.coverage ? ` · process list read on ${discovery.coverage.processes} of ${discovery.coverage.total}` : ""}
          </p>
        )}
      </div>

      {(discovery.retryable || []).length > 0 && <RetryRejected names={discovery.retryable} onRetry={onRetry} />}

      {assessed.map((r) => <Machine key={r.vmId || r.name} r={r} labels={verdictLabels} />)}

      {/* Kept in their own band on purpose. An unread machine folded in with
          the scored ones is how an assessment quietly overstates itself. */}
      {notAssessed.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h4 style={{ fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".7px",
            color: "var(--muted,#5a6373)", margin: "0 0 10px" }}>
            Not assessed — {notAssessed.length} machine{notAssessed.length === 1 ? "" : "s"}
          </h4>
          {notAssessed.map((r) => <Machine key={r.vmId || r.name} r={r} labels={verdictLabels} />)}
        </div>
      )}
    </div>
  );
}


/**
 * The proposal. Assumptions are given their own block, above the artefacts
 * rather than below them — read after the YAML they look like a disclaimer, and
 * the port being a guess is the single most consequential thing on this screen.
 */
function Plans({ plan, caps }) {
  return (
    <div style={{ ...card, borderColor: "rgba(61,90,254,.25)" }}>
      <strong style={{ fontSize: ".95rem" }}>Proposed builds</strong>
      <p style={{ margin: "6px 0 14px", fontSize: ".84rem", color: "var(--muted,#5a6373)" }}>{plan.note}</p>

      {plan.plans.map((p) => (
        <div key={p.machine} style={{ marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border,#eef1f7)" }}>
          <div style={{ fontWeight: 700, fontSize: ".9rem", marginBottom: 2 }}>{p.machine}</div>
          <div style={{ fontSize: ".8rem", color: "var(--muted,#5a6373)", marginBottom: 10 }}>
            namespace {p.namespace} · {p.tiers.length} tier{p.tiers.length === 1 ? "" : "s"}
          </div>

          <div style={{ ...label, color: "#b45309" }}>Confirm before building</div>
          <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: ".82rem", lineHeight: 1.65 }}>
            {p.assumptions.map((a) => (
              <li key={a.id}><strong>{a.field}</strong> = <code>{String(a.value)}</code> — {a.why} <em>{a.confirm}</em></li>
            ))}
          </ul>

          {p.containerfiles.map((cf) => <Code key={cf.tier} title={`Containerfile — ${cf.tier} (${cf.runtimeLabel})`} text={cf.containerfile} />)}
          {p.manifests.map((m) => <Code key={m.kind + m.name} title={`${m.kind} / ${m.name}`} text={m.yaml.trim()} collapsed />)}

          <BuildProposal plan={p} caps={caps} />

          <div style={{ ...label, marginTop: 12 }}>Next</div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem", lineHeight: 1.65 }}>
            {p.nextSteps.map((n, i) => <li key={i}>{n}</li>)}
          </ol>
        </div>
      ))}

      {plan.refused.length > 0 && (
        <>
          <div style={label}>No build proposed — {plan.refused.length}</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem", lineHeight: 1.65 }}>
            {plan.refused.map((r) => <li key={r.machine}><strong>{r.machine}</strong> — {r.message}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}


/**
 * The build, on the customer's own tooling. A third explicit act after assess
 * and propose — by this point they have agreed the verdict and read the
 * scaffold, and this is the first artefact that could actually run.
 */
function BuildProposal({ plan, caps }) {
  const [build, setBuild] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/containerize/build", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }),
      });
      const d = await r.json();
      if (d.error) { showToast(d.error, "err"); return; }
      setBuild(d);
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(false); }
  };

  const blocked = caps?.build?.blockedBy || [];
  if (!build) {
    return (
      <div style={{ marginTop: 12 }}>
        {blocked.map((b) => (
          <p key={b.id} style={{ margin: "0 0 8px", fontSize: ".82rem", lineHeight: 1.6, color: "#b45309" }}>
            <strong>{b.tool} is not usable on this cluster.</strong> {b.reason}
          </p>
        ))}
        <button style={btn(false)} onClick={load} disabled={busy || blocked.length > 0}>
          {busy ? "Proposing…" : "Show how to build it"}
        </button>
        <span style={{ marginLeft: 10, fontSize: ".78rem", color: "var(--muted,#5a6373)" }}>
          BuildConfig, ImageStream and a Tekton pipeline. Starts nothing.
        </span>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border,#eef1f7)" }}>
      <div style={label}>Build it on your own toolchain</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".8rem", marginBottom: 12 }}>
        <tbody>
          {build.toolchain.map((t) => (
            <tr key={t.component} style={{ borderTop: "1px solid var(--border,#eef1f7)" }}>
              <td style={{ padding: "5px 8px 5px 0", color: "var(--muted,#5a6373)", whiteSpace: "nowrap" }}>{t.component}</td>
              <td style={{ padding: "5px 8px", fontWeight: 600 }}>{t.tool}</td>
              <td style={{ padding: "5px 0", color: "var(--muted,#5a6373)" }}>{t.provenance}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Code title="Run it" text={build.commands.join("\n")} />
      {build.manifests.map((m) => <Code key={m.kind + m.name} title={`${m.kind} / ${m.name}`} text={m.yaml.trim()} collapsed />)}

      <div style={{ ...label, marginTop: 10, color: "#b45309" }}>Before you do</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem", lineHeight: 1.65 }}>
        {build.caveats.map((c) => <li key={c.id}><strong>{c.title}.</strong> {c.detail}</li>)}
      </ul>
    </div>
  );
}

function Code({ title, text, collapsed = false }) {
  const [open, setOpen] = useState(!collapsed);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { showToast("Could not copy — select the text instead.", "err"); }
  };
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <button onClick={() => setOpen((v) => !v)}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: ".82rem",
            fontWeight: 700, color: "#3d5afe", fontFamily: "inherit", textAlign: "left" }}>
          {open ? "▾" : "▸"} {title}
        </button>
        {open && (
          <button onClick={copy} style={{ ...btn(false), padding: "4px 10px", fontSize: ".74rem" }}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {open && (
        <pre style={{ margin: "6px 0 0", padding: 12, borderRadius: 8, overflow: "auto", maxHeight: 340,
          background: "var(--code-bg,#0f172a)", color: "#e2e8f0", fontSize: ".74rem", lineHeight: 1.55,
          fontFamily: "SF Mono, Fira Code, monospace" }}>{text}</pre>
      )}
    </div>
  );
}


/** Keep the headline honest after a partial re-read. */
function recount(results, prev) {
  const NOT = new Set(["unreadable", "powered-off"]);
  const total = results.length;
  const assessed = results.filter((r) => !NOT.has(r.verdict)).length;
  const candidates = results.filter((r) => ["container-ready", "container-with-work"].includes(r.verdict)).length;
  return {
    ...prev, total, assessed, notAssessed: total - assessed, candidates,
    candidatePctOfEstate: total ? Math.round((candidates / total) * 100) : 0,
    candidatePctOfAssessed: assessed ? Math.round((candidates / assessed) * 100) : 0,
    note: assessed === total
      ? `All ${total} machines were assessed.`
      : `${assessed} of ${total} machines were assessed. ${total - assessed} could not be read.`,
  };
}

/**
 * Machines whose guest credential was rejected, offered as a group.
 *
 * The alternative — one identical sentence per machine — makes the operator do
 * the grouping themselves, and a fleet with two or three service accounts is
 * completely ordinary.
 */
function RetryRejected({ names, onRetry }) {
  const [extra, setExtra] = useState({ username: "", password: "" });
  return (
    <div style={{ ...card, borderColor: "rgba(217,119,6,.3)" }}>
      <div style={{ ...label, color: "#b45309" }}>
        {names.length} machine{names.length === 1 ? "" : "s"} rejected the credential
      </div>
      <p style={{ margin: "0 0 10px", fontSize: ".83rem", lineHeight: 1.6 }}>
        {names.join(", ")} — these have a different local account. Supply it and only these are re-read;
        the machines that answered are not touched.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input style={{ ...input, flex: "1 1 180px" }} placeholder="Username for these machines"
          value={extra.username} onChange={(e) => setExtra((c) => ({ ...c, username: e.target.value }))} autoComplete="off" />
        <input style={{ ...input, flex: "1 1 180px" }} type="password" placeholder="Password"
          value={extra.password} onChange={(e) => setExtra((c) => ({ ...c, password: e.target.value }))} autoComplete="new-password" />
        <button style={btn(true)} disabled={!extra.username || !extra.password}
          onClick={() => onRetry(names, extra)}>Re-read these {names.length}</button>
      </div>
    </div>
  );
}

/**
 * Guest OS and platform.
 *
 * Three sources on one panel, kept apart: what the dated matrix says, what the
 * cluster actually ships, and — if a model is configured — a narrative that is
 * labelled as narrative. The support levels are never the model's.
 */
function OsSupport({ posture }) {
  const STATUS = {
    corroborated: { fg: "#15803d", text: "matrix and cluster agree" },
    documented: { fg: "#b45309", text: "matrix only — no boot source here" },
    "image-without-support-claim": { fg: "#b45309", text: "cluster ships an image the matrix does not list" },
    "matrix-only": { fg: "#64748b", text: "no boot source on this cluster" },
  };
  const LEVEL = { supported: "#15803d", unsupported: "#b91c1c", caveats: "#b45309", unknown: "#64748b" };
  const a = posture.advice;

  return (
    <div style={card}>
      <div style={label}>Guest OS and platform support</div>
      <p style={{ margin: "0 0 10px", fontSize: ".84rem", lineHeight: 1.6 }}>{posture.headline}</p>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem", marginBottom: 10 }}>
        <thead><tr>
          {["Distribution", "Machines", "Matrix", "On this cluster"].map((h) => (
            <th key={h} style={{ textAlign: "left", padding: "5px 8px 5px 0", fontSize: ".7rem",
              textTransform: "uppercase", letterSpacing: ".6px", color: "var(--muted,#5a6373)" }}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {posture.distributions.map((d) => (
            <tr key={d.distro} style={{ borderTop: "1px solid var(--border,#eef1f7)" }}>
              <td style={{ padding: "6px 8px 6px 0", fontWeight: 600 }}>{d.distro}</td>
              <td style={{ padding: "6px 8px", width: 70 }}>{d.count}</td>
              <td style={{ padding: "6px 8px", color: LEVEL[d.level] || "#64748b", fontWeight: 600 }}>
                {d.level}{d.tierLabel ? <span style={{ display: "block", fontWeight: 400, fontSize: ".74rem", color: "var(--muted,#5a6373)" }}>{d.tierLabel}</span> : null}
              </td>
              <td style={{ padding: "6px 0", color: STATUS[d.status]?.fg || "var(--muted,#5a6373)" }}>{STATUS[d.status]?.text || d.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ margin: 0, fontSize: ".78rem", lineHeight: 1.55, color: "var(--muted,#5a6373)" }}>
        Matrix read {posture.matrix.asOf} — {posture.matrix.age?.note}{" "}
        <a href={posture.matrix.url} target="_blank" rel="noreferrer" style={{ color: "#3d5afe" }}>Red Hat's certified list</a>.
        {posture.cluster.openshift ? ` Cluster is OpenShift ${posture.cluster.openshift}.` : " The OpenShift version could not be read."}
        {posture.images.readable
          ? ` ${posture.images.images.length} boot sources read from this cluster.`
          : ` ${posture.images.reason}`}
      </p>

      {a && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border,#eef1f7)" }}>
          <div style={label}>Reading of this — narrative</div>
          {!a.available ? (
            <p style={{ margin: 0, fontSize: ".82rem", color: "var(--muted,#5a6373)" }}>{a.reason}</p>
          ) : (
            <>
              <p style={{ margin: "0 0 10px", fontSize: ".86rem", lineHeight: 1.6, fontWeight: 600 }}>{a.advice.headline}</p>
              {a.advice.themes.map((t) => (
                <p key={t.title} style={{ margin: "0 0 8px", fontSize: ".83rem", lineHeight: 1.6 }}>
                  <strong>{t.title}.</strong> {t.detail}{t.machines ? <span style={{ color: "var(--muted,#5a6373)" }}> ({t.machines})</span> : null}
                </p>
              ))}
              {a.advice.sequence.length > 0 && (
                <>
                  <div style={{ ...label, marginTop: 10 }}>Suggested order</div>
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem", lineHeight: 1.65 }}>
                    {a.advice.sequence.map((x, i) => <li key={i}>{x}</li>)}
                  </ol>
                </>
              )}
              {a.advice.confirm.length > 0 && (
                <>
                  <div style={{ ...label, marginTop: 10, color: "#b45309" }}>Confirm before this goes in a document</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem", lineHeight: 1.65 }}>
                    {a.advice.confirm.map((x, i) => <li key={i}>{x}</li>)}
                  </ul>
                </>
              )}
              <p style={{ margin: "10px 0 0", fontSize: ".78rem", color: "var(--muted,#5a6373)", fontStyle: "italic" }}>{a.caveat}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Figure({ n, of, pct, title, strong }) {
  return (
    <div>
      <div style={{ fontSize: strong ? "2rem" : "1.5rem", fontWeight: 800, lineHeight: 1.1,
        color: strong ? "var(--fg,#1a1f2b)" : "var(--muted,#5a6373)" }}>
        {pct}%
      </div>
      <div style={{ fontSize: ".78rem", color: "var(--muted,#5a6373)", marginTop: 2 }}>
        {n} of {of} — {title}
      </div>
    </div>
  );
}

function Machine({ r, labels }) {
  const [open, setOpen] = useState(false);
  const s = VERDICT_STYLE[r.verdict] || VERDICT_STYLE.inconclusive;
  const required = (r.concerns || []).filter((c) => c.required);
  const informational = (r.concerns || []).filter((c) => !c.required);

  return (
    <div style={{ ...card, borderColor: s.bd, borderStyle: s.dashed ? "dashed" : "solid" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div>
          <strong style={{ fontSize: ".95rem" }}>{r.name || r.vmId}</strong>
          {r.runtimes?.length > 0 && (
            <span style={{ marginLeft: 10, fontSize: ".82rem", color: "var(--muted,#5a6373)" }}>
              {r.runtimes.map((x) => x.label).join(" + ")}
            </span>
          )}
        </div>
        <span style={{ flexShrink: 0, padding: "4px 10px", borderRadius: 999, fontSize: ".74rem",
          fontWeight: 700, color: s.fg, background: s.bg, border: `1px solid ${s.bd}` }}>
          {labels[r.verdict] || r.verdict}
        </span>
      </div>

      <p style={{ margin: "8px 0 0", fontSize: ".86rem", lineHeight: 1.6 }}>{r.summary}</p>

      {(r.blockers || []).map((b) => (
        <Finding key={b.id} tone="#b91c1c" title={b.title} detail={b.detail} action={b.action} evidence={b.evidence} />
      ))}
      {required.map((c) => (
        <Finding key={c.id} tone="#b45309" title={c.title} detail={c.detail} action={c.action} evidence={c.evidence} />
      ))}

      {(informational.length > 0 || r.unchecked?.length > 0) && (
        <button onClick={() => setOpen((v) => !v)}
          style={{ marginTop: 10, background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: ".8rem", fontWeight: 600, color: "#3d5afe", fontFamily: "inherit" }}>
          {open ? "Hide" : "Show"} what else was seen, and what could not be read
        </button>
      )}
      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border,#eef1f7)" }}>
          {informational.map((c) => (
            <Finding key={c.id} tone="var(--muted,#5a6373)" title={c.title} detail={c.detail} evidence={c.evidence} />
          ))}
          {r.unchecked?.length > 0 && (
            <>
              <div style={{ ...label, marginTop: 12 }}>Not read</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem", lineHeight: 1.6, color: "var(--muted,#5a6373)" }}>
                {r.unchecked.map((u) => <li key={u.fact}><strong>{u.fact}</strong> — {u.reason}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Every finding carries what was actually seen. The platform team will argue
    with the verdict, and they should be able to see the evidence to do it. */
function Finding({ tone, title, detail, action, evidence }) {
  return (
    <div style={{ marginTop: 10, paddingLeft: 12, borderLeft: `2px solid ${tone}` }}>
      <div style={{ fontSize: ".86rem", fontWeight: 700, color: tone }}>{title}</div>
      <div style={{ fontSize: ".84rem", lineHeight: 1.6, marginTop: 2 }}>{detail}</div>
      {action && <div style={{ fontSize: ".84rem", lineHeight: 1.6, marginTop: 4 }}><em>{action}</em></div>}
      {evidence && (
        <div style={{ marginTop: 6, fontSize: ".76rem", fontFamily: "SF Mono, Fira Code, monospace",
          color: "var(--muted,#5a6373)", wordBreak: "break-all" }}>
          {evidence}
        </div>
      )}
    </div>
  );
}
