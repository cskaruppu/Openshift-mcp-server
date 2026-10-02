/**
 * Canary cases for the Upgrade & Lifecycle Agent.
 *
 * What these are protecting: the answer to "can I upgrade this cluster from A
 * to B". Every dangerous regression here points the same way — the agent
 * becoming MORE willing to say yes:
 *
 *   · a downgrade allowed, which OpenShift cannot do and which strands a
 *     cluster mid-upgrade
 *   · a multi-minor jump allowed, which Red Hat does not support and which
 *     leaves operators on an unsupported path
 *   · "already on this version" read as a valid upgrade, which starts a
 *     no-op maintenance window somebody took an outage for
 *
 * None of these throws. A validator that returns `valid: true` more often
 * looks like a product with fewer false blocks.
 */

import { validateUpgradeVersion } from "../../tools/upgrade-preflight.js";

const UPDATES = [{ version: "4.15.9" }, { version: "4.15.12" }];

export default [
  {
    id: "downgrade-is-refused",
    kind: "pure",
    title: "A downgrade is refused as an error",
    why: "OpenShift does not support cluster downgrades. If this ever returns valid, somebody starts a change window for an upgrade that cannot complete and leaves the cluster part-upgraded — the worst state a cluster can be in.",
    run: async () => {
      const v = validateUpgradeVersion("4.16.2", "4.14.5", UPDATES, "stable-4.16");
      return { valid: v.valid, severity: v.severity, reason: v.reason };
    },
    expect: [
      { path: "valid", assert: "equals", value: false },
      { path: "severity", assert: "equals", value: "error", note: "An error, not a warning — a warning is something people click through." },
      { path: "reason", assert: "matches", value: "does not support cluster downgrades" },
    ],
  },

  {
    id: "multi-minor-jump-is-refused",
    kind: "pure",
    title: "Skipping a minor version is refused",
    why: "Red Hat requires sequential minor upgrades (4.14 → 4.15 → 4.16). Allowing 4.14 → 4.17 produces a cluster on an unsupported path, which is only discovered when an operator fails to reconcile and support declines the case.",
    run: async () => {
      const v = validateUpgradeVersion("4.14.5", "4.17.1", UPDATES, "stable-4.14");
      return { valid: v.valid, severity: v.severity, reason: v.reason };
    },
    expect: [
      { path: "valid", assert: "equals", value: false },
      { path: "reason", assert: "matches", value: "Cannot jump from" },
    ],
  },

  {
    id: "same-version-is-not-an-upgrade",
    kind: "pure",
    title: "Upgrading to the version already running is refused",
    why: "A no-op upgrade is a maintenance window and an outage somebody agreed to for nothing. It must be caught before the change request, not after.",
    run: async () => {
      const v = validateUpgradeVersion("4.14.5", "4.14.5", UPDATES, "stable-4.14");
      return { valid: v.valid, reason: v.reason };
    },
    expect: [
      { path: "valid", assert: "equals", value: false },
      { path: "reason", assert: "matches", value: "already running version" },
    ],
  },

  {
    id: "a-supported-upgrade-is-allowed",
    kind: "pure",
    title: "The one supported path IS allowed",
    why: "A validator that refuses everything is as broken as one that allows everything, and far easier to ship by accident while tightening the other cases. This is the case that proves the gate still passes real work.",
    run: async () => {
      const v = validateUpgradeVersion("4.14.5", "4.15.9", UPDATES, "stable-4.15");
      return { valid: v.valid, reason: v.reason };
    },
    expect: [
      { path: "valid", assert: "equals", value: true },
      { path: "reason", assert: "matches", value: "available and supported" },
    ],
  },

  {
    id: "a-missing-version-is-an-error-not-a-pass",
    kind: "pure",
    title: "A missing version is refused rather than assumed",
    why: "An empty target version must not read as 'nothing wrong with it'. Guessing what somebody meant to upgrade to is the one thing an upgrade validator must never do.",
    run: async () => {
      const a = validateUpgradeVersion("4.14.5", "", UPDATES, "stable");
      const b = validateUpgradeVersion("", "4.15.9", UPDATES, "stable");
      const c = validateUpgradeVersion("4.14.5", "not-a-version", UPDATES, "stable");
      return { missingTarget: a.valid, missingCurrent: b.valid, malformed: c.valid, malformedReason: c.reason };
    },
    expect: [
      { path: "missingTarget", assert: "equals", value: false },
      { path: "missingCurrent", assert: "equals", value: false },
      { path: "malformed", assert: "equals", value: false },
      { path: "malformedReason", assert: "matches", value: "Invalid version format" },
    ],
  },
];
