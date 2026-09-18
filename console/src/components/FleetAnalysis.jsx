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

/* ── One donut ────────────────────────────────────────────────────────────────
   A donut earns its place here and almost nowhere else: the four support levels
   are parts of one whole (this family's VM count), there are never more than
   four of them, and the question is "how much of this group is ready" — a
   part-to-whole read at a glance, not a comparison of close values.

   What it is NOT used for: comparing one family against another. Arcs are bad
   at that, so every magnitude underneath is a labelled number instead. Nobody
   is asked to judge a quantity by eye from a curve.                          */
function Donut({ counts, size = 104, thickness = 13, hero = false, onHover }) {
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  const present = LEVELS.filter((l) => (counts[l.key] || 0) > 0);
  const total = present.reduce((n, l) => n + counts[l.key], 0);
  // A 3px gap along the arc, for the same reason stacked bars get one: adjacent
  // fills that touch read as a single mark. A lone segment needs no gap — and
  // must not get one, or a complete ring looks broken.
  const gap = present.length > 1 ? 3 : 0;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--border)" strokeWidth={thickness} opacity={0.5} />
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {present.map((l) => {
          const len = Math.max(1, (C * counts[l.key]) / total - gap);
          const seg = (
            <circle
              key={l.key} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={`var(${l.token})`} strokeWidth={thickness} strokeLinecap="butt"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
              onMouseEnter={() => onHover?.({ level: l, n: counts[l.key] })}
              onMouseLeave={() => onHover?.(null)}
            >
              <title>{`${counts[l.key]} ${l.label.toLowerCase()} — ${l.blurb}`}</title>
            </circle>
          );
          offset += (C * counts[l.key]) / total;
          return seg;
        })}
      </g>
      {/* The number lives in the hole. That is the whole reason to use a ring
          rather than a pie. */}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        style={{ fontSize: hero ? 26 : 21, fontWeight: 800, fill: "var(--text)" }}>
        {total}
      </text>
    </svg>
  );
}

/* One family: its ring, what the ring is made of, and its share of the estate
   as numbers rather than as more geometry. */
function FamilyRing({ label, counts, metrics, hero, onHover }) {
  const total = LEVELS.reduce((n, l) => n + (counts[l.key] || 0), 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: "1 1 128px", minWidth: 128 }}>
      <Donut counts={counts} size={hero ? 124 : 104} thickness={hero ? 15 : 13} hero={hero} onHover={onHover} />
      <div style={{ fontSize: "0.78rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em" }}>
        {label}
      </div>
      {/* Direct labels: the counts are read, never estimated from an arc. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", fontSize: "0.77rem" }}>
        {LEVELS.filter((l) => (counts[l.key] || 0) > 0).map((l) => (
          <span key={l.key} style={{ color: `var(${l.token}-ink)`, fontWeight: 700 }} title={l.label}>
            {l.icon}{counts[l.key]}
          </span>
        ))}
        {total === 0 && <span style={{ color: "var(--text2)" }}>—</span>}
      </div>
      {/* These are measurements, not commentary, so they wear the primary ink.
          Secondary grey at this size is the first thing to disappear on a
          projector, and the vCPU/RAM/storage line is the one number in this
          panel a person actually reads out loud. */}
      {metrics && (
        <div style={{ fontSize: "0.76rem", fontWeight: 600, color: "var(--text)", textAlign: "center", lineHeight: 1.5 }}>
          {metrics.map((m) => <div key={m}>{m}</div>)}
        </div>
      )}
    </div>
  );
}

/* The cost, and the arithmetic behind it.

   A number on a screen invites "how did you get that?", and a cost figure that
   cannot answer is worse than none — someone quotes it in a budget
   conversation and cannot defend it. So the total is shown with the word
   "est.", and one click gives the working: the rates, the token counts, when
   the rates were last checked, and whether they are list price or the
   organisation's own rate card.

   The caveat is not buried. List price ignores enterprise agreements,
   committed-use discounts and provisioned-throughput billing, so for most
   organisations it is the wrong number until MODEL_PRICING is set. Saying so
   is what makes the figure usable rather than merely present. */
