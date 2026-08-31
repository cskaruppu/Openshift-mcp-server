import { useState } from "react";

/* ── UC-10 step 2: fleet analysis ─────────────────────────────────────────────
   The question this page answers is "what did I just select, and can it move?".
   Everything here is a roll-up of /api/migration/analyse — no new judgement is
   made in the browser, so the chart and the table can never disagree with the
   server or with each other.

   Colour is a reserved STATUS palette (see --st-* in styles.css), stepped and
   validated per mode. Every mark carries an icon and a label as well, so the
   chart is readable in greyscale, under any colour-vision deficiency, and in
   forced-colors mode.                                                        */

/** The four states, in a fixed order. Order is the identity — never sorted by
    size, or a filter would repaint the survivors. */
export const LEVELS = [
  { key: "supported",   label: "Ready",        icon: "✓", token: "--st-good",    bg: "--st-good-bg",    blurb: "Certified guest, no MTV concerns" },
  { key: "caveats",     label: "With caveats", icon: "⚠", token: "--st-warn",    bg: "--st-warn-bg",    blurb: "Migrates, but read the notes first" },
  { key: "unknown",     label: "Needs review", icon: "?", token: "--st-unknown", bg: "--st-unknown-bg", blurb: "Guest OS could not be identified" },
  { key: "unsupported", label: "Blocked",      icon: "✖", token: "--st-crit",    bg: "--st-crit-bg",    blurb: "Will fail, or is not supported once migrated" },
];
const LV = Object.fromEntries(LEVELS.map((l) => [l.key, l]));

const FAMILY_LABEL = { windows: "Windows", linux: "Linux", other: "Other", unknown: "Unidentified" };
const gib = (n) => (n == null ? "—" : n >= 1024 ? `${(n / 1024).toFixed(1)} TiB` : `${Math.round(n)} GiB`);

/* ── One stacked horizontal bar ───────────────────────────────────────────────
   Thin mark, 4px rounded outer ends, a 2px surface gap between segments so
   adjacent fills never fuse into one block. The count sits outside the bar in a
   text token — a number inside a coloured fill inherits that fill's contrast
   problems, and the amber step has no contrast budget to spare.              */
function StackBar({ counts, scale, height = 10, onHover }) {
  const present = LEVELS.filter((l) => (counts[l.key] || 0) > 0);
  const total = LEVELS.reduce((n, l) => n + (counts[l.key] || 0), 0);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, width: `${Math.max(2, (total / scale) * 100)}%`, minWidth: 4 }}>
      {present.map((l, i) => (
        <div
          key={l.key}
          onMouseEnter={() => onHover?.({ level: l, n: counts[l.key] })}
          onMouseLeave={() => onHover?.(null)}
          title={`${counts[l.key]} ${l.label.toLowerCase()} — ${l.blurb}`}
          style={{
            flex: counts[l.key], height, background: `var(${l.token})`, cursor: "default",
            borderTopLeftRadius: i === 0 ? 4 : 0, borderBottomLeftRadius: i === 0 ? 4 : 0,
            borderTopRightRadius: i === present.length - 1 ? 4 : 0,
            borderBottomRightRadius: i === present.length - 1 ? 4 : 0,
          }}
        />
      ))}
    </div>
  );
}

/* A headline number is not a chart. Four of them, one per state, read faster
   than any pie would — and the pie would be wrong anyway (four slices, two of
   them small). */
function StatTile({ level, n, total }) {
  const pct = total ? Math.round((n / total) * 100) : 0;
  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px",
      background: n ? `var(${level.bg})` : "transparent", minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span aria-hidden style={{ color: `var(${level.token})`, fontWeight: 800, fontSize: "0.9rem" }}>{level.icon}</span>
        <span style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>
          {level.label}
        </span>
      </div>
      <div style={{ fontSize: "1.6rem", fontWeight: 800, lineHeight: 1.15, marginTop: 2, color: "var(--text)" }}>
        {n}<span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text2)" }}> · {pct}%</span>
      </div>
      <div style={{ fontSize: "0.7rem", color: "var(--text2)", marginTop: 1 }}>{level.blurb}</div>
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: "0.73rem", color: "var(--text2)" }}>
      {LEVELS.map((l) => (
        <span key={l.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: `var(${l.token})`, display: "inline-block" }} />
          <span aria-hidden style={{ color: `var(${l.token})`, fontWeight: 800 }}>{l.icon}</span>
          {l.label}
        </span>
      ))}
    </div>
  );
}

const SEV_TOKEN = { good: "--st-good", warning: "--st-warn", serious: "--st-warn", critical: "--st-crit" };
const SEV_ICON = { good: "✓", warning: "⚠", serious: "⚠", critical: "✖" };

