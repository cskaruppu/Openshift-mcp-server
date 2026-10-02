/**
 * Backup & Disaster Recovery Tools
 *
 * Wraps the Velero / OpenShift APIs for Data Protection (OADP) APIs:
 *   - Backups, Schedules, Restores under velero.io/v1
 *   - DataProtectionApplication under oadp.openshift.io/v1alpha1
 *
 * Provides cluster DR-readiness scoring without needing the velero CLI.
 */

import { z } from "zod";
import { ocpGet, ocpPost, ocpDelete } from "../utils/openshift-client.js";
import { statusOf } from "../utils/api-discovery.js";

const VELERO_API = "apis/velero.io/v1";
const OADP_API = "apis/oadp.openshift.io/v1alpha1";
const DEFAULT_NS = process.env.VELERO_NAMESPACE || "openshift-adp";

function summarizeBackup(b) {
  const s = b.status || {};
  return {
    name: b.metadata?.name,
    namespace: b.metadata?.namespace,
    phase: s.phase || "Unknown",
    startTimestamp: s.startTimestamp || null,
    completionTimestamp: s.completionTimestamp || null,
    expiration: s.expiration || null,
    errors: s.errors || 0,
    warnings: s.warnings || 0,
    progress: s.progress || null,
    storageLocation: b.spec?.storageLocation || null,
    includedNamespaces: b.spec?.includedNamespaces || ["*"],
    schedule: b.metadata?.labels?.["velero.io/schedule-name"] || null,
  };
}

function summarizeRestore(r) {
  const s = r.status || {};
  return {
    name: r.metadata?.name,
    namespace: r.metadata?.namespace,
    backup: r.spec?.backupName,
    phase: s.phase || "Unknown",
    startTimestamp: s.startTimestamp || null,
    completionTimestamp: s.completionTimestamp || null,
    errors: s.errors || 0,
    warnings: s.warnings || 0,
    progress: s.progress || null,
  };
}

function summarizeSchedule(s) {
  const st = s.status || {};
  return {
    name: s.metadata?.name,
    namespace: s.metadata?.namespace,
    schedule: s.spec?.schedule,
    paused: !!s.spec?.paused,
    lastBackup: st.lastBackup || null,
    template: {
      ttl: s.spec?.template?.ttl || null,
      includedNamespaces: s.spec?.template?.includedNamespaces || ["*"],
      storageLocation: s.spec?.template?.storageLocation || null,
    },
  };
}

function ageDays(ts, now = Date.now()) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return null;
  return Math.floor((now - t) / 86400000);
}

/**
 * Score a cluster's disaster-recovery readiness. PURE — facts in, grade out.
 *
 * The single source of truth for this question. It used to be reimplemented in
 * four places — this scorer, the dashboard DR widget, a chat handler and the
 * agent-cache path — which disagreed with each other. On a cluster with no
 * Velero at all the dashboard reported `installed: true, score 20, grade F`,
 * because every one of its reads was wrapped in a catch that returned an empty
 * list, so nothing could ever throw and the "not installed" branch was
 * unreachable. They all call this now.
 *
 * THREE STATES, not two, and the third is the one that keeps the other two
 * honest:
 *
 *   installed: true   read it; score what is there
 *   installed: false  Velero is genuinely ABSENT (a 404 on its API group).
 *                     Grade F is earned: nothing on this cluster could be
 *                     restored.
 *   installed: null   COULD NOT TELL — a 403, a network failure, an
 *                     unreachable API server. No score, grade "—". A 403 does
 *                     not prove presence and it does not prove absence either;
 *                     the product already learned this the hard way with MTA,
 *                     and api-discovery.js exists because of it.
 *
 * @param {object} i
 * @param {boolean|null} i.installed  true / false / null — see above
 * @param {string}  [i.error]         why, when it could not be read
 * @param {Array}   i.backups         summarised backups
 * @param {Array}   i.schedules       summarised schedules
 * @param {Array}   i.locations       raw BackupStorageLocations
 * @param {number}  i.maxBackupAgeDays
 * @param {number}  [i.now]           injected so the result is deterministic
 */