export function CostCell({ ai }) {
  const [open, setOpen] = useState(false);
  const b = ai.costBasis;
  const money = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  return (
    <div style={{ fontSize: "0.79rem" }}>
      <button onClick={() => setOpen((v) => !v)} title="Show how this was calculated"
        style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit",
          cursor: "pointer", fontWeight: 700 }}>
        {b?.unpriced ? "at least " : ""}{money(ai.costUsd)}
        <span style={{ fontWeight: 400, color: "var(--text2)" }}>
          {" "}est.{b?.source === "list-price" ? " · list price" : b?.source === "configured" ? " · your rates" : ""} ▾
        </span>
      </button>
      {open && b && (
        <div style={{ marginTop: 4, padding: "7px 9px", borderRadius: 7, background: "var(--bg2)",
          border: "1px solid var(--border)", fontSize: "0.75rem", lineHeight: 1.55 }}>
          {b.lines.map((l) => (
            <div key={l} style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem" }}>{l}</div>
          ))}
          {b.unpriced > 0 && (
            <div style={{ marginTop: 3, color: "var(--st-warn-ink)" }}>
              {b.unpriced} call{b.unpriced === 1 ? " is" : "s are"} not priced — the model was not in the rate card, so this total is a floor.
            </div>
          )}
          <div data-prose style={{ marginTop: 4, color: "var(--text2)" }}>{b.caveat}</div>
        </div>
      )}
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
        <span aria-hidden style={{ color: `var(${level.token}-ink)`, fontWeight: 800, fontSize: "0.9rem" }}>{level.icon}</span>
        <span style={{ fontSize: "0.76rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>
          {level.label}
        </span>
      </div>
      <div style={{ fontSize: "1.6rem", fontWeight: 800, lineHeight: 1.15, marginTop: 2, color: "var(--text)" }}>
        {n}<span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text2)" }}> · {pct}%</span>
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--text2)", marginTop: 1 }}>{level.blurb}</div>
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: "0.77rem", color: "var(--text2)" }}>
      {LEVELS.map((l) => (
        <span key={l.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: `var(${l.token})`, display: "inline-block" }} />
          <span aria-hidden style={{ color: `var(${l.token}-ink)`, fontWeight: 800 }}>{l.icon}</span>
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
  fits:       { token: "--st-good",    bg: "--st-good-bg",    icon: "✓", word: "will land" },
  tight:      { token: "--st-warn",    bg: "--st-warn-bg",    icon: "⚠", word: "lands, no margin" },
  fragmented: { token: "--st-crit",    bg: "--st-crit-bg",    icon: "✖", word: "room exists, cannot be reached" },
  exceeds:    { token: "--st-crit",    bg: "--st-crit-bg",    icon: "✖", word: "too big for this cluster" },
  blocked:    { token: "--st-crit",    bg: "--st-crit-bg",    icon: "✖", word: "blocked" },
  unknown:    { token: "--st-unknown", bg: "--st-unknown-bg", icon: "?", word: "not known" },
};

/* Three reasons a machine does not land, three different fixes. Pooling them
   into "won't fit" is how someone buys nodes to solve a wave-ordering problem. */
const BLOCK_KIND = {
  hardware: { icon: "✖", token: "--st-crit", title: (n) => `${n} — will never schedule on this cluster`,
    fix: "Add a machine set with bigger nodes, or leave it out of this wave." },
  cluster: { icon: "✖", token: "--st-crit", title: (n) => `${n} — fits the hardware, but the cluster has no room today`,
    fix: "Scale the cluster or free reserved capacity before cutover." },
  wave: { icon: "✖", token: "--st-warn", title: (n) => `${n} — fits the hardware, but nothing is left by the time it is placed`,
    fix: "Move it to the next wave, or place it first and re-run. The cluster does not need to change." },
};

/* A node's memory after this wave lands. One meter per node, direct-labelled —
   the number is read, never estimated from a bar. */
function NodeMeter({ n }) {
  const pct = n.pctMem ?? 0;
  const token = pct >= 95 ? "--st-crit" : pct >= 85 ? "--st-warn" : "--st-good";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(110px,150px) 1fr minmax(150px,auto)", gap: 11, alignItems: "center", padding: "6px 0" }}>
      <div>
        <div style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.77rem", fontWeight: 700 }}>{n.name}</div>
        <div style={{ fontSize: "0.72rem", color: "var(--text2)" }}>{n.memGiB} GiB node</div>
      </div>
      <div style={{ height: 9, borderRadius: 5, background: "rgba(127,127,127,.15)", overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", borderRadius: 5, background: `var(${token})` }} />
      </div>
      <div style={{ fontSize: "0.76rem", color: "var(--text2)", textAlign: "right", whiteSpace: "nowrap" }}>
        <b style={{ color: "var(--text)" }}>{n.vmCount} VM{n.vmCount === 1 ? "" : "s"}</b>
        {" · "}{n.usedMemGiB}/{n.memGiB} GiB
      </div>
    </div>
  );
}

/* ── Will it land? ────────────────────────────────────────────────────────────
   Blockers first, inventory second. Every other tool in this space opens on the
   estate and leaves the operator to find the three rows that matter; the three
   rows that matter are the whole point of the step.

   The placement underneath is packed as a SET. Checking each machine against
   the emptiest node one at a time never accounts for the machine placed there a
   moment earlier, and summing the wave against total headroom ignores that the
   headroom is fragmented. Both are wrong in the optimistic direction. */
function LandingPanel({ capacity }) {
  const [showAll, setShowAll] = useState(false);
  if (!capacity) return null;
  const st = CAP_STYLE[capacity.verdict] || CAP_STYLE.unknown;
  const p = capacity.placement;

  // Placement is the truth when it could be simulated. When the cluster could
  // not be read, the per-VM fit check is all there is — and it is labelled as
  // the weaker answer rather than dressed up as the same one.
  const blockers = p?.available
    ? (p.unplaced || [])
    : (capacity.perVm || []).filter((x) => x.fits === false)
        .map((x) => ({ name: x.name, reason: x.reason, blockedBy: x.permanent ? "hardware" : "cluster" }));
  const order = { hardware: 0, cluster: 1, wave: 2 };
  const sorted = blockers.slice().sort((a, b) => (order[a.blockedBy] ?? 3) - (order[b.blockedBy] ?? 3));
  const placed = p?.placed || [];
  const shown = showAll ? placed : placed.slice(0, 6);

  return (
    <div style={{ border: `1px solid var(${st.token})`, borderRadius: 10, background: "var(--card)", overflow: "hidden" }}>
      <div style={{ padding: "12px 14px", background: `var(${st.bg})`, borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
          <span aria-hidden style={{ color: `var(${st.token}-ink)`, fontWeight: 800 }}>{st.icon}</span>
          <span style={{ fontWeight: 800, fontSize: "0.86rem" }}>Will it land?</span>
          <span style={{ fontSize: "0.76rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: `var(${st.token}-ink)` }}>
            {st.word}
          </span>
          <span style={{ marginLeft: "auto", fontSize: "0.73rem", color: "var(--text2)" }}>
            read live from the target cluster
          </span>
        </div>
        <div style={{ fontSize: "0.79rem", color: "var(--text)", marginTop: 4 }}>{capacity.headline}</div>
      </div>

      {/* ── The blockers, before anything else ── */}
      {sorted.length > 0 && (
        <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: "0.79rem", fontWeight: 800, marginBottom: 5 }}>
            {sorted.length} machine{sorted.length === 1 ? "" : "s"} will stop this wave
          </div>
          {sorted.map((b) => {
            const k = BLOCK_KIND[b.blockedBy] || BLOCK_KIND.cluster;
            return (
              <div key={b.name} style={{ display: "flex", gap: 9, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
                <span aria-hidden style={{ color: `var(${k.token}-ink)`, fontWeight: 800 }}>{k.icon}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "0.8rem", fontWeight: 700 }}>{k.title(b.name)}</div>
                  <div style={{ fontSize: "0.77rem", color: "var(--text2)", marginTop: 1 }}>{b.reason}</div>
                  <div style={{ fontSize: "0.77rem", marginTop: 2 }}>→ {k.fix}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Where everything else lands ── */}
      {p?.available && (
        <div style={{ padding: "11px 14px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontWeight: 800, fontSize: "0.82rem" }}>
              Placement — {p.placedCount} of {p.placedCount + p.unplacedCount} machine
              {p.placedCount + p.unplacedCount === 1 ? "" : "s"} onto {p.nodesUsed} node{p.nodesUsed === 1 ? "" : "s"}
            </span>
            <span style={{ fontSize: "0.74rem", color: "var(--text2)" }}>simulated as a set, not one machine at a time — a placement exists, which is not the same as predicting the scheduler's choice</span>
          </div>

          {p.nodes.map((n) => <NodeMeter key={n.name} n={n} />)}

          {/* A node the cluster can use and a VM cannot is not headroom. */}
          {(p.excluded || []).map((e) => (
            <div key={e.name} style={{ display: "flex", gap: 9, fontSize: "0.75rem", color: "var(--st-unknown-ink)", padding: "4px 0" }}>
              <span style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", minWidth: 110 }}>{e.name}</span>
              <span>Excluded — {e.reason}</span>
            </div>
          ))}

          {placed.length > 0 && (
            <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem" }}>
                <thead>
                  <tr>
                    {["Machine", "Requests", "Can land on", "Spare after"].map((h, i) => (
                      <th key={h} style={{ textAlign: i > 2 ? "right" : "left", padding: "4px 8px", fontWeight: 800,
                        fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)",
                        borderBottom: "1px solid var(--border)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((x) => (
                    <tr key={x.name}>
                      <td style={{ padding: "5px 8px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace" }}>{x.name}</td>
                      {/* The request a KubeVirt VM makes, not the guest's spec —
                          they are different numbers and only one reaches the
                          scheduler. */}
                      <td style={{ padding: "5px 8px", color: "var(--text2)" }}>
                        {x.need.cpuMillis}m · {x.need.memGiB.toFixed(1)} GiB
                      </td>
                      <td style={{ padding: "5px 8px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace" }}>{x.node}</td>
                      <td style={{ padding: "5px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {x.spareMemGiB.toFixed(1)} GiB
                        {x.tight && (
                          <span title="Nothing else this size fits on that node afterwards"
                            style={{ marginLeft: 6, color: "var(--st-warn-ink)", fontWeight: 700 }}>⚠ last fit</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {placed.length > shown.length && (
                <button onClick={() => setShowAll(true)} style={{ background: "none", border: "none", padding: "6px 8px",
                  font: "inherit", fontSize: "0.75rem", fontWeight: 700, color: "var(--text2)", cursor: "pointer" }}>
                  {placed.length - shown.length} more machine{placed.length - shown.length === 1 ? "" : "s"} placed · show all
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* The assumptions, stated. A capacity number without them is a guess
          wearing a suit. */}
      <ul data-prose style={{ margin: 0, padding: "0 14px 11px 32px", fontSize: "0.75rem", color: "var(--text2)" }}>
        {(capacity.notes || []).map((n, i) => <li key={i} style={{ marginTop: 2 }}>{n}</li>)}
      </ul>
    </div>
  );
}

/* ── Node loss ────────────────────────────────────────────────────────────────
   The same pack, re-run with each node removed. No assessment product answers
   this, because none of them are operating the target — and "the wave fits" and
   "the wave fits as long as nothing happens for four hours" are different
   promises. */
function RehearsalPanel({ rehearsal }) {
  if (!rehearsal?.available || !rehearsal.nodes?.length) return null;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "11px 13px 7px" }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>If a node is lost mid-wave</span>
        <span style={{ fontSize: "0.75rem", color: "var(--text2)" }}>
          patching, a drain, a hardware failure — the whole wave is re-packed without it, so the machines left over are not only the ones it was carrying
        </span>
        <span style={{ marginLeft: "auto", fontSize: "0.77rem", color: rehearsal.worst ? "var(--st-warn-ink)" : "var(--st-good-ink)", fontWeight: 700 }}>
          {rehearsal.headline}
        </span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.77rem" }}>
        <thead>
          <tr>
            {["If this node goes", "It carries", "Wave still places", "No longer place", "What it means"].map((h, i) => (
              <th key={h} style={{ textAlign: i >= 1 && i <= 3 ? "right" : "left", padding: "5px 9px", fontWeight: 800,
                fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)",
                borderBottom: "1px solid var(--border)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rehearsal.nodes.map((n) => (
            <tr key={n.node} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "5px 9px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace" }}>{n.node}</td>
              <td style={{ padding: "5px 9px", textAlign: "right" }}>{n.hosted}</td>
              <td style={{ padding: "5px 9px", textAlign: "right" }}>{n.stillPlaces}</td>
              <td style={{ padding: "5px 9px", textAlign: "right", fontWeight: n.stranded ? 800 : 400,
                color: n.stranded ? "var(--st-crit-ink)" : "var(--text2)" }}>{n.stranded}</td>
              <td style={{ padding: "5px 9px" }}>
                {n.stranded ? (
                  <>
                    <b style={{ color: "var(--st-crit-ink)" }}>✖ {n.stranded} stranded</b>
                    <span style={{ color: "var(--text2)" }}>
                      {" "}— do not drain this node while the wave runs
                      {n.strandedNames.length ? `: ${n.strandedNames.join(", ")}` : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <b style={{ color: "var(--st-good-ink)" }}>✓ absorbs</b>
                    {n.tightNodesAfter > 0 && (
                      <span style={{ color: "var(--text2)" }}> — {n.tightNodesAfter} node{n.tightNodesAfter === 1 ? " goes" : "s go"} above 90%</span>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rehearsal.singleNode && (
        <div style={{ padding: "8px 13px", fontSize: "0.76rem", color: "var(--st-warn-ink)" }}>{rehearsal.note}</div>
      )}
    </div>
  );
}

/* ── Staleness ────────────────────────────────────────────────────────────────
   Every product in this space hands over a report, and a report cannot know it
   went out of date. This agent lives in the destination, so it can say that two
   workers were replaced at 14:00 and which verdicts moved because of it. */
function StalenessBand({ analysis, onRecheck, busy }) {
  const at = analysis.assessedAt ? new Date(analysis.assessedAt) : null;
  const cap = analysis.drift?.capacity;
  const nodes = analysis.capacity?.virtNodeCount;
  if (!at && !cap) return null;
  const ageMins = at ? Math.round((Date.now() - at.getTime()) / 60000) : null;
  const age = ageMins == null ? null
    : ageMins < 2 ? "just now"
    : ageMins < 90 ? `${ageMins} minutes old`
    : ageMins < 60 * 48 ? `${Math.round(ageMins / 60)} hours old`
    : `${Math.round(ageMins / 1440)} days old`;
  const moved = cap ? cap.counts.improved + cap.counts.regressed : 0;

  return (
    <div style={{ display: "flex", gap: 11, alignItems: "flex-start", flexWrap: "wrap",
      border: "1px solid var(--border)", borderLeft: `3px solid var(${moved ? "--st-warn" : "--st-unknown"})`,
      borderRadius: 10, padding: "10px 13px", background: "var(--card)", fontSize: "0.78rem", lineHeight: 1.55 }}>
      <span aria-hidden style={{ color: `var(${moved ? "--st-warn" : "--st-unknown"}-ink)`, fontWeight: 800 }}>⟳</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        Assessed <b>{at ? at.toLocaleString() : "—"}</b>
        {nodes != null && <> against <b>{nodes}</b> virtualization node{nodes === 1 ? "" : "s"}</>}
        {age && <span style={{ color: "var(--text2)" }}> · this assessment is {age}</span>}
        {cap && cap.material > 0 && (
          <div style={{ marginTop: 3 }}>
            <span style={{ color: "var(--st-warn-ink)", fontWeight: 800 }}>The target has changed since then</span>
            <span style={{ color: "var(--text2)" }}> — {cap.headline}.</span>
            {[...cap.resized, ...cap.removed, ...cap.added].slice(0, 4).map((n) => (
              <div key={n.name} style={{ color: "var(--text2)" }}>
                <b style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", color: "var(--text)" }}>{n.name}</b> {n.note}
              </div>
            ))}
            {cap.regressed.slice(0, 4).map((v) => (
              <div key={v.name} style={{ color: "var(--text2)" }}>
                <b style={{ color: "var(--st-crit-ink)" }}>✖ {v.name}</b> {v.note}
              </div>
            ))}
          </div>
        )}
      </div>
      {onRecheck && (
        <button onClick={onRecheck} disabled={busy} style={{ flex: "none", padding: "4px 11px", borderRadius: 7,
          fontSize: "0.75rem", fontWeight: 700, fontFamily: "inherit", cursor: busy ? "default" : "pointer",
          background: "transparent", color: "var(--text2)", border: "1px solid var(--border)", opacity: busy ? .6 : 1 }}>
          {busy ? "re-checking…" : "↻ Re-check now"}
        </button>
      )}
    </div>
  );
}

/* ── Evidence ─────────────────────────────────────────────────────────────────
   Device42 hands over data; Zerto hands over replication. Neither hands an
   auditor a line from "assessed on this evidence" through "the model advised,
   policy overruled it" to "a named human approved it under this change record".
   The steps that have not happened yet are shown as not having happened —
   a chain with an invented link is worse than a short one. */
function EvidenceChain({ analysis }) {
  const ai = analysis.ai;
  const steps = [
    { k: "Assessed", v: analysis.assessedAt ? new Date(analysis.assessedAt).toLocaleString() : "—",
      d: `Live node state and pod requests from ${analysis.cluster || "the target cluster"}`, done: true },
    { k: "Model recommended", v: ai?.consulted ? `${ai.calls} call${ai.calls === 1 ? "" : "s"} · ${ai.model || "model"}` : "not consulted — rules only",
      d: ai?.consulted && ai.totalTokens != null ? `${ai.totalTokens.toLocaleString()} tokens` : "every verdict above is computed from rules", done: true },
    { k: "Policy overruled", v: ai?.corrections ? `${ai.corrections} recommendation${ai.corrections === 1 ? "" : "s"}` : "none",
      d: ai?.corrections ? "downgraded before they reached this screen" : "nothing the model proposed needed overriding", done: true },
    { k: "Approved", v: "not yet", d: "a named human signs off at the plan step", done: false },
    { k: "Change request", v: "not yet raised", d: "raised against the wave once VMs are selected", done: false },
  ];
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "11px 13px 8px" }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>What this verdict rests on</span>
        <span style={{ fontSize: "0.75rem", color: "var(--text2)" }}>the same chain an auditor reads, a year later</span>
        {analysis.reportId && (
          <span style={{ marginLeft: "auto", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace",
            fontSize: "0.73rem", color: "var(--text2)" }}>{analysis.reportId}</span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", borderTop: "1px solid var(--border)" }}>
        {steps.map((s) => (
          <div key={s.k} style={{ flex: "1 1 175px", minWidth: 0, padding: "9px 12px",
            borderRight: "1px solid var(--border)", opacity: s.done ? 1 : .62 }}>
            <div style={{ fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>{s.k}</div>
            <div style={{ fontSize: "0.79rem", fontWeight: 700, marginTop: 2 }}>{s.v}</div>
            <div style={{ fontSize: "0.72rem", color: "var(--text2)", marginTop: 1, lineHeight: 1.4 }}>{s.d}</div>
          </div>
        ))}
      </div>
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
  // What changed on the TARGET is the staleness band's job, and it is stated
  // there in full. Repeating it here — under a heading about the source estate,
  // with no rows beneath it — is the kind of duplication that makes a reader
  // stop trusting both panels.
  if (!groups.length) return null;
  const headline = groups.map(([k, label]) => `${drift[k].length} ${label.toLowerCase()}`).join(" · ");

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "11px 13px", background: "var(--card)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Since the last assessment</span>
        <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>in the source estate — {headline}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text2)" }}>
          baseline {drift.sinceReportId} · {new Date(drift.since).toLocaleString()}
        </span>
      </div>
      {groups.map(([key, label, token, icon]) => (
        <div key={key} style={{ marginTop: 7 }}>
          <div style={{ fontSize: "0.76rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: `var(${token}-ink)` }}>
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


/* ── Applications ─────────────────────────────────────────────────────────────
   A migration is planned per application; MTV has no concept of one. What
   matters here is the difference between what vCenter DECLARES — a tag, an
   attribute, a resource pool — and what a heuristic infers. Affinity groups
   live further down and are labelled as inference. These are facts somebody
   typed on purpose, and machines that carry nothing are listed as ungroupable
   rather than swept into a bucket: grouping decides what moves together, so a
   confident wrong group splits a working system across two platforms. */
const APP_SOURCE = {
  cmdb: { label: "from the CMDB", token: "--st-good" },
  tag: { label: "vCenter tag", token: "--st-good" },
  attribute: { label: "custom attribute", token: "--st-good" },
  resourcePool: { label: "resource pool", token: "--st-warn" },
  folder: { label: "vCenter folder", token: "--st-warn" },
};

function ApplicationsPanel({ applications }) {
  const [open, setOpen] = useState(null);
  if (!applications) return null;
  const { groups, ungrouped, coverage, headline, warnings } = applications;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Grouped by application</span>
        <span style={{ fontSize: "0.78rem", color: "var(--text)" }}>{headline}</span>
      </div>

      {/* Whether we cannot SEE the tags, or there are none, are different
          answers and lead to completely different conversations. */}
      {coverage?.note && (
        <div style={{ fontSize: "0.76rem", color: "var(--text2)", border: "1px solid var(--border)", borderLeft: "3px solid var(--st-unknown)",
          borderRadius: 8, padding: "7px 10px", marginBottom: 9 }}>{coverage.note}</div>
      )}

      {warnings?.map((w) => (
        <div key={w.app} style={{ display: "flex", gap: 8, fontSize: "0.78rem", marginBottom: 6 }}>
          <span aria-hidden style={{ color: "var(--st-warn-ink)", fontWeight: 800 }}>⚠</span>
          <div><b>{w.app}</b> — {w.message}</div>
        </div>
      ))}

      {groups.map((g) => {
        const s = APP_SOURCE[g.source] || APP_SOURCE.folder;
        const isOpen = open === g.app;
        return (
          <div key={g.app} style={{ border: "1px solid var(--border)", borderRadius: 9, marginBottom: 6, overflow: "hidden" }}>
            <button onClick={() => setOpen(isOpen ? null : g.app)} style={{ width: "100%", textAlign: "left", background: "var(--bg2)",
              border: "none", font: "inherit", color: "inherit", cursor: "pointer", padding: "8px 11px",
              display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <span style={{ color: "var(--text2)" }}>{isOpen ? "▾" : "▸"}</span>
              <b style={{ fontSize: "0.82rem" }}>{g.app}</b>
              <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "1px 7px", borderRadius: 999,
                background: `var(${s.token}-bg)`, color: `var(${s.token}-ink)` }}>{s.label}</span>
              {g.strength === "weak" && (
                <span title="A resource pool or folder is declared, but it is often not an application"
                  style={{ fontSize: "0.7rem", color: "var(--st-warn-ink)", fontWeight: 700 }}>weak signal</span>
              )}
              <span style={{ fontSize: "0.77rem", color: "var(--text2)" }}>
                {g.count} machine{g.count === 1 ? "" : "s"} · {gib(g.diskGiB)} · {g.cpuCount} vCPU
                {g.owner ? ` · owner ${g.owner}` : ""}
              </span>
              {g.split && <span style={{ marginLeft: "auto", fontSize: "0.72rem", fontWeight: 800, color: "var(--st-warn-ink)" }}>⚠ this wave splits it</span>}
            </button>
            {isOpen && (
              <div style={{ padding: "8px 11px", fontSize: "0.77rem" }}>
                <div style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.75rem" }}>{g.members.join(", ")}</div>
                <div style={{ color: "var(--text2)", marginTop: 4 }}>{g.evidence.join(" · ")}</div>
              </div>
            )}
          </div>
        );
      })}

      {ungrouped?.length > 0 && (
        <div style={{ border: "1px dashed var(--border2, var(--border))", borderRadius: 9, padding: "8px 11px", marginTop: 6 }}>
          <div style={{ fontWeight: 800, fontSize: "0.8rem", color: "var(--st-unknown-ink)" }}>
            No application tag · {ungrouped.length} machine{ungrouped.length === 1 ? "" : "s"}
          </div>
          <div data-prose style={{ fontSize: "0.76rem", color: "var(--text2)", marginTop: 2 }}>
            These carry no tag, attribute, resource pool or folder to group them by, so they are listed individually rather than guessed
            into an application. <b>A wrong grouping is worse than none</b>, because it decides what moves together.
          </div>
          <div style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.74rem", marginTop: 4 }}>
            {ungrouped.map((u) => u.name).join(", ")}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Right-sizing ─────────────────────────────────────────────────────────────
   The blank column is the feature. This agent runs in the destination, so it
   has no history for a machine still on VMware; where nothing was measured,
   nothing is recommended and the panel says what would fix that. A saving
   computed over the 40% of an estate that happened to have monitoring, and
   presented as the estate's saving, is the fastest way to lose the room. */
const RS_STYLE = {
  oversized: { token: "--st-warn", icon: "⚠", label: "Oversized" },
  undersized: { token: "--st-crit", icon: "✖", label: "Runs at its limit" },
  correct: { token: "--st-good", icon: "✓", label: "Right-sized" },
  pinned: { token: "--st-unknown", icon: "◆", label: "Pinned on purpose" },
  unmeasured: { token: "--st-unknown", icon: "?", label: "Not measured" },
};

function RightSizingPanel({ rightsizing }) {
  const [showAll, setShowAll] = useState(false);
  if (!rightsizing) return null;
  const { rows, counts, saving, coverage, headline, caveat, source, basis, sourceReason } = rightsizing;
  // Findings first: undersized machines matter more than savings do.
  const order = { undersized: 0, oversized: 1, pinned: 2, correct: 3, unmeasured: 4 };
  const sorted = rows.slice().sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name));
  const shown = showAll ? sorted : sorted.slice(0, 8);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Size, measured rather than assumed</span>
        <span style={{ fontSize: "0.78rem", color: "var(--text)" }}>{headline}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--text2)" }}>
          {source === "none" ? "no source metrics connected" : source === "supplied" ? "from your own monitoring" : `from ${source}`}
        </span>
      </div>
      {basis && <div style={{ fontSize: "0.74rem", color: "var(--text2)", marginBottom: 6 }}>{basis}</div>}

      {/* What would make this panel work, stated where the blank appears. */}
      {source === "none" && sourceReason && (
        <div data-prose style={{ fontSize: "0.77rem", color: "var(--text2)", border: "1px solid var(--border)",
          borderLeft: "3px solid var(--st-unknown)", borderRadius: 8, padding: "8px 11px", marginBottom: 9 }}>
          {sourceReason}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(118px,1fr))", gap: 8, marginBottom: 9 }}>
        {["undersized", "oversized", "correct", "pinned", "unmeasured"].map((k) => {
          const st = RS_STYLE[k];
          return (
            <div key={k} style={{ border: "1px solid var(--border)", borderRadius: 9, padding: "8px 10px" }}>
              <div style={{ fontSize: "1.25rem", fontWeight: 800, color: counts[k] ? `var(${st.token}-ink)` : "var(--text2)" }}>{counts[k]}</div>
              <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text2)" }}>{st.icon} {st.label}</div>
            </div>
          );
        })}
      </div>

      {saving && (
        <div style={{ border: "1px solid var(--st-good)", background: "var(--st-good-bg)", borderRadius: 9, padding: "9px 11px", marginBottom: 9 }}>
          <div style={{ fontSize: "0.82rem", fontWeight: 800 }}>
            {saving.vcpuBefore} → {saving.vcpuAfter} vCPU
            <span style={{ color: "var(--st-good-ink)" }}> ({saving.pctVcpu}% less)</span>
            {" · "}{saving.memGiBBefore} → {saving.memGiBAfter} GiB
          </div>
          <div data-prose style={{ fontSize: "0.75rem", color: "var(--text2)", marginTop: 2 }}>
            Across the {counts.oversized} machine{counts.oversized === 1 ? "" : "s"} that are measurably oversized. On KubeVirt this is
            not only cost: a VM is a pod that must fit on one node, so the unused size is a placement constraint too.
          </div>
        </div>
      )}
      {caveat && <div style={{ fontSize: "0.76rem", color: "var(--st-warn-ink)", marginBottom: 8 }}>⚠ {caveat}</div>}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem" }}>
        <thead>
          <tr>
            {["Machine", "Today", "p95 observed", "Recommended", "Why"].map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "5px 8px", fontWeight: 800, fontSize: "0.7rem",
                textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)", borderBottom: "1px solid var(--border)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const st = RS_STYLE[r.verdict];
            return (
              <tr key={r.name} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "5px 8px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace" }}>{r.name}</td>
                <td style={{ padding: "5px 8px", whiteSpace: "nowrap",
                  textDecoration: r.recommended ? "line-through" : "none", color: r.recommended ? "var(--text2)" : "var(--text)" }}>
                  {r.current.cpuCount ?? "—"} vCPU / {r.current.memoryGiB ?? "—"} GiB
                </td>
                {/* A blank, not a zero. Nothing was measured here. */}
                <td style={{ padding: "5px 8px", whiteSpace: "nowrap", color: "var(--text2)" }}>
                  {r.p95 ? `${r.p95.cpuCores} vCPU / ${r.p95.memoryGiB} GiB` : "—"}
                </td>
                <td style={{ padding: "5px 8px", whiteSpace: "nowrap", fontWeight: r.recommended ? 800 : 400,
                  color: r.recommended ? `var(${st.token}-ink)` : "var(--text2)" }}>
                  {r.recommended
                    ? `${r.recommended.cpuCount} vCPU / ${r.recommended.memoryGiB} GiB`
                    : r.wouldBe ? `(${r.wouldBe.cpuCount} vCPU / ${r.wouldBe.memoryGiB} GiB, not applied)` : "—"}
                </td>
                <td style={{ padding: "5px 8px", color: "var(--text2)" }}>
                  <span style={{ color: `var(${st.token}-ink)`, fontWeight: 700 }}>{st.icon}</span> {r.reason}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > shown.length && (
        <button onClick={() => setShowAll(true)} style={{ background: "none", border: "none", padding: "6px 8px", font: "inherit",
          fontSize: "0.75rem", fontWeight: 700, color: "var(--text2)", cursor: "pointer" }}>
          {sorted.length - shown.length} more · show all
        </button>
      )}
      <div data-prose style={{ fontSize: "0.74rem", color: "var(--text2)", borderTop: "1px solid var(--border)", paddingTop: 7, marginTop: 6 }}>
        Sized from the 95th percentile with 25% headroom, never below 1 vCPU / 1 GiB, and never for a machine whose CPU, NUMA or memory was
        deliberately pinned or reserved — a percentile does not outrank somebody's decision. Changes smaller than 2 vCPU or 4 GiB are not
        offered at all: they cost a change request and a reboot and free nothing worth having. On OpenShift Virtualization a VM is a pod that
        must fit on one node, so an oversized machine is a placement constraint as much as a cost. Coverage: {coverage.measured} of {coverage.total} machines.
      </div>
    </div>
  );
}

/* ── Cost ─────────────────────────────────────────────────────────────────────
   The countable half always renders; the money needs a rate card. No API
   anywhere reports what a customer pays for vSphere — vCenter does not know —
   so with no rates there is no figure, and an unpriced line is absent rather
   than zero. */
function TcoPanel({ tco }) {
  const [open, setOpen] = useState(false);
  if (!tco) return null;
  const side = (title, rows, annual, annualLabel) => (
    <div style={{ flex: "1 1 260px", minWidth: 0, padding: "10px 12px" }}>
      <div style={{ fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)", marginBottom: 5 }}>{title}</div>
      {rows.map((r) => (
        <div key={r.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", fontSize: "0.79rem" }}>
          <span style={{ color: "var(--text2)" }}>{r.k}</span>
          {r.v != null
            ? <b style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{r.v}</b>
            : <span title={r.why || ""} style={{ color: "var(--text2)" }}>—</span>}
        </div>
      ))}
      {annual != null && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--border)",
          marginTop: 5, paddingTop: 5, fontSize: "0.84rem", fontWeight: 800 }}>
          <span>Annual</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{annualLabel ?? annual.toLocaleString()}</span>
        </div>
      )}
      {rows.filter((r) => r.v == null && r.why).map((r) => (
        <div key={`${r.k}-why`} style={{ fontSize: "0.72rem", color: "var(--text2)", marginTop: 3 }}>{r.why}</div>
      ))}
    </div>
  );

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "11px 13px 6px" }}>
        <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>What this wave costs, before and after</span>
        <span style={{ fontSize: "0.78rem", color: "var(--text)" }}>{tco.headline}</span>
        {tco.basis?.source === "list-price" && (
          <span style={{ fontSize: "0.7rem", fontWeight: 800, padding: "1px 7px", borderRadius: 999,
            background: "var(--st-warn-bg)", color: "var(--st-warn-ink)" }}>list price</span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", borderTop: "1px solid var(--border)" }}>
        {side("On VMware today", tco.source.rows, tco.source.annual, tco.source.annualLabel)}
        <div style={{ width: 1, background: "var(--border)" }} />
        {side("On OpenShift Virtualization", tco.target.rows, tco.target.annual, tco.target.annualLabel)}
      </div>
      {tco.saving != null && (
        <div style={{ padding: "9px 13px", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: "1.15rem", fontWeight: 800, color: tco.saving > 0 ? "var(--st-good-ink)" : "var(--st-crit-ink)" }}>
            {tco.savingLabel}
          </span>
          <span style={{ fontSize: "0.77rem", color: "var(--text2)", marginLeft: 8 }}>
            {tco.savingDirection}{tco.saving < 0 ? " — the panel reports it either way" : ""}
          </span>
          {tco.basis?.lines?.length > 0 && (
            <button onClick={() => setOpen((v) => !v)} style={{ background: "none", border: "none", font: "inherit",
              fontSize: "0.75rem", fontWeight: 700, color: "var(--text2)", cursor: "pointer", marginLeft: 8 }}>
              show the arithmetic ▾
            </button>
          )}
          {open && (
            <div style={{ marginTop: 5, padding: "7px 9px", borderRadius: 7, background: "var(--bg2)", border: "1px solid var(--border)" }}>
              {tco.basis.lines.map((l) => (
                <div key={l} style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem" }}>{l}</div>
              ))}
              {tco.basis.asOf && <div style={{ fontSize: "0.72rem", color: "var(--text2)", marginTop: 3 }}>Rates as of {tco.basis.asOf}.</div>}
            </div>
          )}
        </div>
      )}
      <ul data-prose style={{ margin: 0, padding: "0 13px 11px 30px", fontSize: "0.74rem", color: "var(--text2)" }}>
        {(tco.notes || []).map((n, i) => <li key={i} style={{ marginTop: 2 }}>{n}</li>)}
        {tco.basis?.reason && <li style={{ marginTop: 2 }}>{tco.basis.reason}</li>}
      </ul>
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
            <div style={{ fontSize: "0.75rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>{m.k}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
              <span style={{ fontSize: "1.15rem", fontWeight: 800 }}>{m.assigned}</span>
              <span style={{ color: "var(--text2)" }}>→</span>
              <span style={{ fontSize: "1.15rem", fontWeight: 800, color: m.warn ? "var(--st-warn)" : "var(--st-good)" }}>{m.requested}</span>
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text2)", marginTop: 2 }}>{m.note}</div>
          </div>
        ))}
        <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: "9px 11px" }}>
          <div style={{ fontSize: "0.75rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>
            Quality of service
          </div>
          {Object.entries(QOS).map(([k, q]) => (byClass[k] ? (
            <div key={k} style={{ fontSize: "0.75rem", marginTop: 2 }}>
              <span style={{ color: `var(${q.token}-ink)`, fontWeight: 800 }}>{q.icon}</span>{" "}
              <b>{byClass[k]}</b> <span style={{ color: "var(--text2)" }}>{q.label}</span>
            </div>
          ) : null))}
        </div>
      </div>

      {losing.length > 0 && (
        <div style={{ marginTop: 9, fontSize: "0.77rem" }}>
          <b style={{ color: "var(--st-warn-ink)" }}>⚠ {losing.length} VM{losing.length === 1 ? "" : "s"} lose a guarantee they have today:</b>
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
      {note && <div style={{ fontSize: "0.76rem", color: "var(--text2)", marginTop: 8 }}>{note}</div>}
      <div data-prose style={{ fontSize: "0.75rem", color: "var(--text2)", marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 7 }}>
        Every migrated VM lands as a <b>Burstable</b> pod: scheduled on its request, evictable under node pressure.
        The guest still sees the CPU count it always had — only the scheduler's view of it changes.
      </div>
    </div>
  );
}

export default function FleetAnalysis({
  analysis, suggestions = [], suggestionSource, note, busy,
  advice = [], adviceSource, adviceNote, onBack, onProceed, onExport, onRecheck,
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
  const wontLand = analysis.capacity?.placement?.available ? analysis.capacity.placement.unplacedCount : 0;

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
            // Cost is its own cell rather than a suffix on the usage line: it
            // is the number someone will question, so it needs room for the
            // word "est." and a way to see the arithmetic.
            ...(analysis.ai?.costUsd != null ? [["Estimated AI cost", <CostCell key="c" ai={analysis.ai} />]] : []),
            // What the model cost, next to everything else about provenance.
            // Calls, tokens and cost are three different numbers and the first
            // was being read as the other two. They are labelled, in that order.
            ["AI usage", analysis.ai
              ? (analysis.ai.consulted
                  ? `${analysis.ai.calls} call${analysis.ai.calls === 1 ? "" : "s"} · ${analysis.ai.model || "model"}`
                    + (analysis.ai.totalTokens != null
                        // "at least" when only some calls reported usage: the
                        // sum is a floor, and a cost figure that rounds up
                        // partial data quietly is not one worth quoting.
                        ? ` · ${analysis.ai.tokensPartial ? "at least " : ""}${analysis.ai.totalTokens.toLocaleString()} tokens`
                        : " · tokens not reported by the provider")
                    + (analysis.ai.corrections ? ` · ${analysis.ai.corrections} corrected` : "")
                  : "no model consulted — rules only")
              : "—"],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: "0.72rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>{k}</div>
              <div style={{ fontSize: "0.79rem" }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: "0.79rem", color: "var(--text2)", marginTop: 9, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          {total} VM{total === 1 ? "" : "s"} · {totalCpu} vCPU · {gib(totalMemoryGiB)} RAM ·
          {" "}{gib(totalDiskGiB)} to move · {poweredOn} running · {warmEligible} can migrate warm
        </div>
        {/* Why the call count is small enough to look broken. It is the
            headline claim of this whole design, and leaving it unexplained
            invites someone to read two calls as a failure rather than as the
            point. */}
        {analysis.ai?.consulted && (
          <div data-prose style={{ fontSize: "0.75rem", color: "var(--text2)", marginTop: 5 }}>
            {analysis.ai.calls} call{analysis.ai.calls === 1 ? "" : "s"} covers all {total} machine{total === 1 ? "" : "s"}:
            the supportability verdict, every readiness check, the capacity check and the transfer estimate are computed
            from rules, and the model is asked only to recommend a migration method for the fleet in one pass.
            {analysis.ai.corrections ? ` ${analysis.ai.corrections} of its recommendations were overruled by policy before you saw them.` : ""}
          </div>
        )}
      </div>

      {/* ── How old this answer is, and what moved under it ──────────────── */}
      <StalenessBand analysis={analysis} onRecheck={onRecheck} busy={busy} />

      {/* ── Will it land? Blockers first, then where everything goes ─────── */}
      <LandingPanel capacity={analysis.capacity} />

      {/* ── And if a node is lost while it runs ──────────────────────────── */}
      <RehearsalPanel rehearsal={analysis.capacity?.rehearsal} />

      {/* ── Which machines are one system, as the source declares it ─────── */}
      <ApplicationsPanel applications={analysis.applications} />

      {/* ── What they actually use, where that could be measured ─────────── */}
      <RightSizingPanel rightsizing={analysis.rightsizing} />

      {/* ── And what the whole thing costs ───────────────────────────────── */}
      <TcoPanel tco={analysis.tco} />

      {/* ── The chain from evidence to sign-off ──────────────────────────── */}
      <EvidenceChain analysis={analysis} />

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
          <div style={{ fontSize: "0.76rem", color: "var(--text2)" }}>
            {hover
              ? `${hover.n} ${hover.level.label.toLowerCase()} — ${hover.level.blurb}`
              : "Readiness of each OS family, with the compute and storage it carries"}
          </div>
          <div style={{ marginLeft: "auto" }}><Legend /></div>
        </div>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start", justifyContent: "flex-start" }}>
          {/* The estate first, then each family. Same fixed level order in
              every ring, so a colour means the same thing everywhere. */}
          <FamilyRing
            hero label="All VMs" counts={byLevel || {}}
            metrics={[`${totalCpu} vCPU`, `${gib(totalMemoryGiB)} RAM`, `${gib(totalDiskGiB)} storage`]}
            onHover={setHover}
          />
          <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)" }} />
          {families.map((f) => (
            <FamilyRing
              key={f.family}
              label={FAMILY_LABEL[f.family] || f.family}
              counts={levelCounts(f)}
              metrics={[`${f.cpu || 0} vCPU`, `${gib(f.memoryGiB || 0)} RAM`, `${gib(f.diskGiB || 0)} storage`]}
              onHover={setHover}
            />
          ))}
        </div>
      </div>

      {/* ── Distribution and version detail ──────────────────────────────── */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: "0.84rem" }}>Support by distribution and version</div>
          <div style={{ fontSize: "0.76rem", color: "var(--text2)" }}>Checked against Red Hat's certified guest list for OpenShift Virtualization</div>
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
                    <span style={{ fontSize: "0.77rem", color: "var(--text2)", whiteSpace: "nowrap" }}>
                      {d.total} VM{d.total === 1 ? "" : "s"}
                      {present.length > 1 && present.map((l) => (
                        <span key={l.key} style={{ marginLeft: 6, color: `var(${l.token}-ink)`, fontWeight: 700 }}>
                          {l.icon}{d[l.key]}
                        </span>
                      ))}
                      {/* Red Hat publishes three tiers. "Supported" and
                          "supported by SUSE" are different promises, and the
                          difference only shows up in a support call. */}
                      <span style={{ marginLeft: 9 }} title={d.note || "Verdict from Red Hat's certified guest list"}>
                        <b style={{ color: `var(${LV[d.level]?.token || "--st-unknown"}-ink)` }}>
                          {LV[d.level]?.icon} {d.tierLabel || d.level}
                        </b>
                      </span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        <div data-prose style={{ fontSize: "0.75rem", color: "var(--text2)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          Levels combine Red Hat's certified guest list{matrix?.asOf ? ` (read ${matrix.asOf})` : ""} with MTV's own validation of each VM.
          {" "}Red Hat publishes three tiers: <b style={{ color: "var(--st-good-ink)" }}>certified</b> (Red Hat supports you on it),
          {" "}<b style={{ color: "var(--st-warn-ink)" }}>vendor supported</b> (Oracle, SUSE or Canonical does), and
          {" "}<b style={{ color: "var(--st-crit-ink)" }}>known to run</b> (it boots; nobody certifies it).
          {matrix?.url && (
            <> <a href={matrix.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text2)" }}>
              Check the current list for your OpenShift version →
            </a></>
          )}
        </div>
      </div>

      {/* ── Per-VM detail: what is wrong and what to change ──────────────
          The fleet findings above say how big each problem is. This says what
          the engineer holding a ticket for ONE machine has to do about it. */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "11px 13px 8px" }}>
          <span style={{ fontWeight: 800, fontSize: "0.84rem" }}>Every VM, and what it needs</span>
          <span data-prose style={{ fontSize: "0.75rem", color: "var(--text2)" }}>
            Click a row to see every action for that machine
          </span>
          <span style={{
            marginLeft: "auto", fontSize: "0.72rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700,
            background: adviceSource === "ai" ? "rgba(124,58,237,.16)" : "var(--st-unknown-bg)",
            color: adviceSource === "ai" ? "#a78bfa" : "var(--st-unknown)",
          }}>{adviceSource === "ai" ? "method advised by AI" : "method from rules"}</span>
        </div>
        {adviceNote && <div style={{ fontSize: "0.77rem", color: "var(--st-warn-ink)", padding: "0 13px 6px" }}>{adviceNote}</div>}

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
                    <span style={{ marginLeft: 8, fontSize: "0.77rem", color: "var(--text2)" }}>
                      {famRows.length} VM{famRows.length === 1 ? "" : "s"} · {gib(diskGiB)}
                      {famRows.some((x) => x.blockers.length) && (
                        <span style={{ marginLeft: 8, color: "var(--st-crit-ink)", fontWeight: 700 }}>
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
                    <td style={{ padding: "6px 9px", whiteSpace: "nowrap", color: `var(${l.token}-ink)`, fontWeight: 700 }}>{l.icon} {l.label}</td>
                    <td style={{ padding: "6px 9px", color: "var(--text2)" }} title={r.os?.reported || ""}>
                      <div style={{ color: "var(--text)" }}>{r.os?.distro || "—"}</div>
                      {/* Coloured by the OS's own level, not the row's. A
                          certified guest blocked by a shared disk is still a
                          certified guest — the two say different things. */}
                      {r.os?.tierLabel && (
                        <div style={{ fontSize: "0.73rem", color: `var(${LV[r.os.level]?.token || "--st-unknown"}-ink)` }}>
                          {r.os.tierLabel}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "6px 9px", fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.76rem" }}>
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
                          {p && <span style={{ marginLeft: 6, fontWeight: 600, color: `var(${p.token}-ink)` }}>{p.icon} {p.label}</span>}
                        </>
                      )}
                    </td>
                    {/* The finding itself is the point of the row, so it wears
                        primary ink; only the "+n more" tail is secondary. */}
                    <td style={{ padding: "6px 9px", color: "var(--text)", maxWidth: 300 }}>
                      <span style={{ color: `var(${SEV_TOKEN[worst?.severity] || "--st-unknown"}-ink)`, fontWeight: 700 }}>
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
                            <span aria-hidden style={{ color: `var(${SEV_TOKEN[x.severity] || "--st-unknown"}-ink)`, fontWeight: 800 }}>
                              {SEV_ICON[x.severity] || "•"}
                            </span>
                            <div>
                              <div style={{ fontWeight: 700 }}>
                                {x.title}
                                {x.required && <span style={{ marginLeft: 6, fontSize: "0.71rem", fontWeight: 800, color: "var(--st-warn-ink)" }}>REQUIRED</span>}
                              </div>
                              {x.detail && <div style={{ color: "var(--text2)" }}>{x.detail}</div>}
                              <div>→ {x.action}</div>
                            </div>
                          </div>
                        ))}
                        {/* Snapshots, reviewed and answered. Two questions get
                            asked here and they are different: what is already
                            there, and whether to add one. The second answer is
                            almost always "no", and the reason matters more
                            than the answer — a snapshot taken to be careful is
                            what makes a warm migration impossible. */}
                        {r.snapshotPolicy && (
                          <div style={{ marginTop: 6, paddingTop: 5, borderTop: "1px solid var(--border)", fontSize: "0.76rem" }}>
                            <b>Snapshots · </b>
                            {r.snapshot ? (
                              <span>
                                {r.snapshot.count} on the source
                                {r.snapshot.items.map((sn) => (
                                  <span key={sn.id || sn.name} style={{ color: "var(--text2)" }}>
                                    {" · "}{sn.name || sn.id}
                                    {sn.createdAt ? ` (taken ${new Date(sn.createdAt).toLocaleString()})` : ""}
                                    {sn.sizeGiB ? `, ${sn.sizeGiB} GiB` : ""}
                                  </span>
                                ))}
                              </span>
                            ) : <span style={{ color: "var(--text2)" }}>none reported on the source</span>}
                            <div style={{ marginTop: 2, fontWeight: 700,
                              color: r.snapshotPolicy.recommend === "remove" ? "var(--st-warn-ink)" : "var(--st-good-ink)" }}>
                              {r.snapshotPolicy.headline}
                            </div>
                            <div style={{ color: "var(--text2)" }}>{r.snapshotPolicy.why}</div>
                            <div>→ {r.snapshotPolicy.then}</div>
                            {/* The agent reads the source platform; it cannot
                                write to it. So it hands over the command
                                rather than a button that would fail. */}
                            <div data-prose style={{ marginTop: 3, color: "var(--text2)" }}>
                              This agent has read-only access to vCenter and cannot take or delete a snapshot. To review them there:{" "}
                              <code style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem",
                                background: "var(--bg2)", padding: "1px 5px", borderRadius: 4 }}>
                                {r.snapshotPolicy.commands.review}
                              </code>
                            </div>
                            {r.snapshot && (
                              <div data-prose style={{ marginTop: 2, color: "var(--text2)" }}>
                                To remove:{" "}
                                <code style={{ fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace", fontSize: "0.72rem",
                                  background: "var(--bg2)", padding: "1px 5px", borderRadius: 4 }}>
                                  {r.snapshotPolicy.commands.remove}
                                </code>
                              </div>
                            )}
                          </div>
                        )}

                        {/* How much of the assessment was actually possible.
                            A check the inventory could not answer is never
                            presented as a check that passed. */}
                        {r.checks?.coverage && (
                          <div style={{ marginTop: 6, paddingTop: 5, borderTop: "1px solid var(--border)", fontSize: "0.76rem", color: "var(--text2)" }}
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
            fontSize: "0.72rem", padding: "2px 8px", borderRadius: 999, fontWeight: 700,
            background: suggestionSource === "ai" ? "rgba(124,58,237,.16)" : "var(--st-unknown-bg)",
            color: suggestionSource === "ai" ? "#a78bfa" : "var(--st-unknown)",
          }}>{suggestionSource === "ai" ? "AI + rules" : "rule-based"}</span>
        </div>
        {note && <div style={{ fontSize: "0.77rem", color: "var(--st-warn-ink)", marginBottom: 5 }}>{note}</div>}
        {suggestions.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 9, padding: "7px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
            <span aria-hidden style={{ color: `var(${SEV_TOKEN[s.severity] || "--st-unknown"}-ink)`, fontWeight: 800, fontSize: "0.9rem", lineHeight: 1.3 }}>
              {SEV_ICON[s.severity] || "•"}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: "0.81rem" }}>
                {s.title}
                {s.ai && <span style={{ marginLeft: 6, fontSize: "0.7rem", color: "#a78bfa", fontWeight: 700 }}>AI</span>}
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
        {/* Guest support and landing are different gates, and a machine that
            clears the first still does not move if it cannot be placed. Quoting
            only the first here read as "21 of 21 can go" beside a panel saying
            one of them will never schedule. */}
        <span style={{ fontSize: "0.74rem", color: "var(--text2)" }}>
          {ready} of {total} are supported{blocked ? `; ${blocked} need work first` : ""}.
          {wontLand > 0 && (
            <b style={{ color: "var(--st-crit-ink)" }}>
              {" "}{wontLand} of them will not land on this cluster as it stands.
            </b>
          )}
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
