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
  const border = ok ? "var(--st-good, #0d9488)" : "var(--st-warn, #f59e0b)";
  const ink = ok ? "var(--st-good-ink, #0f766e)" : "var(--st-warn-ink, #a15c07)";

  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start", border: `1px solid var(--border, #e4e8f1)`,
      borderLeft: `3px solid ${border}`, borderRadius: 9, padding: "8px 12px", background: "var(--card, transparent)" }}>
      <span aria-hidden style={{ color: ink, fontWeight: 800, lineHeight: 1.4 }}>{ok ? "✓" : "○"}</span>
      <div style={{ minWidth: 0 }}>
        {ok ? (
          <>
            <span style={{ fontSize: "0.8rem", fontWeight: 700 }}>
              Reading <span style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.77rem" }}>{row.host}</span> beyond the MTV inventory
            </span>
            <div style={{ fontSize: "0.77rem", color: "var(--text2, #5a6373)", marginTop: 1 }}>
              {ORIGIN[row.source] || "credential resolved"} — the report will group by application from vCenter tags,
              and size every machine from measured history.
            </div>
          </>
        ) : (
          <>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: ink }}>
              No vCenter credential for this provider
            </span>
            {/* Naming the two panels is the difference between a warning
                somebody dismisses and one they act on. */}
            <div data-prose style={{ fontSize: "0.77rem", color: "var(--text2, #5a6373)", marginTop: 1, maxWidth: "96ch" }}>
              The report will group machines by vCenter folder instead of by application, and every size will read
              <b> not measured</b>. Discovery and the migration itself are unaffected.
              {" "}Connect one in <b>Settings → Integrations → vCenter</b>.
            </div>
            {row.reason && (
              <div style={{ fontSize: "0.75rem", color: "var(--text2, #5a6373)", marginTop: 3, opacity: 0.9 }}>{row.reason}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
