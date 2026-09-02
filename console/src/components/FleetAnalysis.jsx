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

const SEV_TOKEN = { good: "--st-good", warning: "--st-warn", serious: "--st-warn", critical: "--st-crit", info: "--st-unknown" };
const SEV_ICON = { good: "✓", warning: "⚠", serious: "⚠", critical: "✖", info: "i" };
/* Power outcome is a fact about downtime, so it is stated in those terms. */
const POWER = {
  "stays-online": { icon: "●", label: "Stays online", token: "--st-good" },
  "power-off": { icon: "◐", label: "Must power off", token: "--st-warn" },
  "already-off": { icon: "○", label: "Already off", token: "--st-unknown" },
};


/* ── Target capacity ──────────────────────────────────────────────────────────
   The panel that no other assessment tool can draw. Every product in this space
   reads the source; this agent runs inside the destination, so it can say
   whether the wave will actually schedule — and a KubeVirt VM is a pod, so each
   machine must fit on ONE node. A 64 GiB guest does not run on 32 GiB workers,
   however much RAM the cluster has in total. */
const CAP_STYLE = {
  fits:    { token: "--st-good",    bg: "--st-good-bg",    icon: "✓" },
  tight:   { token: "--st-warn",    bg: "--st-warn-bg",    icon: "⚠" },
  exceeds: { token: "--st-crit",    bg: "--st-crit-bg",    icon: "✖" },
  blocked: { token: "--st-crit",    bg: "--st-crit-bg",    icon: "✖" },
  unknown: { token: "--st-unknown", bg: "--st-unknown-bg", icon: "?" },
};

