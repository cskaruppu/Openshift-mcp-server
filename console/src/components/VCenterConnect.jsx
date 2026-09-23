import { useEffect, useState } from "react";

/* ── What the agent can read from this provider's vCenter ─────────────────────
   Status, not settings. The credential is configured once in Settings →
   Integrations; what belongs HERE is the answer to a question the operator is
   about to act on: when this wave reaches the report, will it group by
   application and show measured sizes, or not?

   Most of the time there is nothing to say beyond one green line — MTV already
   holds a credential for every provider it migrates from, and the agent reuses
   it. The strip earns its place in the other case, by naming what the report
   will be missing BEFORE the assessment runs rather than leaving two blank
   panels to explain themselves afterwards.

   It never blocks discovery. Tags and utilisation make the report better; the
   MTV inventory alone still produces a migration. */

const ORIGIN = {
  "mtv-secret": "via MTV's own provider credential",
  provider: "via the read-only account registered for this provider",
  host: "via the read-only account registered for this vCenter",
  global: "via the global credential",
};

export default function VCenterConnect({ provider }) {
  // null = still loading; { unknown, why } = we could not find out.
  const [row, setRow] = useState(null);
  // "checking" while the round trip is in flight, then the probe's answer.
  const [probe, setProbe] = useState(null);

  useEffect(() => {
    if (!provider) { setRow(null); return; }
    let stop = false;
    setRow(null);
    fetch("/api/settings/vcenter/providers")
      .then(async (r) => {
        if (!r.ok) throw new Error(`the agent returned ${r.status} for /api/settings/vcenter/providers`);
        return r.json();
      })
      .then((d) => {
        if (stop) return;
        const found = (d?.providers || []).find((p) => p.uid === provider);
        // A provider the agent cannot see is NOT the same as one with no
        // credential, and neither is the same as nothing at all — which is
        // what this used to render, silently, in both cases.
        setRow(found || { unknown: true, why: d?.error
          || `MTV did not report a source provider matching the one selected. It may have been removed, or the agent could not read providers on this cluster.` });
      })
      .catch((e) => { if (!stop) setRow({ unknown: true, why: e.message }); });
    return () => { stop = true; };
  }, [provider]);

  // A resolved credential is a promise; this is the observation. Fired
  // separately so Discover is never waiting on a vCenter round trip, and the
  // line upgrades itself when the answer lands.
  useEffect(() => {
    if (!provider) { setProbe(null); return; }
    let stop = false;
    setProbe("checking");
    fetch(`/api/settings/vcenter/probe?provider=${encodeURIComponent(provider)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!stop) setProbe(d || { reachable: false, error: "The agent did not answer the probe." }); })
      .catch((e) => { if (!stop) setProbe({ reachable: false, error: e.message }); });
    return () => { stop = true; };
  }, [provider]);

  if (!provider || !row) return null;

  if (row.unknown) {
    return (
      <div style={{ display: "flex", gap: 9, alignItems: "flex-start", border: "1px solid var(--border, #e4e8f1)",
        borderLeft: "3px solid var(--st-unknown, #64748b)", borderRadius: 9, padding: "8px 12px", background: "var(--card, transparent)" }}>
        <span aria-hidden style={{ color: "var(--st-unknown-ink, #5a6675)", fontWeight: 800, lineHeight: 1.4 }}>?</span>
        <div>
          <span style={{ fontSize: "0.8rem", fontWeight: 700 }}>Could not tell what this vCenter connection can read</span>
          <div data-prose style={{ fontSize: "0.77rem", color: "var(--text2, #5a6373)", marginTop: 1, maxWidth: "96ch" }}>
            {row.why} Discovery and the migration are unaffected; the report may group by folder and leave sizes
            unmeasured without saying why.
          </div>
        </div>
      </div>
    );
  }

  const ok = row.configured;
  // Three states, not two: a credential that resolved, a vCenter that answered,
  // and a vCenter that did not. The middle one is the only one entitled to a
  // green tick.
  const live = probe && probe !== "checking" ? probe : null;
  const failed = live && live.reachable === false;
  const tone = !ok || failed ? "warn" : live?.reachable ? "good" : "unknown";
  const border = tone === "good" ? "var(--st-good, #0d9488)" : tone === "warn" ? "var(--st-warn, #f59e0b)" : "var(--st-unknown, #64748b)";
  const ink = tone === "good" ? "var(--st-good-ink, #0f766e)" : tone === "warn" ? "var(--st-warn-ink, #a15c07)" : "var(--st-unknown-ink, #5a6675)";
  const mark = tone === "good" ? "✓" : tone === "warn" ? "✕" : "…";

  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start", border: `1px solid var(--border, #e4e8f1)`,
      borderLeft: `3px solid ${border}`, borderRadius: 9, padding: "8px 12px", background: "var(--card, transparent)" }}>
      <span aria-hidden style={{ color: ink, fontWeight: 800, lineHeight: 1.4 }}>{mark}</span>
      <div style={{ minWidth: 0 }}>
        {!ok ? (
          <>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: ink }}>No vCenter credential for this provider</span>
            <div data-prose style={{ fontSize: "0.77rem", color: "var(--text2, #5a6373)", marginTop: 1, maxWidth: "96ch" }}>
              The report will group machines by vCenter folder instead of by application, and every size will read
              <b> not measured</b>. Discovery and the migration itself are unaffected.
              {" "}Connect one in <b>Settings → Integrations → vCenter</b>.
            </div>
            {row.reason && <div style={{ fontSize: "0.75rem", color: "var(--text2, #5a6373)", marginTop: 3, opacity: 0.9 }}>{row.reason}</div>}
          </>
        ) : probe === "checking" || !live ? (
          <>
            <span style={{ fontSize: "0.8rem", fontWeight: 700 }}>
              Checking <span style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.77rem" }}>{row.host}</span>…
            </span>
            <div style={{ fontSize: "0.77rem", color: "var(--text2, #5a6373)", marginTop: 1 }}>
              A credential resolved {ORIGIN[row.source] || ""} — confirming vCenter answers.
            </div>
          </>
        ) : failed ? (
          <>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: ink }}>
              Credential resolved, but <span style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.77rem" }}>{row.host}</span> did not answer
            </span>
            <div data-prose style={{ fontSize: "0.77rem", color: "var(--text2, #5a6373)", marginTop: 1, maxWidth: "96ch" }}>
              {live.error || live.tagsError || "vCenter could not be reached."}
            </div>
            <div data-prose style={{ fontSize: "0.75rem", color: "var(--text2, #5a6373)", marginTop: 3 }}>
              The report will group by folder and leave every size unmeasured. Discovery and the migration are unaffected.
            </div>
          </>
        ) : (
          <>
            <span style={{ fontSize: "0.8rem", fontWeight: 700 }}>
              Connected to <span style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.77rem" }}>{row.host}</span>
              {live.ms != null && <span style={{ fontWeight: 400, color: "var(--text2, #5a6373)" }}> · {live.ms} ms</span>}
            </span>
            {/* What it can actually read, counted — not what it intends to. */}
            <div style={{ fontSize: "0.77rem", color: "var(--text2, #5a6373)", marginTop: 1 }}>
              {ORIGIN[live.credential] || ORIGIN[row.source] || "credential resolved"} as{" "}
              <span style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.75rem" }}>{live.user}</span>
              {" · "}
              <b style={{ color: live.tagsDefined ? "var(--st-good-ink, #0f766e)" : "var(--st-warn-ink, #a15c07)" }}>
                {live.tagsDefined ? `${live.tagsDefined} tag${live.tagsDefined === 1 ? "" : "s"} readable` : "no tags defined in this vCenter"}
              </b>
              {" · "}
              <b style={{ color: live.perfReadable ? "var(--st-good-ink, #0f766e)" : "var(--st-warn-ink, #a15c07)" }}>
                {live.perfReadable ? "performance history readable" : "performance history NOT readable"}
              </b>
            </div>
            {!live.perfReadable && live.perfError && (
              <div data-prose style={{ fontSize: "0.75rem", color: "var(--text2, #5a6373)", marginTop: 3 }}>{live.perfError}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
