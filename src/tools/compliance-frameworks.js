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

export function evaluateFramework(frameworkId, cisFindings) {
  const fw = FRAMEWORKS[frameworkId];
  if (!fw) return null;

  const findings = Array.isArray(cisFindings) ? cisFindings : [];
  const failsById = new Map();
  for (const f of findings) {
    if (f.status === "FAIL") {
      if (!failsById.has(f.id)) failsById.set(f.id, []);
      failsById.get(f.id).push(f);
    }
  }

  const controlEntries = Object.entries(fw.controls);
  const totalControls = controlEntries.length;
  let compliantControls = 0;
  let partialControls = 0;
  let nonCompliantControls = 0;

  const controls = controlEntries.map(([controlId, c]) => {
    const checks = c.cisChecks || [];
    let passCount = 0;
    let failCount = 0;
    const failedFindings = [];

    for (const checkId of checks) {
      if (failsById.has(checkId)) {
        failCount++;
        failedFindings.push(...failsById.get(checkId));
      } else {
        passCount++;
      }
    }

    let status;
    if (checks.length === 0) {
      status = "not-evaluated";
    } else if (failCount === 0) {
      status = "compliant";
      compliantControls++;
    } else if (failCount === checks.length) {
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
      findings: failedFindings,
    };
  });

  const score = totalControls === 0
    ? 0
    : Math.round(((compliantControls + 0.5 * partialControls) / totalControls) * 100);
  const grade = calculateGrade(score);

  return {
    frameworkId,
    frameworkName: fw.name,
    totalControls,
    compliantControls,
    partialControls,
    nonCompliantControls,
    score,
    grade,
    controls,
  };
}

export function evaluateAllFrameworks(cisFindings) {
  return Object.keys(FRAMEWORKS).map((id) => evaluateFramework(id, cisFindings));
}