export default function FleetAnalysis({ analysis, suggestions = [], suggestionSource, note, busy, onBack, onProceed }) {
  const [tableView, setTableView] = useState(false);
  const [hover, setHover] = useState(null);

  if (!analysis) return null;
  const { total, byLevel, families = [], rows = [], totalDiskGiB, totalMemoryGiB, warmEligible, matrix } = analysis;

  // One scale across every bar, so a Windows row and a Linux row are directly
  // comparable. Per-row scaling would make a 2-VM distro look like a 20-VM one.
  const scale = Math.max(1, ...families.map((f) => f.total));
  const blocked = (byLevel?.unsupported || 0) + (byLevel?.unknown || 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Headline ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: "0.95rem" }}>Migration analysis</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text2)" }}>
          {total} VM{total === 1 ? "" : "s"} selected · {gib(totalDiskGiB)} to move · {gib(totalMemoryGiB)} RAM · {warmEligible} can migrate warm
        </div>
        <button onClick={() => setTableView((v) => !v)} style={{
          marginLeft: "auto", padding: "4px 11px", borderRadius: 7, fontSize: "0.75rem", fontWeight: 700, cursor: "pointer",
          background: "transparent", color: "var(--text2)", border: "1px solid var(--border)", fontFamily: "inherit",
        }}>{tableView ? "▤ Chart view" : "▦ Table view"}</button>
      </div>

      {/* ── Stat tiles ───────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 9 }}>
        {LEVELS.map((l) => <StatTile key={l.key} level={l} n={byLevel?.[l.key] || 0} total={total} />)}
      </div>

      {/* ── Chart: support by OS family, then by distribution ────────────── */}
      {!tableView && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontWeight: 800, fontSize: "0.84rem" }}>Support by operating system</div>
            <div style={{ fontSize: "0.72rem", color: "var(--text2)" }}>
              {hover ? `${hover.n} ${hover.level.label.toLowerCase()} — ${hover.level.blurb}` : "Grouped by family, then by distribution and version"}
            </div>
            <div style={{ marginLeft: "auto" }}><Legend /></div>
          </div>

          {families.map((f) => (
            <div key={f.family} style={{ marginBottom: 14 }}>
              {/* Family header row — the "how much Windows?" question. */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                <div style={{ width: 190, flexShrink: 0, fontWeight: 800, fontSize: "0.82rem" }}>
                  {FAMILY_LABEL[f.family] || f.family}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                  <StackBar counts={levelCounts(f)} scale={scale} height={13} onHover={setHover} />
                  <span style={{ fontSize: "0.75rem", color: "var(--text2)", whiteSpace: "nowrap" }}>
                    {f.total} VM{f.total === 1 ? "" : "s"} · {gib(f.diskGiB)}
                  </span>
                </div>
              </div>

              {/* Distribution rows — the "which Windows?" question. */}
              {f.distros.map((d) => {
                // The bar shows what happens to these VMs; the chip shows what
                // the matrix says about the OS. They are different facts and
                // routinely disagree — a certified RHEL 8 guest can still be
                // blocked by a shared disk — so each is labelled for what it is.
                const present = LEVELS.filter((l) => (d[l.key] || 0) > 0);
                return (
                  <div key={d.distro} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
                    <div style={{ width: 190, flexShrink: 0, paddingLeft: 14, fontSize: "0.76rem", color: "var(--text2)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.note || d.distro}>
                      {d.distro}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                      <StackBar counts={d} scale={scale} height={9} onHover={setHover} />
                      <span style={{ fontSize: "0.73rem", color: "var(--text2)", whiteSpace: "nowrap" }}>
                        {d.total} VM{d.total === 1 ? "" : "s"}
                        {/* Direct labels on a mixed row — without them the only
                            thing separating two segments is colour. */}
                        {present.length > 1 && present.map((l) => (
                          <span key={l.key} style={{ marginLeft: 6, color: `var(${l.token})`, fontWeight: 700 }}>
                            {l.icon}{d[l.key]}
                          </span>
                        ))}
                        <span style={{ marginLeft: 9 }} title="Verdict from the OpenShift Virtualization guest OS matrix for this distribution">
                          matrix:{" "}
                          <b style={{ color: `var(${LV[d.level]?.token || "--st-unknown"})` }}>
                            {LV[d.level]?.icon} {d.level}
                          </b>
                        </span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          <div style={{ fontSize: "0.7rem", color: "var(--text2)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            Support levels come from the OpenShift Virtualization guest matrix{matrix?.asOf ? ` (as of ${matrix.asOf})` : ""} combined with
            MTV's own validation of each VM. {matrix?.source || "Confirm against the guest OS support statement for your OpenShift version before committing to a wave."}
          </div>
        </div>
      )}

      {/* ── Table view: the same numbers, per VM ─────────────────────────── */}
      {tableView && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", maxHeight: 420, background: "var(--card)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.77rem" }}>
            <thead>
              <tr style={{ background: "var(--bg2)", position: "sticky", top: 0 }}>
                {["VM", "Status", "Guest OS", "Family", "IP address", "vCPU", "RAM", "Disk", "Warm", "Notes"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "7px 9px", fontWeight: 800, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const l = LV[r.level] || LV.unknown;
                return (
                  <tr key={r.id || r.name} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 9px", fontWeight: 700 }}>{r.name}</td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap", color: `var(${l.token})`, fontWeight: 700 }}>{l.icon} {l.label}</td>
                    <td style={{ padding: "6px 9px", color: "var(--text2)" }}>{r.os?.distro || "—"}</td>
                    <td style={{ padding: "6px 9px", color: "var(--text2)" }}>{FAMILY_LABEL[r.os?.family] || r.os?.family}</td>
                    <td style={{ padding: "6px 9px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem" }}>
                      {r.ips?.length ? r.ips.join(", ") : "—"}
                    </td>
                    <td style={{ padding: "6px 9px" }}>{r.cpuCount ?? "—"}</td>
                    <td style={{ padding: "6px 9px" }}>{r.memoryGiB ? `${r.memoryGiB} GiB` : "—"}</td>
                    <td style={{ padding: "6px 9px" }}>{gib(r.diskGiB)}</td>
                    <td style={{ padding: "6px 9px", color: r.warmEligible ? "var(--st-good)" : "var(--text2)" }}>{r.warmEligible ? "yes" : "no"}</td>
                    <td style={{ padding: "6px 9px", color: "var(--text2)", maxWidth: 300 }}>
                      {[...r.blockers.map((b) => `✖ ${b.message}`), ...r.warnings.map((w) => `⚠ ${w.message}`)].join(" ") || r.os?.note || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Suggestions ──────────────────────────────────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "11px 13px", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 7 }}>
          <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>What to do about it</span>
          <span style={{
            fontSize: "0.68rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700,
            background: suggestionSource === "ai" ? "rgba(124,58,237,.16)" : "var(--st-unknown-bg)",
            color: suggestionSource === "ai" ? "#a78bfa" : "var(--st-unknown)",
          }}>{suggestionSource === "ai" ? "AI + rules" : "rule-based"}</span>
          {busy && <span style={{ fontSize: "0.74rem", color: "var(--text2)" }}>analysing…</span>}
        </div>
        {note && <div style={{ fontSize: "0.73rem", color: "var(--st-warn)", marginBottom: 5 }}>{note}</div>}
        {suggestions.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 9, padding: "7px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
            <span aria-hidden style={{ color: `var(${SEV_TOKEN[s.severity] || "--st-unknown"})`, fontWeight: 800, fontSize: "0.9rem", lineHeight: 1.3 }}>
              {SEV_ICON[s.severity] || "•"}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: "0.81rem" }}>
                {s.title}
                {s.ai && <span style={{ marginLeft: 6, fontSize: "0.65rem", color: "#a78bfa", fontWeight: 700 }}>AI</span>}
              </div>
              {s.detail && <div style={{ fontSize: "0.77rem", color: "var(--text2)", marginTop: 1 }}>{s.detail}</div>}
              <div style={{ fontSize: "0.77rem", marginTop: 2 }}>→ {s.action}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Gate to step 3 ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={onBack} style={{
          padding: "8px 14px", borderRadius: 8, fontSize: "0.82rem", fontWeight: 700, cursor: "pointer",
          background: "transparent", color: "var(--text2)", border: "1px solid var(--border)", fontFamily: "inherit",
        }}>← Change selection</button>
        <button onClick={onProceed} disabled={!total} style={{
          padding: "8px 16px", borderRadius: 8, fontSize: "0.82rem", fontWeight: 700, border: "none",
          cursor: total ? "pointer" : "not-allowed", opacity: total ? 1 : .5,
          background: "#3d5afe", color: "#fff", fontFamily: "inherit",
        }}>Continue to migration →</button>
        {blocked > 0 && (
          <span style={{ fontSize: "0.76rem", color: "var(--st-warn)" }}>
            ⚠ {blocked} VM{blocked === 1 ? "" : "s"} in this selection {blocked === 1 ? "is" : "are"} blocked or unidentified —
            they are carried forward, but MTV will reject a plan that contains them.
          </span>
        )}
      </div>
    </div>
  );
}

/** Family-level counts, summed from its distributions so the family bar and the
    rows beneath it can never disagree. */
function levelCounts(family) {
  const out = { supported: 0, caveats: 0, unknown: 0, unsupported: 0 };
  for (const d of family.distros || []) for (const k of Object.keys(out)) out[k] += d[k] || 0;
  return out;
}
