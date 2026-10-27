import { useState, useEffect, useCallback } from "react";

// Private AI Factory — Model catalogue: the approved models, whether each runs,
// whether it fits on the GPUs now (checked against HAMi's free memory per card),
// and deploying one (Admin, audited). Source per model: an OpenShift AI catalog
// image (oci://…, no download) or Hugging Face (downloaded once into storage).
// Data: /api/command-center/catalogue for the cluster being viewed.

const ROLE_COLOR = { large: "#3b6fd8", small: "#18a0a6", vision: "#8a5cd6", coder: "#2f9e8f", embed: "#d08a1e" };
const ROLE_NAME = { large: "Reasoning", small: "Fast", vision: "Vision", coder: "Code", embed: "Embeddings" };
const STATUS = {
  running: ["ok", "● Running"], stopped: ["", "■ Stopped"], "not-deployed": ["", "Not deployed"], deploying: ["warn", "Deploying…"],
  starting: ["warn", "Starting…"], "not-connected": ["warn", "Not connected"], down: ["crit", "● Down"],
};
const gb = (mib) => (mib == null ? "—" : `${Math.round(mib / 1024)} GB`);
const short = (n) => String(n || "").split(".")[0];
const FILTERS = [["all", "All"], ["validated", "Red Hat validated"], ["small", "Fast"], ["large", "Reasoning"], ["vision", "Vision"], ["embed", "Embeddings"], ["fits", "Fits now"]];

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function Fit({ it }) {
  const f = it.fit;
  if (!f) return null;
  if (f.status === "unknown") return <div className="ct-fit"><span className="cc-pill">GPU memory not reported</span></div>;
  if (f.status === "no-fit") return <div className="ct-fit"><span className="cc-pill crit">Doesn&apos;t fit</span><span>needs {gb(it.gpuMiB)} on one card · most free now {gb(f.largestFreeMiB)}</span></div>;
  return (
    <div className="ct-fit">
      <span className={"cc-pill " + (f.status === "tight" ? "warn" : "ok")}>{f.status === "tight" ? "Tight" : "Fits"}</span>
      <em className="ct-bar"><i style={{ width: `${Math.min(100, (it.gpuMiB / f.freeMiB) * 100)}%` }} /></em>
      <span>{gb(it.gpuMiB)} of {gb(f.freeMiB)} free on {short(f.node)} · card {f.index}{f.status === "tight" ? " — takes the card a bigger model needs" : ""}</span>
    </div>
  );
}

