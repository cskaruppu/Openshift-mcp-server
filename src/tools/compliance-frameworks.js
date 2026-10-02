import { categoryForControl } from "./compliance-scanner.js";

export const FRAMEWORKS = {
  "soc2": {
    name: "SOC 2 Type II",
    description: "AICPA Trust Services Criteria for security, availability, processing integrity, confidentiality, and privacy",
    categories: ["Security", "Availability", "Confidentiality"],
    controls: {
      "CC6.1": {
        title: "Logical and Physical Access Controls",
        description: "Restrict logical access to system resources",
        cisChecks: ["CIS-5.2.1", "CIS-5.2.2", "CIS-5.2.5"],
      },
      "CC6.6": {
        title: "Authentication and Authorization",
        description: "RBAC controls authentication and authorization",
        cisChecks: ["CIS-5.1.1", "CIS-5.1.3", "CIS-5.1.5"],
      },
      "CC6.7": {
        title: "Restriction of Information Flow",
        description: "Network policy isolation",
        cisChecks: ["CIS-5.3.1", "CIS-5.3.2"],
      },
      "CC7.1": {
        title: "System Operations - Image Integrity",
        description: "Container image security",
        cisChecks: ["CIS-5.4.1"],
      },
    },
  },
  "pci-dss": {
    name: "PCI-DSS v4.0",
    description: "Payment Card Industry Data Security Standard",
    categories: ["Build & Maintain Secure Network", "Protect Cardholder Data", "Access Control"],
    controls: {
      "1.2": {
        title: "Restrict inbound and outbound traffic",
        description: "Network segmentation via NetworkPolicies",
        cisChecks: ["CIS-5.3.1", "CIS-5.3.2"],
      },
      "2.2": {
        title: "Configure system components securely",
        description: "Pod Security Standards enforcement",
        cisChecks: ["CIS-5.2.1", "CIS-5.2.2", "CIS-5.2.5"],
      },
      "7.1": {
        title: "Restrict access by need-to-know",
        description: "Least-privilege RBAC",
        cisChecks: ["CIS-5.1.1", "CIS-5.1.3", "CIS-5.1.5"],
      },
      "8.2": {
        title: "Strong authentication",
        description: "ServiceAccount controls",
        cisChecks: ["CIS-5.1.5"],
      },
    },
  },
  "hipaa": {
    name: "HIPAA Security Rule",
    description: "Health Insurance Portability and Accountability Act - Security Rule (45 CFR 164)",
    categories: ["Administrative Safeguards", "Technical Safeguards", "Physical Safeguards"],
    controls: {
      "164.308(a)(4)": {
        title: "Information Access Management",
        description: "Authorize and supervise workforce members",
        cisChecks: ["CIS-5.1.1", "CIS-5.1.3"],
      },
      "164.312(a)(1)": {
        title: "Access Control",
        description: "Unique user identification, automatic logoff, encryption",
        cisChecks: ["CIS-5.2.1", "CIS-5.2.2"],
      },
      "164.312(c)(1)": {
        title: "Integrity",
        description: "Protect ePHI from improper alteration",
        cisChecks: ["CIS-5.2.5", "CIS-5.4.1"],
      },
      "164.312(e)(1)": {
        title: "Transmission Security",
        description: "Protect ePHI during transmission",
        cisChecks: ["CIS-5.3.1", "CIS-5.3.2"],
      },
    },
  },
  "nist-800-53": {
    name: "NIST 800-53 Rev 5",
    description: "Security and Privacy Controls for Information Systems",
    categories: ["Access Control", "System and Communications Protection", "Configuration Management"],
    controls: {
      "AC-3": {
        title: "Access Enforcement",
        description: "Enforce approved authorizations",
        cisChecks: ["CIS-5.1.1", "CIS-5.1.3", "CIS-5.1.5"],
      },
      "AC-6": {
        title: "Least Privilege",
        description: "Employ principle of least privilege",
        cisChecks: ["CIS-5.2.1", "CIS-5.2.2"],
      },
      "SC-7": {
        title: "Boundary Protection",
        description: "Network policy boundary protection",
        cisChecks: ["CIS-5.3.1", "CIS-5.3.2"],
      },
      "CM-6": {
        title: "Configuration Settings",
        description: "Establish secure baseline configurations",
        cisChecks: ["CIS-5.2.1", "CIS-5.2.2", "CIS-5.2.5", "CIS-5.4.1"],
      },
    },
  },
  "iso-27001": {
    name: "ISO/IEC 27001:2022",
    description: "Information Security Management Systems",
    categories: ["Organizational", "People", "Physical", "Technological"],
    controls: {
      "A.5.15": {
        title: "Access Control",
        description: "Rules for access to information",
        cisChecks: ["CIS-5.1.1", "CIS-5.1.3"],
      },
      "A.8.2": {
        title: "Privileged Access Rights",
        description: "Allocation and use of privileged access",
        cisChecks: ["CIS-5.2.1", "CIS-5.2.2", "CIS-5.2.5"],
      },
      "A.8.20": {
        title: "Network Security",
        description: "Networks and network services management",
        cisChecks: ["CIS-5.3.1", "CIS-5.3.2"],
      },
      "A.8.31": {
        title: "Separation of Development and Production",
        description: "Image security and supply chain",
        cisChecks: ["CIS-5.4.1"],
      },
    },
  },
};

