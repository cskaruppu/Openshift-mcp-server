import { useState } from "react";

// User & Access → one person: where they exist, how they log in, every role
// they hold and what it means, live permission checks, and lifecycle actions
// (remove a role, disable / enable, delete, reset password), each a request.

const ago = (iso) => {
  if (!iso) return "—";
  const d = Math.round((Date.now() - Date.parse(iso)) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
};
const day = (iso) => (iso ? String(iso).slice(0, 10) : "—");
const roleClass = (r) => (r === "cluster-admin" ? "adm" : r === "admin" || r === "edit" ? "dev" : "view");

export default function UserDetail({ person, data, label, canApprove, busy, onRequest, onCanI, onRotation, onClose }) {
  const [ci, setCi] = useState({ cluster: Object.keys(person.detail || person.clusters || {})[0] || "local", verb: "delete", resource: "pods", namespace: "" });
  const [ciRes, setCiRes] = useState(null);
  const clustersIn = Object.keys({ ...(person.detail || {}), ...person.clusters }).filter((c) => (person.clusters[c] || []).length || person.detail?.[c]?.exists);
  const local = Object.values(person.detail || {}).some((d) => /htpasswd/.test(d.source || "")) || /htpasswd/.test(person.source || "");
  const sessions = Object.values(person.detail || {}).reduce((a, d) => a + (d.sessions || 0), 0);
  const roles = [...new Set(Object.values(person.clusters).flat().map((g) => g.role))];
  const history = (data.requests || []).filter((r) => r.user === person.name);
  const grantReq = (c, g) => history.find((r) => r.kind === "grant" && r.role === g.role && (r.namespace || "cluster") === g.scope && r.clusters.includes(c) && ["done", "partly done"].includes(r.status));
  const ask = (body, confirmText) => { if (!confirmText || window.confirm(confirmText)) onRequest({ ...body, user: person.name }); };

  return (
    <div className="ua-drawer" role="dialog" aria-modal="true" aria-label={`Access of ${person.name}`}>
      <div className="ua-drawer-in">
        <div className="ua-dh">
          <div>
            <h3>{person.name} {person.disabled && <span className="ua-st crit">Disabled</span>}</h3>
            <p className="vc-muted ua-small">{person.source || "login not known"} · last login {ago(person.lastLogin)} · {sessions} active session{sessions === 1 ? "" : "s"}{person.rotation ? ` · password every ${person.rotation.everyDays} days${person.rotation.overdue ? " (overdue)" : `, next ${day(person.rotation.dueAt)}`}` : ""}</p>
          </div>
          <button className="vc-btn ghost sm" onClick={onClose}>Close</button>
        </div>

        <div className="ua-dacts">
          {person.disabled
            ? <button className="vc-btn primary sm" disabled={!!busy} onClick={() => ask({ kind: "enable", clusters: clustersIn, fromRequest: person.disabled.request, reason: "Re-enable" })}>Enable (restore access)</button>
            : <button className="vc-btn sm" disabled={!!busy || !clustersIn.length} onClick={() => ask({ kind: "disable", clusters: clustersIn, reason: "Suspend access" }, `Disable ${person.name} on ${clustersIn.length} cluster(s)? Their access is suspended and their sessions are ended; Enable restores it.`)}>Disable</button>}
          {local && !person.disabled && <button className="vc-btn sm" disabled={!!busy} onClick={() => ask({ kind: "reset-password", clusters: clustersIn, reason: "Password reset" })}>Reset password</button>}
          <button className="vc-btn danger sm" disabled={!!busy} onClick={() => ask({ kind: "revoke", clusters: clustersIn, reason: "Leaver / removal" }, `Delete ${person.name} from ${clustersIn.length} cluster(s)? This removes their access, local login, user record and sessions. It cannot be undone.`)}>Delete everywhere</button>
          {local && canApprove && (
            <label className="ua-small vc-muted">Rotate password every{" "}
              <select className="ua-in ua-inl" value={person.rotation?.everyDays || ""} onChange={(e) => onRotation(person.name, e.target.value ? Number(e.target.value) : null)}>
                <option value="">never</option>{[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
          )}
        </div>
        <p className="ua-hint">Each action is a request: approved here by another Admin, or in ServiceNow. Disable keeps a record so Enable puts back exactly what was there; Delete does not.</p>

        <div className="vgf-label">Where they exist</div>
        <table className="ua-t">
          <thead><tr><th>Cluster</th><th>Login</th><th>Created</th><th>Sessions</th><th>Status</th></tr></thead>
          <tbody>
            {Object.keys({ ...(person.detail || {}), ...person.clusters }).map((c) => {
              const d = person.detail?.[c] || {};
              return (
                <tr key={c}>
                  <td>{label(c)}</td>
                  <td>{d.source || (d.exists ? d.provider : "has not logged in here")}</td>
                  <td>{day(d.createdAt)}</td>
                  <td>{d.sessions ?? 0}</td>
                  <td>{d.locked ? <span className="ua-flag crit">local login locked</span> : (person.clusters[c] || []).length ? <span className="ua-st ok">active</span> : <span className="vc-muted">no roles</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="vgf-label" style={{ marginTop: 14 }}>Roles</div>
        <table className="ua-t">
          <thead><tr><th>Cluster</th><th>Role</th><th>Where</th><th>Given</th><th>Granted</th><th>Ends</th><th /></tr></thead>
          <tbody>
            {Object.entries(person.clusters).flatMap(([c, gs]) => gs.map((g, i) => {
              const q = grantReq(c, g);
              return (
                <tr key={`${c}${i}`}>
                  <td>{label(c)}</td>
                  <td><span className={"ua-chip " + roleClass(g.role)}>{data.roleDocs?.[g.role]?.label || g.role}</span> <span className="vc-muted ua-small">{g.role}</span></td>
                  <td>{g.scope === "cluster" ? "whole cluster" : `namespace ${g.scope}`}</td>
                  <td>{g.via === "direct" ? <span className="ua-flag warn">directly</span> : <>group {g.via}{g.synced ? <span className="ua-src">AD-synced</span> : null}</>}<div className="vc-muted ua-small">binding {g.binding?.name}{g.binding?.managed ? " · platform" : ""}</div></td>
                  <td className="ua-small">{q ? <>{q.id} · {q.decidedBy}<br />{day(q.decidedAt)}</> : g.binding?.request || day(g.binding?.createdAt)}</td>
                  <td className="ua-small">{q?.expires ? day(q.expires) : "—"}</td>
                  <td>{!person.builtin && (g.synced
                    ? <span className="vc-muted ua-small">remove in AD</span>
                    : <button className="ua-link" disabled={!!busy} onClick={() => ask({ kind: "remove-role", clusters: [c], role: g.role, scope: g.scope, via: g.via, reason: "Role no longer needed" })}>Remove</button>)}</td>
                </tr>
              );
            }))}
            {!Object.values(person.clusters).flat().length && <tr><td colSpan={7} className="vc-muted">No roles.</td></tr>}
          </tbody>
        </table>

        {roles.length > 0 && <>
          <div className="vgf-label" style={{ marginTop: 14 }}>What these roles allow</div>
          <div className="ua-roledocs">
            {roles.map((r) => {
              const d = data.roleDocs?.[r] || {};
              return (
                <div key={r} className="ua-roledoc">
                  <b><span className={"ua-chip " + roleClass(r)}>{d.label || r}</span> <span className="vc-muted ua-small">{r} · {d.scope === "cluster" ? "cluster-wide" : "per namespace"}</span></b>
                  <p>{d.text}</p>
                  {d.cluster?.description && <p className="vc-muted ua-small">OpenShift: {d.cluster.description}</p>}
                  {d.cluster && <p className="vc-muted ua-small">{d.cluster.rules} rules{d.cluster.aggregated ? " (aggregated)" : ""} · verbs: {d.cluster.verbs.join(", ")}</p>}
                </div>
              );
            })}
          </div>
        </>}

        <div className="vgf-label" style={{ marginTop: 14 }}>Can they…?</div>
        <div className="ua-cani">
          <select className="ua-in" value={ci.cluster} onChange={(e) => setCi({ ...ci, cluster: e.target.value })}>{Object.keys({ ...(person.detail || {}), ...person.clusters }).map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
          <select className="ua-in" value={ci.verb} onChange={(e) => setCi({ ...ci, verb: e.target.value })}>{["get", "list", "create", "update", "patch", "delete", "*"].map((v) => <option key={v}>{v}</option>)}</select>
          <input className="ua-in" value={ci.resource} onChange={(e) => setCi({ ...ci, resource: e.target.value.trim() })} placeholder="resource (pods, secrets, nodes…)" />
          <input className="ua-in" value={ci.namespace} onChange={(e) => setCi({ ...ci, namespace: e.target.value.trim() })} placeholder="namespace (empty = cluster)" />
          <button className="vc-btn sm" onClick={async () => setCiRes(await onCanI({ ...ci, user: person.name }))}>Check</button>
        </div>
        {ciRes && <p className={"ua-small " + (ciRes.error ? "ua-flag crit" : ciRes.allowed ? "ua-flag ok" : "ua-flag warn")}>{ciRes.error || `${ciRes.allowed ? "Yes" : "No"}: ${person.name} ${ciRes.allowed ? "can" : "cannot"} ${ci.verb} ${ci.resource}${ci.namespace ? ` in ${ci.namespace}` : " cluster-wide"} on ${label(ci.cluster)}.${ciRes.reason ? ` (${ciRes.reason})` : ""}`}</p>}

        <div className="vgf-label" style={{ marginTop: 14 }}>History</div>
        <ul className="ua-hist">
          {history.slice(0, 20).map((r) => <li key={r.id}><span className="ua-small vc-muted">{day(r.requestedAt)}</span> <b>{r.id}</b> {r.title} · <i>{r.status}</i>{r.decidedBy ? ` · by ${r.decidedBy}` : ""}</li>)}
          {!history.length && <li className="vc-muted">No changes through the platform yet.</li>}
        </ul>
      </div>
    </div>
  );
}
