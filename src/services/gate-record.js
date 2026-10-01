/**
 * The evidence record for a pre-deploy gate.
 *
 * An auditor asking "what was this deploy checked against?" six months later
 * needs four things, and a screenshot is none of them:
 *
 *   1. WHICH manifests were checked — by content, so that a later edit cannot
 *      be passed off as the thing that passed. That is the manifest digest.
 *   2. WHICH standard, at which version — the profile id and version, not just
 *      "CIS", because the control set moves between editions.
 *   3. WHAT the result was — per-control, with the verdict and the threshold
 *      actually applied.
 *   4. That the record was not edited afterwards — the signature.
 *
 * And the honesty rule that makes it worth anything: the deploy path RE-DIGESTS
 * what it is about to apply and compares. If the user ran the gate and then
 * edited the YAML, the digests differ and the record says the gate does not
 * cover this deploy. A gate you can walk around by editing the textarea is
 * theatre; this one notices.
 *
 * Signing: HMAC-SHA256 with GATE_SIGNING_KEY when it is configured. With no key
 * the record carries a plain SHA-256 content digest and says signed: false —
 * it never claims a signature it did not make.
 */

import crypto from "crypto";
import yaml from "js-yaml";

export const GATE_RECORD_VERSION = "1";

/**
 * Canonical digest of a manifest set.
 *
 * Canonical means: key order, whitespace, and the order of the documents
 * themselves must not change the digest, or every re-render would look like
 * tampering. Objects are sorted by kind+namespace+name and keys are emitted in
 * sorted order.
 */
export function manifestDigest(manifests) {
  const objs = (manifests || []).filter((m) => m && typeof m === "object");
  const key = (m) => `${(m.kind || "").toLowerCase()}|${m.metadata?.namespace || ""}|${m.metadata?.name || ""}`;
  const canonical = objs
    .map((m) => ({ k: key(m), text: yaml.dump(m, { sortKeys: true, lineWidth: -1, noRefs: true }) }))
    .sort((a, b) => a.k.localeCompare(b.k) || a.text.localeCompare(b.text))
    .map((x) => x.text)
    .join("---\n");
  return {
    algorithm: "sha256",
    value: crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
    objectCount: objs.length,
    objects: objs.map(key).sort(),
  };
}

function signingKey() {
  const k = process.env.GATE_SIGNING_KEY || "";
  return k.trim() ? k.trim() : null;
}

/** Stable JSON for signing: keys sorted recursively, no incidental whitespace. */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * Build the evidence record for one gate run.
 *
 * @param {object} p
 * @param {Array}  p.manifests  the objects that were checked
 * @param {object} p.cis        cisCheckManifests() output
 * @param {object} [p.images]   scanManifestImages() output
 * @param {object} [p.admission] checkAdmissionParity() output
 * @param {object} [p.remediation] remediateManifests() counts, when one was run
 * @param {string} [p.user]     who ran it
 * @param {string} [p.cluster]  cluster id the check was run against
 */
export function buildGateRecord({ manifests, cis, images, admission, remediation, user, cluster, namespace } = {}) {
  const digest = manifestDigest(manifests || []);
  const body = {
    recordVersion: GATE_RECORD_VERSION,
    recordedAt: new Date().toISOString(),
    runBy: user || "anonymous",
    cluster: cluster || "local",
    namespace: namespace || cis?.namespace || null,
    manifest: digest,
    policy: cis?.profile
      ? { id: cis.profile.id, name: cis.profile.name, version: cis.profile.version, standard: cis.profile.standard }
      : null,
    compliance: cis
      ? {
          applicable: cis.applicable !== false,
          grade: cis.summary?.grade ?? null,
          passed: cis.summary?.passed ?? null,
          failed: cis.summary?.failed ?? null,
          notEvaluated: cis.summary?.notEvaluated ?? 0,
          threshold: cis.verdict?.threshold ?? null,
          pass: cis.verdict?.pass ?? null,
          blocking: cis.verdict?.blocking || [],
          // Per-control, because "9 of 10" is not evidence of which one failed.
          controls: (cis.controls || []).map((c) => ({ id: c.id, status: c.status, severity: c.severity, offenders: c.offenders || [] })),
        }
      : null,
    // Two scores, carried separately into the record for the same reason they
    // are reported separately: they are different claims.
    imageHygiene: images?.hygiene ? { grade: images.hygiene.grade, findings: images.hygiene.findings, images: images.hygiene.total, clean: images.hygiene.clean } : null,
    imageVulnerability: images?.vulnerability
      ? { status: images.vulnerability.status, grade: images.vulnerability.grade, scanned: images.vulnerability.scanned, unscanned: images.vulnerability.unscanned, critical: images.vulnerability.critical, high: images.vulnerability.high }
      : null,
    admission: admission
      ? { namespace: admission.namespace, namespaceState: admission.namespaceState, status: admission.verdict?.status, critical: admission.verdict?.critical ?? null, enforce: admission.psa?.enforce ?? null }
      : null,
    remediation: remediation ? { fixes: remediation.fixes ?? null, safe: remediation.safe ?? null, verify: remediation.verify ?? null, unfixable: remediation.unfixable ?? null } : null,
    // Named so nobody has to infer what the signature covers.
    checksNotRun: [
      ...(cis ? [] : ["policy compliance"]),
      ...(images ? [] : ["image hygiene and vulnerability"]),
      ...(admission ? [] : ["admission parity against the target namespace"]),
    ],
  };

  const key = signingKey();
  const payload = stableJson(body);
  const signature = key
    ? {
        signed: true,
        algorithm: "hmac-sha256",
        value: crypto.createHmac("sha256", key).update(payload, "utf8").digest("hex"),
        keyId: crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12),
        covers: "every field of this record except the signature itself",
      }
    : {
        signed: false,
        algorithm: "sha256",
        value: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
        keyId: null,
        covers: "every field of this record except the signature itself",
        note: "This is a content digest, not a signature: GATE_SIGNING_KEY is not set, so anyone who can write the record can recompute this. Set GATE_SIGNING_KEY in the server environment to make the record tamper-evident.",
      };

  return { ...body, signature };
}