function DeployPanel({ it, cards, busy, onDeploy, onClose, canManage, onImage }) {
  const [node, setNode] = useState(it.fit?.node || "");
  const [oci, setOci] = useState(it.source.kind === "oci" ? it.source.uri : "");
  const nodes = [...new Set((it.fit?.candidates || []).map((c) => c.node))];
  const onNode = (n) => cards.filter((c) => c.node === n);
  return (
    <div className="ct-side">
      <section className="cc-card">
        <header><h3>Deploy {it.name}</h3><span>Admin · audited</span><button className="vc-btn ghost sm ct-x" onClick={onClose}>Close</button></header>
        <div className="ff-kv"><span>Source</span><b>{it.source.kind === "oci" ? "OpenShift AI catalog image" : "Hugging Face"}</b></div>
        <div className="ff-kv"><span>{it.source.kind === "oci" ? "Image" : "Repository"}</span><b className="mono ct-small">{it.source.kind === "oci" ? it.source.uri : it.hf}</b></div>
        <div className="ff-kv"><span>Download</span><b>{it.source.kind === "oci" ? "None — pulled like any Red Hat image" : `Once, into ${it.id}-cache (${it.diskGi} Gi)`}</b></div>
        <div className="ff-kv"><span>Hugging Face token</span><b>{it.source.kind === "oci" ? "Not needed" : "Used if the hf-token Secret exists"}</b></div>
        <div className="ff-kv"><span>Serving</span><b>{it.runtime === "tei" ? "Text Embeddings Inference" : "vLLM (Red Hat runtime)"}{it.args.some((a) => /tool-choice/.test(a)) ? " · tool calling on" : ""}</b></div>
        <div className="ff-kv"><span>GPU slice (HAMi)</span><b>{gb(it.gpuMiB)} · {it.context} context</b></div>
        <div className="ff-kv"><span>Router role</span><b>{ROLE_NAME[it.role]}</b></div>
        <div className="ff-kv"><span>Licence</span><b>{it.licence}</b></div>
        {canManage && (
          <div className="ct-oci">
            <span className="cc-lbl">OpenShift AI catalog image (optional)</span>
            <div className="ff-ask">
              <input value={oci} onChange={(e) => setOci(e.target.value)} placeholder="oci://registry.redhat.io/…  (copy from the OpenShift AI model catalog)" />
              <button className="vc-btn ghost sm" disabled={!!busy || oci === (it.source.kind === "oci" ? it.source.uri : "")} onClick={() => onImage(it.id, oci)}>{oci ? "Use image" : "Use Hugging Face"}</button>
            </div>
          </div>
        )}
      </section>
      <section className="cc-card">
        <header><h3>Where it will run</h3><span>free GPU memory now · the model is placed on this node; HAMi picks the card</span></header>
        {nodes.length > 1 && (
          <div className="fl-seg">{nodes.map((n) => <button key={n} className={node === n ? "on" : ""} onClick={() => setNode(n)}>{short(n)}</button>)}</div>
        )}
        {[node].filter(Boolean).map((n) => onNode(n).map((c) => {
          const chosen = n === node && it.fit?.candidates?.some((x) => x.node === n && String(x.index) === String(c.index)) && c.freeMiB === Math.min(...(it.fit?.candidates || []).filter((x) => x.node === n).map((x) => x.freeMiB));
          return (
            <div key={`${n}-${c.index}`} className={"ct-card" + (chosen ? " pick" : "")}>
              <div className="ct-card-h"><b>{short(n)} · card {c.index}</b><span>{chosen ? <span className="cc-pill ok">chosen · {gb(c.freeMiB)} free</span> : `${gb(c.freeMiB)} free`}</span></div>
              <div className="ff-bar">
                {(c.slices || []).map((s, i) => <span key={i} className="ff-seg" style={{ flexBasis: `${c.memTotalMiB ? (s.mib / c.memTotalMiB) * 100 : 20}%`, background: s.ours ? "#5b7bb0" : "#9aa9bb" }}>{c.memTotalMiB && s.mib / c.memTotalMiB > 0.15 ? s.owner : ""}</span>)}
                {chosen && <span className="ff-seg" style={{ flexBasis: `${c.memTotalMiB ? (it.gpuMiB / c.memTotalMiB) * 100 : 20}%`, background: ROLE_COLOR[it.role], opacity: 0.85 }}>{it.id}</span>}
              </div>
            </div>
          );
        }))}
        <p className="cc-note">After deploy: {it.source.kind === "oci" ? "the image is pulled and the model starts" : "the weights download (minutes to an hour by size), then the model starts"}; it is connected to the AI router automatically and appears in Model performance and Usage.</p>
        <div className="cc-actions">
          <button className="vc-btn ghost" onClick={onClose}>Cancel</button>
          <button className="vc-btn primary" disabled={!!busy || !canManage || !node} onClick={() => onDeploy(it.id, node)}>{canManage ? `Deploy to ${short(node)}` : "Admin role needed"}</button>
        </div>
      </section>
    </div>
  );
}

