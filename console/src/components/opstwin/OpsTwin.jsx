import { useState, useEffect, useCallback, useMemo } from "react";
import { clusterUrl } from "../../api/client";
import { showToast } from "../../store/toastStore";

// Automation Hub → Ops Twin: what-if simulations on a live copy of a cluster
// (services/ops-twin.js). Pick a scenario, see what moves where, what cannot,
// what stops and what to do first, then raise the change with the evidence.
// Nothing here changes the cluster.

const gib = (mib) => (mib == null ? "—" : `${Math.round((mib / 1024) * 10) / 10} GiB`);
const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const LEVEL_WORD = { ok: "OK", warn: "Action", crit: "Stops", info: "" };
const ICON = { ok: "✓", warn: "!", crit: "✕", info: "•" };

// Industry scenarios: real situations, each a preset of a what-if.
const LIBRARY = [
  { sector: "Retail", title: "Festive sale, ×3 traffic", text: "Can the storefront take three times the load?", kind: "peak", set: { factor: 3 } },
  { sector: "Banking", title: "Month-end batch, ×2", text: "Payments and batch at twice the load", kind: "peak", set: { factor: 2 } },
  { sector: "Banking", title: "DR failover drill", text: "Can the DR cluster run everything?", kind: "dr", set: {} },
  { sector: "Manufacturing", title: "Plant patching in 4 h", text: "Patch every node inside the line's maintenance window", kind: "window", set: { windowHours: 4 } },
  { sector: "Healthcare", title: "Zero-downtime patching", text: "Clinical apps marked critical: any single replica stops the plan", kind: "window", set: { windowHours: 8 }, critical: /clinic|ehr|emr|his|pacs|lab|patient|health/ },
  { sector: "Telecom", title: "Fleet upgrade plan", text: "Every cluster, dev first, production last", kind: "fleet", set: {} },
  { sector: "Private AI", title: "Add a 70B model", text: "About 140 GiB of GPU memory", kind: "add-model", set: { gpuGiB: 140, name: "llama-70b" } },
  { sector: "Private AI", title: "A GPU fails", text: "Where do its models go?", kind: "gpu-fail", set: {} },
  { sector: "VMware exit", title: "Bring 300 VMs", text: "4 vCPU and 16 GiB each: nodes needed", kind: "add-vms", set: { count: 300, cpu: 4, memGiB: 16 } },
  { sector: "Security", title: "Compromised node", text: "What an attacker on one node can reach", kind: "blast", set: { blastBy: "node" } },
  { sector: "Data centre", title: "Site or zone outage", text: "Lose a whole site at once", kind: "site-fail", set: {} },
  { sector: "Sustainability", title: "Retire a node", text: "Energy and cost saved, safely", kind: "retire", set: {} },
];
const ENV_RANK = (c) => (/dev|lab|sandbox/i.test(c) ? 0 : /test|qa|uat|stag/i.test(c) ? 1 : /prod|prd|live/i.test(c) ? 3 : 2);
const riskClass = (r) => (r?.level === "High" ? "crit" : r?.level === "Medium" ? "warn" : "ok");

