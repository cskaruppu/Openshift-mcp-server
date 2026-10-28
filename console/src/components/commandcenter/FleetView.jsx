import { useState } from "react";

// Private AI Factory — the fleet part of the Infrastructure tab: every GPU cluster side by side, the
// fleet totals, and how the AI router uses each cluster (answers on/off,
// sensitive data allowed, region, preferred vs least-loaded).
// Data: /api/command-center/fleet (read by the parent and passed in).

const ROLE_COLOR = { large: "#3b6fd8", small: "#18a0a6", vision: "#8a5cd6", coder: "#2f9e8f", embed: "#d08a1e" };
const gb = (mib) => (mib == null ? "—" : `${Math.round(mib / 1024)} GB`);

async function post(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function Toggle({ on, label, disabled, onChange, title }) {
  return (
    <button className={"fl-toggle" + (on ? " on" : "")} disabled={disabled} onClick={() => onChange(!on)} title={title} role="switch" aria-checked={on}>
      <i aria-hidden="true" /><span>{label}</span>
    </button>
  );
}

function RegionInput({ value, disabled, onSave }) {
  const [v, setV] = useState(value || "");
  return (
    <input className="fl-region" value={v} disabled={disabled} maxLength={40} placeholder="Region (e.g. India)"
      onChange={(e) => setV(e.target.value)} onBlur={() => { if ((value || "") !== v) onSave(v); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
  );
}

export default function FleetView({ fleet, busy, act$, onOpen, viewCluster, reload }) {
  if (!fleet) return <div className="cc-empty">Reading the GPU clusters…</div>;
  if (fleet.error) return <div className="vc-alert">{fleet.error}</div>;
  const t = fleet.totals; const admin = !!fleet.you?.canManage;
  const run = (label, fn, ok) => act$(label, async () => { await fn(); await reload(); }, ok);
  return (
    <>
      <div className="fl-totals">
        <div><span className="cc-lbl">GPU clusters</span><b>{t.clusters}</b></div>
        <div><span className="cc-lbl">GPUs</span><b>{t.cards}</b></div>
        <div><span className="cc-lbl">Models ready</span><b>{t.modelsReady} / {t.models}</b></div>
        <div><span className="cc-lbl">GPU memory reserved</span><b>{t.memUsedPct != null ? `${t.memUsedPct}%` : "—"}</b></div>
        <div><span className="cc-lbl">GPU power now</span><b>{t.powerW != null ? `${(t.powerW / 1000).toFixed(1)} kW` : "—"}</b></div>
        <div className="fl-mode">
          <span className="cc-lbl">Routing across clusters</span>
          <div className="fl-seg">
            {[["preferred", "Selected cluster first"], ["least-loaded", "Least loaded"]].map(([m, l]) => (
              <button key={m} className={fleet.mode === m ? "on" : ""} disabled={!admin || !!busy || fleet.mode === m}
                onClick={() => run("mode", () => post("/api/command-center/fleet/mode", { mode: m }), `Routing: ${l.toLowerCase()}`)}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {!fleet.clusters.length && <div className="cc-empty">No GPU clusters yet. Save cluster access in Settings → Private AI for each GPU cluster, then press Discover models here.</div>}

      <div className="fl-grid">
        {fleet.clusters.map((c) => (
          <section key={c.cluster} className={"cc-card fl-card" + (c.cluster === viewCluster ? " viewing" : "")}>
            <header>
              <h3>{c.label}</h3>
              {c.label !== c.cluster && <span className="mono">{c.cluster}</span>}
              {c.preferred && <span className="cc-pill">selected</span>}
              {!c.policy.routing && <span className="cc-pill warn">no answers</span>}
            </header>
            <div className="fl-hw">
              <b>{c.cards ? `${c.cards}× ${c.gpuModel || "GPU"}` : "No GPUs reported"}</b>
              <span className="cc-muted">{c.nodes != null ? `${c.nodes} node${c.nodes === 1 ? "" : "s"}` : ""}{c.powerW != null ? ` · ${c.powerW} W` : ""}</span>
            </div>
            <div className="fl-meters">
              <div><span className="cc-muted">Utilisation</span><div className="ff-util big"><i style={{ width: `${c.avgUtilPct || 0}%` }} /></div><span className="mono">{c.avgUtilPct != null ? `${c.avgUtilPct}%` : "—"}</span></div>
              <div><span className="cc-muted">Memory reserved</span><div className="ff-util big"><i style={{ width: `${c.memUsedPct || 0}%` }} /></div><span className="mono">{c.memUsedPct != null ? `${c.memUsedPct}% of ${gb(c.memTotalMiB)}` : "—"}</span></div>
            </div>
            {c.telemetry !== "ok" && c.reason && <p className="cc-note fl-reason" title={c.reason}>{c.reason}</p>}
            <div className="fl-models">
              {c.models.map((m) => <span key={m.model} className={"fl-model" + (m.ready ? "" : " down")}><i style={{ background: ROLE_COLOR[m.role] || "#9aa9bb" }} />{m.model}<em>{m.ready ? "ready" : "down"}</em></span>)}
              {!c.models.length && <span className="cc-muted">No models found yet{c.discoveredAt ? "" : " — press Discover models"}</span>}
            </div>
            <div className="fl-policy">
              <Toggle on={c.policy.routing} label="Answers AI requests" disabled={!admin || !!busy}
                title="Whether the router sends requests to this cluster's models"
                onChange={(v) => run(`pol-${c.cluster}`, () => post("/api/command-center/fleet/policy", { cluster: c.cluster, routing: v }), v ? `${c.label} answers again` : `${c.label} takes no AI requests`)} />
              <Toggle on={c.policy.sensitive} label="Sensitive data allowed" disabled={!admin || !!busy}
                title="Data residency: requests with secrets or personal data only go to clusters where this is on"
                onChange={(v) => run(`pol-${c.cluster}`, () => post("/api/command-center/fleet/policy", { cluster: c.cluster, sensitive: v }), v ? `Sensitive data allowed on ${c.label}` : `Sensitive data kept off ${c.label}`)} />
              <RegionInput value={c.policy.region} disabled={!admin || !!busy}
                onSave={(v) => run(`pol-${c.cluster}`, () => post("/api/command-center/fleet/policy", { cluster: c.cluster, region: v }), "Region saved")} />
            </div>
            <div className="cc-actions">
              <button className="vc-btn primary sm" onClick={() => onOpen(c.cluster)}>Show this cluster</button>
              <button className="vc-btn ghost sm" disabled={!admin || !!busy} title="Find the OpenShift AI models on this cluster and connect them"
                onClick={() => run(`disc-${c.cluster}`, () => post("/api/command-center/fleet/discover", { cluster: c.cluster }), `Models on ${c.label} connected`)}>Discover models</button>
            </div>
          </section>
        ))}
      </div>
      <p className="cc-note">The router picks the model for each question, then the cluster: only clusters that answer AI requests, and for sensitive requests only those where sensitive data is allowed. If that cluster&apos;s model is down, the same model on another cluster answers. Every change here is recorded in the Audit trail.</p>
    </>
  );
}