/** Recompute and compare a record's own signature/digest. */
export function verifyGateRecord(record) {
  if (!record || typeof record !== "object") return { valid: false, reason: "No record." };
  const { signature, ...body } = record;
  if (!signature) return { valid: false, reason: "The record carries no signature field." };
  const payload = stableJson(body);
  const key = signingKey();
  if (signature.signed) {
    if (!key) return { valid: null, reason: "The record is signed but no GATE_SIGNING_KEY is configured here, so it cannot be verified." };
    const want = crypto.createHmac("sha256", key).update(payload, "utf8").digest("hex");
    return want === signature.value
      ? { valid: true, reason: "The signature matches: no field of this record has changed since it was written." }
      : { valid: false, reason: "The signature does not match. Either the record was altered after it was written, or it was signed with a different key." };
  }
  const want = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  return want === signature.value
    ? { valid: true, reason: "The content digest matches, but it is not a signature — see the record's note.", signed: false }
    : { valid: false, reason: "The content digest does not match: the record was altered after it was written." };
}

/**
 * Does a gate record cover the manifests actually being deployed?
 *
 * This is the check that makes the gate more than advice. Run the gate, edit
 * the YAML, deploy — and the digest moves. The deploy is not blocked here (the
 * human may be entitled to do exactly that), but the record of the deploy says,
 * permanently, that nothing checked this.
 */
export function gateCoversManifests(record, manifests) {
  const now = manifestDigest(manifests || []);
  if (!record?.manifest?.value) {
    return {
      covered: false, reason: "no-gate-record",
      message: "This deploy carries no gate record: the pre-deploy checks were never run, or their result was not passed through. Nothing verified these manifests.",
      deployedDigest: now.value,
    };
  }
  if (record.manifest.value === now.value) {
    return {
      covered: true, reason: "digest-match",
      message: `The ${now.objectCount} object(s) being applied are byte-for-byte what the gate checked under ${record.policy?.name || "the policy"} ${record.policy?.version || ""}.`.trim(),
      deployedDigest: now.value,
    };
  }
  // Say WHAT moved, not just that something did.
  const was = new Set(record.manifest.objects || []);
  const is = new Set(now.objects);
  const addedObjs = now.objects.filter((o) => !was.has(o));
  const removedObjs = (record.manifest.objects || []).filter((o) => !is.has(o));
  const changedOnly = addedObjs.length === 0 && removedObjs.length === 0;
  return {
    covered: false, reason: "digest-mismatch",
    message: changedOnly
      ? `The manifests were EDITED after the gate ran: the same ${now.objectCount} object(s) no longer match the checked content. The gate's verdict does not apply to what is being deployed.`
      : `The manifest set CHANGED after the gate ran${addedObjs.length ? `, added: ${addedObjs.slice(0, 6).join(", ")}` : ""}${removedObjs.length ? `, removed: ${removedObjs.slice(0, 6).join(", ")}` : ""}. The gate's verdict does not apply to what is being deployed.`,
    checkedDigest: record.manifest.value,
    deployedDigest: now.value,
    added: addedObjs, removed: removedObjs,
  };
}
