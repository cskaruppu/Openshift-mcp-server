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
          <button style={btn(true)} onClick={discover} disabled={!provider || busy === "discover"}>
            {busy === "discover" ? "Reading inventory…" : "Discover"}
          </button>
        </div>
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

      {result && <Results result={result} />}
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

function Results({ result }) {
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
