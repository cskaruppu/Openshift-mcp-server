/* ── One migration, as a record rather than a log line ────────────────────────
   A migration is not an event that happened; it is a case that stays open.
   Somebody raised it, a board is sitting on it, a window is booked for next
   Tuesday, and the person who comes back to it on Monday is usually not the
   person who started it.

   The old row was a single line of facts — strategy, VM count, tokens, cost —
   which answers "what was this" and none of "where is it, who has it, what
   happens next, can I pick it up". Those four are the whole reason anybody
   opens a history.

   So the record leads with STATE and the PENDING ACTION, puts the evidence
   (change request, window, timings) where an auditor looks, and offers resume
   only when there is genuinely something to resume. Cost and tokens drop to
   the bottom line: true, worth keeping, and not what anyone came for. */

const S = {
  card: { border: "1px solid var(--border,#e4e8f1)", borderRadius: 11, background: "var(--card-bg,#fff)", overflow: "hidden" },
  row: { display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", padding: "10px 13px" },
  mono: { fontFamily: "'SF Mono','Fira Code',ui-monospace,monospace" },
  label: { fontSize: "0.68rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: ".055em", color: "var(--text2)" },
  meta: { fontSize: "0.76rem", color: "var(--text2)" },
};

/**
 * The state vocabulary. Deliberately small and in the order a migration moves
 * through, so the pill means the same thing everywhere it appears.
 *
 * Colour never carries the state alone — every pill has a word, and the words
 * are the ones a change manager already uses.
 */
export const STATE = {
  "awaiting-approval": { label: "Awaiting approval", tone: "--st-warn", mark: "◷" },
  scheduled: { label: "Scheduled", tone: "--st-unknown", mark: "▤" },
  ready: { label: "Ready to start", tone: "--st-good", mark: "▶" },
  validating: { label: "Validating", tone: "--st-unknown", mark: "◌" },
  transferring: { label: "Transferring", tone: "--st-good", mark: "⇢" },
  "awaiting-cutover": { label: "Awaiting cutover", tone: "--st-warn", mark: "◷" },
  migrated: { label: "Migrated", tone: "--st-good", mark: "✓" },
  "rolled-back": { label: "Rolled back", tone: "--st-crit", mark: "↩" },
  failed: { label: "Failed", tone: "--st-crit", mark: "✕" },
  unknown: { label: "Unknown", tone: "--st-unknown", mark: "?" },
};

/** Who is holding it, in the words a status meeting uses. */
const OWNER = {
  you: "with you",
  "change board": "with the change board",
  "VMware team": "with the VMware team",
  nobody: "running",
};

const fmt = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined,
    { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** "in 6 days" / "3 hours ago" — the reading a person actually wants. */
function relative(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.round((then - Date.now()) / 60000);
  const ahead = mins >= 0;
  const n = Math.abs(mins);
  const say = n < 60 ? `${n} minute${n === 1 ? "" : "s"}`
    : n < 60 * 36 ? `${Math.round(n / 60)} hour${Math.round(n / 60) === 1 ? "" : "s"}`
    : `${Math.round(n / 1440)} day${Math.round(n / 1440) === 1 ? "" : "s"}`;
  return ahead ? `in ${say}` : `${say} ago`;
}

function Pill({ state }) {
  const s = STATE[state] || STATE.unknown;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.71rem", fontWeight: 800,
      padding: "2px 9px", borderRadius: 999, whiteSpace: "nowrap",
      background: `var(${s.tone}-bg)`, color: `var(${s.tone}-ink)` }}>
      <span aria-hidden>{s.mark}</span>{s.label}
    </span>
  );
}

/**
 * @param {object} rec   a live plan or an archived run, already normalised
 * @param {func}   onResume  called with the record when there is work to pick up
 */
