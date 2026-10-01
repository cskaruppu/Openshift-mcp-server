/**
 * Policy profiles for the App Deployment Agent's pre-deploy gate.
 *
 * One hardcoded control list cannot serve every customer: a bank gates on the
 * full CIS Benchmark, a platform team gates on Pod Security "restricted" and
 * nothing else, and a team migrating legacy workloads needs "baseline" for a
 * while. A gate whose standard cannot be named, versioned and narrowed is a
 * gate that gets switched off.
 *
 * A profile answers three questions, and only these three:
 *   1. WHICH controls apply (the rest are reported as not-in-profile, never as
 *      passed — a control that was not evaluated is not a pass).
 *   2. WHAT severity each control carries under this standard. "Run as
 *      non-root" is a hard stop under restricted and advisory under baseline;
 *      same check, different consequence.
 *   3. WHEN the gate blocks — the fail threshold.
 *
 * Every profile carries a version string. It goes into the signed evidence
 * record (gate-record.js), so an audit six months later can tell which edition
 * of which standard a given deploy was measured against.
 */

// Control catalogue — the ids manifest-scan.js emits. Kept here so a profile is
// validated against real control ids rather than typos.
export const ALL_CONTROLS = [
  "CIS-5.2.1", // privileged
  "CIS-5.2.6", // runAsNonRoot
  "CIS-5.2.5", // allowPrivilegeEscalation
  "CIS-5.2.8", // drop ALL capabilities
  "CIS-5.2.9", // seccompProfile RuntimeDefault
  "CIS-5.2.4", // requests + limits
  "CIS-5.2.7", // host namespaces
  "CIS-5.1.6", // non-default ServiceAccount
  "CIS-5.3.2", // NetworkPolicy present
  "CIS-5.4.1", // credentials from Secrets
];

/**
 * failThreshold — how much failure blocks the deploy:
 *   "none"     never blocks; the gate only reports (use while onboarding)
 *   "critical" blocks on a failed critical control
 *   "warning"  blocks on a failed critical OR warning control
 *   "any"      blocks on any failed control, whatever its severity
 */
export const POLICY_PROFILES = Object.freeze({
  "cis-1.9": {
    id: "cis-1.9",
    name: "CIS Kubernetes Benchmark",
    version: "1.9",
    standard: "CIS Kubernetes Benchmark v1.9 (section 5, workload controls)",
    description: "Every workload control the agent can evaluate statically. The broadest profile — use it when the customer's auditor cites CIS.",
    controls: ALL_CONTROLS,
    severity: {},            // keep manifest-scan's own severities
    failThreshold: "warning",
  },

  "pss-restricted": {
    id: "pss-restricted",
    name: 'Pod Security Standards "restricted"',
    version: "k8s-1.31",
    standard: 'Kubernetes Pod Security Standards, "restricted" profile',
    description: "Exactly what the restricted profile enforces at admission — nothing more. Pass this and the Pod Security admission controller will not reject the pod.",
    // Deliberately excludes CIS-5.2.4 (resources), 5.1.6 (ServiceAccount),
    // 5.3.2 (NetworkPolicy) and 5.4.1 (secret hygiene): good practice, but the
    // restricted profile does not check them and claiming it does would make
    // the gate's verdict unfalsifiable against the real admission controller.
    controls: ["CIS-5.2.1", "CIS-5.2.6", "CIS-5.2.5", "CIS-5.2.8", "CIS-5.2.9", "CIS-5.2.7"],
    severity: {
      "CIS-5.2.5": "critical",   // admission rejects it, so it is not a warning
      "CIS-5.2.8": "critical",
      "CIS-5.2.9": "critical",
      "CIS-5.2.7": "critical",
    },
    failThreshold: "any",
  },

  "pss-baseline": {
    id: "pss-baseline",
    name: 'Pod Security Standards "baseline"',
    version: "k8s-1.31",
    standard: 'Kubernetes Pod Security Standards, "baseline" profile',
    description: "The minimally restrictive profile: blocks known privilege escalations, allows a workload to run as root. For legacy applications being lifted onto the platform before they are hardened.",
    controls: ["CIS-5.2.1", "CIS-5.2.7", "CIS-5.2.5"],
    severity: { "CIS-5.2.1": "critical", "CIS-5.2.7": "critical", "CIS-5.2.5": "warning" },
    failThreshold: "critical",
  },

  "enterprise-baseline": {
    id: "enterprise-baseline",
    name: "Enterprise baseline (CIS + platform hygiene)",
    version: "2026.1",
    standard: "CIS Kubernetes Benchmark v1.9 with every control treated as blocking",
    description: "The strictest profile: every control, every failure blocks. The default for a production gate once an estate is clean.",
    controls: ALL_CONTROLS,
    severity: Object.fromEntries(ALL_CONTROLS.map((c) => [c, "critical"])),
    failThreshold: "any",
  },
});

export const DEFAULT_PROFILE_ID = "cis-1.9";

/** Resolve a profile id to a profile. Unknown ids fall back to the default. */
export function resolveProfile(id) {
  if (!id) return POLICY_PROFILES[DEFAULT_PROFILE_ID];
  const p = POLICY_PROFILES[String(id).toLowerCase()];
  return p || POLICY_PROFILES[DEFAULT_PROFILE_ID];
}

/** The profiles, as the console's picker needs them. */
export function listProfiles() {
  return Object.values(POLICY_PROFILES).map((p) => ({
    id: p.id, name: p.name, version: p.version, standard: p.standard,
    description: p.description, controlCount: p.controls.length, failThreshold: p.failThreshold,
  }));
}

/**
 * Decide whether a set of evaluated controls clears the profile's threshold.
 * Returns { pass, threshold, blocking: [ids], reason }.
 *
 * `overrideThreshold` lets a caller tighten or loosen the gate per run without
 * inventing a new profile — the threshold actually used is what gets recorded.
 */
export function gateVerdict(controls, profile, overrideThreshold) {
  const threshold = ["none", "critical", "warning", "any"].includes(overrideThreshold)
    ? overrideThreshold
    : profile.failThreshold;
  const failed = controls.filter((c) => c.status === "FAIL");
  const blocks = (sev) =>
    threshold === "any" ? true
    : threshold === "warning" ? sev === "critical" || sev === "warning"
    : threshold === "critical" ? sev === "critical"
    : false;
  const blocking = failed.filter((c) => blocks(c.severity)).map((c) => c.id);
  const pass = blocking.length === 0;
  const reason = pass
    ? failed.length
      ? `${failed.length} control(s) failed, none above the "${threshold}" threshold — the gate reports but does not block.`
      : `Every control in ${profile.name} ${profile.version} passed.`
    : `${blocking.length} control(s) fail at or above the "${threshold}" threshold: ${blocking.join(", ")}.`;
  return { pass, threshold, blocking, reason };
}
