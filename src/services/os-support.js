// ---------------------------------------------------------------------------
// Is the support matrix still true?
// ---------------------------------------------------------------------------
/**
 * A support matrix is a fact somebody else publishes, and it moves.
 *
 * The one in vm-migration.js is data, dated, and overridable — which is the
 * right shape — but nothing checked whether it had gone stale relative to the
 * cluster it was being applied to. A matrix read against OpenShift 4.16 and
 * applied to a 4.20 cluster is not slightly out of date, it is describing a
 * different product, and the customer's architect will know that before we do.
 *
 * THE MODEL IS NOT THE SOURCE. This is the important design decision and it is
 * deliberate: an LLM asked "is RHEL 7 supported on OpenShift Virtualization"
 * will answer confidently from training data of unknown vintage, and that
 * answer will end up in a customer's business case. So the model never
 * supplies a support level here. Three real sources do:
 *
 *   1. THE MATRIX — dated, versioned, with the article it came from.
 *   2. THE CLUSTER — the guest images Red Hat actually ships for THIS cluster,
 *      read from the DataSources that OpenShift Virtualization installs. That
 *      is not a claim about support, it is evidence of it: Red Hat shipping a
 *      rhel9 DataSource on your cluster is a stronger statement than any
 *      document, and an OS with no image is at minimum a question.
 *   3. THE OPERATOR — the OpenShift and OpenShift Virtualization versions,
 *      so the matrix can say whether it was written for them.
 *
 * The model's job, elsewhere, is to explain what these three mean together.
 * Not to be one of them.
 *
 * Never throws.
 */

import { ocpGet } from "../utils/openshift-client.js";
import { SUPPORT_MATRIX, classifyGuestOS } from "./vm-migration.js";

const DAY = 24 * 60 * 60 * 1000;

/** How old the matrix is, and whether that is a problem yet. */
export function matrixAge(asOf, now = Date.now()) {
  const t = Date.parse(asOf || "");
  if (!Number.isFinite(t)) return { days: null, stale: null, note: "The support matrix carries no date, so its age cannot be judged." };
  const days = Math.floor((now - t) / DAY);
  // Red Hat revises the certified guest list roughly with each minor release.
  // Six months is about one release cycle; a year is two and is no longer a
  // current document.
  const stale = days > 365 ? "stale" : days > 180 ? "ageing" : "current";
  return {
    days, stale,
    note: stale === "current"
      ? `The matrix was read ${days} days ago and is current for this release cycle.`
      : stale === "ageing"
        ? `The matrix was read ${days} days ago. Red Hat revises the certified list roughly each minor release — confirm anything marginal against the live article before it goes in a document.`
        : `The matrix was read ${days} days ago, which is more than a year. Treat every level below as needing confirmation against the live article, not as an answer.`,
  };
}

/**
 * What the cluster is, so the matrix can be judged against it.
 *
 * Version comparison is by minor release, because that is the granularity at
 * which the certified list actually changes.
 */
export async function clusterVersions() {
  const out = { openshift: null, virtualization: null, notes: [] };
  try {
    const cv = await ocpGet("/apis/config.openshift.io/v1/clusterversions/version");
    out.openshift = cv?.status?.desired?.version || cv?.spec?.desiredUpdate?.version || null;
  } catch (e) { out.notes.push(`OpenShift version could not be read: ${e.message}`); }

  try {
    const hco = await ocpGet("/apis/hco.kubevirt.io/v1beta1/hyperconvergeds");
    const item = (hco.items || [])[0];
    out.virtualization = item?.status?.versions?.find?.((v) => v.name === "operator")?.version
      || item?.metadata?.labels?.["app.kubernetes.io/version"] || null;
  } catch { out.notes.push("OpenShift Virtualization version could not be read — the operator may not be installed."); }

  return out;
}

/**
 * The guest images this cluster actually ships.
 *
 * Evidence rather than documentation. A DataSource named rhel9 that reports
 * Ready means Red Hat is shipping and maintaining a RHEL 9 boot source for
 * THIS cluster — which is a stronger statement about support than any article,
 * and it is the thing a containerisation or migration decision can lean on.
 */
