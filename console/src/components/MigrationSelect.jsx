import { useState } from "react";
// Imported from the server module rather than copied: the grouping runs
// server-side, but the split check depends on what is ticked right now, so it
// has to run here. affinity.js is dependency-free ESM, so one definition
// serves both and cannot drift.
import { splitGroups } from "../../../src/services/affinity.js";

/* ── UC-10 step 3: choose what moves, and how ─────────────────────────────────
   Separate from the report on purpose. Reading an assessment and committing to
   a wave are different acts, and a page that does both invites the second one
   to happen while you are still doing the first.

   Nothing here re-derives support: the level, the warm eligibility and the
   recommendation all come from the analysis, so this page cannot offer an
   option the previous page said was impossible.                              */

const LV = {
  supported:   { label: "Ready",        icon: "✓", token: "--st-good" },
  caveats:     { label: "With caveats", icon: "⚠", token: "--st-warn" },
  unknown:     { label: "Needs review", icon: "?", token: "--st-unknown" },
  unsupported: { label: "Blocked",      icon: "✖", token: "--st-crit" },
};
const gib = (n) => (n == null ? "—" : n >= 1024 ? `${(n / 1024).toFixed(1)} TiB` : `${Math.round(n)} GiB`);

export default function MigrationSelect({
  analysis, advice = [], selected = {}, onChange,
  ready, target, onTarget, onBack, onProceed,
}) {
  const [filter, setFilter] = useState("eligible"); // eligible | all
  const rows = analysis?.rows || [];
  const byName = Object.fromEntries(advice.map((a) => [a.name, a]));
  const keyOf = (r) => r.id || r.name;

  // A blocked or unidentified VM can still be ticked — the operator may know
  // something the matrix does not — but it is not shown by default, because
  // the common case is that it should not be in this wave.
  const eligible = (r) => r.level === "supported" || r.level === "caveats";
  const shown = filter === "eligible" ? rows.filter(eligible) : rows;

  const picked = rows.filter((r) => selected[keyOf(r)] !== undefined);
  const warmCount = picked.filter((r) => selected[keyOf(r)] === "warm").length;
  const pickedGiB = picked.reduce((n, r) => n + (r.diskGiB || 0), 0);
  const risky = picked.filter((r) => !eligible(r)).length;
  // Groups this wave would cut in half. MTV has no concept of an application,
  // so nothing else in the toolchain will mention it.
  const split = splitGroups(analysis?.affinity || [], picked.map((r) => r.name));

  const set = (next) => onChange?.(next);
  const toggle = (r) => {
    const k = keyOf(r), next = { ...selected };
    if (next[k] !== undefined) delete next[k];
    else next[k] = byName[r.name]?.strategy === "warm" && r.warmEligible ? "warm" : "cold";
    set(next);
  };
  const setStrategy = (r, v) => set({ ...selected, [keyOf(r)]: v });

  const bulk = (which) => {
    const next = { ...selected };
    for (const r of shown) {
      const k = keyOf(r);
      if (which === "none") delete next[k];
      else if (which === "recommended") next[k] = byName[r.name]?.strategy === "warm" && r.warmEligible ? "warm" : "cold";
      else next[k] = which === "warm" && r.warmEligible ? "warm" : "cold";
    }
    set(next);
  };

  const btn = (primary) => ({
    padding: primary ? "8px 16px" : "5px 11px", borderRadius: primary ? 8 : 7,
    fontSize: primary ? "0.82rem" : "0.75rem", fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
    border: primary ? "none" : "1px solid var(--border)",
    background: primary ? "#3d5afe" : "transparent", color: primary ? "#fff" : "var(--text2)",
  });
  const field = {
    padding: "6px 9px", borderRadius: 8, border: "1px solid var(--border)",
    background: "var(--card)", color: "var(--text)", fontSize: "0.8rem", fontFamily: "inherit",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: "0.95rem" }}>Choose the wave</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text2)" }}>
          {picked.length} of {rows.length} selected · {gib(pickedGiB)} to move · {warmCount} warm, {picked.length - warmCount} cold
        </div>
      </div>

      {/* ── Bulk actions and the eligibility filter ───────────────────────── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => bulk("recommended")} style={btn()}>Select all, use recommended method</button>
        <button onClick={() => bulk("cold")} style={btn()}>All cold</button>
        <button onClick={() => bulk("warm")} style={btn()} title="Only applied where warm is actually possible">All warm where possible</button>
        <button onClick={() => bulk("none")} style={btn()}>Clear</button>
        <label style={{ marginLeft: "auto", fontSize: "0.78rem", color: "var(--text2)", display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={filter === "all"} onChange={(e) => setFilter(e.target.checked ? "all" : "eligible")} />
          Show the {rows.length - rows.filter(eligible).length} blocked / unidentified VMs too
        </label>
      </div>

      {/* ── The choice ───────────────────────────────────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", maxHeight: 460, background: "var(--card)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ background: "var(--bg2)", position: "sticky", top: 0 }}>
              {["", "VM", "Status", "Guest OS", "Storage", "Method", "Source VM during copy", "Why"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "7px 9px", fontWeight: 800, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const k = keyOf(r);
              const chosen = selected[k];
              const l = LV[r.level] || LV.unknown;
              const rec = byName[r.name];
              // The downtime statement follows the CURRENT choice, not the
              // recommendation — change the method and this changes with it.
              const power = !r.poweredOn ? "Already off — no additional downtime"
                : chosen === "warm" ? "Stays online; short cutover at the end"
                : "Must power off for the whole copy";
              return (
                <tr key={k} style={{ borderBottom: "1px solid var(--border)", background: chosen !== undefined ? "rgba(61,90,254,.06)" : "transparent" }}>
                  <td style={{ padding: "6px 9px" }}>
                    <input type="checkbox" checked={chosen !== undefined} onChange={() => toggle(r)} />
                  </td>
                  <td style={{ padding: "6px 9px", fontWeight: 700 }}>{r.name}</td>
                  <td style={{ padding: "6px 9px", whiteSpace: "nowrap", color: `var(${l.token})`, fontWeight: 700 }}>{l.icon} {l.label}</td>
                  <td style={{ padding: "6px 9px", color: "var(--text2)" }} title={r.os?.reported || ""}>{r.os?.distro || "—"}</td>
                  <td style={{ padding: "6px 9px", whiteSpace: "nowrap" }}>{gib(r.diskGiB)}</td>
                  <td style={{ padding: "6px 9px" }}>
                    <select value={chosen ?? ""} disabled={chosen === undefined}
                      onChange={(e) => setStrategy(r, e.target.value)}
                      title={r.warmEligible ? "" : r.warmBlockedReason || ""}
                      // Fixed width: the "not possible" option is longer than
                      // "warm", and a select that resizes per row makes the
                      // column look broken.
                      style={{ ...field, padding: "3px 7px", fontSize: "0.76rem", width: 96, opacity: chosen === undefined ? .45 : 1 }}>
                      <option value="" disabled>—</option>
                      <option value="cold">cold</option>
                      {/* Warm is offered only where it can actually work. */}
                      <option value="warm" disabled={!r.warmEligible}>
                        warm{r.warmEligible ? "" : " — not possible"}
                      </option>
                    </select>
                  </td>
                  <td style={{ padding: "6px 9px", color: "var(--text2)", whiteSpace: "nowrap" }}>
                    {chosen === undefined ? "—" : power}
                  </td>
                  <td style={{ padding: "6px 9px", color: "var(--text2)", maxWidth: 320 }}>
                    <div style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                      title={chosen && chosen !== rec?.strategy ? "Changed from the recommendation." : rec?.reason || ""}>
                      {chosen && chosen !== rec?.strategy
                        ? (r.warmEligible ? "Changed from the recommendation." : r.warmBlockedReason)
                        : rec?.reason || "—"}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Move-together groups ─────────────────────────────────────────
          Both migrations succeed and the system is still broken: one half on
          OpenShift, one half on VMware, for however long the gap lasts. This
          is the moment that is worth knowing, and the only moment. */}
      {split.length > 0 && (
        <div style={{ border: "1px solid var(--st-warn)", borderRadius: 10, padding: "11px 13px", background: "var(--st-warn-bg)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
            <span aria-hidden style={{ color: "var(--st-warn)", fontWeight: 800 }}>⚠</span>
            <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>
              This wave splits {split.length} group{split.length === 1 ? "" : "s"} of machines that look related
            </span>
          </div>
          {split.map((g) => (
            <div key={g.id} style={{ marginTop: 7, fontSize: "0.78rem" }}>
              <div><b>{g.inWave.join(", ")}</b> — {g.message}</div>
              <div style={{ color: "var(--text2)", fontSize: "0.73rem" }}>
                They {g.because}. <span style={{ opacity: .8 }}>({g.confidence} confidence)</span>
              </div>
              <button onClick={() => {
                // Pull the rest in with the recommended method, which is what
                // the warning is for — it should be one click to act on.
                const next = { ...selected };
                for (const name of g.leftBehind) {
                  const r = rows.find((x) => x.name === name);
                  if (r) next[keyOf(r)] = byName[name]?.strategy === "warm" && r.warmEligible ? "warm" : "cold";
                }
                set(next);
              }} style={{ ...btn(), marginTop: 4 }}>
                Add {g.leftBehind.length} more to this wave
              </button>
            </div>
          ))}
          <div style={{ fontSize: "0.71rem", color: "var(--text2)", marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
            Inferred from addresses, names, vCenter folders and datastores — a suggestion to check, not a fact.
            Migrate them together, or confirm the split is safe for the gap between waves.
          </div>
        </div>
      )}

      {/* ── Where it lands ───────────────────────────────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "11px 13px", background: "var(--card)" }}>
        <div style={{ fontWeight: 800, fontSize: "0.84rem", marginBottom: 8 }}>Target</div>
        <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: "0.78rem", color: "var(--text2)" }}>Namespace</label>
          <input value={target.targetNamespace}
            onChange={(e) => onTarget({ ...target, targetNamespace: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
            placeholder="prod-apps" style={{ ...field, minWidth: 160 }} />
          <select value={target.storageMap} onChange={(e) => onTarget({ ...target, storageMap: e.target.value })} style={field}>
            <option value="">— storage map —</option>
            {(ready?.storageMaps || []).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
          <select value={target.networkMap} onChange={(e) => onTarget({ ...target, networkMap: e.target.value })} style={field}>
            <option value="">— network map —</option>
            {(ready?.networkMaps || []).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
        </div>
      </div>

      {/* ── Gate to the plan step ────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={onBack} style={{ ...btn(), padding: "8px 14px", fontSize: "0.82rem" }}>← Back to the report</button>
        <button onClick={onProceed}
          disabled={!picked.length || !target.targetNamespace || !target.storageMap || !target.networkMap}
          style={{ ...btn(true), opacity: (picked.length && target.targetNamespace && target.storageMap && target.networkMap) ? 1 : .5,
            cursor: picked.length ? "pointer" : "not-allowed" }}>
          Continue with {picked.length} VM{picked.length === 1 ? "" : "s"} →
        </button>
        {!picked.length && <span style={{ fontSize: "0.76rem", color: "var(--text2)" }}>Select at least one VM.</span>}
        {picked.length > 0 && (!target.targetNamespace || !target.storageMap || !target.networkMap) && (
          <span style={{ fontSize: "0.76rem", color: "var(--st-warn)" }}>
            ⚠ A target namespace, storage map and network map are all required before a plan can be built.
          </span>
        )}
        {risky > 0 && (
          <span style={{ fontSize: "0.76rem", color: "var(--st-warn)", flexBasis: "100%" }}>
            ⚠ {risky} selected VM{risky === 1 ? " is" : "s are"} blocked or unidentified — MTV will reject a plan containing {risky === 1 ? "it" : "them"}.
          </span>
        )}
      </div>
    </div>
  );
}