async function call(path, cluster, { method = "GET", body } = {}) {
  const hub = path === "/api/ops-twin/change" || path === "/api/ops-twin/failover";
  const r = await fetch(hub ? path : clusterUrl(path, cluster), {
    method, credentials: "same-origin",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(hub ? {} : { "X-Cluster-Context": cluster || "local" }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { body: j, status: r.status });
  return j;
}

export default function OpsTwin({ clusters = [], activeCluster }) {
  const [cluster, setCluster] = useState(activeCluster || clusters[0] || "local");
  const [labels, setLabels] = useState({});
  const [twin, setTwin] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState("drain");
  const [p, setP] = useState({ node: "", card: "", rack: "", gpuGiB: 40, name: "new-model", count: 10, cpu: 4, memGiB: 16, site: "", namespaces: "", factor: 2, windowHours: 4, retire: [], blastBy: "node", serviceAccount: "", drTo: "", critical: "" });
  const [fleet, setFleet] = useState(null);
  const [res, setRes] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [question, setQuestion] = useState("");

  useEffect(() => { fetch("/api/cluster-labels").then((r) => r.json()).then((j) => setLabels(j.labels || {})).catch(() => {}); }, []);
  const label = (c) => (c === "local" ? labels.local || "This cluster" : labels[c] || c);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setErr(null);
    try {
      const j = await call(`/api/ops-twin${refresh ? "?refresh=true" : ""}`, cluster);
      setTwin(j);
      setP((x) => {
        const gpuNode = j.nodes.find((n) => n.cards.length);
        const worker = j.nodes.find((n) => !n.roles.includes("master") && !n.roles.includes("control-plane"));
        return {
          ...x,
          node: j.nodes.some((n) => n.name === x.node) ? x.node : (gpuNode || worker || j.nodes[0])?.name || "",
          rack: j.racks[x.rack] ? x.rack : Object.keys(j.racks).find((r) => r !== "Unassigned") || "",
          site: (j.sites || []).includes(x.site) ? x.site : (j.sites || [])[0] || "",
          namespaces: x.namespaces || (j.namespaces || []).filter((n) => !/^(openshift|kube-|default$)/.test(n)).slice(0, 6).join(", "),
        };
      });
    } catch (e) { setErr(e.message); setTwin(null); }
    finally { setLoading(false); }
  }, [cluster]);
  useEffect(() => { setResult(null); load(); }, [load]);

  const node = twin?.nodes.find((n) => n.name === p.node);
  const scen = twin?.scenarios.find((s) => s.id === kind);
  const racks = twin ? Object.keys(twin.racks).filter((r) => r !== "Unassigned") : [];
  const ready = !!twin && (
    (kind === "drain" || kind === "node-fail") ? !!node
      : kind === "gpu-fail" ? !!node?.cards.length
        : kind === "rack-fail" ? !!p.rack && racks.includes(p.rack)
          : kind === "add-model" ? Number(p.gpuGiB) > 0
            : kind === "add-vms" ? Number(p.count) > 0 && Number(p.cpu) > 0 && Number(p.memGiB) > 0
              : kind === "site-fail" ? !!p.site
                : kind === "peak" ? !!p.namespaces.trim() && Number(p.factor) > 1 && Number(p.factor) <= 10
                  : kind === "window" ? Number(p.windowHours) >= 1
                    : kind === "retire" ? p.retire.length > 0
                      : kind === "blast" ? (p.blastBy === "node" ? !!node : /^[a-z0-9-]+\/[a-z0-9-]+$/.test(p.serviceAccount.trim()))
                        : kind === "dr" ? !!p.drTo && p.drTo !== cluster : true);
  const others = clusters.filter((c) => c !== cluster);

  const scenarioOf = (k = kind, q = p) => {
    const sc = { kind: k };
    if (q.critical.trim()) sc.critical = q.critical;
    if (k === "drain" || k === "node-fail") sc.node = q.node;
    if (k === "gpu-fail") { sc.node = q.node; sc.card = q.card || twin.nodes.find((n) => n.name === q.node)?.cards[0]?.uuid; }
    if (k === "rack-fail") sc.rack = q.rack;
    if (k === "site-fail") sc.site = q.site;
    if (k === "add-model") Object.assign(sc, { gpuGiB: Number(q.gpuGiB), name: q.name });
    if (k === "add-vms") Object.assign(sc, { count: Number(q.count), cpu: Number(q.cpu), memGiB: Number(q.memGiB) });
    if (k === "peak") Object.assign(sc, { namespaces: q.namespaces, factor: Number(q.factor) });
    if (k === "window") sc.windowHours = Number(q.windowHours);
    if (k === "retire") sc.nodes = q.retire;
    if (k === "blast") Object.assign(sc, q.blastBy === "node" ? { node: q.node } : { serviceAccount: q.serviceAccount.trim() });
    return sc;
  };
  const runScenario = async (k, q) => {
    setBusy("sim"); setFleet(null);
    try {
      if (k === "dr") setResult(await call("/api/ops-twin/failover", cluster, { method: "POST", body: { from: cluster, to: q.drTo, critical: q.critical || undefined } }));
      else { setResult(await call("/api/ops-twin/simulate", cluster, { method: "POST", body: { scenario: scenarioOf(k, q) } })); load(); }
    } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  };
  // Fleet upgrade: the same check on every cluster, least critical first.
  const runFleet = async () => {
    setBusy("fleet"); setResult(null);
    const order = [...(clusters.length ? clusters : ["local"])].sort((a, b) => ENV_RANK(a) - ENV_RANK(b));
    const rows = [];
    for (const c of order) {
      try { const o = await call("/api/ops-twin/simulate", c, { method: "POST", body: { scenario: { kind: "upgrade", ...(p.critical.trim() ? { critical: p.critical } : {}) } } }); rows.push({ cluster: c, level: o.verdict.level, title: o.verdict.title, minutes: o.kpis.minutes, risk: o.risk }); }
      catch (e) { rows.push({ cluster: c, level: "crit", title: e.message, error: true }); }
      setFleet({ rows: [...rows], done: false });
    }
    setFleet({ rows, done: true }); setBusy("");
  };
  const pickPreset = (x) => {
    if (x.kind === "fleet") { runFleet(); return; }
    let q = { ...p, ...x.set };
    if (x.critical) { const hit = (twin.namespaces || []).filter((n) => x.critical.test(n)); if (hit.length) q.critical = hit.join(", "); }
    if (x.kind === "dr") { if (!others.length) { showToast("A DR check needs a second cluster connected to the hub", "err"); return; } q.drTo = q.drTo || others[0]; }
    if (x.kind === "site-fail" && !q.site) { showToast("No sites or zones known: label nodes with tcs.io/site or topology.kubernetes.io/zone", "err"); setKind(x.kind); setP(q); return; }
    if (x.kind === "gpu-fail") { const g = twin.nodes.find((n) => n.cards.length); if (!g) { showToast("This cluster has no GPUs", "err"); return; } q.node = g.name; q.card = g.cards[0].uuid; }
    if (x.kind === "blast" || x.kind === "retire") { const w = twin.nodes.find((n) => !n.roles.includes("master") && !n.roles.includes("control-plane")); if (w) { q.node = w.name; if (x.kind === "retire") q.retire = [w.name]; } }
    setKind(x.kind); setP(q); runScenario(x.kind, q);
  };
  const checkResilience = async () => {
    setBusy("res");
    try { setRes(await call("/api/ops-twin/resilience", cluster, { method: "POST", body: p.critical.trim() ? { critical: p.critical } : {} })); load(); }
    catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  };
  const evidence = async () => {
    try {
      const r = await fetch(clusterUrl("/api/ops-twin/evidence", cluster), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Cluster-Context": cluster || "local" }, body: JSON.stringify({ scenario: scenarioOf(kind) }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `ops-twin-evidence-${result.scenario.kind}-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { showToast(e.message, "err"); }
  };

  const simulate = () => runScenario(kind, p);
  const ask = async (q) => {
    const text = (q ?? question).trim();
    if (!text) return;
    setBusy("ask");
    try {
      const out = await call("/api/ops-twin/ask", cluster, { method: "POST", body: { question: text } });
      setResult(out); setKind(out.scenario.kind);
      const s = out.parsed || {};
      setP((x) => ({ ...x, ...(s.node ? { node: s.node } : {}), ...(s.rack ? { rack: s.rack } : {}), ...(s.card ? { card: s.card } : {}), ...(s.gpuGiB ? { gpuGiB: s.gpuGiB } : {}), ...(s.count ? { count: s.count, cpu: s.cpu, memGiB: s.memGiB } : {}), ...(s.site ? { site: s.site } : {}), ...(s.factor ? { factor: s.factor, namespaces: (s.namespaces || []).join(", ") } : {}), ...(s.windowHours ? { windowHours: s.windowHours } : {}), ...(s.nodes ? { retire: s.nodes } : {}), ...(s.serviceAccount ? { blastBy: "sa", serviceAccount: s.serviceAccount } : s.kind === "blast" ? { blastBy: "node" } : {}) }));
      load();
    } catch (e) { showToast(e.message, "err"); } finally { setBusy(""); }
  };
  const raise = async (override) => {
    setBusy("cr");
    try {
      const j = await call("/api/ops-twin/change", cluster, { method: "POST", body: {
        cluster, label: scen?.label || (result.scenario.kind === "dr-failover" ? "DR failover" : "Change"), subject: result.scenario.subject, verdict: result.verdict.title, level: result.verdict.level,
        risk: result.risk ? { score: result.risk.score, level: result.risk.level } : undefined,
        report: result.report, plan: (result.plan || []).map((s) => s.text), ...(override ? { override } : {}),
      } });
      showToast(j.number ? `ServiceNow change ${j.number} raised with the twin’s report` : "Change request raised", "ok");
    } catch (e) {
      if (e.body?.guardrail && twin.you?.isAdmin) {
        setBusy("");
        const why = window.prompt(`${e.message}\n\nReason for overriding (recorded in the audit trail and the change):`);
        if (why && why.trim()) return raise(why.trim());
        return;
      }
      showToast(e.message, "err");
    } finally { setBusy(""); }
  };
  const exportReport = () => {
    const blob = new Blob([result.report], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ops-twin-${result.scenario.kind}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.txt`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const suggestions = useMemo(() => {
    if (!twin) return [];
    const g = twin.nodes.find((n) => n.cards.length), w = twin.nodes.find((n) => !n.cards.length && !n.roles.includes("master") && !n.roles.includes("control-plane"));
    const r = Object.keys(twin.racks).find((x) => x !== "Unassigned");
    return [g && `What if ${g.name} goes down?`, w && `Drain ${w.name}`, r && `What if rack ${r} loses power?`, "Is the upgrade safe?", g && "Can we add a model of 40 GiB?"].filter(Boolean);
  }, [twin]);

  if (!twin && !err) return <div className="vgf-empty">{loading ? "Reading the cluster into the twin…" : "No cluster selected."}</div>;

  const view = result?.view || twin?.nodes;
  const rackOrder = twin ? [...Object.keys(twin.racks).filter((r) => r !== "Unassigned").sort(), ...(twin.racks.Unassigned ? ["Unassigned"] : [])] : [];

  return (
    <div className="ot">
      <div className="ot-intro">
        <div>
          <h3>Ops Twin</h3>
          <p>Rehearse a change on a live copy of the cluster before you touch it: what moves where, what cannot, what stops, and what to do first. Nothing here changes the cluster.</p>
        </div>
        <div className="ot-intro-r">
          <select value={cluster} onChange={(e) => setCluster(e.target.value)} aria-label="Cluster">
            {(clusters.length ? clusters : ["local"]).map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
          <button className="vc-btn ghost sm" disabled={loading} onClick={() => load(true)}>{loading ? "Reading…" : "Refresh twin"}</button>
        </div>
      </div>
      {err && <div className="ot-err">The twin could not read {label(cluster)}: {err}</div>}
      {twin && (
        <div className="ot-grid">
          {/* ── left: scenario ── */}
          <div className="ot-col">
            <div className="vc-card">
              <div className="vgf-label">1 · Pick a what-if</div>
              <div className="ot-scen">
                {[...twin.scenarios, { id: "dr", label: "DR failover", hint: "can another cluster take it all?" }].map((s) => (
                  <button key={s.id} className={"ot-sc" + (kind === s.id ? " on" : "")} onClick={() => setKind(s.id)} aria-pressed={kind === s.id}>
                    {s.label}<span>{s.hint}</span>
                  </button>
                ))}
              </div>
              <div className="ot-fields">
                {(kind === "drain" || kind === "node-fail" || kind === "gpu-fail") && (
                  <label>Node
                    <select value={p.node} onChange={(e) => setP({ ...p, node: e.target.value, card: "" })}>
                      {twin.nodes.filter((n) => kind !== "gpu-fail" || n.cards.length).map((n) => <option key={n.name} value={n.name}>{n.name}{n.rack ? ` · rack ${n.rack}` : ""}{n.cards.length ? ` · ${n.cards.length} GPU` : ""}</option>)}
                    </select>
                  </label>
                )}
                {kind === "gpu-fail" && node && (
                  <label>GPU
                    <select value={p.card || node.cards[0]?.uuid} onChange={(e) => setP({ ...p, card: e.target.value })}>
                      {node.cards.map((c) => <option key={c.uuid} value={c.uuid}>GPU-{c.index} · {c.slices.length ? c.slices.map((s) => s.owner).join(", ") : "free"}</option>)}
                    </select>
                  </label>
                )}
                {kind === "gpu-fail" && !twin.nodes.some((n) => n.cards.length) && <p className="ot-hint">This cluster has no GPUs.</p>}
                {kind === "rack-fail" && (racks.length ? (
                  <label>Rack
                    <select value={p.rack} onChange={(e) => setP({ ...p, rack: e.target.value })}>
                      {racks.map((r) => <option key={r} value={r}>{r} · {twin.racks[r].length} node{twin.racks[r].length > 1 ? "s" : ""}</option>)}
                    </select>
                  </label>
                ) : <p className="ot-hint">No racks known yet. Label each node with its rack, for example <span className="vc-mono">oc label node &lt;name&gt; tcs.io/rack=R2</span>, and refresh the twin.</p>)}
                {kind === "add-model" && (<>
                  <label>Model name<input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} maxLength={63} /></label>
                  <label>GPU memory (GiB)<input type="number" min="1" max="1024" value={p.gpuGiB} onChange={(e) => setP({ ...p, gpuGiB: e.target.value })} /></label>
                </>)}
                {kind === "add-vms" && (<div className="ot-3">
                  <label>VMs<input type="number" min="1" max="500" value={p.count} onChange={(e) => setP({ ...p, count: e.target.value })} /></label>
                  <label>vCPU each<input type="number" min="1" max="128" value={p.cpu} onChange={(e) => setP({ ...p, cpu: e.target.value })} /></label>
                  <label>GiB each<input type="number" min="1" max="2048" value={p.memGiB} onChange={(e) => setP({ ...p, memGiB: e.target.value })} /></label>
                </div>)}
                {kind === "upgrade" && <p className="ot-hint">Checks a drain of every worker in turn, against the cluster as it is now.</p>}
                {kind === "site-fail" && ((twin.sites || []).length ? (
                  <label>Site or zone
                    <select value={p.site} onChange={(e) => setP({ ...p, site: e.target.value })}>{twin.sites.map((x) => <option key={x}>{x}</option>)}</select>
                  </label>
                ) : <p className="ot-hint">No sites known. Label nodes with <span className="vc-mono">tcs.io/site</span> or <span className="vc-mono">topology.kubernetes.io/zone</span> and refresh the twin.</p>)}
                {kind === "peak" && (<>
                  <label>Namespaces (comma separated, * allowed)<input value={p.namespaces} onChange={(e) => setP({ ...p, namespaces: e.target.value })} placeholder="storefront, checkout, payments-*" /></label>
                  <label>Load factor (×)<input type="number" min="1.1" max="10" step="0.5" value={p.factor} onChange={(e) => setP({ ...p, factor: e.target.value })} /></label>
                </>)}
                {kind === "window" && <label>Window (hours)<input type="number" min="1" max="48" value={p.windowHours} onChange={(e) => setP({ ...p, windowHours: e.target.value })} /></label>}
                {kind === "retire" && (
                  <div className="ot-pick">{twin.nodes.filter((n) => !n.roles.includes("master") && !n.roles.includes("control-plane")).map((n) => (
                    <label key={n.name} className="ot-chk"><input type="checkbox" checked={p.retire.includes(n.name)} onChange={(e) => setP({ ...p, retire: e.target.checked ? [...p.retire, n.name] : p.retire.filter((x) => x !== n.name) })} />{n.name}</label>
                  ))}</div>
                )}
                {kind === "blast" && (<>
                  <label>Compromised
                    <select value={p.blastBy} onChange={(e) => setP({ ...p, blastBy: e.target.value })}><option value="node">a node</option><option value="sa">a service account</option></select>
                  </label>
                  {p.blastBy === "node"
                    ? <label>Node<select value={p.node} onChange={(e) => setP({ ...p, node: e.target.value })}>{twin.nodes.map((n) => <option key={n.name}>{n.name}</option>)}</select></label>
                    : <label>Service account<input value={p.serviceAccount} onChange={(e) => setP({ ...p, serviceAccount: e.target.value })} placeholder="namespace/name" /></label>}
                </>)}
                {kind === "dr" && (others.length ? (
                  <label>Fail over to
                    <select value={p.drTo} onChange={(e) => setP({ ...p, drTo: e.target.value })}><option value="">choose the DR cluster</option>{others.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
                  </label>
                ) : <p className="ot-hint">A DR check needs a second cluster connected to the hub.</p>)}
                {!["add-model", "add-vms", "blast"].includes(kind) && (
                  <label>Critical apps (namespaces, optional)<input value={p.critical} onChange={(e) => setP({ ...p, critical: e.target.value })} placeholder="e.g. payments, ehr-*" /></label>
                )}
              </div>
              <button className="vc-btn primary ot-go" disabled={!ready || !!busy} onClick={simulate}>{busy === "sim" ? "Simulating…" : "▶ Simulate on the twin"}</button>
              <p className="ot-hint">The twin replays live state through requests, taints, selectors, affinity and spread rules, volumes, quotas, GPU memory per card and disruption budgets{twin.usageKnown ? ", with real usage from Prometheus" : ""}.</p>
            </div>
            <div className="vc-card">
              <div className="vgf-label">Trust in the twin</div>
              <div className="ot-trust">
                <div>
                  <b>{res ? `${res.score}%` : twin.resilience?.trend?.[0] ? `${twin.resilience.trend[0].score}%` : "—"}</b>
                  <span>Resilience (N+1)</span>
                  <small>{res ? `${res.survivable} of ${res.workers} node failures without an outage` : twin.resilience?.trend?.[0] ? `checked ${twin.resilience.trend[0].day}` : "not checked yet"}</small>
                </div>
                <div>
                  <b>{twin.accuracy?.placementPct != null ? `${twin.accuracy.placementPct}%` : "—"}</b>
                  <span>Placement accuracy</span>
                  <small>{twin.accuracy?.evaluated ? `${twin.accuracy.workloads} workloads over ${twin.accuracy.evaluated} real drains` : `${twin.accuracy?.open || 0} prediction${twin.accuracy?.open === 1 ? "" : "s"} waiting for a real drain`}</small>
                </div>
              </div>
              {res?.failing?.length > 0 && <ul className="ot-hist">{res.failing.slice(0, 5).map((f) => <li key={f.node}><span className="ot-dot crit" aria-hidden="true" />If {f.node} fails<span className="vc-muted"> · {f.stops[0] || f.title}</span></li>)}</ul>}
              {twin.resilience?.trend?.length > 1 && <p className="ot-hint">Trend: {twin.resilience.trend.slice(0, 7).reverse().map((t) => `${t.score}%`).join(" → ")}</p>}
              <button className="vc-btn sm" disabled={!!busy} onClick={checkResilience}>{busy === "res" ? "Checking every node…" : "Check N+1 now"}</button>
              <p className="ot-hint">Resilience: can the cluster lose any one worker without an outage. Accuracy: after a node you simulated is drained for real, where the pods actually landed is compared with the prediction.</p>
            </div>
            <div className="vc-card">
              <div className="vgf-label">Twin status</div>
              <dl className="ot-kv">
                <dt>Read from the cluster</dt><dd>{ago(twin.at)}</dd>
                <dt>Nodes</dt><dd>{twin.counts.nodes} ({twin.counts.workers} workers)</dd>
                <dt>Racks</dt><dd>{twin.counts.racks || "not labelled"}</dd>
                <dt>GPUs</dt><dd>{twin.counts.gpus || "none"}</dd>
                <dt>Pods · VMs</dt><dd>{twin.counts.pods} · {twin.counts.vms}</dd>
                <dt>Models</dt><dd>{twin.counts.models}{twin.counts.modelsAsleep ? ` (${twin.counts.modelsAsleep} asleep)` : ""}</dd>
                <dt>Sources</dt><dd>{["Kubernetes", twin.sources?.virtualization && "Virtualization", twin.sources?.models && "KServe", twin.sources?.gpuTelemetry && "DCGM"].filter(Boolean).join(" · ")}</dd>
              </dl>
            </div>
            {twin.history?.length > 0 && (
              <div className="vc-card">
                <div className="vgf-label">Recent what-ifs</div>
                <ul className="ot-hist">
                  {twin.history.slice(0, 6).map((h, i) => <li key={i}><span className={"ot-dot " + h.level} aria-hidden="true" />{h.scenario.subject}<span className="vc-muted"> · {h.verdict} · {ago(h.at)}</span></li>)}
                </ul>
              </div>
            )}
          </div>

          {/* ── centre: the twin ── */}
          <div className="vc-card ot-map">
            <div className="ot-maphead">
              <div className="vgf-label" style={{ margin: 0 }}>2 · Twin view{result ? ` — ${result.scenario.kind === "dr-failover" ? "DR failover" : scen?.label?.toLowerCase() || "what-if"}: ${result.scenario.subject}` : ""}</div>
              <div className="ot-legend"><span><i className="m" />Model</span><span><i className="o" />Other workload</span><span><i className="n" />Moves here</span><span><i className="f" />Free</span></div>
            </div>
            <div className="ot-racks">
              {result?.scenario.kind === "dr-failover" && (
                <div className="ot-rack">
                  <div className="ot-rt"><span>{label(result.cluster)} (DR site)</span><span>{view.length} nodes</span></div>
                  {view.map((n) => <NodeCard key={n.name} n={n} result={result} />)}
                </div>
              )}
              {result?.scenario.kind !== "dr-failover" && rackOrder.map((r) => (
                <div key={r} className="ot-rack">
                  <div className="ot-rt"><span>{r === "Unassigned" ? (racks.length ? "No rack label" : "Nodes") : `Rack ${r}`}</span>
                    <span>{rackPower(view, twin.racks[r], result)}</span></div>
                  {twin.racks[r].map((name) => view.find((v) => v.name === name)).filter(Boolean).map((n) => <NodeCard key={n.name} n={n} result={result} />)}
                </div>
              ))}
            </div>
            {result && (
              <div className="ot-under">
                <div className="vgf-label">What the twin checked</div>
                <div className="ot-checks">{result.checks.map((c) => <span key={c.name} className={"ot-ck " + c.level} title={c.note || ""}>{ICON[c.level]} {c.name}</span>)}</div>
                {result.plan?.length > 0 && (<>
                  <div className="vgf-label" style={{ marginTop: 14 }}>{result.scenario.kind === "upgrade" ? "Upgrade order" : result.scenario.kind === "window" ? "Window schedule" : result.scenario.kind === "blast" ? "Isolation steps" : "Plan"}</div>
                  <ol className="ot-plan">{result.plan.map((s, i) => <li key={i} className={s.level}><b>{i + 1}</b><span>{s.text}</span></li>)}</ol>
                </>)}
                <p className="ot-assume">{result.assumptions}</p>
              </div>
            )}
          </div>

          {/* ── right: verdict ── */}
          <div className="ot-col">
            {result ? (<>
              <div className={"ot-verdict " + result.verdict.level}>
                <div className="ot-vt">{ICON[result.verdict.level]} {result.verdict.title}</div>
                <p>{result.verdict.text}</p>
                {result.risk && (
                  <details className={"ot-risk " + riskClass(result.risk)}>
                    <summary><b>Risk {result.risk.score}/100</b> · {result.risk.level}</summary>
                    <ul>{result.risk.reasons.map((r, i) => <li key={i}><span>+{r.points}</span>{r.text}</li>)}</ul>
                  </details>
                )}
                {result.window && <p className="ot-extra">Window {result.window.hours} h: {result.window.nodesInWindow} nodes fit, about {Math.round(result.window.totalMinutes / 6) / 10} h of work, {result.window.windowsNeeded} window{result.window.windowsNeeded > 1 ? "s" : ""} needed.</p>}
                {result.sizing && <p className="ot-extra">Sizing: {result.sizing.nodesNeeded} more node{result.sizing.nodesNeeded === 1 ? "" : "s"} of the usual size, {result.sizing.withSpare} with one spare for a failure; about {result.sizing.vmsPerNode} such VMs per node.</p>}
                {result.kpis.nodesNeeded != null && !result.sizing && result.kpis.nodesNeeded > 0 && <p className="ot-extra">About {result.kpis.nodesNeeded} more node{result.kpis.nodesNeeded === 1 ? "" : "s"} needed.</p>}
                {result.savings && <p className="ot-extra">Saves about {result.savings.kwhMonth} kWh a month{result.savings.money != null ? `, ${result.savings.currency}${result.savings.money.toLocaleString()} a month` : ""}.</p>}
                <div className="ot-kpis">
                  <div><b>{result.kpis.downtime === "none" ? "None" : result.kpis.downtime === "outage" ? "Outage" : result.kpis.downtime === "brief restarts" ? "Brief" : "Until rescheduled"}</b><span>expected downtime</span></div>
                  {result.kpis.minutes != null ? <div><b>~{result.kpis.minutes} min</b><span>{result.scenario.kind === "upgrade" ? "for all nodes" : "to drain"}</span></div>
                    : <div><b>{result.kpis.moves}</b><span>{result.scenario.kind.startsWith("add") ? "placed" : "moves"}</span></div>}
                  {result.kpis.gpusInService ? <div><b>{result.kpis.gpusInService}</b><span>GPUs in service</span></div>
                    : <div><b>{result.kpis.cannotMove}</b><span>cannot {result.scenario.kind.startsWith("add") ? "fit" : "move"}</span></div>}
                  {result.kpis.powerW != null ? <div><b>{result.kpis.powerW} W</b><span>GPU power meanwhile</span></div>
                    : <div><b>{result.impact.filter((i) => i.level !== "ok").length}</b><span>to look at</span></div>}
                </div>
              </div>
              <div className="vc-card">
                <div className="vgf-label">3 · Expected impact</div>
                <ul className="ot-imp">
                  {[...result.impact].sort((a, b) => ({ crit: 0, warn: 1, ok: 2 }[a.level] - { crit: 0, warn: 1, ok: 2 }[b.level])).map((i, n) => (
                    <li key={n}>
                      <span className={"ot-ic " + i.level} aria-label={LEVEL_WORD[i.level]}>{ICON[i.level]}</span>
                      <div><b>{i.title}</b> <span className="vc-muted">· {i.text}</span>
                        {i.fix && i.level !== "ok" && <div className="ot-fix">Fix: {i.fix.text}</div>}</div>
                    </li>
                  ))}
                  {!result.impact.length && <li><span className="ot-ic ok">✓</span><div>Nothing runs there that would be affected.</div></li>}
                </ul>
              </div>
              <div className="ot-acts">
                <button className="vc-btn primary" disabled={!twin.you?.canRaise || !!busy} title={twin.you?.canRaise ? "" : "Needs the Operator or Admin role"} onClick={() => raise()}>{busy === "cr" ? "Raising…" : "Raise change in ServiceNow"}</button>
                <button className="vc-btn" onClick={exportReport}>Export report</button>
                {result.scenario.kind !== "dr-failover" && <button className="vc-btn" onClick={evidence} title="The report with its risk score and method, for auditors">Evidence pack</button>}
                <button className="vc-btn" onClick={() => navigator.clipboard?.writeText(result.report).then(() => showToast("Report copied", "ok"))}>Copy report</button>
                <button className="vc-btn ghost" onClick={() => setResult(null)}>Clear</button>
              </div>
            </>) : (
              <div className="vc-card ot-empty">
                <b>Pick a what-if and simulate.</b>
                <p>The twin shows what moves where, what cannot move, what would stop, and the actions to take first. You can raise the change in ServiceNow with the report attached.</p>
              </div>
            )}
            {fleet && (
              <div className="vc-card">
                <div className="vgf-label">Fleet upgrade plan{fleet.done ? "" : " · checking…"}</div>
                <ol className="ot-plan">{fleet.rows.map((r, i) => <li key={r.cluster} className={r.level === "crit" ? "crit" : r.level === "warn" ? "warn" : "info"}><b>{i + 1}</b><span>{label(r.cluster)}: {r.title}{r.minutes ? ` · ~${r.minutes} min` : ""}{r.risk ? ` · risk ${r.risk.score}` : ""}{r.level === "crit" ? " — hold" : ""}</span></li>)}</ol>
                <p className="ot-hint">Least critical first (dev, test, then production), each checked node by node. Fix the held clusters before their turn.</p>
              </div>
            )}
            <div className="vc-card">
              <div className="vgf-label">Industry scenarios</div>
              <div className="ot-lib">
                {LIBRARY.map((x) => (
                  <button key={x.title} className="ot-lb" disabled={!!busy} onClick={() => pickPreset(x)}>
                    <em>{x.sector}</em><b>{x.title}</b><span>{x.text}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="vc-card">
              <div className="vgf-label">Ask the twin</div>
              <form className="ot-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
                <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What if tcsaiinode1 goes down tonight?" maxLength={500} aria-label="Ask the twin" />
                <button className="vc-btn primary sm" disabled={!question.trim() || !!busy}>{busy === "ask" ? "…" : "Ask"}</button>
              </form>
              <div className="ot-sugg">{suggestions.map((s) => <button key={s} className="ot-chip" disabled={!!busy} onClick={() => { setQuestion(s); ask(s); }}>{s}</button>)}</div>
              <p className="ot-hint">In AI Chat, the same what-ifs are available to the agent as the twin_simulate tool.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function rackPower(view, names, result) {
  const nodes = (view || []).filter((v) => names.includes(v.name));
  const w = nodes.reduce((a, n) => a + n.cards.reduce((b, c) => b + (c.powerW || 0), 0), 0);
  if (!w) return `${nodes.length} node${nodes.length > 1 ? "s" : ""}`;
  const lost = result ? nodes.filter((n) => n.state === "lost" || n.state === "draining").reduce((a, n) => a + n.cards.reduce((b, c) => b + (c.powerW || 0), 0), 0) : 0;
  return lost ? `GPU ${(w / 1000).toFixed(1)} kW → ${((w - lost) / 1000).toFixed(1)} kW` : `GPU ${(w / 1000).toFixed(1)} kW`;
}

function NodeCard({ n, result }) {
  const state = n.state || "same";
  const tag = { draining: ["Draining", "r"], lost: ["Lost", "r"], receives: ["Receives", "g"] }[state];
  const out = state === "draining" || state === "lost";
  const incoming = n.incoming || [];
  const inPods = incoming.filter((m) => m.kind === "pod").length;
  const inVms = incoming.filter((m) => m.kind === "vm");
  return (
    <div className={"ot-node " + state}>
      <div className="ot-nh"><b>{n.name}</b>
        {tag ? <span className={"ot-tag " + tag[1]}>{tag[0]}</span>
          : <span className="ot-tag n">{n.cards.length ? `${n.cards.length} GPU` : n.roles.includes("master") || n.roles.includes("control-plane") ? "control plane" : `${n.pods} pod${n.pods === 1 ? "" : "s"}`}{n.vms.length ? ` · ${n.vms.length} VM${n.vms.length > 1 ? "s" : ""}` : ""}</span>}
      </div>
      <div className="ot-use">
        <span>CPU {pct(n.cpu.req, n.cpu.alloc)}%</span><i><em style={{ width: `${pct(n.cpu.req, n.cpu.alloc)}%` }} /></i>
        <span>RAM {pct(n.mem.req, n.mem.alloc)}%</span><i><em style={{ width: `${pct(n.mem.req, n.mem.alloc)}%` }} /></i>
      </div>
      {n.cards.length > 0 && (
        <div className="ot-gpus">
          {n.cards.map((c) => {
            const dead = out || (n.goneCards || []).includes(c.uuid);
            const add = incoming.filter((m) => m.card === c.uuid);
            const used = c.slices.reduce((a, s) => a + s.mib, 0);
            const free = c.totalMiB - used - add.reduce((a, m) => a + (m.gpuMiB || 0), 0);
            return (
              <div key={c.uuid} className={"ot-gpu" + (dead ? " dead" : "")}>
                <div className="ot-gt"><span>GPU-{c.index}</span><span>{[c.tempC != null && `${Math.round(c.tempC)} °C`, c.powerW != null && `${Math.round(c.powerW)} W`].filter(Boolean).join(" · ")}</span></div>
                <div className="ot-bar" aria-hidden="true">
                  {c.slices.map((s, i) => <i key={i} className={s.model ? "m" : "o"} style={{ width: `${pct(s.mib, c.totalMiB)}%` }} />)}
                  {!dead && add.map((m, i) => <i key={`a${i}`} className="n" style={{ width: `${pct(m.gpuMiB || 0, c.totalMiB)}%` }} />)}
                </div>
                <div className="ot-slc">
                  {c.slices.map((s, i) => <div key={i} className={dead ? "out" : ""}><span>{s.owner}</span>{gib(s.mib)}</div>)}
                  {!dead && add.map((m, i) => <div key={`a${i}`} className="in"><span>+ {m.name}</span>{gib(m.gpuMiB)}</div>)}
                  {!dead && <div className="free"><span>free</span>{gib(Math.max(0, free))}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(n.vms.length > 0 || inVms.length > 0 || inPods > 0) && (
        <div className="ot-vms">
          {n.vms.map((v) => <span key={v} className={"ot-vm" + (out ? " out" : "")}>{v}</span>)}
          {inVms.map((v) => <span key={v.name} className="ot-vm in">+ {v.name}</span>)}
          {inPods > 0 && <span className="ot-vm in">+ {inPods} pod{inPods > 1 ? "s" : ""}</span>}
        </div>
      )}
      {result && out && n.pods > 0 && <div className="ot-note">{n.pods} pod{n.pods > 1 ? "s" : ""} {state === "lost" ? "lost with the node" : "evicted"}</div>}
    </div>
  );
}
