import { useState } from "react";

/* ── UC-10 step 2: pre-migration analysis report ──────────────────────────────
   The question this page answers is "what did I just select, can it move, and
   how should it move?". Everything here is a roll-up of /api/migration/analyse —
   no new judgement is made in the browser, so the chart, the table and the plan
   gate can never disagree with each other.

   Colour is a reserved STATUS palette (see --st-* in styles.css), stepped and
   validated per mode. Every mark carries an icon and a label as well, so the
   report is readable in greyscale, under any colour-vision deficiency, and in
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

/* The four measures of the source landscape. One chart each — never two scales
   on one axis, which is the fastest way to make a comparison that isn't true. */
const METRICS = [
  { key: "vms",       label: "Virtual machines", fmt: (n) => String(n) },
  { key: "cpu",       label: "vCPU",             fmt: (n) => String(n) },
  { key: "memoryGiB", label: "Memory",           fmt: (n) => gib(n) },
  { key: "diskGiB",   label: "Storage",          fmt: (n) => gib(n) },
];

const FAMILY_LABEL = { windows: "Windows", linux: "Linux", other: "Other", unknown: "Unidentified" };
function gib(n) { return n == null ? "—" : n >= 1024 ? `${(n / 1024).toFixed(1)} TiB` : `${Math.round(n)} GiB`; }

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

/* ── One column chart: a measure of the source landscape, split by OS family
   and stacked by support level ────────────────────────────────────────────────
   Four of these side by side rather than one chart with several scales. Each
   is a small multiple of the same shape, so the eye compares the SHAPES and
   not two axes it has to reconcile. */
