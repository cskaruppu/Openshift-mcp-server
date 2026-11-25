import { useState, useEffect, useCallback, useMemo } from "react";
import { showToast } from "../../store/toastStore";
import UserDetail from "./UserDetail";
import { Governance, Reviews } from "./Governance";

// Automation Hub → User & Access (services/user-access.js): who can log in to
// which cluster and with what rights, across every cluster; changes go in as
// requests that an Admin approves before anything touches a cluster.

const ago = (iso) => {
  if (!iso) return null;
  const d = Math.round((Date.now() - Date.parse(iso)) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
};
const roleClass = (r) => (r === "cluster-admin" ? "adm" : r === "admin" || r === "edit" ? "dev" : "view");
const STATUS_CLASS = { pending: "wait", running: "wait", done: "ok", "partly done": "warn", failed: "crit", rejected: "muted" };

async function call(path, { method = "GET", body } = {}) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

export default function UserAccess({ clusters = [] }) {
  const all = useMemo(() => (clusters.length ? clusters : ["local"]), [clusters]);
  const [labels, setLabels] = useState({});
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState("");
  const [onlyFlags, setOnlyFlags] = useState(false);
  const [secret, setSecret] = useState(null);       // { user, password, id } shown once
  const [f, setF] = useState({ mode: "directory", user: "", clusters: [], role: "edit", namespace: "", expires: "", hours: "", delivery: "direct", reason: "" });
  const [tab, setTab] = useState("people");
  const [fc, setFc] = useState("");   // filter: one cluster
  const [sel, setSel] = useState(null);

  useEffect(() => { fetch("/api/cluster-labels").then((r) => r.json()).then((j) => setLabels(j.labels || {})).catch(() => {}); }, []);
  const label = (c) => (c === "local" ? labels.local || "This cluster" : labels[c] || c);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setData(await call(`/api/user-access?clusters=${encodeURIComponent(all.join(","))}`)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [all]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setF((x) => (x.clusters.length ? x : { ...x, clusters: all.slice(0, 1) })); }, [all]);

  const roleInfo = data?.roles?.find((r) => r.id === f.role);
  const ready = f.user.trim() && f.clusters.length && (roleInfo?.clusterWide || f.namespace.trim());

  const [viaSnow, setViaSnow] = useState(true);
  const submit = async (body) => {
    setBusy("submit");
    try {
      const r = await call("/api/user-access/requests", { method: "POST", body });
      // Send it to ServiceNow for approval as well: approved there, it is applied.
      let t = null;
      if (viaSnow) t = await call(`/api/user-access/requests/${r.id}/ticket`, { method: "POST", body: {} }).catch((e) => ({ error: e.message }));
      showToast(t?.number ? `${r.id} sent for approval in ServiceNow (${t.number})` : t?.error ? `${r.id} submitted; ServiceNow: ${t.error}` : `${r.id} submitted for approval`, t?.error ? "err" : "ok");
      if (body.kind === "grant") setF((x) => ({ ...x, user: "", reason: "" }));
      load();
    } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  };
  const decide = async (id, what) => {
    setBusy(id + what);
    try {
      const r = await call(`/api/user-access/requests/${id}/${what}`, { method: "POST", body: {} });
      if (what === "approve") {
        showToast(`${id}: ${r.status}`, r.status === "done" ? "ok" : "err");
        if (r.password) setSecret({ id, user: r.user, password: r.password });
        if (r.manifests) download(`${id}.yaml`, r.manifests);
      } else if (what === "ticket") showToast(r.number ? `ServiceNow ${r.number}` : "Change request raised", "ok");
      else showToast(`${id} rejected`, "ok");
      load();
    } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  };
  const download = (name, text) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (!data && !err) return <div className="vgf-empty">{loading ? "Reading users, groups and role bindings from every cluster…" : "No clusters connected yet."}</div>;
  if (err && !data) return <div className="ot-err">{err}</div>;

  const k = data.kpis;
  const okClusters = data.clusters.filter((c) => c.ok).map((c) => c.cluster);
  const people = data.people.filter((p) => (!q || p.name.toLowerCase().includes(q.toLowerCase()) || Object.values(p.clusters).flat().some((g) => (g.scope || "").includes(q) || (g.via || "").includes(q)))
    && (!onlyFlags || p.flags.length));
  const pending = data.requests.filter((r) => r.status === "pending");
  const recent = data.requests.filter((r) => r.status !== "pending").slice(0, 6);
  const inactive = data.people.filter((p) => p.flags.some((x) => /last login/.test(x.text)));

  return (
    <div className="ua">
      <div className="ot-intro">
        <div>
          <h3>User &amp; Access</h3>
          <p>Who can log in to which cluster, and with what rights. Add or remove access on many clusters at once; every change is approved before it is applied, and recorded.</p>
        </div>
        <div className="ot-intro-r">
          <button className={"vc-btn sm" + (onlyFlags ? " primary" : "")} onClick={() => { setTab("people"); setOnlyFlags((v) => !v); }}>{onlyFlags ? "Showing what needs a look" : "Needs a look"}</button>
          <button className="vc-btn ghost sm" disabled={loading} onClick={load}>{loading ? "Reading…" : "Refresh"}</button>
        </div>
      </div>

      <div className="ua-kpis">
        <div className="ua-kpi"><b>{k.clusters}</b><span>clusters · {k.companyLogin} with company login{k.reachable < k.clusters ? ` · ${k.clusters - k.reachable} not reachable` : ""}</span></div>
        <div className="ua-kpi"><b>{k.people}</b><span>people with access</span></div>
        <div className={"ua-kpi" + (k.directAdmins ? " warn" : "")}><b>{k.clusterAdmins}</b><span>cluster-admins{k.directAdmins ? ` (${k.directAdmins} given directly)` : ""}</span></div>
        <div className={"ua-kpi" + (k.kubeadmin ? " crit" : "")}><b>{k.kubeadmin}</b><span>clusters still have kubeadmin</span></div>
        <div className={"ua-kpi" + (k.inactive ? " warn" : "")}><b>{k.inactive}</b><span>not logged in for 90+ days</span></div>
        <div className="ua-kpi"><b>{k.pending}</b><span>requests waiting for approval</span></div>
      </div>

      <div className="ua-tabs" role="tablist">
        {[["people", "People and requests"], ["gov", `Governance${(k.unofficial || 0) + (k.sod || 0) + (k.leavers || 0) ? ` (${(k.unofficial || 0) + (k.sod || 0) + (k.leavers || 0)})` : ""}`], ["reviews", `Access reviews${(data.reviews || []).filter((r) => r.status === "open").length ? ` (${(data.reviews || []).filter((r) => r.status === "open").length} open)` : ""}`]].map(([v, l]) => (
          <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? "on" : ""} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>
      {tab === "gov" && <Governance data={data} label={label} canApprove={!!data.you?.canApprove} busy={busy} clustersParam={all.join(",")} onRequest={submit} onOpenPerson={(n) => setSel(n)}
        onAccept={async (keys) => { try { await call("/api/user-access/baseline", { method: "POST", body: { keys } }); showToast(`${keys.length} accepted as approved`, "ok"); load(); } catch (e) { showToast(e.message, "err"); } }} />}
      {tab === "reviews" && <Reviews data={data} label={label} canApprove={!!data.you?.canApprove} clustersParam={all.join(",")} onChanged={load} toast={showToast} />}

      {tab === "people" && <div className="ua-grid">
        {/* ── add access ── */}
        <div className="vc-card ua-add">
          <div className="vgf-label">Add access <span>to one person, on many clusters</span></div>
          <div className="ua-step"><b className="ua-n">1</b><div>
            <p className="ua-sh">Who</p>
            <div className="ua-seg">
              <button className={f.mode === "directory" ? "on" : ""} onClick={() => setF({ ...f, mode: "directory" })}>Company login (AD / SSO)</button>
              <button className={f.mode === "htpasswd" ? "on" : ""} onClick={() => setF({ ...f, mode: "htpasswd", delivery: "direct" })}>Local user (htpasswd)</button>
            </div>
            <input className="ua-in" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value.trim() })} placeholder={f.mode === "directory" ? "OpenShift user name, as their company login shows it (e.g. priya.sharma)" : "New local user name (e.g. lab-user1)"} maxLength={128} />
            <p className="ua-hint">{f.mode === "directory" ? "No password is created; they log in with their company account." : "A password is generated when the request is approved and shown once to the approver. Use for labs and emergency accounts only."}</p>
          </div></div>
          <div className="ua-step"><b className="ua-n">2</b><div>
            <p className="ua-sh">Where</p>
            <div className="ua-cl">
              {all.map((c) => {
                const on = f.clusters.includes(c);
                const row = data.clusters.find((x) => x.cluster === c);
                return (
                  <label key={c} className={"ua-cb" + (on ? " on" : "")}>
                    <input type="checkbox" checked={on} onChange={() => setF({ ...f, clusters: on ? f.clusters.filter((x) => x !== c) : [...f.clusters, c] })} />
                    <span>{label(c)}</span>
                    <small>{row?.ok ? (row.idps.some((p) => p.company) ? "company login" : "htpasswd only") : "not reachable"}</small>
                  </label>
                );
              })}
            </div>
          </div></div>
          <div className="ua-step"><b className="ua-n">3</b><div>
            <p className="ua-sh">Role and how long</p>
            <div className="ua-row">
              <select className="ua-in" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {(data.roles || []).map((r) => <option key={r.id} value={r.id}>{r.label} ({r.id})</option>)}
              </select>
              {!roleInfo?.clusterWide && <input className="ua-in" value={f.namespace} onChange={(e) => setF({ ...f, namespace: e.target.value.trim() })} placeholder="namespace" maxLength={63} />}
              <select className="ua-in" value={f.hours ? `h${f.hours}` : f.expires !== "" || f.dur === "date" ? "date" : "none"} onChange={(e) => { const v = e.target.value; setF({ ...f, hours: v.startsWith("h") ? Number(v.slice(1)) : "", expires: v === "date" ? f.expires : "", dur: v }); }} aria-label="How long">
                <option value="none">No end date</option><option value="date">Until a date…</option>
                {[1, 2, 4, 8, 24, 72].map((h) => <option key={h} value={`h${h}`}>Temporary: {h} h</option>)}
              </select>
              {(f.dur === "date" || f.expires) && <input className="ua-in" type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} aria-label="Access ends on" />}
            </div>
          </div></div>
          <div className="ua-step"><b className="ua-n">4</b><div>
            <p className="ua-sh">How it is applied</p>
            <div className="ua-seg">
              {[["direct", "Directly, through the agents"], ["acm", "ACM policy"], ["gitops", "GitOps manifests"]].map(([v, l]) => (
                <button key={v} className={f.delivery === v ? "on" : ""} disabled={f.mode === "htpasswd" && v !== "direct"} onClick={() => setF({ ...f, delivery: v })}>{l}</button>
              ))}
            </div>
            <input className="ua-in" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Reason (optional, goes to the approver and ServiceNow)" maxLength={300} />
            <div className="ua-preview">
              {ready ? <>On <b>{f.clusters.length} cluster{f.clusters.length > 1 ? "s" : ""}</b>: {f.mode === "htpasswd" ? <>create a local login for <b>{f.user}</b>, </> : null}add <b>{f.user}</b> to group <b>tcs-{f.role}-{roleInfo?.clusterWide ? "cluster" : f.namespace}</b> and bind it to <b>{f.role}</b>{roleInfo?.clusterWide ? " cluster-wide" : <> in namespace <b>{f.namespace}</b></>}.
                {f.delivery !== "direct" ? <> Nothing is applied: you get the {f.delivery === "acm" ? "ACM policy" : "manifests"} to apply.</> : null}
                {f.hours ? <> Temporary: removed automatically <b>{f.hours} h</b> after approval.</> : f.expires ? <> Access is removed automatically on <b>{f.expires}</b>.</> : null}</>
                : "Fill in who, where and the role to see exactly what will change."}
            </div>
            <div className="ua-acts">
              <button className="vc-btn primary" disabled={!ready || !!busy} onClick={() => submit({ kind: "grant", ...f, expires: f.hours ? null : f.expires || null, hours: f.hours || null })}>{busy === "submit" ? "Submitting…" : "Submit for approval"}</button>
              <label className="ua-small ua-snowck"><input type="checkbox" checked={viaSnow} onChange={(e) => setViaSnow(e.target.checked)} /> Approve in ServiceNow</label>
            </div>
            <p className="ua-hint">{viaSnow
              ? "A ServiceNow change request is raised; when it is approved there, the change is applied automatically. An Admin can also approve it here."
              : `Approved here by an Admin${data.you?.selfApprove ? "" : " other than you"}.`}
              {f.mode === "htpasswd" ? " Local users are applied by an Admin here even after ServiceNow approval, because the password is shown to that person once." : ""}</p>
          </div></div>
        </div>

        <div className="ua-right">
          {/* ── who has access ── */}
          <div className="vc-card">
            <div className="vgf-label">Who has access <span className="ua-filters">
              <select className="ua-search ua-fsel" value={fc} onChange={(e) => setFc(e.target.value)} aria-label="Cluster">
                <option value="">All clusters</option>
                {data.clusters.filter((c) => c.ok).map((c) => <option key={c.cluster} value={c.cluster}>{label(c.cluster)}</option>)}
              </select>
              <input className="ua-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search person, namespace or group" />
            </span></div>
            <div className="ua-tablewrap">
              <table className="ua-t">
                <thead><tr><th style={{ width: "24%" }}>Person</th><th>Clusters and roles</th><th style={{ width: "24%" }} /></tr></thead>
                <tbody>
                  {people.slice(0, 80).map((p) => {
                    // The clusters this person is on, each with its roles; one chip per role and scope.
                    const on = okClusters.filter((c) => (!fc || c === fc) && (p.builtin ? p.kubeadmin?.[c] : (p.clusters[c] || []).length || p.detail?.[c]?.exists));
                    if (fc && !on.length) return null;
                    const rolesOn = (c) => {
                      const by = new Map();
                      for (const g of p.clusters[c] || []) { const key = `${g.role}|${g.scope}`; by.set(key, [...(by.get(key) || []), g.via]); }
                      return [...by].map(([key, via]) => { const [role, scope] = key.split("|"); return { role, scope, via }; })
                        .sort((a, b) => ["cluster-admin", "cluster-reader", "admin", "edit", "view"].indexOf(a.role) - ["cluster-admin", "cluster-reader", "admin", "edit", "view"].indexOf(b.role));
                    };
                    return (
                    <tr key={p.name}>
                      <td><button className="ua-name" onClick={() => setSel(p.name)}>{p.name}</button>{p.disabled && <span className="ua-src ht">disabled</span>}{p.source && <span className={"ua-src" + (/htpasswd|built-in/.test(p.source) ? " ht" : "")}>{p.source}</span>}{p.lastLogin && <div className="vc-muted ua-small">last login {ago(p.lastLogin)}</div>}</td>
                      <td>
                        {on.length ? on.map((c) => {
                          const gs = p.builtin ? [{ role: "cluster-admin", scope: "cluster", via: ["built-in"] }] : rolesOn(c);
                          return (
                            <div key={c} className="ua-cr">
                              <span className="ua-crn">{label(c)}</span>
                              <span>{gs.length ? gs.slice(0, 4).map((g, i) => <span key={i} className={"ua-chip " + roleClass(g.role)} title={g.via.map((v) => (v === "direct" ? "given directly" : v === "built-in" ? "built-in account" : `via group ${v}`)).join(", ")}>{p.builtin ? "present" : g.role}{g.scope !== "cluster" ? ` · ${g.scope}` : ""}</span>) : <span className="vc-muted ua-small">no roles</span>}
                                {gs.length > 4 && <button className="ua-link" onClick={() => setSel(p.name)}>+{gs.length - 4} more</button>}</span>
                            </div>
                          );
                        }) : <span className="vc-muted">—</span>}
                      </td>
                      <td className="ua-flagcell">
                        {p.flags.slice(0, 1).map((x, i) => <div key={i} className={"ua-flag " + x.level}>{x.text}</div>)}
                        {p.builtin
                          ? k.kubeadmin > 0 && <button className="ua-link" disabled={!!busy} onClick={() => submit({ kind: "remove-kubeadmin", clusters: on, reason: "Company login in place" })}>Request removal</button>
                          : <button className="ua-link" disabled={!!busy || !on.length} onClick={() => { if (window.confirm(`Request removal of ${p.name} from ${on.length} cluster${on.length > 1 ? "s" : ""}: ${on.map(label).join(", ")}?`)) submit({ kind: "revoke", clusters: on, user: p.name, reason: p.flags.map((x) => x.text).join("; ") }); }}>{fc ? "Remove from this cluster" : "Remove everywhere"}</button>}
                      </td>
                    </tr>
                    );
                  })}
                  {!people.filter((p) => !fc || (p.builtin ? p.kubeadmin?.[fc] : (p.clusters[fc] || []).length || p.detail?.[fc]?.exists)).length && <tr><td colSpan={3} className="vc-muted">{onlyFlags ? "Nothing needs a look." : "No one matches."}</td></tr>}
                </tbody>
              </table>
            </div>
            {onlyFlags && inactive.length > 0 && (
              <button className="vc-btn sm" disabled={!!busy} onClick={() => inactive.forEach((p) => submit({ kind: "revoke", clusters: okClusters, user: p.name, reason: "Access review: inactive for 90+ days" }))}>Request removal of {inactive.length} inactive {inactive.length > 1 ? "people" : "person"}</button>
            )}
          </div>

          {/* ── login methods ── */}
          <div className="vc-card">
            <div className="vgf-label">Login methods per cluster <span>OAuth identity providers</span></div>
            <div className="ua-idp">
              {data.clusters.map((c) => (
                <div key={c.cluster} className="ua-ic">
                  <b>{label(c.cluster)}</b>
                  {c.ok ? (<>
                    <div className="ua-pills">{c.idps.length ? c.idps.map((p) => <span key={p.name} className={"ua-pill " + (p.type === "HTPasswd" ? "ht" : p.type === "OpenID" ? "sso" : "ad")}>{p.label}</span>) : <span className="ua-pill ht">none</span>}</div>
                    <span className="vc-muted ua-small">
                      {!c.idps.some((p) => p.company) ? "No company login yet: add an LDAP or OpenID provider to the OAuth config. " : ""}
                      {c.lastGroupSync ? `Group sync ${ago(c.lastGroupSync)}. ` : ""}
                      {c.htpasswdDiffers ? `htpasswd differs from ${label(c.htpasswdDiffers.from)} (${c.htpasswdDiffers.users} user${c.htpasswdDiffers.users > 1 ? "s" : ""}). ` : ""}
                      {c.lastLoginKnown ? "" : "Last logins not readable here. "}
                    </span>
                  </>) : <span className="ua-flag crit">Not reachable: {c.error}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* ── requests ── */}
          <div className="vc-card">
            <div className="vgf-label">Requests <span>every change is approved first, and recorded in the audit trail</span></div>
            <table className="ua-t ua-req">
              <tbody>
                {[...pending, ...recent].map((r) => (
                  <tr key={r.id}>
                    <td><span className={"ua-st " + (STATUS_CLASS[r.status] || "")}>{r.status}</span></td>
                    <td><b>{r.id}</b> · {r.title}{r.reason ? <span className="vc-muted"> · {r.reason}</span> : null}
                      {r.results && <div className="ua-small">{r.results.map((x) => <div key={x.cluster} className={x.ok ? "vc-muted" : "ua-flag crit"}>{label(x.cluster)}: {x.text}</div>)}</div>}
                      {r.expired && <div className="ua-small vc-muted">Expired {ago(r.expired.at)}</div>}
                      {r.status === "pending" && <div className="ua-small ua-wait">{
                        r.snApproved ? `Approved in ServiceNow ${r.ticket}: an Admin applies it here to receive the one-time password.`
                          : r.ticket ? `Waiting for approval of ${r.ticket} in ServiceNow${data.you?.canApprove && r.requestedBy !== data.you.name ? ", or approve it here" : ""}.`
                            : r.requestedBy === data.you?.name && !data.you?.selfApprove ? "Waiting for another Admin, or send it to ServiceNow for approval." : "Waiting for an Admin."}</div>}
                      {r.decidedBy && r.status !== "pending" && <div className="ua-small vc-muted">{r.status === "rejected" ? "Rejected" : "Approved"} by {r.decidedBy}</div>}</td>
                    <td className="ua-small vc-muted">{r.requestedBy} · {ago(r.requestedAt)}{r.ticket ? ` · ${r.ticket}` : ""}</td>
                    <td className="ua-acts2">
                      {r.status === "pending" && data.you?.canApprove && (data.you.selfApprove || r.requestedBy !== data.you.name) && <>
                        <button className="vc-btn primary sm" disabled={!!busy} onClick={() => decide(r.id, "approve")}>{busy === r.id + "approve" ? "Applying…" : "Approve"}</button>
                        <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => decide(r.id, "reject")}>Reject</button>
                      </>}
                      {!r.ticket && r.status === "pending" && <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => decide(r.id, "ticket")}>Send to ServiceNow</button>}
                      {r.kind === "grant" && r.mode !== "htpasswd" && <a className="ua-link" href={`/api/user-access/requests/${r.id}/manifest`}>YAML</a>}
                    </td>
                  </tr>
                ))}
                {!pending.length && !recent.length && <tr><td className="vc-muted">No requests yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>}

      {sel && (() => {
        const person = data.people.find((p) => p.name === sel) || { name: sel, clusters: {}, detail: {}, flags: [] };
        return <UserDetail person={person} data={data} label={label} canApprove={!!data.you?.canApprove} busy={busy}
          onRequest={(b) => submit(b)} onClose={() => setSel(null)}
          onCanI={async (b) => { try { return await call("/api/user-access/can-i", { method: "POST", body: b }); } catch (e) { return { error: e.message }; } }}
          onRotation={async (user, everyDays) => { try { await call("/api/user-access/rotation", { method: "POST", body: { user, everyDays } }); showToast(everyDays ? `Rotation every ${everyDays} days` : "Rotation off", "ok"); load(); } catch (e) { showToast(e.message, "err"); } }} />;
      })()}

      {secret && (
        <div className="ua-modal" role="dialog" aria-modal="true">
          <div className="ua-modal-in">
            <h3>Password for {secret.user}</h3>
            <p>Shown once, now. It is not stored anywhere; hand it to the person over a secure channel. htpasswd has no self-service password change: use Reset password on the person when it needs changing.</p>
            <code className="ua-pw">{secret.password}</code>
            <div className="ua-acts">
              <button className="vc-btn" onClick={() => navigator.clipboard?.writeText(secret.password).then(() => showToast("Copied", "ok"))}>Copy</button>
              <button className="vc-btn primary" onClick={() => setSecret(null)}>I have saved it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
