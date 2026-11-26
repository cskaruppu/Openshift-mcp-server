import { useState, useEffect } from "react";

// User & Access → Governance and Access reviews.

const day = (iso) => (iso ? String(iso).slice(0, 10) : "—");

export function Governance({ data, label, canApprove, busy, onRequest, onAccept, onOpenPerson, clustersParam }) {
  const g = data.governance || { unofficial: [], sod: [], leavers: [], privilegedSAs: [] };
  const rot = data.people.filter((p) => p.rotation);
  return (
    <div className="ua-gov">
      <div className="vc-card">
        <div className="vgf-label">Unofficial access <span>cluster-admin and admin grants not made through the platform</span></div>
        <p className="ua-hint">Someone gave these by hand (for example with <span className="vc-mono">oc adm policy</span>). Accept the ones that are intended, so only new ones are flagged; request removal of the rest.</p>
        {g.unofficial.length > 0 && canApprove && <button className="vc-btn sm" disabled={!!busy} onClick={() => { if (window.confirm(`Accept all ${g.unofficial.length} as approved? Only grants made by hand after today will be flagged.`)) onAccept(g.unofficial.map((u) => u.key)); }}>Accept all {g.unofficial.length} as today’s approved state</button>}
        <table className="ua-t">
          <thead><tr><th>Cluster</th><th>Role</th><th>Given to</th><th>Binding</th><th>Created</th><th /></tr></thead>
          <tbody>
            {g.unofficial.slice(0, 100).map((u) => (
              <tr key={u.key}>
                <td>{label(u.cluster)}</td>
                <td><span className={"ua-chip " + (u.role === "cluster-admin" ? "adm" : "dev")}>{u.role}</span>{u.namespace ? <span className="vc-muted ua-small"> · {u.namespace}</span> : null}</td>
                <td>{u.subjectKind === "User" ? <button className="ua-link" onClick={() => onOpenPerson(u.subject)}>{u.subject}</button> : <>group {u.subject}</>}</td>
                <td className="ua-small">{u.binding}</td>
                <td className="ua-small">{day(u.createdAt)}</td>
                <td className="ua-acts2">
                  {canApprove && <button className="ua-link" disabled={!!busy} onClick={() => onAccept([u.key])}>Accept</button>}
                  <button className="ua-link" disabled={!!busy} onClick={() => onRequest({ kind: "remove-binding", clusters: [u.cluster], binding: u.binding, namespace: u.namespace, subjectKind: u.subjectKind, subject: u.subject, role: u.role, user: u.subjectKind === "User" ? u.subject : "group-binding", reason: "Unofficial grant" })}>Request removal</button>
                </td>
              </tr>
            ))}
            {!g.unofficial.length && <tr><td colSpan={6} className="vc-muted">None: every cluster-admin and admin grant was made through the platform or accepted.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="ua-gov2">
        <div className="vc-card">
          <div className="vgf-label">Separation of duties <span>rules checked on every read</span></div>
          <ul className="ua-list">
            {g.sod.map((s, i) => <li key={i}><span className="ua-flag warn">{s.text}</span><br /><button className="ua-link" onClick={() => onOpenPerson(s.person)}>{s.person}</button> <span className="vc-muted ua-small">on {s.clusters.map(label).join(", ")}</span></li>)}
            {!g.sod.length && <li className="vc-muted">No conflicts found.</li>}
          </ul>
          <p className="ua-hint">Rules: no cluster-admin given directly to a person; no local (htpasswd) cluster-admin on production; approvers do not also hold cluster-admin on production; no standing cluster-admin on every cluster. Production = cluster names matching <span className="vc-mono">USER_ACCESS_PROD_PATTERN</span> (default “prod”).</p>
        </div>
        <div className="vc-card">
          <div className="vgf-label">Possible leavers <span>logs in through AD, but in no AD-synced group any more</span></div>
          <ul className="ua-list">
            {g.leavers.map((l) => <li key={l.person}><button className="ua-link" onClick={() => onOpenPerson(l.person)}>{l.person}</button> <span className="vc-muted ua-small">on {l.clusters.map(label).join(", ")}</span>{" "}
              <button className="ua-link" disabled={!!busy} onClick={() => onRequest({ kind: "disable", clusters: l.clusters, user: l.person, reason: "Possible leaver: no longer in any AD-synced group" })}>Disable</button></li>)}
            {!g.leavers.length && <li className="vc-muted">None found (needs LDAP group sync on the cluster).</li>}
          </ul>
        </div>
        <div className="vc-card">
          <div className="vgf-label">Password rotation <span>local (htpasswd) users with a rule</span></div>
          <ul className="ua-list">
            {rot.map((p) => <li key={p.name}><button className="ua-link" onClick={() => onOpenPerson(p.name)}>{p.name}</button> <span className={"ua-small " + (p.rotation.overdue ? "ua-flag warn" : "vc-muted")}>every {p.rotation.everyDays} days · {p.rotation.lastSetAt ? `last set ${day(p.rotation.lastSetAt)}` : "never set by the platform"}{p.rotation.overdue ? " · overdue" : ` · next ${day(p.rotation.dueAt)}`}</span>
              {p.rotation.overdue && <> <button className="ua-link" disabled={!!busy} onClick={() => onRequest({ kind: "reset-password", clusters: Object.keys(p.detail || p.clusters), user: p.name, reason: "Scheduled rotation" })}>Reset now</button></>}</li>)}
            {!rot.length && <li className="vc-muted">No rules yet: open a local user and set “Rotate password every…”.</li>}
          </ul>
        </div>
        <div className="vc-card">
          <div className="vgf-label">Privileged service accounts <span>cluster-admin or admin outside the platform’s own namespaces</span></div>
          <ul className="ua-list">
            {g.privilegedSAs.slice(0, 40).map((s, i) => <li key={i}><b>{s.namespace}/{s.name}</b> <span className="vc-muted ua-small">{s.role} · {s.scope === "cluster" ? "cluster-wide" : s.scope} · {label(s.cluster)} · binding {s.binding}</span></li>)}
            {!g.privilegedSAs.length && <li className="vc-muted">None.</li>}
          </ul>
        </div>
      </div>

      <div className="vc-card ua-row2">
        <div>
          <div className="vgf-label">Entitlement report <span>for auditors</span></div>
          <p className="ua-hint">One row per person, cluster and role: how it is given, the binding, the request and who approved it, and when it ends.</p>
        </div>
        <a className="vc-btn primary sm" href={`/api/user-access/report.csv?clusters=${encodeURIComponent(clustersParam)}`}>Download CSV</a>
      </div>
      <p className="ua-hint">Access requests, approvals, expiries and reviews are also sent to the notification channels set up in Settings (Teams, Slack, e-mail), when there are any.</p>
    </div>
  );
}

async function call(path, { method = "GET", body } = {}) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

export function Reviews({ data, label, canApprove, clustersParam, onChanged, toast, hints = null }) {
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({ name: `Access review ${new Date().toISOString().slice(0, 7)}`, due: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), scope: "privileged" });
  const [busy, setBusy] = useState(false);
  const [removeUnreviewed, setRemoveUnreviewed] = useState(false);
  const load = async (id) => { try { setOpen(await call(`/api/user-access/reviews/${id}`)); } catch (e) { toast(e.message, "err"); } };
  useEffect(() => { if (open) load(open.id); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn) => { setBusy(true); try { await fn(); onChanged(); } catch (e) { toast(e.message, "err"); } finally { setBusy(false); } };
  const decide = (items) => act(async () => { await call(`/api/user-access/reviews/${open.id}/decide`, { method: "POST", body: { decisions: items } }); await load(open.id); });

  return (
    <div className="ua-gov">
      <div className="vc-card">
        <div className="vgf-label">Access reviews <span>people confirm or remove each grant; removals become requests</span></div>
        {canApprove && (
          <div className="ua-cani">
            <input className="ua-in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} />
            <select className="ua-in" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}><option value="privileged">cluster-admin and admin only</option><option value="all">every role</option></select>
            <input className="ua-in" type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} aria-label="Due" />
            <button className="vc-btn primary sm" disabled={busy} onClick={() => act(async () => { const r = await call(`/api/user-access/reviews?clusters=${encodeURIComponent(clustersParam)}`, { method: "POST", body: form }); toast(`${r.id} started: ${r.items} grants`, "ok"); await load(r.id); })}>Start review</button>
          </div>
        )}
        <table className="ua-t">
          <thead><tr><th>Review</th><th>Scope</th><th>Due</th><th>Progress</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(data.reviews || []).map((r) => (
              <tr key={r.id}>
                <td><b>{r.id}</b> {r.name}<div className="vc-muted ua-small">by {r.createdBy} · {day(r.createdAt)}</div></td>
                <td>{r.scope === "all" ? "every role" : "privileged"}</td>
                <td>{day(r.due)}</td>
                <td>{r.decided}/{r.items} decided · {r.keep} keep · {r.remove} remove</td>
                <td><span className={"ua-st " + (r.status === "open" ? "wait" : "ok")}>{r.status}</span>{r.requests?.length ? <div className="vc-muted ua-small">{r.requests.length} request{r.requests.length > 1 ? "s" : ""} raised</div> : null}</td>
                <td><button className="ua-link" onClick={() => load(r.id)}>Open</button></td>
              </tr>
            ))}
            {!(data.reviews || []).length && <tr><td colSpan={6} className="vc-muted">No reviews yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="vc-card">
          <div className="vgf-label">{open.id} · {open.name} <span>due {day(open.due)} · {open.status}</span></div>
          {open.status === "open" && (
            <div className="ua-acts">
              <button className="vc-btn sm" disabled={busy} onClick={() => decide(open.items.filter((i) => !i.decision).map((i) => ({ key: i.key, decision: "keep" })))}>Keep all undecided</button>
              {canApprove && <>
                <label className="ua-small vc-muted"><input type="checkbox" checked={removeUnreviewed} onChange={(e) => setRemoveUnreviewed(e.target.checked)} /> also remove grants nobody confirmed</label>
                <button className="vc-btn primary sm" disabled={busy} onClick={() => act(async () => { const r = await call(`/api/user-access/reviews/${open.id}/close`, { method: "POST", body: { removeUnreviewed } }); toast(`${r.id} closed: ${r.requests.length} removal request(s)`, "ok"); await load(open.id); })}>Close review</button>
              </>}
            </div>
          )}
          <div className="ua-tablewrap">
            <table className="ua-t">
              <thead><tr><th>Person</th><th>Cluster</th><th>Role</th><th>Where</th><th>Given</th><th>Suggested</th><th>Decision</th></tr></thead>
              <tbody>
                {open.items.map((i) => (
                  <tr key={i.key}>
                    <td><b>{i.person}</b></td><td>{label(i.cluster)}</td><td>{i.role}</td><td>{i.scope}</td>
                    <td className="ua-small">{i.via === "direct" ? "directly" : `group ${i.via}`}{i.synced ? " (AD)" : ""}</td>
                    <td className="ua-small">{(() => { const h = hints?.[`${i.person}|${i.cluster}|${i.role}|${i.scope}`]; return h ? <><span className={"ua-flag " + (h.suggest === "remove" ? "warn" : "ok")}>{h.suggest === "remove" ? "Remove" : "Keep"}</span> <span className="vc-muted">{h.why}</span></> : <span className="vc-muted">—</span>; })()}</td>
                    <td>{open.status === "open"
                      ? <span className="ua-seg ua-seg-sm">
                        <button className={i.decision === "keep" ? "on" : ""} disabled={busy} onClick={() => decide([{ key: i.key, decision: "keep" }])}>Keep</button>
                        <button className={i.decision === "remove" ? "on" : ""} disabled={busy} onClick={() => decide([{ key: i.key, decision: "remove" }])}>Remove</button>
                      </span>
                      : <span className="ua-small">{i.decision || "not decided"}</span>}
                      {i.by && <div className="vc-muted ua-small">{i.by}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
