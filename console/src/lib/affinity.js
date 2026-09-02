// ---------------------------------------------------------------------------
// Move-together groups — the browser half
// ---------------------------------------------------------------------------
/**
 * The grouping itself runs server-side (src/services/affinity.js) and arrives
 * on the analysis. This is the part that cannot: which groups the CURRENT
 * selection cuts in half, recomputed on every tick without a round trip.
 *
 * It lives in the console tree rather than being imported across from the
 * server, because the two container images have disjoint build contexts — the
 * console image copies only console/. An import across that line resolves on a
 * developer's disk and fails in the image.
 *
 * Pure, and tested by test/unit/affinity.test.js.
 */

/**
 * Which groups the current selection cuts in half. Pure.
 *
 * This is the only output that matters at the moment of choosing: not "here are
 * some groups", but "you are about to leave two machines behind".
 *
 * @param {Array} groups     from affinityGroups()
 * @param {Set|Array} chosen names selected for this wave
 */
export function splitGroups(groups = [], chosen = []) {
  const picked = chosen instanceof Set ? chosen : new Set(chosen);
  const out = [];
  for (const g of groups) {
    const inWave = g.members.filter((n) => picked.has(n));
    const leftBehind = g.members.filter((n) => !picked.has(n));
    if (!inWave.length || !leftBehind.length) continue;       // all in, or all out
    out.push({
      ...g, inWave, leftBehind,
      message: `${inWave.length} of ${g.size} selected — ${leftBehind.join(", ")} would stay on VMware.`,
      because: g.evidence.map((e) => e.text).join("; "),
    });
  }
  return out.sort((a, b) => b.leftBehind.length - a.leftBehind.length);
}