/**
 * Read the cluster's Velero state and score it — the whole question, once.
 *
 * Every caller that wants a DR readiness answer uses this: the MCP tool, the
 * dashboard widget and the chat handler. Before it existed each had its own
 * copy, and they disagreed. The dashboard's wrapped every read in a catch that
 * returned an empty list, so its "not installed" branch was unreachable and a
 * cluster with no Velero reported `installed: true, score 20, grade F`.
 *
 * The backups read is the one that decides presence, so its failure is
 * classified rather than swallowed. The other two reads are genuinely optional
 * — a cluster can have backups and no schedules — but a FAILURE to read them is
 * not the same as there being none, so each records whether it was read.
 */
export async function readDrReadiness({ namespace = DEFAULT_NS, maxBackupAgeDays = 7 } = {}) {
  let backups;
  try {
    backups = ((await ocpGet(`/${VELERO_API}/namespaces/${namespace}/backups`)).items || []).map(summarizeBackup);
  } catch (err) {
    return { ...scoreDrReadiness({ installed: veleroPresence(err), error: veleroReadReason(err) }), namespace };
  }

  let schedules = [], locations = [];
  let schedulesRead = true, locationsRead = true;
  try {
    schedules = ((await ocpGet(`/${VELERO_API}/namespaces/${namespace}/schedules`)).items || []).map(summarizeSchedule);
  } catch { schedulesRead = false; }
  try {
    locations = (await ocpGet(`/${VELERO_API}/namespaces/${namespace}/backupstoragelocations`)).items || [];
  } catch { locationsRead = false; }

  return {
    ...scoreDrReadiness({ installed: true, backups, schedules, locations, maxBackupAgeDays, schedulesRead, locationsRead }),
    namespace,
  };
}

/**
 * What a failed read of the Velero API actually tells us.
 *
 *   404  the group is not served — Velero is absent. A definite answer.
 *   403  the API server authorised before routing, so this says nothing about
 *        whether Velero exists. Unknown.
 *   else no HTTP answer at all — the cluster was not reached. Unknown.
 *
 * @returns {false|null} false = definitively absent, null = could not tell
 */
export function veleroPresence(err) {
  return statusOf(err) === 404 ? false : null;
}

/**
 * Why the read failed, in words a person can act on.
 *
 * The raw error is an internal URL — "Failed to parse URL from
 * https://undefined:undefined/apis/..." — which tells the reader nothing and
 * leaks how the client is wired. The status code is the useful part.
 */
export function veleroReadReason(err) {
  const st = statusOf(err);
  if (st === 403) return "this service account may not read velero.io resources";
  if (st === 401) return "the cluster rejected the credential";
  if (st >= 500) return `the API server returned ${st}`;
  return "the cluster could not be reached";
}