export function getFrameworkList() {
  return Object.entries(FRAMEWORKS).map(([id, fw]) => ({
    id,
    name: fw.name,
    description: fw.description,
    controlCount: Object.keys(fw.controls).length,
  }));
}

export function getFramework(frameworkId) {
  const fw = FRAMEWORKS[frameworkId];
  if (!fw) return null;
  return {
    id: frameworkId,
    name: fw.name,
    description: fw.description,
    categories: fw.categories,
    controls: Object.entries(fw.controls).map(([controlId, c]) => ({
      controlId,
      title: c.title,
      description: c.description,
      cisChecks: c.cisChecks,
    })),
  };
}

function calculateGrade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/**
 * Map a framework's controls onto the CIS findings from a scan.
 *
 * THE RULE THIS EXISTS TO HOLD: a framework is scored only when a scan actually
 * ran. The CIS scanner reports FAILURES — a check that ran and passed produces
 * no finding — so an empty list is genuinely ambiguous: it means either "the
 * scan ran and nothing is wrong" or "no scan has ever run". Those are opposite
 * facts and they arrive identically.
 *
 * This used to resolve that ambiguity the most dangerous way available. Every
 * control's checks were absent from the (empty) failure list, so every control
 * counted as compliant and every framework scored 100% with grade A. A customer
 * opening the Audit tab before the first scan completed — or on a cluster the
 * scanner could not read — was shown perfect SOC 2, PCI-DSS and HIPAA
 * compliance. Nothing threw, nothing was logged, and the number is the kind
 * somebody screenshots for an assessor.
 *
 * Now the caller says whether a scan happened, and when it did not the result
 * carries `scanned: false`, a NULL score and the grade "—". Not zero: zero is a
 * score, and "nobody looked" is not a score.
 *
 * @param {string} frameworkId
 * @param {Array}  cisFindings  findings from the CIS scan (failures, plus any
 *                              explicit passes)
 * @param {object} [opts]
 * @param {boolean} [opts.scanned]  did a scan actually run? An explicit answer
 *                                  always wins. Without one the only honest
 *                                  inference is "findings present ⇒ a scan
 *                                  ran", and anything else is unknown — which
 *                                  must never resolve to 100%.
 * @param {string} [opts.scanTime]  when, so the result can be aged
 */