export default function CatalogueView({ busy, act$, scoped, onTab }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState("all");
  const [sel, setSel] = useState(null);
  const load = useCallback(async () => {
    try { const r = await fetch(scoped("/api/command-center/catalogue")); const j = await r.json(); if (!r.ok) throw new Error(j.error || "Catalogue unavailable"); setC(j); setErr(null); }
    catch (e) { setErr(e.message); }
  }, [scoped]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  if (err && !c) return <div className="vc-alert">{err}</div>;
  if (!c) return <div className="cc-empty">Reading the catalogue and free GPU memory…</div>;

  const t = c.totals; const admin = !!c.you?.canManage;
  const shown = c.items.filter((i) => filter === "all" || (filter === "validated" ? i.validated : filter === "fits" ? i.fit && ["fits", "tight"].includes(i.fit.status) : i.role === filter));
  const selected = sel && c.items.find((i) => i.id === sel);
  const deploy = (id, node) => act$(`deploy-${id}`, async () => { await post(scoped("/api/command-center/catalogue/deploy"), { id, node }); setSel(null); await load(); }, "Deployment started — progress shows on the model's card");
  const setImage = (id, oci) => act$(`img-${id}`, async () => { await post(scoped("/api/command-center/catalogue/image"), { id, oci }); await load(); }, oci ? "Catalog image saved" : "Back to Hugging Face");
  const startStop = (it, run) => act$(`model-${it.id}`, async () => { await post(scoped("/api/command-center/model"), { name: it.id, run }); await load(); }, run ? `${it.name} starting` : `${it.name} stopped`);

  return (
    <>
      <div className="fl-totals ct-totals">
        <div><span className="cc-lbl">Approved models</span><b>{t.approved}</b><span className="cc-muted">{t.validated} Red Hat validated · {t.catalogImages} from the OpenShift AI catalog</span></div>
        <div><span className="cc-lbl">Running</span><b>{t.running}</b><span className="cc-muted">{c.items.filter((i) => i.status === "running").map((i) => i.id).join(" · ") || "none"}</span></div>
        <div><span className="cc-lbl">GPU memory free</span><b>{gb(t.freeMiB)}</b><span className="cc-muted">largest free on one card: {gb(t.largestFreeMiB)}</span></div>
        <div><span className="cc-lbl">Fit now</span><b>{t.fitsNow} of {c.items.filter((i) => i.fit).length}</b><span className="cc-muted">not running, can start without moving anything</span></div>
        <div className="fl-mode"><span className="cc-lbl">Show</span>
          <div className="ct-filters">{FILTERS.map(([k, l]) => <button key={k} className={"ct-f" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>)}</div>
        </div>
      </div>

      <div className={"ct-grid" + (selected ? " with-side" : "")}>
        <section className="cc-card">
          <header><h3>Model catalogue</h3><span>approved for this platform · sized for HAMi GPU slices · checked against free GPU memory now</span></header>
          <div className="ct-cards">
            {shown.map((it) => {
              const [tone, label] = STATUS[it.status] || ["", it.status];
              return (
                <div key={it.id} className={"ct-m" + (sel === it.id ? " sel" : "")}>
                  <div className="ct-mh"><i className="ff-dot" style={{ background: ROLE_COLOR[it.role] }} /><b>{it.name}</b>
                    {it.source.kind === "oci" ? <span className="cc-pill crit">OpenShift AI catalog</span> : it.validated ? <span className="cc-pill crit">Red Hat validated</span> : <span className="cc-pill warn">Hugging Face</span>}
                    <span className={"cc-pill ct-st " + tone}>{label}</span></div>
                  <p className="ct-desc">{it.desc}</p>
                  <div className="ct-facts"><div><span>Role</span><b>{ROLE_NAME[it.role]}</b></div><div><span>GPU memory</span><b>{gb(it.gpuMiB)}</b></div><div><span>Context</span><b>{it.context}</b></div><div><span>Licence</span><b>{it.licence}</b></div></div>
                  <Fit it={it} />
                  {it.deploy && it.status !== "running" && (
                    <div className={"ct-dep " + (it.deploy.phase === "failed" ? "bad" : "")}>
                      <b>{it.deploy.phase === "failed" ? `Deploy failed: ${it.deploy.error}` : it.deploy.phase === "downloading" ? "Downloading weights…" : it.deploy.phase === "ready" ? "Deployed" : "Starting…"}</b>
                      {(it.deploy.steps || []).slice(-3).map((s, i) => <span key={i} className="cc-muted">{new Date(s.at).toLocaleTimeString([], { hour12: false })} · {s.text}</span>)}
                    </div>
                  )}
                  <div className="ct-acts">
                    {it.status === "running" && <button className="vc-btn ghost sm" onClick={() => onTab("floor")}>Test on Factory floor</button>}
                    {it.status === "running" && admin && <button className="vc-btn ghost sm" disabled={!!busy} onClick={() => startStop(it, false)}>Stop</button>}
                    {it.status === "stopped" && admin && <button className="vc-btn primary sm" disabled={!!busy || it.fit?.status === "no-fit"} title={it.fit?.status === "no-fit" ? "Not enough free GPU memory on any card" : ""} onClick={() => startStop(it, true)}>Start{it.fit?.node ? ` on ${short(it.fit.node)}` : ""}</button>}
                    {it.status === "not-deployed" && <button className={"vc-btn sm " + (it.fit?.status === "fits" ? "primary" : "ghost")} disabled={!!busy || !it.fit || it.fit.status === "no-fit" || it.fit.status === "unknown"} onClick={() => setSel(it.id)}>Deploy…</button>}
                    {it.status === "not-connected" && <button className="vc-btn ghost sm" onClick={() => onTab("fleet")}>Connect (GPU fleet)</button>}
                  </div>
                </div>
              );
            })}
          </div>
          {!admin && <p className="cc-note">Deploying, starting and stopping models needs the Admin role.</p>}
        </section>
        {selected && <DeployPanel it={selected} cards={c.cards} busy={busy} canManage={admin} onDeploy={deploy} onImage={setImage} onClose={() => setSel(null)} />}
      </div>
    </>
  );
}