export function scoreDrReadiness({
  installed, error = null, backups = [], schedules = [], locations = [],
  maxBackupAgeDays = 7, now = Date.now(),
  // Whether the optional reads actually happened. A read that FAILED is not a
  // read that found nothing, and deducting for "no schedules" when nobody
  // could list them turns a permissions gap into a backup gap.
  schedulesRead = true, locationsRead = true,
} = {}) {
  // Unknown. Not absent, not present — and emphatically not a grade.
  if (installed === null || installed === undefined) {
    return {
      score: null, grade: "—", installed: null, error,
      recommendation: "Determine whether OADP/Velero is installed: grant this service account read access to velero.io resources, or check API connectivity.",
      findings: [{
        severity: "warning",
        message: `Whether Velero/OADP is installed could not be determined${error ? ` (${error})` : ""}. This is neither a pass nor a failure — until it is known, the disaster-recovery posture of this cluster is unknown.`,
      }],
    };
  }
  if (installed === false) {
    return {
      score: 0, grade: "F", installed: false, error,
      recommendation: "Install OADP/Velero operator.",
      findings: [{
        severity: "critical",
        message: "Velero/OADP is not installed, so this cluster has no backups at all. This is not a passing state — nothing here could be restored.",
      }],
    };
  }

  const findings = [];
  let score = 100;

  // 2. Storage locations available
  const availableLocs = locations.filter((l) => l.status?.phase === "Available");
  const unread = [];
  if (!locationsRead) {
    unread.push("BackupStorageLocations");
    findings.push({ severity: "warning", message: "BackupStorageLocations could not be read, so whether backups have anywhere to go is unknown. Not scored either way." });
  } else if (locations.length === 0) {
    score -= 30;
    findings.push({ severity: "critical", message: "No BackupStorageLocations defined." });
  } else if (availableLocs.length === 0) {
    score -= 25;
    findings.push({ severity: "critical", message: "No BackupStorageLocations are Available." });
  }

  // 3. Schedules exist and not all paused
  if (!schedulesRead) {
    unread.push("Schedules");
    findings.push({ severity: "warning", message: "Backup schedules could not be read, so whether anything is scheduled is unknown. Not scored either way." });
  } else if (schedules.length === 0) {
    score -= 25;
    findings.push({ severity: "high", message: "No backup schedules defined — relying on manual backups only." });
  } else {
    const active = schedules.filter((s) => !s.paused);
    if (active.length === 0) {
      score -= 20;
      findings.push({ severity: "high", message: "All backup schedules are paused." });
    }
  }

  // 4. Recent successful backup exists
  const completed = backups
    .filter((b) => b.phase === "Completed")
    .sort((a, b) => (b.completionTimestamp || "").localeCompare(a.completionTimestamp || ""));
  const lastGood = completed[0];
  const lastGoodAge = lastGood ? ageDays(lastGood.completionTimestamp, now) : null;
  if (!lastGood) {
    score -= 25;
    findings.push({ severity: "critical", message: "No successful backup has ever completed." });
  } else if (lastGoodAge != null && lastGoodAge > maxBackupAgeDays) {
    score -= 15;
    findings.push({
      severity: "high",
      message: `Last successful backup is ${lastGoodAge} days old (threshold ${maxBackupAgeDays}).`,
    });
  }

  // 5. Recent failures
  const recentFails = backups.filter(
    (b) => ["Failed", "PartiallyFailed", "FailedValidation"].includes(b.phase)
      && (ageDays(b.startTimestamp, now) ?? 999) <= 7
  );
  if (recentFails.length > 0) {
    score -= Math.min(15, recentFails.length * 5);
    findings.push({
      severity: "warning",
      message: `${recentFails.length} backup(s) failed in the last 7 days.`,
    });
  }

  // 6. Backups have storage TTL
  const failedBackups = backups.filter((b) => ["Failed", "PartiallyFailed", "FailedValidation"].includes(b.phase)).length;
  const noTtl = backups.filter((b) => !b.expiration).length;
  if (backups.length > 0 && noTtl === backups.length) {
    score -= 5;
    findings.push({ severity: "info", message: "No backups have an expiration — storage will grow unbounded." });
  }

  score = Math.max(0, Math.round(score));
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

  return {
    score, grade, installed: true,
    // Named, because the score silently covers less when these are present.
    unreadable: unread.length ? unread : null,
    note: unread.length
      ? `${unread.join(" and ")} could not be read, so ${unread.length === 1 ? "that part of" : "parts of"} this score is based on less than the full picture.`
      : null,
    summary: {
      totalBackups: backups.length,
      completed: completed.length,
      failed: failedBackups,
      activeSchedules: schedulesRead ? schedules.filter((x) => !x.paused).length : null,
      schedules: schedules.length,
      storageLocations: locations.length,
      availableStorageLocations: availableLocs.length,
      lastSuccessfulBackup: lastGood?.name || null,
      lastSuccessfulBackupAgeDays: lastGoodAge,
    },
    findings,
  };
}