export function evaluateFramework(frameworkId, cisFindings, opts = {}) {
  const fw = FRAMEWORKS[frameworkId];
  if (!fw) return null;

  const findings = Array.isArray(cisFindings) ? cisFindings : [];
  const scanned = typeof opts.scanned === "boolean" ? opts.scanned : findings.length > 0;

  if (!scanned) {
    const controlEntries = Object.entries(fw.controls);
    return {
      frameworkId,
      frameworkName: fw.name,
      frameworkDescription: fw.description || null,
      totalControls: controlEntries.length,
      compliantControls: 0,
      partialControls: 0,
      nonCompliantControls: 0,
      notEvaluatedControls: controlEntries.length,
      // Null, not 0. A score of 0 says "this cluster fails everything"; null
      // says "nothing was measured", and the console renders them differently.
      score: null,
      grade: "—",
      scanned: false,
      scanTime: null,
      note: "No CIS scan result was available, so this framework was not evaluated. This is not a compliance score of any kind — run a scan, then read it. An empty finding set cannot be told apart from an unread cluster.",
      controls: controlEntries.map(([controlId, c]) => ({
        controlId,
        title: c.title,
        description: c.description,
        status: "not-evaluated",
        cisChecks: c.cisChecks || [],
        passCount: 0,
        failCount: 0,
        findings: [],
      })),
    };
  }

  const failsById = new Map();
  // A check whose underlying scan could not READ what it needed was not
  // evaluated. It produces no FAIL, so without this it would be credited as a
  // pass — which is how an unreachable cluster scored 100% against every
  // framework. The scanner marks those findings `unreadable`.
  const unreadableIds = new Set();
  const unreadableCategories = new Set();
  for (const f of findings) {
    if (f.unreadable) {
      unreadableIds.add(f.id);
      if (f.category) unreadableCategories.add(f.category);
    }
    if (f.status === "FAIL") {
      if (!failsById.has(f.id)) failsById.set(f.id, []);
      failsById.get(f.id).push(f);
    }
  }
  // A category that failed to read takes every one of its checks with it. The
  // mapping comes from the scanner's catalogue, not from the findings: a failed
  // category reports ONE marker finding, so all its other controls are simply
  // absent — and absent is exactly what used to be read as "passed".
  const wasRead = (checkId) =>
    !unreadableIds.has(checkId) && !unreadableCategories.has(categoryForControl(checkId));

  const controlEntries = Object.entries(fw.controls);
  const totalControls = controlEntries.length;
  let compliantControls = 0;
  let partialControls = 0;
  let nonCompliantControls = 0;
  let notEvaluatedControls = 0;

  const controls = controlEntries.map(([controlId, c]) => {
    const checks = c.cisChecks || [];
    let passCount = 0;
    let failCount = 0;
    let unreadCount = 0;
    const failedFindings = [];

    for (const checkId of checks) {
      if (failsById.has(checkId)) {
        failCount++;
        failedFindings.push(...failsById.get(checkId));
      } else if (!wasRead(checkId)) {
        unreadCount++;
      } else {
        passCount++;
      }
    }

    const evaluated = passCount + failCount;
    let status;
    if (checks.length === 0 || evaluated === 0) {
      // Either no CIS check is mapped to this control, or every check that is
      // could not be read. Both mean nothing was measured, and neither may
      // quietly inflate the pass side of the denominator.
      status = "not-evaluated";
      notEvaluatedControls++;
    } else if (failCount === 0) {
      status = "compliant";
      compliantControls++;
    } else if (failCount === evaluated) {
      status = "non-compliant";
      nonCompliantControls++;
    } else {
      status = "partial";
      partialControls++;
    }

    return {
      controlId,
      title: c.title,
      description: c.description,
      status,
      cisChecks: checks,
      passCount,
      failCount,
      unreadCount,
      findings: failedFindings,
    };
  });

  // Scored over the controls that could actually be evaluated, never over all
  // of them. A control with no CIS check behind it is neither a pass nor a
  // failure, and folding it into either direction makes the percentage mean
  // something different from what it says — the same rule the deploy gate's
  // policy profiles follow.
  const evaluatedControls = totalControls - notEvaluatedControls;
  const score = evaluatedControls === 0
    ? null
    : Math.round(((compliantControls + 0.5 * partialControls) / evaluatedControls) * 100);
  const grade = score === null ? "—" : calculateGrade(score);

  return {
    frameworkId,
    frameworkName: fw.name,
    // The framework's own description was computed nowhere and the console
    // rendered a blank line where it should have been.
    frameworkDescription: fw.description || null,
    totalControls,
    compliantControls,
    partialControls,
    nonCompliantControls,
    notEvaluatedControls,
    evaluatedControls,
    score,
    grade,
    scanned: true,
    scanTime: opts.scanTime || null,
    // Two different reasons a control goes unevaluated, and they need different
    // actions: one is a gap in the mapping, the other is a cluster that could
    // not be read. Saying "no CIS check mapped" for an unreadable cluster sends
    // somebody to edit a catalogue when the real problem is connectivity.
    note: notEvaluatedControls > 0
      ? (() => {
          const unmapped = controls.filter((c) => c.status === "not-evaluated" && (c.cisChecks || []).length === 0).length;
          const unread = notEvaluatedControls - unmapped;
          const reasons = [
            unread ? `${unread} because the checks behind them could not be read on this cluster` : null,
            unmapped ? `${unmapped} because no CIS check is mapped to them` : null,
          ].filter(Boolean);
          return evaluatedControls === 0
            ? `None of this framework's ${totalControls} control(s) could be evaluated — ${reasons.join(", and ")}. There is no score: this is not a pass, and not a failure either.`
            : `${notEvaluatedControls} of ${totalControls} control(s) were not evaluated — ${reasons.join(", and ")}. The score covers the ${evaluatedControls} that were.`;
        })()
      : null,
    controls,
  };
}

export function evaluateAllFrameworks(cisFindings, opts = {}) {
  return Object.keys(FRAMEWORKS).map((id) => evaluateFramework(id, cisFindings, opts));
}