export async function clusterGuestImages(namespace = process.env.VM_IMAGE_NAMESPACE || "openshift-virtualization-os-images") {
  try {
    const ds = await ocpGet(`/apis/cdi.kubevirt.io/v1beta1/namespaces/${namespace}/datasources`);
    const images = (ds.items || []).map((d) => ({
      name: d.metadata.name,
      ready: (d.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
    }));
    return { readable: true, namespace, images, reason: null };
  } catch (e) {
    return {
      readable: false, namespace, images: [],
      reason: `The golden images on this cluster could not be read (${e.message}). Without them, the matrix is the only source and cannot be corroborated.`,
    };
  }
}

/** Loose match between a matrix label and a DataSource name: "RHEL 9" ↔ rhel9. */
export function imageMatches(label, imageName) {
  const a = String(label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = String(imageName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Reconcile the matrix against what the cluster ships.
 *
 * Three outcomes worth telling apart, and the third is the one nobody else
 * reports:
 *
 *   corroborated  the matrix says supported and the cluster ships the image.
 *   documented    the matrix says supported, the cluster ships no image. Not a
 *                 contradiction — images are opt-in — but it means a migration
 *                 has no golden source and somebody has to bring one.
 *   undocumented  the cluster ships an image the matrix does not list, which
 *                 usually means the matrix is older than the cluster.
 */
export function reconcile(distributions = [], images = []) {
  const names = images.filter((i) => i.ready !== false).map((i) => i.name);
  const rows = distributions.map((d) => {
    const image = names.find((n) => imageMatches(d.distro, n)) || null;
    return {
      distro: d.distro, level: d.level, tier: d.tier, tierLabel: d.tierLabel, count: d.count,
      image,
      status: d.level === "supported" && image ? "corroborated"
        : d.level === "supported" ? "documented"
        : image ? "image-without-support-claim"
        : "matrix-only",
      note: d.level === "supported" && image
        ? `The matrix lists this as supported and the cluster ships a ${image} boot source. Both agree.`
        : d.level === "supported"
          ? "The matrix lists this as supported, but this cluster ships no boot source for it. Migration works; provisioning a fresh one would need an image brought in."
          : image
            ? `The cluster ships a ${image} boot source for an OS the matrix does not list as supported — usually a sign the matrix is older than the cluster.`
            : null,
    };
  });

  const undocumented = names.filter((n) => !distributions.some((d) => imageMatches(d.distro, n)));
  return { rows, undocumented };
}

/**
 * The full picture: matrix, its age, the cluster, and what they say together.
 *
 * @param {Array} vms  machines carrying a guest OS string
 */
export async function supportPosture(vms = [], { now = Date.now() } = {}) {
  // Group the estate by the distribution the matrix recognises.
  const byDistro = new Map();
  let unreported = 0;
  for (const vm of vms) {
    const raw = vm.guestOS || vm.osType || vm.os?.fullName || null;
    if (!raw) { unreported++; continue; }
    const c = classifyGuestOS(raw, vm.guestId || vm.os?.id || null);
    const key = c.distro;
    if (!byDistro.has(key)) byDistro.set(key, { ...c, count: 0, machines: [] });
    const e = byDistro.get(key);
    e.count++;
    if (e.machines.length < 12) e.machines.push(vm.name || vm.id);
  }
  const distributions = [...byDistro.values()].sort((a, b) => b.count - a.count);

  const [versions, imagery] = await Promise.all([clusterVersions(), clusterGuestImages()]);
  const age = matrixAge(SUPPORT_MATRIX.asOf, now);
  const { rows, undocumented } = reconcile(distributions, imagery.images);

  // Whether the matrix was written for the cluster it is being applied to.
  const minor = (v) => { const m = /^(\d+)\.(\d+)/.exec(String(v || "")); return m ? `${m[1]}.${m[2]}` : null; };
  const ocp = minor(versions.openshift);

  const unsupported = distributions.filter((d) => d.level === "unsupported");
  const unknown = distributions.filter((d) => d.level === "unknown");

  return {
    matrix: { asOf: SUPPORT_MATRIX.asOf, source: SUPPORT_MATRIX.source, url: SUPPORT_MATRIX.url, age },
    cluster: { openshift: versions.openshift, openshiftMinor: ocp, virtualization: versions.virtualization, notes: versions.notes },
    images: imagery,
    distributions: rows,
    undocumentedImages: undocumented,
    unreported,
    totals: {
      machines: vms.length,
      distributions: distributions.length,
      unsupported: unsupported.reduce((n, d) => n + d.count, 0),
      unknown: unknown.reduce((n, d) => n + d.count, 0),
      unreported,
    },
    // One honest sentence for the panel, assembled from what was actually read.
    headline: [
      `${vms.length} machines across ${distributions.length} distribution${distributions.length === 1 ? "" : "s"}.`,
      unsupported.length ? `${unsupported.reduce((n, d) => n + d.count, 0)} on an OS the matrix does not support.` : null,
      unknown.length ? `${unknown.reduce((n, d) => n + d.count, 0)} on an OS the matrix does not list at all.` : null,
      unreported ? `${unreported} reported no guest OS.` : null,
      ocp ? `Cluster is OpenShift ${versions.openshift}.` : "The OpenShift version could not be read.",
      age.note,
    ].filter(Boolean).join(" "),
  };
}