function ColumnChart({ families, metric, onHover }) {
  const H = 104;
  const totalOf = (f) => LEVELS.reduce((n, l) => n + (f.levels?.[l.key]?.[metric.key] || 0), 0);
  const totals = families.map(totalOf);
  const max = Math.max(1, ...totals);
  const grand = totals.reduce((a, b) => a + b, 0);

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>
        {metric.label}
      </div>
      <div style={{ fontSize: "0.95rem", fontWeight: 800, marginBottom: 6 }}>{metric.fmt(grand)}</div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: H }}>
        {families.map((f, i) => {
          const present = LEVELS.filter((l) => (f.levels?.[l.key]?.[metric.key] || 0) > 0);
          return (
            <div key={f.family} style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center", alignItems: "flex-end", height: "100%" }}>
              <div style={{
                width: "100%", maxWidth: 42, height: Math.max(3, Math.round(H * (totals[i] / max))),
                display: "flex", flexDirection: "column-reverse", gap: 2,
              }}>
                {present.map((l, j) => (
                  <div
                    key={l.key}
                    onMouseEnter={() => onHover?.({ level: l, n: f.levels[l.key][metric.key], metric, family: f.family })}
                    onMouseLeave={() => onHover?.(null)}
                    title={`${FAMILY_LABEL[f.family] || f.family} · ${l.label} — ${metric.fmt(f.levels[l.key][metric.key])}`}
                    style={{
                      flex: f.levels[l.key][metric.key], background: `var(${l.token})`, cursor: "default",
                      // column-reverse puts the last child on top, so that is
                      // the only end that gets rounded.
                      borderTopLeftRadius: j === present.length - 1 ? 4 : 0,
                      borderTopRightRadius: j === present.length - 1 ? 4 : 0,
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Direct labels under every column — the only way this reads without
          hovering, and the only way it reads at all in greyscale. */}
      <div style={{ display: "flex", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 5, marginTop: 4 }}>
        {families.map((f, i) => (
          <div key={f.family} style={{ flex: 1, minWidth: 0, textAlign: "center" }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 700 }}>{metric.fmt(totals[i])}</div>
            <div style={{ fontSize: "0.67rem", color: "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {FAMILY_LABEL[f.family] || f.family}
            </div>
          </div>
        ))}
      </div>
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
/* Power outcome is a fact about downtime, so it is stated in those terms. */
const POWER = {
  "stays-online": { icon: "●", label: "Stays online", token: "--st-good" },
  "power-off": { icon: "◐", label: "Must power off", token: "--st-warn" },
  "already-off": { icon: "○", label: "Already off", token: "--st-unknown" },
};

export default function FleetAnalysis({
  analysis, suggestions = [], suggestionSource, note, busy,
  advice = [], adviceSource, adviceNote,
  selected = {}, onToggle, onBack, onProceed,
}) {
  const [hover, setHover] = useState(null);

  if (!analysis) return null;
  const { total, byLevel, families = [], rows = [], totalDiskGiB, totalMemoryGiB, totalCpu, poweredOn, warmEligible, matrix } = analysis;

  // One scale across every distribution bar, so a Windows row and a Linux row
  // are directly comparable. Per-row scaling would make a 2-VM distro look like
  // a 20-VM one.
  const scale = Math.max(1, ...families.map((f) => f.total));
  const byName = Object.fromEntries(advice.map((a) => [a.name, a]));
  const keyOf = (r) => r.id || r.name;
  const confirmed = rows.filter((r) => selected[keyOf(r)] !== undefined).length;
  const blocked = (byLevel?.unsupported || 0) + (byLevel?.unknown || 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Headline ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: "0.95rem" }}>Pre-migration analysis report</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text2)" }}>
          {total} VM{total === 1 ? "" : "s"} from the source platform · {totalCpu} vCPU · {gib(totalMemoryGiB)} RAM ·
          {" "}{gib(totalDiskGiB)} to move · {poweredOn} running · {warmEligible} can migrate warm
        </div>
        {busy && <span style={{ fontSize: "0.76rem", color: "var(--text2)" }}>re-analysing…</span>}
      </div>

      {/* ── Stat tiles ───────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 9 }}>
        {LEVELS.map((l) => <StatTile key={l.key} level={l} n={byLevel?.[l.key] || 0} total={total} />)}
      </div>

      {/* ── The source landscape, split by OS family ─────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: "0.84rem" }}>Source landscape by operating system</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text2)" }}>
            {hover
              ? `${FAMILY_LABEL[hover.family] || hover.family || ""} · ${hover.level.label} — ${hover.metric ? hover.metric.fmt(hover.n) : hover.n}`
              : "Compute and storage carried by each OS family, coloured by support level"}
          </div>
          <div style={{ marginLeft: "auto" }}><Legend /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 18 }}>
          {METRICS.map((m) => <ColumnChart key={m.key} families={families} metric={m} onHover={setHover} />)}
        </div>
      </div>

      {/* ── Distribution and version detail ──────────────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: "0.84rem" }}>Support by distribution and version</div>
          <div style={{ fontSize: "0.72rem", color: "var(--text2)" }}>Checked against the OpenShift Virtualization guest matrix</div>
        </div>

        {families.map((f) => (
          <div key={f.family} style={{ marginBottom: 14 }}>
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

      {/* ── Validate: confirm the VMs and read the recommendation ────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "11px 13px 8px" }}>
          <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Validate the selection</span>
          <span style={{ fontSize: "0.75rem", color: "var(--text2)" }}>
            Untick anything that should not move in this wave. {confirmed} of {rows.length} confirmed.
          </span>
          <span style={{
            marginLeft: "auto", fontSize: "0.68rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700,
            background: adviceSource === "ai" ? "rgba(124,58,237,.16)" : "var(--st-unknown-bg)",
            color: adviceSource === "ai" ? "#a78bfa" : "var(--st-unknown)",
          }}>{adviceSource === "ai" ? "method advised by AI" : "method from rules"}</span>
        </div>
        {adviceNote && <div style={{ fontSize: "0.73rem", color: "var(--st-warn)", padding: "0 13px 6px" }}>{adviceNote}</div>}

        <div style={{ overflow: "auto", maxHeight: 460 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.77rem" }}>
            <thead>
              <tr style={{ background: "var(--bg2)", position: "sticky", top: 0 }}>
                {["", "VM", "Status", "Guest OS", "IP address", "vCPU", "RAM", "Storage", "Method", "Source VM", "Why"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "7px 9px", fontWeight: 800, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const l = LV[r.level] || LV.unknown;
                const a = byName[r.name];
                const p = POWER[a?.power] || null;
                const on = selected[keyOf(r)] !== undefined;
                const why = a?.reason || r.blockers.map((b) => b.message).join(" ") || r.os?.note || "—";
                return (
                  <tr key={keyOf(r)} style={{ borderBottom: "1px solid var(--border)", opacity: on ? 1 : .5 }}>
                    <td style={{ padding: "6px 9px" }}>
                      <input type="checkbox" checked={on} onChange={() => onToggle?.(keyOf(r))}
                        title={on ? "Exclude from this wave" : "Include in this wave"} />
                    </td>
                    <td style={{ padding: "6px 9px", fontWeight: 700 }}>{r.name}</td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap", color: `var(${l.token})`, fontWeight: 700 }}>{l.icon} {l.label}</td>
                    <td style={{ padding: "6px 9px", color: "var(--text2)" }} title={r.os?.reported || ""}>{r.os?.distro || "—"}</td>
                    <td style={{ padding: "6px 9px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem" }}>
                      {r.ips?.length ? r.ips.join(", ") : "—"}
                    </td>
                    <td style={{ padding: "6px 9px" }}>{r.cpuCount ?? "—"}</td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap" }}>{r.memoryGiB ? `${r.memoryGiB} GiB` : "—"}</td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap" }}>{gib(r.diskGiB)}</td>
                    {/* The AI's two calls: how to move it, and what that costs
                        the source machine in downtime. */}
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap", fontWeight: 700,
                      color: a?.strategy === "warm" ? "var(--st-good)" : "var(--text2)" }}>
                      {a?.strategy || "—"}
                      {a?.overridden && <span style={{ color: "var(--st-warn)", fontWeight: 600 }} title="Warm is not possible for this VM — corrected"> (corrected)</span>}
                    </td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap", color: p ? `var(${p.token})` : "var(--text2)", fontWeight: 700 }}
                      title={a?.detail || ""}>
                      {p ? `${p.icon} ${p.label}` : "—"}
                    </td>
                    {/* Clamped to two lines so one wordy reason cannot set the
                        height of every row; the full text is on hover. */}
                    <td style={{ padding: "6px 9px", color: "var(--text2)", maxWidth: 340 }}>
                      <div title={why} style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {why}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Suggestions ──────────────────────────────────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "11px 13px", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 7 }}>
          <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>What to do about it</span>
          <span style={{
            fontSize: "0.68rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700,
            background: suggestionSource === "ai" ? "rgba(124,58,237,.16)" : "var(--st-unknown-bg)",
            color: suggestionSource === "ai" ? "#a78bfa" : "var(--st-unknown)",
          }}>{suggestionSource === "ai" ? "AI + rules" : "rule-based"}</span>
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
        <button onClick={onProceed} disabled={!confirmed} style={{
          padding: "8px 16px", borderRadius: 8, fontSize: "0.82rem", fontWeight: 700, border: "none",
          cursor: confirmed ? "pointer" : "not-allowed", opacity: confirmed ? 1 : .5,
          background: "#3d5afe", color: "#fff", fontFamily: "inherit",
        }}>Accept report for {confirmed} VM{confirmed === 1 ? "" : "s"} →</button>
        <span style={{ fontSize: "0.74rem", color: "var(--text2)" }}>
          Applies the recommended method. You can still change it per VM in the next step.
        </span>
        {blocked > 0 && (
          <span style={{ fontSize: "0.76rem", color: "var(--st-warn)", flexBasis: "100%" }}>
            ⚠ {blocked} VM{blocked === 1 ? "" : "s"} in this selection {blocked === 1 ? "is" : "are"} blocked or unidentified —
            untick {blocked === 1 ? "it" : "them"} here, or MTV will reject the plan that contains {blocked === 1 ? "it" : "them"}.
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
