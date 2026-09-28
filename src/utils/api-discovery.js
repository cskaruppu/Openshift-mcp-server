// ---------------------------------------------------------------------------
// Does this API group exist?
// ---------------------------------------------------------------------------
/**
 * A 403 does not prove that something is installed.
 *
 * This was a real and embarrassing bug: the toolchain panel reported "MTA is
 * installed, but this service account may not read its resources" on a cluster
 * with no MTA at all, and told the customer to grant a role for a product they
 * had never installed.
 *
 * The cause is the order the API server does its work. Authentication, then
 * AUTHORIZATION, then the request is routed to a handler. A service account
 * with no rule matching `mta.konveyor.io` is refused at the authorization step,
 * and the request never reaches the point where it would have been a 404. So a
 * missing operator and a missing role produce the same status code, and code
 * that reads 403 as presence gets it wrong every time on a locked-down cluster.
 *
 * Discovery settles it. `/apis/<group>/<version>` lists the resources a group
 * serves, and the `system:discovery` ClusterRole is bound to
 * `system:authenticated` on any normal cluster — so a service account that may
 * not LIST a resource can still see whether its group is served.
 *
 *   discovery 200  the group exists. A 403 on its resources is then genuinely
 *                  a missing role, and saying so is useful.
 *   discovery 404  the group is not served. Whatever the resource call said,
 *                  the thing is not installed.
 *   anything else  unknown, and reported as unknown.
 */

import { ocpGet } from "./openshift-client.js";

/** HTTP status out of the client's error text, or 0 when it was not HTTP. */
export function statusOf(err) {
  const m = /OCP API (\d{3})/.exec(err?.message || "");
  return m ? Number(m[1]) : 0;
}

/**
 * Is this API group served by the cluster?
 *
 * @returns {{present: boolean|null, status: number, reason: string|null}}
 *   present true / false / null — null means we could not find out, which is
 *   a third answer and never collapsed into false.
 */
export async function apiGroupPresent(group, version) {
  try {
    const r = await ocpGet(`/apis/${group}/${version}`);
    // A served group returns an APIResourceList. Anything else is not a group.
    const ok = r && (r.kind === "APIResourceList" || Array.isArray(r.resources));
    return { present: Boolean(ok), status: 200, reason: ok ? null : `/apis/${group}/${version} answered with something that is not an APIResourceList.` };
  } catch (e) {
    const status = statusOf(e);
    if (status === 404) return { present: false, status, reason: null };
    if (status === 403) {
      // Discovery itself refused. Unusual — it means system:discovery is not
      // bound to system:authenticated — and it is genuinely unknown, not absent.
      return { present: null, status, reason: "This cluster does not allow API discovery for this service account, so whether the operator is installed cannot be determined. Grant the system:discovery ClusterRole." };
    }
    if (status === 401) return { present: null, status, reason: "The cluster rejected the credential." };
    if (/Failed to parse URL|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(e.message || "")) {
      return { present: null, status, reason: "This cluster could not be reached, so nothing on it could be checked." };
    }
    return { present: null, status, reason: `Could not be checked: ${e.message}` };
  }
}

/**
 * Presence and readability as two separate answers.
 *
 * `installed` comes from discovery and `readable` from the resource call, so
 * the four combinations stay distinct instead of collapsing into one status
 * code:
 *
 *   installed + readable    usable
 *   installed + not readable a role to grant
 *   not installed           an operator to install — whatever the resource said
 *   unknown                 say so
 */
export async function probeResource({ group, version, path }) {
  const disco = await apiGroupPresent(group, version);
  if (disco.present === false) {
    return { installed: false, readable: true, usable: false, status: 404, reason: null };
  }
  if (disco.present === null) {
    return { installed: null, readable: null, usable: false, status: disco.status, reason: disco.reason };
  }

  try {
    await ocpGet(path);
    return { installed: true, readable: true, usable: true, status: 200, reason: null };
  } catch (e) {
    const status = statusOf(e);
    if (status === 403) {
      return {
        installed: true, readable: false, usable: false, status,
        reason: "Installed, but this service account may not read it. Grant read on this API group — a cluster-side role binding, no image rebuild.",
      };
    }
    // The group is served but this particular path is not — a namespace that
    // does not exist, most often. The operator is installed either way.
    if (status === 404) return { installed: true, readable: true, usable: false, status, reason: null };
    return { installed: true, readable: null, usable: false, status, reason: `Could not be read: ${e.message}` };
  }
}
