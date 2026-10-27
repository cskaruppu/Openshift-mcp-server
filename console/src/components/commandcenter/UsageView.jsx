import { useState, useEffect, useCallback, useMemo } from "react";
import { RequestDetail } from "./FactoryFloor";

// Private AI Factory — Usage: tokens and requests per model, user and feature, by
// day, and every request (who asked, which model answered, tokens in and out,
// time). Read from /api/command-center/usage — the router's running totals, kept
// across restarts — and exportable as CSV. Questions are masked by the server.

const ROLE_COLOR = { large: "#3b6fd8", small: "#18a0a6", vision: "#8a5cd6", coder: "#2f9e8f", embed: "#d08a1e" };
const FEATURE = { "ai-chat": "AI Chat", "incident-memory": "Incident memory", "model-test": "Model test", "side-by-side": "Side by side", "UC-10": "VM assessment" };
const num = (n) => (n == null ? "—" : Number(n).toLocaleString());
const ms = (v) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const usd = (tokens, price) => `$${((tokens / 1e6) * price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const feature = (k) => FEATURE[k] || k || "other";

function rows(map) {
  return Object.entries(map || {}).map(([k, v]) => ({ key: k, ...v, avgMs: v.timed ? v.ms / v.timed : null })).sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
}

function Table({ title, sub, data, label, price, color }) {
  const max = Math.max(1, ...data.map((r) => r.tokens));
  return (
    <section className="cc-card">
      <header><h3>{title}</h3><span>{sub}</span></header>
      <div className="us-t">
        <div className="us-tr us-th"><span>{label}</span><span>Requests</span><span>Tokens in</span><span>Tokens out</span><span>Total</span><span>Avg time</span><span>Cloud equiv.</span></div>
        {data.map((r) => (
          <div key={r.key} className="us-tr">
            <span className="us-name">{color && <i className="ff-dot" style={{ background: color(r.key) }} />}<b title={r.key}>{label === "Feature" ? feature(r.key) : r.key}</b>
              <em className="us-bar"><i style={{ width: `${(r.tokens / max) * 100}%`, background: color ? color(r.key) : "var(--cc-blue)" }} /></em></span>
            <span className="mono">{num(r.requests)}{r.failed ? <em className="us-bad"> · {r.failed} failed</em> : null}{r.blocked ? <em className="us-bad"> · {r.blocked} blocked</em> : null}</span>
            <span className="mono">{num(r.tokensIn)}</span>
            <span className="mono">{num(r.tokensOut)}</span>
            <span className="mono"><b>{num(r.tokens)}</b></span>
            <span className="mono">{ms(r.avgMs)}</span>
            <span className="mono">{usd(r.tokens, price)}</span>
          </div>
        ))}
        {!data.length && <p className="cc-note">Nothing yet.</p>}
      </div>
    </section>
  );
}

function Days({ byDay }) {
  const days = Object.entries(byDay || {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-30);
  if (!days.length) return null;
  const max = Math.max(1, ...days.map(([, v]) => v.tokens));
  return (
    <section className="cc-card">
      <header><h3>Tokens per day</h3><span>last {days.length} day{days.length === 1 ? "" : "s"}</span></header>
      <div className="us-days">
        {days.map(([d, v]) => (
          <div key={d} className="us-day" title={`${d}: ${num(v.tokens)} tokens · ${num(v.requests)} requests`}>
            <i style={{ height: `${Math.max(2, (v.tokens / max) * 100)}%` }} />
            <span>{d.slice(5)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function csv(requests) {
  const head = ["time", "user", "feature", "model", "role", "cluster", "status", "tokens_in", "tokens_out", "tokens_total", "first_token_ms", "total_ms", "tools_called", "sensitive", "question_masked"];
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = requests.map((r) => [r.at, r.user || "", r.useCase || "", r.model || "", r.role || "", r.cluster || "", r.blocked ? "blocked" : r.ok ? "ok" : r.ok === false ? "failed" : "running",
    r.promptTokens ?? "", r.completionTokens ?? "", r.tokens ?? "", r.firstTokenMs ?? "", r.ms ?? "", (r.toolCalls || []).join(" "), (r.sensitive || []).join(" "), r.question || ""].map(esc).join(","));
  return [head.join(","), ...lines].join("\n");
}

export default function UsageView({ act$, busy }) {
  const [u, setU] = useState(null);
  const [err, setErr] = useState(null);
  const [fModel, setFModel] = useState("");
  const [fUser, setFUser] = useState("");
  const [detail, setDetail] = useState(null);
  const load = useCallback(async () => {
    try { const r = await fetch("/api/command-center/usage"); const j = await r.json(); if (!r.ok) throw new Error(j.error || "Usage unavailable"); setU(j); setErr(null); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const roleOf = useMemo(() => { const m = {}; for (const r of u?.requests || []) if (r.model && r.role) m[r.model] = r.role; return m; }, [u]);
  if (err && !u) return <div className="vc-alert">{err}</div>;
  if (!u) return <div className="cc-empty">Reading usage…</div>;

  const models = rows(u.byModel), users = rows(u.byUser), features = rows(u.byFeature);
  const tot = models.reduce((a, r) => ({ requests: a.requests + r.requests, tokens: a.tokens + r.tokens, tokensIn: a.tokensIn + r.tokensIn, tokensOut: a.tokensOut + r.tokensOut, failed: a.failed + r.failed, blocked: a.blocked + r.blocked }),
    { requests: 0, tokens: 0, tokensIn: 0, tokensOut: 0, failed: 0, blocked: 0 });
  const list = (u.requests || []).filter((r) => (!fModel || r.model === fModel) && (!fUser || (r.user || "platform (background)") === fUser));
  const download = () => {
    const blob = new Blob([csv(list)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `private-ai-usage-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const color = (m) => ROLE_COLOR[roleOf[m]] || "#9aa9bb";

  return (
    <>
      <div className="fl-totals us-totals">
        <div><span className="cc-lbl">Requests</span><b>{num(tot.requests)}</b><span className="cc-muted">{tot.failed ? `${num(tot.failed)} failed · ` : ""}{tot.blocked ? `${num(tot.blocked)} blocked` : "since " + new Date(u.since).toLocaleDateString()}</span></div>
        <div><span className="cc-lbl">Tokens</span><b>{num(tot.tokens)}</b><span className="cc-muted">{num(tot.tokensIn)} in · {num(tot.tokensOut)} out</span></div>
        <div><span className="cc-lbl">Per request</span><b>{tot.requests ? num(Math.round(tot.tokens / Math.max(1, tot.requests - tot.blocked))) : "—"}</b><span className="cc-muted">tokens on average</span></div>
        <div><span className="cc-lbl">Cloud equivalent</span><b>{usd(tot.tokens, u.pricePerMTok)}</b><span className="cc-muted">at ${u.pricePerMTok} per million tokens</span></div>
        <div><span className="cc-lbl">Users</span><b>{num(users.filter((r) => r.key !== "platform (background)").length)}</b><span className="cc-muted">plus platform background work</span></div>
        <div className="fl-mode">
          <span className="cc-lbl">Record since {new Date(u.since).toLocaleString()}</span>
          <div className="cc-actions">
            <button className="vc-btn ghost sm" onClick={download} disabled={!list.length}>Export CSV</button>
            {u.you?.canManage && <button className="vc-btn ghost sm" disabled={!!busy}
              onClick={() => { if (window.confirm("Reset the usage record? Totals per model, user, feature and day start again from zero.")) act$("usage-reset", async () => { const r = await fetch("/api/command-center/usage/reset", { method: "POST" }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Reset failed"); await load(); }, "Usage record reset"); }}>Reset</button>}
          </div>
        </div>
      </div>

      <div className="ff-row">
        <Table title="By model" sub="tokens each deployed model has processed" data={models} label="Model" price={u.pricePerMTok} color={color} />
        <Days byDay={u.byDay} />
      </div>
      <div className="ff-row us-row2">
        <Table title="By user" sub="who used Private AI (background = incident analysis, VM assessment…)" data={users} label="User" price={u.pricePerMTok} />
        <Table title="By feature" sub="where the tokens went" data={features} label="Feature" price={u.pricePerMTok} />
      </div>

      <section className="cc-card">
        <header><h3>Requests</h3><span>latest {num(list.length)} · click one for the full detail</span>
          <div className="us-filters">
            <select value={fModel} onChange={(e) => setFModel(e.target.value)} aria-label="Filter by model"><option value="">All models</option>{models.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}</select>
            <select value={fUser} onChange={(e) => setFUser(e.target.value)} aria-label="Filter by user"><option value="">All users</option>{users.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}</select>
          </div>
        </header>
        <div className="us-t">
          <div className="us-tr us-req us-th"><span>Time</span><span>User</span><span>Question (masked)</span><span>Model</span><span>Feature</span><span>In</span><span>Out</span><span>Time</span></div>
          {list.slice(0, 200).map((r) => (
            <div key={r.id} className="us-tr us-req click" role="button" tabIndex={0} onClick={() => setDetail(r)} onKeyDown={(e) => { if (e.key === "Enter") setDetail(r); }}>
              <span className="mono cc-muted">{new Date(r.at).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
              <span className="us-ell">{r.user || "platform"}</span>
              <span className="us-ell">{r.question || "—"}</span>
              <span className="us-ell">{r.blocked ? <span className="cc-pill crit">blocked</span> : <><i className="ff-dot" style={{ background: ROLE_COLOR[r.role] || "#9aa9bb" }} />{r.model || "—"}{r.ok === false ? <em className="us-bad"> · failed</em> : null}</>}</span>
              <span className="us-ell cc-muted">{feature(r.useCase)}</span>
              <span className="mono">{num(r.promptTokens)}</span>
              <span className="mono">{num(r.completionTokens)}</span>
              <span className="mono">{ms(r.ms)}</span>
            </div>
          ))}
          {!list.length && <p className="cc-note">No requests yet. Ask something in AI Chat with Private AI selected.</p>}
        </div>
      </section>
      {detail && <RequestDetail r={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
