import { useState } from "react";

/* ── Test migration into an isolated namespace ────────────────────────────────
   "Prove it boots before we commit" — the question a customer who has seen
   Zerto's test failover will ask, and the one MTV has no answer for.

   It is also the most dangerous thing in this product, and for reasons that
   have nothing to do with the target cluster:

     · MTV powers the SOURCE off before a cold copy, so a cold "test" of a
       running machine is a production outage.
     · A test VM boots carrying the original IP and MAC. On a routable network
       that is an outage of the machine still running, and a second
       domain-joined clone of a live server is worse.

   So this screen proposes and refuses; it does not execute. The manifests are
   handed over to be applied, in an order where isolation exists before
   anything boots — the same posture as the snapshot advice elsewhere, where
   the agent gives you the command rather than a button that would do damage. */

const S = { fontFamily: "inherit", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit" };
const mono = { fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.73rem" };

export default function TestMigration({ vms = [], target = {}, provider, wave = "wave-1", onRun }) {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [strategy, setStrategy] = useState("cold");
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  const propose = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await onRun({
        vms, wave, strategy,
        sourceProvider: provider, targetProvider: target.targetProvider,
        storageMap: target.storageMap, networkMap: target.networkMap,
      });
      setOut(d);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    const text = (out?.manifests || []).map((m) => JSON.stringify(m, null, 2)).join("\n---\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* no clipboard */ }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "11px 13px", background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Test it first, into an isolated namespace</span>
        <span data-prose style={{ fontSize: "0.75rem", color: "var(--text2)" }}>
          Copies these machines into a throwaway namespace with all traffic denied, so you can prove they boot before the real cutover.
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 7, alignItems: "center" }}>
          <select value={strategy} onChange={(e) => { setStrategy(e.target.value); setOut(null); }}
            style={{ ...S, padding: "4px 8px", fontSize: "0.76rem" }}>
            <option value="cold">cold — source must be off</option>
            <option value="warm">warm — source keeps running</option>
          </select>
          <button onClick={propose} disabled={busy || !vms.length}
            style={{ ...S, padding: "5px 12px", fontSize: "0.78rem", fontWeight: 700, cursor: busy ? "default" : "pointer" }}>
            {busy ? "Checking…" : "Check what a test would take"}
          </button>
        </div>
      </div>

      {err && <div style={{ color: "var(--st-crit-ink)", fontSize: "0.78rem", marginTop: 7 }}>✖ {err}</div>}

      {out && (
        <div style={{ marginTop: 9 }}>
          <div style={{ fontSize: "0.8rem", fontWeight: 700, color: out.ok ? "var(--st-good-ink)" : "var(--st-crit-ink)" }}>
            {out.ok ? "✓" : "✖"} {out.headline}
          </div>

          {/* Refusals are per machine and each carries the fix, because
              "3 VMs cannot be tested" is not something anyone can act on. */}
          {out.refusals?.length > 0 && (
            <div style={{ marginTop: 7 }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--st-crit-ink)" }}>
                Refused · {out.refusals.length}
              </div>
              {out.refusals.map((r) => (
                <div key={r.name + r.code} style={{ fontSize: "0.77rem", marginTop: 3 }}>
                  <b>{r.name}</b> <span style={{ color: "var(--text2)" }}>{r.message}</span>
                </div>
              ))}
            </div>
          )}

          {out.warnings?.length > 0 && (
            <div style={{ marginTop: 7 }}>
              {out.warnings.map((w) => (
                <div key={w.name + w.code} style={{ fontSize: "0.77rem", marginTop: 2 }}>
                  <span style={{ color: "var(--st-warn-ink)", fontWeight: 800 }}>⚠</span>{" "}
                  <b>{w.name}</b> <span style={{ color: "var(--text2)" }}>{w.message}</span>
                </div>
              ))}
            </div>
          )}

          {out.blocking?.length > 0 && out.blocking.map((b) => (
            <div key={b.code} style={{ fontSize: "0.78rem", marginTop: 4 }}>
              <span style={{ color: "var(--st-crit-ink)", fontWeight: 800 }}>✖</span>{" "}
              <span style={{ color: "var(--text2)" }}>{b.message}</span>
            </div>
          ))}

          {out.ok && (
            <>
              <ol style={{ margin: "9px 0 0", paddingLeft: 20, fontSize: "0.78rem" }}>
                {out.order.map((o) => <li key={o} style={{ marginTop: 2 }}>{o}</li>)}
              </ol>

              <div style={{ marginTop: 9, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                  {out.manifests.length} manifests → <span style={mono}>{out.namespace}</span>
                </span>
                <button onClick={copy} style={{ ...S, padding: "4px 11px", fontSize: "0.75rem", fontWeight: 700, cursor: "pointer" }}>
                  {copied ? "✓ copied" : "⧉ Copy manifests"}
                </button>
                {/* Why there is no Apply button here, said plainly rather than
                    left as a gap somebody reads as an oversight. */}
                <span data-prose style={{ fontSize: "0.73rem", color: "var(--text2)" }}>
                  Applied by hand on purpose: the isolation policy has to exist before a VM with a live machine's IP boots, and that
                  ordering is not something to hand to a button.
                </span>
              </div>

              <div style={{ marginTop: 9 }}>
                <div style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>
                  Then check, in this order
                </div>
                {out.checklist.map((c) => (
                  <div key={c.id} style={{ fontSize: "0.77rem", marginTop: 3 }}>
                    <span style={{ color: c.automatic ? "var(--st-good-ink)" : "var(--st-warn-ink)", fontWeight: 800 }}>
                      {c.automatic ? "▸" : "✋"}
                    </span>{" "}
                    <b>{c.label}</b>
                    <div style={{ ...mono, color: "var(--text2)", marginLeft: 16 }}>{c.how}</div>
                    {c.why && <div style={{ color: "var(--text2)", marginLeft: 16, fontSize: "0.75rem" }}>{c.why}</div>}
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 9, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
                <div style={{ fontSize: "0.78rem", fontWeight: 700 }}>Tear it down afterwards</div>
                {out.teardown.commands.map((c) => <div key={c} style={{ ...mono, marginTop: 2 }}>$ {c}</div>)}
                <div style={{ fontSize: "0.75rem", color: "var(--text2)", marginTop: 3 }}>{out.teardown.note}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--st-warn-ink)", marginTop: 2 }}>⚠ {out.teardown.warning}</div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