function CapacityPanel({ capacity }) {
  if (!capacity) return null;
  const st = CAP_STYLE[capacity.verdict] || CAP_STYLE.unknown;
  const bad = (capacity.perVm || []).filter((p) => p.fits === false);
  // Memory is the binding constraint — it is not overcommitted, CPU is.
  const ratio = capacity.free?.memGiB > 0 ? capacity.demand.memGiB / capacity.free.memGiB : null;
  const pct = ratio == null ? null : Math.min(100, Math.round(ratio * 100));
  // A bar pinned at 100% cannot say "four times over", and the difference
  // between 105% and 400% is the difference between freeing a node and buying
  // three — so when it overflows, the multiple is stated in words.
  const over = ratio > 1 ? `${ratio.toFixed(1)}× over` : null;

  return (
    <div style={{ border: `1px solid var(${st.token})`, borderRadius: 10, padding: "12px 14px", background: `var(${st.bg})` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span aria-hidden style={{ color: `var(${st.token})`, fontWeight: 800 }}>{st.icon}</span>
        <span style={{ fontWeight: 800, fontSize: "0.86rem" }}>Will it fit?</span>
        <span style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: `var(${st.token})` }}>
          {capacity.verdict}
        </span>
        <span style={{ fontSize: "0.79rem", color: "var(--text)" }}>{capacity.headline}</span>
      </div>

      {pct != null && (
        <div style={{ marginTop: 9 }}>
          <div style={{ height: 8, borderRadius: 999, background: "rgba(127,127,127,.18)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: `var(${st.token})` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: "0.72rem", color: "var(--text2)", marginTop: 3 }}>
            <span>
              {capacity.demand.memGiB} GiB required by this wave
              {over && <b style={{ color: `var(${st.token})`, marginLeft: 6 }}>{over}</b>}
            </span>
            <span>{capacity.free.memGiB} GiB unreserved on {capacity.virtNodeCount} virtualization node(s)</span>
          </div>
        </div>
      )}

      {bad.length > 0 && (
        <div style={{ marginTop: 9 }}>
          {bad.map((p) => (
            <div key={p.name} style={{ display: "flex", gap: 8, fontSize: "0.78rem", marginTop: 4 }}>
              <span aria-hidden style={{ color: `var(${p.permanent ? "--st-crit" : "--st-warn"})`, fontWeight: 800 }}>
                {p.permanent ? "✖" : "⚠"}
              </span>
              <div><b>{p.name}</b> — {p.reason}</div>
            </div>
          ))}
        </div>
      )}

      {/* The assumptions, stated. A capacity number without them is a guess
          wearing a suit. */}
      <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: "0.7rem", color: "var(--text2)" }}>
        {(capacity.notes || []).map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </div>
  );
}

/* ── Drift ───────────────────────────────────────────────────────────────────
   An estate assessment goes stale in weeks. Showing only today's state hides
   that three machines regressed since the board signed off. */
function DriftPanel({ drift }) {
  if (!drift) return null;
  const groups = [
    ["improved", "Improved", "--st-good", "✓"],
    ["regressed", "Regressed", "--st-crit", "✖"],
    ["added", "New", "--st-unknown", "+"],
    ["removed", "Gone", "--st-unknown", "−"],
    ["changed", "Otherwise changed", "--st-warn", "⚠"],
  ].filter(([k]) => drift[k]?.length);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "11px 13px", background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Since the last assessment</span>
        <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>{drift.headline}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--text2)" }}>
          baseline {drift.sinceReportId} · {new Date(drift.since).toLocaleString()}
        </span>
      </div>
      {groups.map(([key, label, token, icon]) => (
        <div key={key} style={{ marginTop: 7 }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: `var(${token})` }}>
            {icon} {label} · {drift[key].length}
          </div>
          {drift[key].map((d) => (
            <div key={d.name} style={{ fontSize: "0.77rem", marginTop: 2 }}>
              <b>{d.name}</b> <span style={{ color: "var(--text2)" }}>{d.note}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}


/* ── Resource guarantees ──────────────────────────────────────────────────────
   The difference nobody assesses for, and the one that produces a performance
   ticket three weeks after a migration everyone called a success. VMware
   assigns vCPU and memory and may reserve them; OpenShift Virtualization turns
   the VM into a pod whose CPU request is the vCPU count divided by the
   cluster's overcommit ratio. The guest's own view never changes, which is
   exactly why this is invisible from inside it. */
const QOS = {
  guaranteed: { label: "guaranteed on VMware", token: "--st-crit", icon: "✖" },
  partial:    { label: "partly reserved",      token: "--st-warn", icon: "⚠" },
  shared:     { label: "already shared",       token: "--st-good", icon: "✓" },
  unknown:    { label: "not reported",         token: "--st-unknown", icon: "?" },
};

function FidelityPanel({ fidelity }) {
  if (!fidelity?.vms) return null;
  const { cpu, memory, byClass, losing, headline, note } = fidelity;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ fontWeight: 800, fontSize: "0.84rem" }}>Resource guarantees after migration</div>
        <div style={{ fontSize: "0.78rem", color: "var(--text)" }}>{headline}</div>
      </div>

      {/* Assigned vs requested, side by side. CPU is where the gap is; memory
          is requested in full, which is worth showing so nobody assumes the
          same applies to both. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 10 }}>
        {[
          { k: "CPU", assigned: `${cpu.assignedVcpu} vCPU`, requested: `${cpu.requestedCores} cores`,
            note: `overcommitted ${cpu.ratio}:1 by default`, warn: cpu.ratio > 1 },
          { k: "Memory", assigned: `${memory.assignedGiB} GiB`, requested: `${memory.requestedGiB} GiB`,
            note: "requested in full, plus virt-launcher overhead", warn: false },
        ].map((m) => (
          <div key={m.k} style={{ border: "1px solid var(--border)", borderRadius: 9, padding: "9px 11px" }}>
            <div style={{ fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>{m.k}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
              <span style={{ fontSize: "1.15rem", fontWeight: 800 }}>{m.assigned}</span>
              <span style={{ color: "var(--text2)" }}>→</span>
              <span style={{ fontSize: "1.15rem", fontWeight: 800, color: m.warn ? "var(--st-warn)" : "var(--st-good)" }}>{m.requested}</span>
            </div>
            <div style={{ fontSize: "0.71rem", color: "var(--text2)", marginTop: 2 }}>{m.note}</div>
          </div>
        ))}
        <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: "9px 11px" }}>
          <div style={{ fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>
            Quality of service
          </div>
          {Object.entries(QOS).map(([k, q]) => (byClass[k] ? (
            <div key={k} style={{ fontSize: "0.75rem", marginTop: 2 }}>
              <span style={{ color: `var(${q.token})`, fontWeight: 800 }}>{q.icon}</span>{" "}
              <b>{byClass[k]}</b> <span style={{ color: "var(--text2)" }}>{q.label}</span>
            </div>
          ) : null))}
        </div>
      </div>

      {losing.length > 0 && (
        <div style={{ marginTop: 9, fontSize: "0.77rem" }}>
          <b style={{ color: "var(--st-warn)" }}>⚠ {losing.length} VM{losing.length === 1 ? "" : "s"} lose a guarantee they have today:</b>
          {losing.slice(0, 6).map((l) => (
            <div key={l.name} style={{ marginTop: 2 }}>
              <b>{l.name}</b> <span style={{ color: "var(--text2)" }}>{l.evidence.join("; ")}</span>
            </div>
          ))}
          {losing.length > 6 && <div style={{ color: "var(--text2)" }}>+{losing.length - 6} more — see the register</div>}
          <div style={{ marginTop: 4 }}>
            → Set <code>dedicatedCpuPlacement</code> and matching CPU/memory limits on these after migration, with CPU Manager
            enabled on the target nodes. MTV carries no reservation, limit, share or latency setting across.
          </div>
        </div>
      )}
      {note && <div style={{ fontSize: "0.72rem", color: "var(--text2)", marginTop: 8 }}>{note}</div>}
      <div style={{ fontSize: "0.7rem", color: "var(--text2)", marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
        Every migrated VM lands as a <b>Burstable</b> pod: scheduled on its request, evictable under node pressure.
        The guest still sees the CPU count it always had — only the scheduler's view of it changes.
      </div>
    </div>
  );
}

export default function FleetAnalysis({
  analysis, suggestions = [], suggestionSource, note, busy,
  advice = [], adviceSource, adviceNote, onBack, onProceed, onExport,
}) {
  const [hover, setHover] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const exportBtn = {
    padding: "4px 11px", borderRadius: 7, fontSize: "0.74rem", fontWeight: 700, cursor: "pointer",
    fontFamily: "inherit", background: "transparent", color: "var(--text2)", border: "1px solid var(--border)",
  };

  if (!analysis) return null;
  const { total, byLevel, families = [], rows = [], totalDiskGiB, totalMemoryGiB, totalCpu, poweredOn, warmEligible, matrix } = analysis;

  // One scale across every distribution bar, so a Windows row and a Linux row
  // are directly comparable. Per-row scaling would make a 2-VM distro look like
  // a 20-VM one.
  const scale = Math.max(1, ...families.map((f) => f.total));
  const byName = Object.fromEntries(advice.map((a) => [a.name, a]));
  const keyOf = (r) => r.id || r.name;
  const ready = (byLevel?.supported || 0) + (byLevel?.caveats || 0);
  // Same order as the charts above — Windows before Linux would make the page
  // disagree with itself.
  const osGroups = families
    .map((f) => ({
      family: f.family,
      diskGiB: f.diskGiB,
      rows: rows.filter((r) => (r.os?.family || "unknown") === f.family),
    }))
    .filter((g) => g.rows.length);
  const blocked = (byLevel?.unsupported || 0) + (byLevel?.unknown || 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Provenance ───────────────────────────────────────────────────────
          A report with no identity is a screenshot. This one has a number a
          person can quote in a change record, a timestamp, the matrix version
          it was judged against, and a way to take it out of the building. */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "11px 13px", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: "0.95rem" }}>Pre-migration analysis report</div>
          {analysis.reportId && (
            <span style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.75rem",
              padding: "2px 8px", borderRadius: 6, background: "var(--bg2)", color: "var(--text2)" }}>
              {analysis.reportId}
            </span>
          )}
          {busy && <span style={{ fontSize: "0.76rem", color: "var(--text2)" }}>re-analysing…</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 7 }}>
            <button onClick={() => onExport?.("html")} style={exportBtn}>⭳ Evidence pack</button>
            <button onClick={() => onExport?.("csv")} style={exportBtn}>⭳ CSV register</button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 8, marginTop: 9 }}>
          {[
            ["Assessed", analysis.assessedAt ? new Date(analysis.assessedAt).toLocaleString() : "—"],
            ["Source platform", analysis.provider || "—"],
            ["Target cluster", analysis.cluster || "—"],
            ["Guest matrix", matrix?.asOf || "—"],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: "0.68rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>{k}</div>
              <div style={{ fontSize: "0.79rem" }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: "0.79rem", color: "var(--text2)", marginTop: 9, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          {total} VM{total === 1 ? "" : "s"} · {totalCpu} vCPU · {gib(totalMemoryGiB)} RAM ·
          {" "}{gib(totalDiskGiB)} to move · {poweredOn} running · {warmEligible} can migrate warm
        </div>
      </div>

      {/* ── Will it fit? ─────────────────────────────────────────────────── */}
      <CapacityPanel capacity={analysis.capacity} />

      {/* ── What the workload is promised, before and after ──────────────── */}
      <FidelityPanel fidelity={analysis.fidelity} />

      {/* ── What moved since last time ───────────────────────────────────── */}
      <DriftPanel drift={analysis.drift} />

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

      {/* ── Per-VM detail: what is wrong and what to change ──────────────
          The fleet findings above say how big each problem is. This says what
          the engineer holding a ticket for ONE machine has to do about it. */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "11px 13px 8px" }}>
          <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Every VM, and what it needs</span>
          <span style={{ fontSize: "0.75rem", color: "var(--text2)" }}>
            Click a row to see every action for that machine
          </span>
          <span style={{
            marginLeft: "auto", fontSize: "0.68rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700,
            background: adviceSource === "ai" ? "rgba(124,58,237,.16)" : "var(--st-unknown-bg)",
            color: adviceSource === "ai" ? "#a78bfa" : "var(--st-unknown)",
          }}>{adviceSource === "ai" ? "method advised by AI" : "method from rules"}</span>
        </div>
        {adviceNote && <div style={{ fontSize: "0.73rem", color: "var(--st-warn)", padding: "0 13px 6px" }}>{adviceNote}</div>}

        <div style={{ overflow: "auto", maxHeight: 520 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.77rem" }}>
            <thead>
              <tr style={{ background: "var(--bg2)", position: "sticky", top: 0 }}>
                {["VM", "Status", "Guest OS", "IP address", "vCPU", "RAM", "Storage", "Suggested method", "What to change"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "7px 9px", fontWeight: 800, borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Grouped by OS family, because that is how the work is
                  organised: Windows needs VirtIO drivers and usually a
                  different team, Linux does not. A flat list of forty machines
                  hides which half of the estate a finding belongs to. */}
              {osGroups.flatMap(({ family, rows: famRows, diskGiB }) => [
                <tr key={`fam-${family}`}>
                  <td colSpan={9} style={{
                    padding: "8px 9px 5px", background: "var(--bg2)",
                    borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
                  }}>
                    <span style={{ fontWeight: 800, fontSize: "0.79rem" }}>{FAMILY_LABEL[family] || family}</span>
                    <span style={{ marginLeft: 8, fontSize: "0.73rem", color: "var(--text2)" }}>
                      {famRows.length} VM{famRows.length === 1 ? "" : "s"} · {gib(diskGiB)}
                      {famRows.some((x) => x.blockers.length) && (
                        <span style={{ marginLeft: 8, color: "var(--st-crit)", fontWeight: 700 }}>
                          ✖ {famRows.filter((x) => x.blockers.length).length} blocked
                        </span>
                      )}
                    </span>
                  </td>
                </tr>,
                ...famRows.map((r) => {
                const l = LV[r.level] || LV.unknown;
                const a = byName[r.name];
                const p = POWER[a?.power] || null;
                const open = expanded === keyOf(r);
                const acts = r.actions || [];
                const worst = acts[0];
                return [
                  <tr key={keyOf(r)} onClick={() => setExpanded(open ? null : keyOf(r))}
                    style={{ borderBottom: open ? "none" : "1px solid var(--border)", cursor: "pointer" }}>
                    <td style={{ padding: "6px 9px", fontWeight: 700, whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--text2)", marginRight: 5 }}>{open ? "▾" : "▸"}</span>{r.name}
                    </td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap", color: `var(${l.token})`, fontWeight: 700 }}>{l.icon} {l.label}</td>
                    <td style={{ padding: "6px 9px", color: "var(--text2)" }} title={r.os?.reported || ""}>{r.os?.distro || "—"}</td>
                    <td style={{ padding: "6px 9px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem" }}>
                      {r.ips?.length ? r.ips[0] + (r.ips.length > 1 ? ` +${r.ips.length - 1}` : "") : "—"}
                    </td>
                    <td style={{ padding: "6px 9px" }}>{r.cpuCount ?? "—"}</td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap" }}>{r.memoryGiB ? `${r.memoryGiB} GiB` : "—"}</td>
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap" }}>{gib(r.diskGiB)}</td>
                    {/* A blocked machine has no method: offering "warm · stays
                        online" beside "Blocked" invites someone to read past
                        the blocker. */}
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap", fontWeight: 700,
                      color: r.blockers.length ? "var(--text2)" : a?.strategy === "warm" ? "var(--st-good)" : "var(--text2)" }}
                      title={r.blockers.length ? "Not migratable as things stand — clear the blocker first." : a?.reason || ""}>
                      {r.blockers.length ? (
                        <span style={{ fontWeight: 600 }}>— not migratable</span>
                      ) : (
                        <>
                          {a?.strategy || "—"}
                          {p && <span style={{ marginLeft: 6, fontWeight: 600, color: `var(${p.token})` }}>{p.icon} {p.label}</span>}
                        </>
                      )}
                    </td>
                    <td style={{ padding: "6px 9px", color: "var(--text2)", maxWidth: 300 }}>
                      <span style={{ color: `var(${SEV_TOKEN[worst?.severity] || "--st-unknown"})`, fontWeight: 700 }}>
                        {SEV_ICON[worst?.severity] || "•"}
                      </span>{" "}
                      {worst?.title || "—"}
                      {acts.length > 1 && <span style={{ color: "var(--text2)" }}> +{acts.length - 1} more</span>}
                    </td>
                  </tr>,
                  open && (
                    <tr key={keyOf(r) + "-x"} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td colSpan={9} style={{ padding: "2px 9px 10px 30px", background: "var(--bg2)" }}>
                        {acts.map((x, i) => (
                          <div key={i} style={{ display: "flex", gap: 8, padding: "5px 0" }}>
                            <span aria-hidden style={{ color: `var(${SEV_TOKEN[x.severity] || "--st-unknown"})`, fontWeight: 800 }}>
                              {SEV_ICON[x.severity] || "•"}
                            </span>
                            <div>
                              <div style={{ fontWeight: 700 }}>
                                {x.title}
                                {x.required && <span style={{ marginLeft: 6, fontSize: "0.66rem", fontWeight: 800, color: "var(--st-warn)" }}>REQUIRED</span>}
                              </div>
                              {x.detail && <div style={{ color: "var(--text2)" }}>{x.detail}</div>}
                              <div>→ {x.action}</div>
                            </div>
                          </div>
                        ))}
                        {/* How much of the assessment was actually possible.
                            A check the inventory could not answer is never
                            presented as a check that passed. */}
                        {r.checks?.coverage && (
                          <div style={{ marginTop: 6, paddingTop: 5, borderTop: "1px solid var(--border)", fontSize: "0.72rem", color: "var(--text2)" }}
                            title={(r.checks.unchecked || []).map((u) => u.label).join(", ")}>
                            {r.checks.coverage.ran} of {r.checks.coverage.total} source checks ran
                            {r.checks.unchecked?.length > 0 && (
                              <> · not reported by the inventory: {r.checks.unchecked.map((u) => u.label).join(", ")}</>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              }),
              ])}
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

      {/* ── Gate to the selection step ───────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={onBack} style={{
          padding: "8px 14px", borderRadius: 8, fontSize: "0.82rem", fontWeight: 700, cursor: "pointer",
          background: "transparent", color: "var(--text2)", border: "1px solid var(--border)", fontFamily: "inherit",
        }}>← Back to discovery</button>
        <button onClick={onProceed} disabled={!total} style={{
          padding: "8px 16px", borderRadius: 8, fontSize: "0.82rem", fontWeight: 700, border: "none",
          cursor: total ? "pointer" : "not-allowed", opacity: total ? 1 : .5,
          background: "#3d5afe", color: "#fff", fontFamily: "inherit",
        }}>Choose VMs to migrate →</button>
        <span style={{ fontSize: "0.74rem", color: "var(--text2)" }}>
          {ready} of {total} can go in a wave today{blocked ? `; ${blocked} need work first` : ""}.
        </span>
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
