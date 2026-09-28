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

export default function ContainerizationAgent({ cluster }) {
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [vms, setVms] = useState(null);
  const [sel, setSel] = useState({});
  const [creds, setCreds] = useState({ username: "", password: "" });
  const [result, setResult] = useState(null);
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
    get("/api/containerize/toolchain")
      .then((d) => { if (live) setTc(d); })
      .catch(() => { if (live) setTc({ components: [], capabilities: {}, unreachable: true }); });
    return () => { live = false; };
  }, [cluster]);            // eslint-disable-line react-hooks/exhaustive-deps

  // Discovery needs MTV and nothing else. Gating it on the build or pipeline
  // tooling would invent a dependency that does not exist — those gate their
  // own steps, further down, where they actually bite.
  const canDiscover = tc?.capabilities?.discover?.ready !== false;
  const discoverBlockers = tc?.capabilities?.discover?.blockedBy || [];

  const discover = async () => {
    if (!provider) return;
    setBusy("discover"); setVms(null); setResult(null);
    try {
      const d = await get(`/api/migration/vms?provider=${encodeURIComponent(provider)}&search=${encodeURIComponent(search)}`);
      setVms(d.vms || []);
      if (d.error) showToast(d.error, "err");
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  const selection = (vms || []).filter((v) => sel[v.id || v.name]);

  const assess = async () => {
    if (!selection.length) return;
    setBusy("assess");
    try {
      const d = await post("/api/containerize/assess", {
        vms: selection, provider,
        guestUsername: creds.username || undefined,
        guestPassword: creds.password || undefined,
      });
      if (d.error) { showToast(d.error, "err"); return; }
      setResult(d);
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(null); }
  };

  return (
    <div>
      <Intro />
      <Toolchain tc={tc} />

      {/* ── Pick the machines ─────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 240, flex: "1 1 240px" }}>
            <label style={label}>Source</label>
            <select style={input} value={provider} onChange={(e) => setProvider(e.target.value)}>
              {!providers.length && <option value="">No source provider found</option>}
              {providers.map((p) => <option key={p.uid} value={p.uid}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 200, flex: "1 1 200px" }}>
            <label style={label}>Filter by name</label>
            <input style={input} value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="optional" onKeyDown={(e) => e.key === "Enter" && discover()} />
          </div>
          <button style={btn(true)} onClick={discover}
            disabled={!provider || !canDiscover || busy === "discover"}
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

      {/* ── The credential ────────────────────────────────────────────── */}
      {vms && <GuestCredential creds={creds} setCreds={setCreds} />}

      {vms && (
        <div style={{ marginBottom: 16 }}>
          <button style={btn(true)} onClick={assess} disabled={!selection.length || busy === "assess"}>
            {busy === "assess" ? "Reading inside the guests…" : `Assess ${selection.length || ""} machine${selection.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {result && <Results result={result} post={post} caps={tc?.capabilities} />}
    </div>
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

function Results({ result, post, caps }) {
  const { funnel, results, discovery, verdictLabels = {} } = result;
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);

  // Proposing is a second, explicit act. The assessment is the thing a customer
  // argues with; generating a scaffold before they have agreed the verdict puts
  // YAML in front of a decision nobody has made yet.
  const propose = async () => {
    setPlanning(true);
    try {
      const d = await post("/api/containerize/plan", { results });
      if (d.error) { showToast(d.error, "err"); return; }
      setPlan(d);
    } catch (e) { showToast(e.message, "err"); }
    finally { setPlanning(false); }
  };
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

      {funnel.candidates > 0 && (
        <div style={{ marginBottom: 14 }}>
          <button style={btn(true)} onClick={propose} disabled={planning}>
            {planning ? "Proposing…" : `Propose a build for the ${funnel.candidates} candidate${funnel.candidates === 1 ? "" : "s"}`}
          </button>
          <span style={{ marginLeft: 12, fontSize: ".8rem", color: "var(--muted,#5a6373)" }}>
            Proposes a Containerfile and manifests. Builds nothing, pushes nothing, deploys nothing.
          </span>
        </div>
      )}

      {plan && <Plans plan={plan} caps={caps} />}

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