export default function MigrationRecord({ rec, onResume, onDismiss }) {
  const pending = rec.pending || null;
  const state = rec.state || "unknown";
  const cr = rec.changeRequest || pending?.waitingOn || null;
  const scheduled = rec.scheduledAt || rec.window?.start || null;
  const done = pending?.done === true || ["migrated", "rolled-back", "failed"].includes(state);

  return (
    <div style={S.card}>
      {/* Line 1 — what it is and where it is. */}
      <div style={{ ...S.row, paddingBottom: 6 }}>
        <Pill state={state} />
        <b style={{ ...S.mono, fontSize: "0.82rem" }}>{rec.planName}</b>
        <span style={S.meta}>
          {rec.strategy}{rec.osFamily ? ` · ${rec.osFamily}` : ""} · {rec.vmCount} VM{rec.vmCount === 1 ? "" : "s"}
          {rec.totalGiB ? ` · ${rec.totalGiB} GiB` : ""}
        </span>
        {rec.vmNames?.length > 0 && (
          <span style={{ ...S.meta, ...S.mono, fontSize: "0.73rem" }}>
            {rec.vmNames.slice(0, 2).join(", ")}{rec.vmNames.length > 2 ? ` +${rec.vmNames.length - 2}` : ""}
          </span>
        )}
        <span style={{ marginLeft: "auto", ...S.meta, fontSize: "0.73rem" }}>
          {fmt(rec.finishedAt || rec.startedAt || rec.createdAt) || ""}
        </span>
      </div>

      {/* Line 2 — the one that makes this a record rather than a log.
          WHO has it and WHAT they are waiting for, in a band you cannot miss. */}
      {pending && (
        <div style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "8px 13px",
          borderTop: "1px solid var(--border,#e4e8f1)",
          background: done ? "transparent" : "var(--st-warn-bg)" }}>
          <span aria-hidden style={{ fontWeight: 800, color: done ? "var(--text2)" : "var(--st-warn-ink)" }}>
            {done ? "—" : "▸"}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "0.79rem", fontWeight: 700 }}>
              {done ? "Nothing pending" : `Next step — ${OWNER[pending.owner] || pending.owner}`}
            </div>
            <div style={{ fontSize: "0.77rem", color: "var(--text2)", marginTop: 1 }}>{pending.action}</div>
          </div>
          {/* Resume is offered only when the next move is actually the
              operator's. Offering it while a board holds the change would be
              a button that cannot do anything, which is worse than no button. */}
          {!done && pending.owner === "you" && onResume && (
            <button onClick={() => onResume(rec)} style={{ flex: "none", padding: "5px 13px", borderRadius: 8,
              border: "none", background: "#3d5afe", color: "#fff", fontSize: "0.77rem", fontWeight: 700,
              fontFamily: "inherit", cursor: "pointer" }}>
              Resume →
            </button>
          )}
        </div>
      )}

      {/* Line 3 — the evidence. What an auditor opens this for, and what the
          person coming back on Monday needs: the change record, the window it
          is booked into, and what was promised against what happened. */}
      {(cr || scheduled || rec.estimatedMinutes != null || rec.verification?.verdict) && (
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", padding: "8px 13px",
          borderTop: "1px solid var(--border,#e4e8f1)" }}>
          {cr && (
            <div>
              <div style={S.label}>Change request</div>
              <div style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                {rec.changeRequestUrl
                  ? <a href={rec.changeRequestUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{cr}</a>
                  : cr}
                {rec.changeState && <span style={{ fontWeight: 400, color: "var(--text2)" }}> · {rec.changeState}</span>}
              </div>
            </div>
          )}
          {scheduled && (
            <div>
              <div style={S.label}>Window</div>
              <div style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                {fmt(scheduled)}
                {/* The relative reading is the one that answers "is this this
                    week or next". An absolute timestamp alone makes everyone
                    do that arithmetic in their head. */}
                <span style={{ fontWeight: 400, color: "var(--text2)" }}> · {relative(scheduled)}</span>
              </div>
            </div>
          )}
          {(rec.actualMinutes != null || rec.estimatedMinutes != null) && (
            <div>
              <div style={S.label}>Transfer</div>
              <div style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                {rec.actualMinutes != null ? `${rec.actualMinutes} min` : `~${rec.estimatedMinutes} min`}
                {rec.actualMinutes != null && rec.estimatedMinutes != null && (
                  <span style={{ fontWeight: 400, color: "var(--text2)" }}> · estimated {rec.estimatedMinutes}</span>
                )}
              </div>
            </div>
          )}
          {rec.verification?.verdict && (
            <div>
              <div style={S.label}>Verification</div>
              <div style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                {rec.verification.verdict.replace(/-/g, " ")}
                {rec.verification.ran != null && rec.verification.total != null && (
                  <span style={{ fontWeight: 400, color: "var(--text2)" }}> · {rec.verification.ran} of {rec.verification.total} checks</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Line 4 — true, worth keeping, and not what anyone came for. */}
      {(rec.ai?.consulted || rec.unitCost || onDismiss) && (
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", padding: "6px 13px 8px",
          borderTop: "1px solid var(--border,#e4e8f1)", fontSize: "0.74rem", color: "var(--text2)" }}>
          {rec.ai?.consulted && (
            <span>
              AI {rec.ai.calls} call{rec.ai.calls === 1 ? "" : "s"}
              {rec.ai.totalTokens != null ? ` · ${rec.ai.tokensPartial ? "≥" : ""}${rec.ai.totalTokens.toLocaleString()} tokens` : ""}
              {rec.ai.costUsd != null ? ` · $${rec.ai.costUsd < 0.01 ? rec.ai.costUsd.toFixed(4) : rec.ai.costUsd.toFixed(2)}` : ""}
            </span>
          )}
          {rec.unitCost && (
            <span title={(rec.unitCost.tokensPerVm != null ? `${rec.unitCost.tokensPerVm.toLocaleString()} tokens per machine` : "")
              + (rec.unitCost.partial ? " · token count is partial, so this is a floor" : "")}>
              {rec.unitCost.partial ? "≥" : ""}{rec.unitCost.perVm} per VM
            </span>
          )}
          {onDismiss && (
            <button onClick={() => onDismiss(rec)}
              title={rec.dismissedAt
                ? `Dismissed ${fmt(rec.dismissedAt)}. Put it back in the list.`
                : "Hide this from the list. It stays in the history store and in ServiceNow — nothing is deleted."}
              style={{ marginLeft: "auto", padding: "2px 9px", borderRadius: 7, cursor: "pointer",
                border: "1px solid var(--border,#e4e8f1)", background: "transparent",
                color: "var(--text2)", fontSize: "0.72rem", fontWeight: 700, fontFamily: "inherit" }}>
              {rec.dismissedAt ? "Restore" : "Dismiss"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
