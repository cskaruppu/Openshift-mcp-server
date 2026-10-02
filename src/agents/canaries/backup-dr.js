/**
 * Canary cases for the Backup & Disaster Recovery Agent.
 *
 * What these are protecting: the single most expensive number this product can
 * display. A DR readiness panel showing a reassuring grade for a cluster that
 * cannot be restored is worse than no panel at all — somebody looks at it,
 * believes it, and stops asking.
 *
 * The regressions all point the same way, and none of them throws:
 *
 *   · Velero absent read as "no backups needed" rather than "nothing can be
 *     restored". An absent operator is an ordinary 404, not an error.
 *   · A cluster that has never completed a backup still scoring a pass.
 *   · Paused schedules counted as schedules.
 *   · A six-month-old backup counted as a recent one.
 *
 * The scoring was lifted out of the MCP tool handler specifically so these
 * could be checked without a cluster.
 */

import { scoreDrReadiness } from "../../tools/velero.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const GOOD = {
  installed: true,
  now: NOW,
  backups: [
    { name: "daily-1", phase: "Completed", completionTimestamp: daysAgo(1), startTimestamp: daysAgo(1), expiration: daysAgo(-30) },
    { name: "daily-2", phase: "Completed", completionTimestamp: daysAgo(2), startTimestamp: daysAgo(2), expiration: daysAgo(-29) },
  ],
  schedules: [{ name: "daily", paused: false }],
  locations: [{ metadata: { name: "default" }, status: { phase: "Available" } }],
};

export default [
  {
    id: "no-velero-is-not-a-pass",
    kind: "pure",
    title: "A cluster with no Velero scores 0 and grade F",
    why: "An absent OADP operator is an ordinary 404 — nothing throws, nothing alerts. If that ever renders as an empty-but-passing result, a DR dashboard tells somebody their cluster is protected when nothing on it could be restored. This is the reason the scoring was pulled out of the tool handler.",
    run: async () => {
      const r = scoreDrReadiness({ installed: false, error: "the server could not find the requested resource" });
      return {
        score: r.score, grade: r.grade, installed: r.installed,
        recommendation: r.recommendation,
        firstFinding: r.findings?.[0]?.message,
        __evidence: { read: 0, expected: 3, confidence: "high", concluded: true, unread: ["Velero API is not served"] },
      };
    },
    expect: [
      { path: "score", assert: "equals", value: 0 },
      { path: "grade", assert: "equals", value: "F" },
      { path: "installed", assert: "equals", value: false },
      { path: "firstFinding", assert: "matches", value: "not a passing state" },
    ],
  },

  {
    id: "never-backed-up-cannot-grade-well",
    kind: "pure",
    title: "A cluster that has never completed a backup cannot reach a passing grade",
    why: "No completed backup means no restore is possible, whatever else is configured. If schedules and storage locations can carry the score up on their own, a cluster scores well for being ready to back up rather than for having done so.",
    run: async () => {
      const r = scoreDrReadiness({
        installed: true, now: NOW,
        backups: [],
        schedules: [{ name: "daily", paused: false }],
        locations: [{ status: { phase: "Available" } }],
      });
      return { score: r.score, grade: r.grade, findings: r.findings.map((f) => f.message) };
    },
    expect: [
      { path: "grade", assert: "oneOf", value: ["C", "D", "F"], note: "Never A or B. Nothing has ever been backed up." },
      { path: "findings", assert: "contains", value: "No successful backup has ever completed." },
    ],
  },

  {
    id: "paused-schedules-do-not-count",
    kind: "pure",
    title: "Schedules that are all paused are reported as no active schedule",
    why: "A paused schedule looks like a schedule in every listing. Counting it means a cluster whose backups were paused months ago still reports a backup regime.",
    run: async () => {
      const r = scoreDrReadiness({ ...GOOD, schedules: [{ name: "daily", paused: true }, { name: "weekly", paused: true }] });
      return { findings: r.findings.map((f) => f.message), score: r.score };
    },
    expect: [
      { path: "findings", assert: "contains", value: "All backup schedules are paused." },
    ],
  },

  {
    id: "a-stale-backup-is-called-stale",
    kind: "pure",
    title: "A backup older than the threshold is flagged with its real age",
    why: "'There is a backup' and 'there is a recent backup' are different claims. A six-month-old backup restores a six-month-old cluster, and the age has to be in the finding for anyone to notice.",
    run: async () => {
      const r = scoreDrReadiness({
        ...GOOD,
        backups: [{ name: "old", phase: "Completed", completionTimestamp: daysAgo(180), startTimestamp: daysAgo(180), expiration: daysAgo(-1) }],
        maxBackupAgeDays: 7,
      });
      return { age: r.summary.lastSuccessfulBackupAgeDays, findings: r.findings.map((f) => f.message) };
    },
    expect: [
      { path: "age", assert: "equals", value: 180 },
      { path: "findings", assert: "contains", value: "Last successful backup is 180 days old (threshold 7)." },
    ],
  },

  {
    id: "unavailable-storage-is-critical",
    kind: "pure",
    title: "A storage location that is not Available is a critical finding",
    why: "A BackupStorageLocation that exists but is not Available means new backups have nowhere to go and old ones may be unreachable. It exists in the listing, so only its phase distinguishes a working DR setup from a broken one.",
    run: async () => {
      const none = scoreDrReadiness({ ...GOOD, locations: [] });
      const broken = scoreDrReadiness({ ...GOOD, locations: [{ status: { phase: "Unavailable" } }] });
      return {
        noneFindings: none.findings.filter((f) => f.severity === "critical").map((f) => f.message),
        brokenFindings: broken.findings.filter((f) => f.severity === "critical").map((f) => f.message),
      };
    },
    expect: [
      { path: "noneFindings", assert: "contains", value: "No BackupStorageLocations defined." },
      { path: "brokenFindings", assert: "contains", value: "No BackupStorageLocations are Available." },
    ],
  },

  {
    id: "a-healthy-dr-setup-grades-well",
    kind: "pure",
    title: "A cluster with recent backups, an active schedule and available storage grades A",
    why: "A scorer that can never award a good grade gets ignored, and then the bad grades are ignored too. This case keeps the others meaningful.",
    run: async () => {
      const r = scoreDrReadiness(GOOD);
      return { score: r.score, grade: r.grade, installed: r.installed, criticals: r.findings.filter((f) => f.severity === "critical").length };
    },
    expect: [
      { path: "grade", assert: "equals", value: "A" },
      { path: "installed", assert: "equals", value: true },
      { path: "criticals", assert: "equals", value: 0 },
    ],
  },
];