export function registerVeleroTools(server) {
  // ---------- velero_list_backups ----------
  server.tool(
    "velero_list_backups",
    "List Velero/OADP backups across the cluster",
    {
      namespace: z.string().optional().default(DEFAULT_NS).describe("OADP namespace (default: openshift-adp)"),
      phase: z
        .enum(["Completed", "Failed", "PartiallyFailed", "InProgress", "New", "FailedValidation"])
        .optional()
        .describe("Filter by backup phase"),
      schedule: z.string().optional().describe("Filter by schedule name"),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async ({ namespace, phase, schedule, limit }) => {
      try {
        const path = `/${VELERO_API}/namespaces/${namespace}/backups`;
        const data = await ocpGet(path);
        let items = (data.items || []).map(summarizeBackup);
        if (phase) items = items.filter((b) => b.phase === phase);
        if (schedule) items = items.filter((b) => b.schedule === schedule);
        items.sort((a, b) => (b.startTimestamp || "").localeCompare(a.startTimestamp || ""));
        items = items.slice(0, limit);
        return {
          content: [{ type: "text", text: JSON.stringify({ count: items.length, backups: items }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_get_backup ----------
  server.tool(
    "velero_get_backup",
    "Get full details of a single Velero backup",
    {
      name: z.string().describe("Backup name"),
      namespace: z.string().optional().default(DEFAULT_NS),
    },
    async ({ name, namespace }) => {
      try {
        const data = await ocpGet(`/${VELERO_API}/namespaces/${namespace}/backups/${name}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_list_schedules ----------
  server.tool(
    "velero_list_schedules",
    "List Velero backup schedules",
    {
      namespace: z.string().optional().default(DEFAULT_NS),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(`/${VELERO_API}/namespaces/${namespace}/schedules`);
        const items = (data.items || []).map(summarizeSchedule);
        return { content: [{ type: "text", text: JSON.stringify({ count: items.length, schedules: items }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_list_restores ----------
  server.tool(
    "velero_list_restores",
    "List Velero restore operations",
    {
      namespace: z.string().optional().default(DEFAULT_NS),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
    async ({ namespace, limit }) => {
      try {
        const data = await ocpGet(`/${VELERO_API}/namespaces/${namespace}/restores`);
        const items = (data.items || []).map(summarizeRestore);
        items.sort((a, b) => (b.startTimestamp || "").localeCompare(a.startTimestamp || ""));
        return {
          content: [
            { type: "text", text: JSON.stringify({ count: items.length, restores: items.slice(0, limit) }, null, 2) },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_create_backup ----------
  server.tool(
    "velero_create_backup",
    "Trigger an on-demand Velero backup",
    {
      name: z.string().describe("Backup name"),
      namespace: z.string().optional().default(DEFAULT_NS),
      includedNamespaces: z.array(z.string()).optional().describe("Namespaces to include (default: all)"),
      excludedNamespaces: z.array(z.string()).optional(),
      ttl: z.string().optional().default("720h0m0s").describe("Time-to-live before garbage collection"),
      storageLocation: z.string().optional(),
      snapshotVolumes: z.boolean().optional(),
    },
    async ({ name, namespace, includedNamespaces, excludedNamespaces, ttl, storageLocation, snapshotVolumes }) => {
      try {
        const body = {
          apiVersion: "velero.io/v1",
          kind: "Backup",
          metadata: { name, namespace },
          spec: {
            ttl,
            ...(includedNamespaces && { includedNamespaces }),
            ...(excludedNamespaces && { excludedNamespaces }),
            ...(storageLocation && { storageLocation }),
            ...(snapshotVolumes !== undefined && { snapshotVolumes }),
          },
        };
        const data = await ocpPost(`/${VELERO_API}/namespaces/${namespace}/backups`, body);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ created: data.metadata?.name, phase: data.status?.phase || "New" }, null, 2),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_create_restore ----------
  server.tool(
    "velero_create_restore",
    "Restore from an existing Velero backup",
    {
      name: z.string().describe("Restore name"),
      backupName: z.string().describe("Name of the backup to restore from"),
      namespace: z.string().optional().default(DEFAULT_NS),
      includedNamespaces: z.array(z.string()).optional(),
      namespaceMapping: z.record(z.string()).optional().describe("Map source namespace -> destination namespace"),
    },
    async ({ name, backupName, namespace, includedNamespaces, namespaceMapping }) => {
      try {
        const body = {
          apiVersion: "velero.io/v1",
          kind: "Restore",
          metadata: { name, namespace },
          spec: {
            backupName,
            ...(includedNamespaces && { includedNamespaces }),
            ...(namespaceMapping && { namespaceMapping }),
          },
        };
        const data = await ocpPost(`/${VELERO_API}/namespaces/${namespace}/restores`, body);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { created: data.metadata?.name, backup: backupName, phase: data.status?.phase || "New" },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_delete_backup ----------
  server.tool(
    "velero_delete_backup",
    "Delete a Velero backup (creates a DeleteBackupRequest)",
    {
      name: z.string(),
      namespace: z.string().optional().default(DEFAULT_NS),
    },
    async ({ name, namespace }) => {
      try {
        const body = {
          apiVersion: "velero.io/v1",
          kind: "DeleteBackupRequest",
          metadata: { name: `${name}-delete-${Date.now()}`, namespace },
          spec: { backupName: name },
        };
        const data = await ocpPost(`/${VELERO_API}/namespaces/${namespace}/deletebackuprequests`, body);
        return { content: [{ type: "text", text: JSON.stringify({ requested: data.metadata?.name }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_storage_locations ----------
  server.tool(
    "velero_storage_locations",
    "List Velero BackupStorageLocations and their availability",
    {
      namespace: z.string().optional().default(DEFAULT_NS),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(`/${VELERO_API}/namespaces/${namespace}/backupstoragelocations`);
        const items = (data.items || []).map((b) => ({
          name: b.metadata?.name,
          provider: b.spec?.provider,
          bucket: b.spec?.objectStorage?.bucket,
          phase: b.status?.phase || "Unknown",
          accessMode: b.spec?.accessMode || "ReadWrite",
          isDefault: !!b.spec?.default,
          lastValidationTime: b.status?.lastValidationTime || null,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ count: items.length, locations: items }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_dr_readiness ----------
  server.tool(
    "velero_dr_readiness",
    "Compute a Disaster-Recovery readiness score for the cluster (0-100)",
    {
      namespace: z.string().optional().default(DEFAULT_NS),
      maxBackupAgeDays: z.number().int().min(1).max(365).optional().default(7),
    },
    async ({ namespace, maxBackupAgeDays }) => {
      try {
        // One reader, one scorer, shared with the dashboard widget and chat.
        const out = await readDrReadiness({ namespace, maxBackupAgeDays });
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ---------- velero_dpa_status ----------
  server.tool(
    "velero_dpa_status",
    "Get OpenShift DataProtectionApplication (OADP) configuration status",
    {
      namespace: z.string().optional().default(DEFAULT_NS),
    },
    async ({ namespace }) => {
      try {
        const data = await ocpGet(`/${OADP_API}/namespaces/${namespace}/dataprotectionapplications`);
        const items = (data.items || []).map((d) => ({
          name: d.metadata?.name,
          conditions: d.status?.conditions || [],
          backupLocations: d.spec?.backupLocations?.length || 0,
          snapshotLocations: d.spec?.snapshotLocations?.length || 0,
          features: d.spec?.configuration?.velero?.featureFlags || [],
          defaultPlugins: d.spec?.configuration?.velero?.defaultPlugins || [],
        }));
        return { content: [{ type: "text", text: JSON.stringify({ count: items.length, dpas: items }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
