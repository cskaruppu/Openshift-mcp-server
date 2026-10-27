import { useState, useEffect, useCallback, Fragment } from "react";
import { useThemeStore } from "../store/themeStore";
import { showToast } from "../store/toastStore";
import { refreshCommandCenterEnabled } from "./commandcenter/CommandCenter";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const PERSONAS = [
  { key: "sre", icon: "\u{1F6E0}", name: "SRE", desc: "Reliability, incidents, SLOs" },
  { key: "security", icon: "\u{1F6E1}", name: "Security", desc: "Compliance, CVEs, policies" },
  { key: "developer", icon: "\u{1F4BB}", name: "Developer", desc: "Apps, builds, routes, logs" },
  { key: "platform", icon: "☁", name: "Platform Admin", desc: "Capacity, upgrades, multi-cluster" },
];

const GUARDRAILS = [
  { key: "read", icon: "\u{1F50D}", label: "Read-only queries", default: true },
  { key: "scale", icon: "⚖", label: "Allow scaling operations", default: true },
  { key: "restart", icon: "♻", label: "Allow pod restart/delete", default: true },
  { key: "node", icon: "\u{1F6A7}", label: "Allow node drain/cordon", default: false },
  { key: "delete", icon: "\u{1F5D1}", label: "Allow resource deletion", default: false },
  { key: "impact", icon: "⚠", label: "Require impact analysis", default: true },
];

const TABS = [
  { key: "llm", label: "LLM Providers" },
  { key: "integrations", label: "Integrations" },
  { key: "rbac", label: "RBAC / Access" },
  { key: "notifications", label: "Notifications" },
  { key: "flags", label: "Feature Flags" },
  { key: "privateai", label: "Private AI" },
  { key: "appearance", label: "Appearance" },
  { key: "docs", label: "Documents" },
];

const LLM_PROVIDERS = [
  { key: "openai", abbr: "OA", color: "#10a37f", name: "OpenAI", defaultUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  { key: "anthropic", abbr: "AN", color: "#d4a27f", name: "Anthropic / Claude", defaultUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6",
    models: ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"] },
  { key: "azure", abbr: "AZ", color: "#0078d4", name: "Azure OpenAI", defaultUrl: "", defaultModel: "gpt-4o" },
  { key: "gemini", abbr: "GE", color: "#4285f4", name: "Google Gemini", defaultUrl: "https://generativelanguage.googleapis.com", defaultModel: "gemini-1.5-pro" },
  { key: "bedrock", abbr: "AW", color: "#ff9900", name: "AWS Bedrock", defaultUrl: "", defaultModel: "anthropic.claude-3-sonnet" },
  { key: "ollama", abbr: "OL", color: "#1d1d1f", name: "Ollama", defaultUrl: "http://localhost:11434", defaultModel: "llama3" },
];

const INTEGRATION_DEFS = [
  { key: "slack", name: "Slack", icon: "\u{1F4AC}", fields: [{ name: "webhookUrl", label: "Webhook URL", type: "url" }, { name: "channel", label: "Channel", type: "text" }] },
  { key: "teams", name: "Microsoft Teams", icon: "\u{1F4E2}", fields: [{ name: "webhookUrl", label: "Webhook URL", type: "url" }] },
  { key: "pagerduty", name: "PagerDuty", icon: "\u{1F6A8}", fields: [{ name: "routingKey", label: "Routing Key", type: "password" }, { name: "serviceId", label: "Service ID", type: "text" }] },
  { key: "prometheus", name: "Prometheus", icon: "\u{1F525}", fields: [{ name: "url", label: "Prometheus URL", type: "url" }, { name: "apiKey", label: "API Key", type: "password" }] },
  { key: "webhook", name: "Generic Webhook", icon: "\u{1F310}", fields: [{ name: "url", label: "Endpoint URL", type: "url" }, { name: "secret", label: "Secret", type: "password" }] },
];

const ROLE_DEFS = [
  { key: "admin", name: "Admin", desc: "Full access -- manage users, settings, all clusters, destructive operations" },
  { key: "operator", name: "Operator", desc: "Read + write access -- deploy, scale, restart, but cannot manage users or settings" },
  { key: "viewer", name: "Viewer", desc: "Read-only access -- view dashboards, logs, metrics. No mutations allowed" },
];

const NOTIFICATION_TYPES = ["Slack", "Microsoft Teams", "Webhook"];
const EVENT_TYPES = ["alert.critical", "alert.warning", "deployment.started", "deployment.failed", "node.drain", "pod.crash"];

/* ------------------------------------------------------------------ */
/*  Inline styles (keeps everything in one file)                       */
/* ------------------------------------------------------------------ */

const S = {
  tabBar: {
    // Wraps rather than scrolls: a hidden horizontal scroll hid the last tabs
    // on narrower screens and at higher browser zoom.
    display: "flex", flexWrap: "wrap", gap: 6, paddingBottom: 8,
    borderBottom: "1px solid var(--border)", marginBottom: 16,
  },
  tabBtn: (active) => ({
    padding: "5px 12px", borderRadius: 14, border: "1px solid var(--border)",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text2)",
    fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
  }),
  card: {
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 10, padding: 16, marginBottom: 12,
  },
  cardHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10,
  },
  badge: (color) => ({
    width: 32, height: 32, borderRadius: "50%", background: color,
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", fontSize: 11, fontWeight: 800, flexShrink: 0,
  }),
  cardTitle: { display: "flex", alignItems: "center", gap: 10, fontWeight: 600, fontSize: 14 },
  field: { marginBottom: 10 },
  label: { display: "block", fontSize: 11, color: "var(--text2)", marginBottom: 3, fontWeight: 600 },
  input: {
    width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--card)", color: "var(--text)", fontSize: 13, boxSizing: "border-box",
  },
  select: {
    width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)",
    background: "var(--card)", color: "var(--text)", fontSize: 13, boxSizing: "border-box",
  },
  btnPrimary: {
    padding: "8px 18px", borderRadius: 8, border: "none",
    background: "var(--accent)", color: "#fff", fontSize: 13,
    fontWeight: 600, cursor: "pointer",
  },
  btnOutline: {
    padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)",
    background: "transparent", color: "var(--text2)", fontSize: 12,
    fontWeight: 600, cursor: "pointer",
  },
  btnDanger: {
    padding: "6px 14px", borderRadius: 8, border: "1px solid #ef4444",
    background: "transparent", color: "#ef4444", fontSize: 12,
    fontWeight: 600, cursor: "pointer",
  },
  slider: {
    width: "100%", accentColor: "var(--accent)",
  },
  pillOn: {
    display: "inline-block", padding: "2px 10px", borderRadius: 10,
    background: "#22c55e22", color: "#22c55e", fontSize: 11, fontWeight: 700,
  },
  pillOff: {
    display: "inline-block", padding: "2px 10px", borderRadius: 10,
    background: "#ef444422", color: "#ef4444", fontSize: 11, fontWeight: 700,
  },
  row: { display: "flex", alignItems: "center", gap: 8 },
  muted: { fontSize: 12, color: "var(--text2)" },
  mb8: { marginBottom: 8 },
  mb12: { marginBottom: 12 },
  mb16: { marginBottom: 16 },
  mt8: { marginTop: 8 },
  mt12: { marginTop: 12 },
  flexBetween: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  gap8: { display: "flex", gap: 8 },
  chainItem: {
    display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
    background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8,
    fontSize: 13, marginBottom: 4,
  },
  chainBtns: { marginLeft: "auto", display: "flex", gap: 4 },
  chainBtn: {
    background: "none", border: "none", color: "var(--text2)",
    cursor: "pointer", fontSize: 14, padding: "0 2px",
  },
};

/* ------------------------------------------------------------------ */
/*  Utility                                                            */
/* ------------------------------------------------------------------ */

function Toggle({ checked, onChange, disabled }) {
  return (
    <label className="guardrail-toggle" style={disabled ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="gt-slider" />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 1: LLM Providers                                               */
/* ------------------------------------------------------------------ */

function LLMProvidersTab() {
  const [providers, setProviders] = useState(() => {
    const defaults = {};
    LLM_PROVIDERS.forEach((p) => {
      defaults[p.key] = { enabled: false, apiKey: "", apiUrl: p.defaultUrl, model: p.defaultModel };
    });
    return defaults;
  });
  const [temperature, setTemperature] = useState(0.3);
  const [maxTokens, setMaxTokens] = useState(2000);
  const [fallbackChain, setFallbackChain] = useState(["openai", "anthropic"]);
  const [testing, setTesting] = useState({});
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    fetch("/api/settings/llm")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        if (data.providers) {
          setProviders((prev) => {
            const merged = { ...prev };
            Object.keys(data.providers).forEach((k) => {
              if (merged[k]) merged[k] = { ...merged[k], ...data.providers[k] };
            });
            return merged;
          });
        }
        if (data.temperature != null) setTemperature(data.temperature);
        if (data.maxTokens != null) setMaxTokens(data.maxTokens);
        if (data.fallbackChain) setFallbackChain(data.fallbackChain);
      })
      .catch(() => {});
  }, []);

  const updateProvider = (key, field, value) => {
    setProviders((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const testConnection = async (key) => {
    setTesting((t) => ({ ...t, [key]: true }));
    try {
      const res = await fetch("/api/settings/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: key, ...providers[key] }),
      });
      const data = await res.json().catch(() => ({}));
      showToast(res.ok ? `${key}: Connection OK` : `${key}: ${data.error || "Failed"}`, res.ok ? "ok" : "err");
    } catch {
      showToast(`${key}: Connection failed`, "err");
    } finally {
      setTesting((t) => ({ ...t, [key]: false }));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers, temperature, maxTokens, fallbackChain }),
      });
      showToast(res.ok ? "LLM settings saved" : "Save failed", res.ok ? "ok" : "err");
    } catch {
      showToast("Save failed", "err");
    } finally {
      setSaving(false);
    }
  };

  const moveChain = (idx, dir) => {
    setFallbackChain((prev) => {
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  const removeChain = (idx) => {
    setFallbackChain((prev) => prev.filter((_, i) => i !== idx));
  };

  const addToChain = (key) => {
    if (!fallbackChain.includes(key)) setFallbackChain((prev) => [...prev, key]);
  };

  return (
    <div>
      {LLM_PROVIDERS.map((def) => {
        const prov = providers[def.key];
        return (
          <div key={def.key} style={S.card}>
            <div style={S.cardHeader}>
              <div style={S.cardTitle}>
                <div style={S.badge(def.color)}>{def.abbr}</div>
                <span>{def.name}</span>
              </div>
              <Toggle checked={prov.enabled} onChange={() => updateProvider(def.key, "enabled", !prov.enabled)} />
            </div>

            {prov.enabled && (
              <>
                <div style={S.field}>
                  <label style={S.label}>API Key</label>
                  <input
                    type="password"
                    style={S.input}
                    placeholder="sk-..."
                    value={prov.apiKey}
                    onChange={(e) => updateProvider(def.key, "apiKey", e.target.value)}
                  />
                </div>
                <div style={S.field}>
                  <label style={S.label}>API URL</label>
                  <input
                    type="text"
                    style={S.input}
                    placeholder={def.defaultUrl || "https://..."}
                    value={prov.apiUrl}
                    onChange={(e) => updateProvider(def.key, "apiUrl", e.target.value)}
                  />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Model</label>
                  {def.models ? (
                    <select
                      style={S.select}
                      value={prov.model}
                      onChange={(e) => updateProvider(def.key, "model", e.target.value)}
                    >
                      {def.models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  ) : (
                    <input
                      type="text"
                      style={S.input}
                      placeholder={def.defaultModel}
                      value={prov.model}
                      onChange={(e) => updateProvider(def.key, "model", e.target.value)}
                    />
                  )}
                </div>
                <button
                  style={{ ...S.btnOutline, ...(testing[def.key] ? { opacity: 0.6 } : {}) }}
                  onClick={() => testConnection(def.key)}
                  disabled={testing[def.key]}
                >
                  {testing[def.key] ? "Testing..." : "Test Connection"}
                </button>
              </>
            )}
          </div>
        );
      })}

      {/* Advanced */}
      <div style={S.card}>
        <div style={{ ...S.flexBetween, cursor: "pointer" }} onClick={() => setShowAdvanced(!showAdvanced)}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Advanced Settings</span>
          <span style={{ color: "var(--text2)", fontSize: 16 }}>{showAdvanced ? "▲" : "▼"}</span>
        </div>
        {showAdvanced && (
          <div style={S.mt12}>
            <div style={S.field}>
              <label style={S.label}>Temperature: {temperature.toFixed(2)}</label>
              <input
                type="range"
                min="0" max="1" step="0.01"
                style={S.slider}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
              />
              <div style={{ ...S.muted, display: "flex", justifyContent: "space-between" }}>
                <span>Precise (0)</span><span>Creative (1)</span>
              </div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Max Tokens</label>
              <input
                type="number"
                style={S.input}
                min={100} max={128000}
                value={maxTokens}
                onChange={(e) => setMaxTokens(parseInt(e.target.value, 10) || 2000)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Fallback Chain */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: 14, ...S.mb8 }}>Provider Fallback Chain</div>
        <div style={S.muted}>
          Order determines priority. If the first provider fails, the next is tried.
        </div>
        <div style={S.mt8}>
          {fallbackChain.map((key, idx) => {
            const def = LLM_PROVIDERS.find((p) => p.key === key);
            return (
              <div key={key} style={S.chainItem}>
                <span style={{ fontWeight: 600, color: "var(--text2)", fontSize: 11, width: 16 }}>{idx + 1}.</span>
                {def && <div style={{ ...S.badge(def.color), width: 22, height: 22, fontSize: 9 }}>{def.abbr}</div>}
                <span>{def?.name || key}</span>
                <div style={S.chainBtns}>
                  <button style={S.chainBtn} onClick={() => moveChain(idx, -1)} title="Move up">{"▲"}</button>
                  <button style={S.chainBtn} onClick={() => moveChain(idx, 1)} title="Move down">{"▼"}</button>
                  <button style={{ ...S.chainBtn, color: "#ef4444" }} onClick={() => removeChain(idx)} title="Remove">{"×"}</button>
                </div>
              </div>
            );
          })}
        </div>
        {LLM_PROVIDERS.filter((p) => !fallbackChain.includes(p.key)).length > 0 && (
          <div style={S.mt8}>
            <select
              style={{ ...S.select, width: "auto" }}
              value=""
              onChange={(e) => { if (e.target.value) addToChain(e.target.value); }}
            >
              <option value="">+ Add provider...</option>
              {LLM_PROVIDERS.filter((p) => !fallbackChain.includes(p.key)).map((p) => (
                <option key={p.key} value={p.key}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <button style={{ ...S.btnPrimary, width: "100%", ...(saving ? { opacity: 0.6 } : {}) }} onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save LLM Settings"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 2: Integrations                                                */
/* ------------------------------------------------------------------ */

function ServiceNowSection() {
  const [snow, setSnow] = useState({ instance: "", username: "", password: "" });
  const [connected, setConnected] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings/servicenow")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        setSnow({
          instance: data.instance || "",
          username: data.username || "",
          password: data.password ? "••••••••" : "",
        });
        setConnected(data.enabled || data.configured || false);
      })
      .catch(() => {});
  }, []);

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await fetch("/api/settings/servicenow/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snow),
      });
      const data = await res.json().catch(() => ({}));
      setConnected(res.ok);
      showToast(res.ok ? "ServiceNow connected" : `Failed: ${data.error || "Connection error"}`, res.ok ? "ok" : "err");
    } catch {
      setConnected(false);
      showToast("Connection failed", "err");
    } finally {
      setTesting(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/servicenow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snow),
      });
      showToast(res.ok ? "ServiceNow settings saved" : "Save failed", res.ok ? "ok" : "err");
    } catch {
      showToast("Save failed", "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={S.card}>
      <div style={S.cardHeader}>
        <div style={S.cardTitle}>
          <div style={S.badge("#0c5e2e")}>SN</div>
          <span>ServiceNow</span>
        </div>
        <span style={connected ? S.pillOn : connected === false ? S.pillOff : { ...S.pillOff, background: "#64748b22", color: "#94a3b8" }}>
          {connected ? "Connected" : connected === false ? "Not Connected" : "Unknown"}
        </span>
      </div>
      <div style={S.field}>
        <label style={S.label}>Instance URL</label>
        <input type="text" style={S.input} placeholder="https://yourinstance.service-now.com"
          value={snow.instance} onChange={(e) => setSnow((s) => ({ ...s, instance: e.target.value }))} />
      </div>
      <div style={S.field}>
        <label style={S.label}>Username</label>
        <input type="text" style={S.input} placeholder="admin"
          value={snow.username} onChange={(e) => setSnow((s) => ({ ...s, username: e.target.value }))} />
      </div>
      <div style={S.field}>
        <label style={S.label}>Password</label>
        <input type="password" style={S.input} placeholder="••••••••"
          value={snow.password} onChange={(e) => setSnow((s) => ({ ...s, password: e.target.value }))} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={{ ...S.btnOutline, ...(testing ? { opacity: 0.6 } : {}) }} onClick={testConnection} disabled={testing}>
          {testing ? "Testing..." : "Test Connection"}
        </button>
        <button style={{ ...S.btnPrimary, ...(saving ? { opacity: 0.6 } : {}) }} onClick={saveSettings} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      <div style={{ ...S.muted, marginTop: 8 }}>
        Used for Change Requests, Incidents, and approval workflows. Without ServiceNow, ITSM tickets are saved locally.
      </div>
    </div>
  );
}

/* vCenter — one credential PER SOURCE PROVIDER, not one for the product.
   An estate with several vCenters, or a fleet where each cluster's MTV points
   somewhere different, has no single correct answer: a global credential would
   authenticate happily against the wrong appliance and return somebody else's
   tags. So the list is the providers MTV already knows about, and each one
   resolves its own.

   The default needs no configuration at all. MTV already holds a credential
   for every provider it migrates from, and the agent reuses it — which is also
   the only version that cannot drift out of step with reality. */
const CRED_LABEL = {
  "mtv-secret": { text: "MTV's credential", tone: "#16a34a" },
  provider: { text: "registered here", tone: "#16a34a" },
  host: { text: "shared by host", tone: "#16a34a" },
  global: { text: "global fallback", tone: "#b45309" },
  "global-mismatch": { text: "wrong vCenter", tone: "#dc2626" },
  none: { text: "not configured", tone: "#94a3b8" },
};

function VCenterProviderRow({ p, onSaved }) {
  const [form, setForm] = useState({ username: p.username || "", password: "", insecure: p.insecure === true });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState(null);

  const post = async (body) => {
    const r = await fetch("/api/settings/vcenter", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Save failed");
    return d;
  };

  const test = async () => {
    setBusy("test"); setResult(null);
    try {
      const r = await fetch("/api/settings/vcenter/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: { uid: p.uid, name: p.name, url: p.url, secret: p.secret }, ...form }),
      });
      const d = await r.json().catch(() => ({}));
      setResult(d);
      showToast(d.success ? `${p.name} connected` : `Failed: ${d.error || "Connection error"}`, d.success ? "ok" : "err");
    } catch (e) { setResult({ success: false, error: e.message }); }
    finally { setBusy(""); }
  };

  const save = async () => {
    setBusy("save");
    try {
      await post({ uid: p.uid, ...form });
      showToast(`${p.name} credential saved`, "ok");
      onSaved?.();
    } catch (e) { showToast(e.message, "err"); }
    finally { setBusy(""); }
  };

  const label = CRED_LABEL[p.source] || CRED_LABEL.none;
  return (
    <div style={{ border: "1px solid var(--border,#28304a)", borderRadius: 8, padding: "9px 11px", marginBottom: 7 }}>
      <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: "0.82rem" }}>{p.name}</b>
        <span style={{ ...S.muted, fontFamily: "'SF Mono',ui-monospace,monospace", fontSize: "0.72rem" }}>{p.host || p.url}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.72rem", fontWeight: 700, color: label.tone }}>
          {p.configured ? "✓" : "○"} {label.text}
        </span>
        <button style={{ ...S.btnOutline, padding: "3px 10px", fontSize: "0.72rem" }} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : p.configured ? "Override" : "Configure"}
        </button>
      </div>
      {!p.configured && p.reason && (
        <div style={{ ...S.muted, marginTop: 5, fontSize: "0.74rem" }}>{p.reason}</div>
      )}
      {open && (
        <div style={{ marginTop: 9 }}>
          <div style={S.field}>
            <label style={S.label}>Username</label>
            <input type="text" style={S.input} placeholder="svc-migration-agent@vsphere.local"
              value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
          </div>
          <div style={S.field}>
            <label style={S.label}>Password</label>
            <input type="password" style={S.input} placeholder="••••••••"
              value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          </div>
          <label style={{ ...S.muted, display: "flex", gap: 7, alignItems: "center", margin: "2px 0 9px" }}>
            <input type="checkbox" checked={form.insecure}
              onChange={(e) => setForm((f) => ({ ...f, insecure: e.target.checked }))} />
            Accept a self-signed certificate on this appliance
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...S.btnOutline, ...(busy ? { opacity: 0.6 } : {}) }} onClick={test} disabled={!!busy}>
              {busy === "test" ? "Testing..." : "Test"}
            </button>
            <button style={{ ...S.btnPrimary, ...(busy ? { opacity: 0.6 } : {}) }} onClick={save} disabled={!!busy}>
              {busy === "save" ? "Saving..." : "Save"}
            </button>
          </div>
          <div style={{ ...S.muted, marginTop: 7, fontSize: "0.73rem" }}>
            The URL is not asked for — it comes from this provider in MTV, so it can never point somewhere
            other than the vCenter the migration reads from.
          </div>
        </div>
      )}
      {result && (
        <div style={{ ...S.muted, marginTop: 7, fontSize: "0.74rem", color: result.success ? "#16a34a" : "#dc2626" }}>
          {result.success
            ? `${result.detail}${result.soap ? " Performance history is readable." : ` Performance history is NOT readable${result.soapReason ? ` — ${result.soapReason}` : "."}`}`
            : result.error}
        </div>
      )}
    </div>
  );
}

function VCenterSection() {
  const [rows, setRows] = useState(null);
  const [useMtv, setUseMtv] = useState(true);
  const [err, setErr] = useState(null);

  const load = () => {
    fetch("/api/settings/vcenter/providers")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not read the source providers from MTV."))))
      .then((d) => { setRows(d.providers || []); setUseMtv(d.useMtvSecret !== false); setErr(null); })
      .catch((e) => { setRows([]); setErr(e.message); });
  };
  useEffect(load, []);

  const toggleMtv = async (on) => {
    setUseMtv(on);
    await fetch("/api/settings/vcenter", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useMtvSecret: on }),
    }).catch(() => {});
    load();
  };

  return (
    <div style={S.card}>
      <div style={S.cardHeader}>
        <div style={S.cardTitle}>
          <div style={S.badge("#1d4ed8")}>VC</div>
          <span>vCenter (read-only)</span>
        </div>
        <span style={{ ...S.muted, fontSize: "0.73rem" }}>
          {rows ? `${rows.filter((r) => r.configured).length} of ${rows.length} source provider(s) resolved` : "loading…"}
        </span>
      </div>

      <label style={{ ...S.muted, display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10 }}>
        <input type="checkbox" checked={useMtv} onChange={(e) => toggleMtv(e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          <b style={{ color: "var(--text,#e6e8ee)" }}>Reuse MTV&apos;s own provider credentials</b> — nothing to configure, correct per
          provider, and it rotates with MTV. The trade-off, stated plainly: that account belongs to MTV and MTV needs more than
          read, because it powers machines off and takes snapshots. This agent only ever reads with it. To run the assessment
          under a genuinely read-only account instead, register one against a provider below and it takes precedence.
        </span>
      </label>

      {err && <div style={{ ...S.muted, color: "#dc2626", marginBottom: 8 }}>{err}</div>}
      {rows?.length === 0 && !err && (
        <div style={S.muted}>No vSphere source provider is configured in MTV on the active cluster.</div>
      )}
      {rows?.map((p) => <VCenterProviderRow key={p.uid} p={p} onSaved={load} />)}

      <div style={{ ...S.muted, marginTop: 8 }}>
        Read-only is enough — <b>System.Read</b>. This reads what Forklift&apos;s inventory cannot carry: vCenter tags, which live
        in vAPI and decide how machines group into applications, and performance history from QueryPerf, which is what
        right-sizing measures. Providers are listed for the <b>active cluster</b>; switch cluster to configure another.
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const [integrations, setIntegrations] = useState(() => {
    const init = {};
    INTEGRATION_DEFS.forEach((d) => {
      const fields = {};
      d.fields.forEach((f) => { fields[f.name] = ""; });
      init[d.key] = { enabled: false, ...fields };
    });
    return init;
  });
  const [testing, setTesting] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/integrations")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        setIntegrations((prev) => {
          const merged = { ...prev };
          Object.keys(data).forEach((k) => {
            if (merged[k]) merged[k] = { ...merged[k], ...data[k] };
          });
          return merged;
        });
      })
      .catch(() => {});
  }, []);

  const update = (key, field, value) => {
    setIntegrations((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const testIntegration = async (key) => {
    setTesting((t) => ({ ...t, [key]: true }));
    try {
      const res = await fetch(`/api/integrations/${key}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(integrations[key]),
      });
      showToast(res.ok ? `${key}: Test OK` : `${key}: Test failed`, res.ok ? "ok" : "err");
    } catch {
      showToast(`${key}: Test failed`, "err");
    } finally {
      setTesting((t) => ({ ...t, [key]: false }));
    }
  };

  const saveAll = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(integrations),
      });
      showToast(res.ok ? "Integrations saved" : "Save failed", res.ok ? "ok" : "err");
    } catch {
      showToast("Save failed", "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* ServiceNow — dedicated section with its own API */}
      <ServiceNowSection />

      {/* vCenter — read-only, for tags and performance history */}
      <VCenterSection />

      {INTEGRATION_DEFS.map((def) => {
        const integ = integrations[def.key];
        return (
          <div key={def.key} style={S.card}>
            <div style={S.cardHeader}>
              <div style={S.cardTitle}>
                <span style={{ fontSize: 20 }}>{def.icon}</span>
                <span>{def.name}</span>
              </div>
              <Toggle checked={integ.enabled} onChange={() => update(def.key, "enabled", !integ.enabled)} />
            </div>
            {integ.enabled && (
              <>
                {def.fields.map((f) => (
                  <div key={f.name} style={S.field}>
                    <label style={S.label}>{f.label}</label>
                    <input
                      type={f.type}
                      style={S.input}
                      placeholder={f.label}
                      value={integ[f.name] || ""}
                      onChange={(e) => update(def.key, f.name, e.target.value)}
                    />
                  </div>
                ))}
                <button
                  style={{ ...S.btnOutline, ...(testing[def.key] ? { opacity: 0.6 } : {}) }}
                  onClick={() => testIntegration(def.key)}
                  disabled={testing[def.key]}
                >
                  {testing[def.key] ? "Testing..." : "Test"}
                </button>
              </>
            )}
          </div>
        );
      })}
      <button style={{ ...S.btnPrimary, width: "100%", ...(saving ? { opacity: 0.6 } : {}) }} onClick={saveAll} disabled={saving}>
        {saving ? "Saving..." : "Save All Integrations"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 3: RBAC / Access Control                                       */
/* ------------------------------------------------------------------ */

function RBACTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [assignUser, setAssignUser] = useState("");
  const [assignRole, setAssignRole] = useState("viewer");
  const [assignNamespaces, setAssignNamespaces] = useState("");
  const [assigning, setAssigning] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/users");
      const data = await res.json();
      setUsers(data.users || []);
    } catch {
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const assignRoleSubmit = async () => {
    if (!assignUser.trim()) { showToast("Username required", "err"); return; }
    setAssigning(true);
    try {
      const res = await fetch("/api/rbac/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: assignUser.trim(),
          role: assignRole,
          namespaces: assignNamespaces ? assignNamespaces.split(",").map((s) => s.trim()).filter(Boolean) : [],
        }),
      });
      showToast(res.ok ? "Role assigned" : "Assignment failed", res.ok ? "ok" : "err");
      if (res.ok) {
        setAssignUser("");
        setAssignNamespaces("");
        loadUsers();
      }
    } catch {
      showToast("Assignment failed", "err");
    } finally {
      setAssigning(false);
    }
  };

  return (
    <div>
      {/* Role descriptions */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: 14, ...S.mb8 }}>Role Definitions</div>
        {ROLE_DEFS.map((r) => (
          <div key={r.key} style={{ ...S.mb8, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{r.name}</div>
            <div style={S.muted}>{r.desc}</div>
          </div>
        ))}
      </div>

      {/* User list */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: 14, ...S.mb8 }}>Current Users</div>
        {loading ? (
          <div style={S.muted}>Loading users...</div>
        ) : users.length === 0 ? (
          <div style={S.muted}>No users found.</div>
        ) : (
          <table className="audit-table" style={{ width: "100%", marginBottom: 0 }}>
            <thead>
              <tr><th>User</th><th>Role</th><th>Status</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username}>
                  <td style={{ fontWeight: 600 }}>{u.display_name || u.username}</td>
                  <td>
                    <span className="pill" style={{
                      background: u.role === "admin" ? "var(--accent)" : u.role === "operator" ? "#3b82f6" : "#6b7280"
                    }}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    <span style={{
                      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                      background: u.active !== false ? "#22c55e" : "#666",
                    }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Assign role form */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: 14, ...S.mb8 }}>Assign Role</div>
        <div style={S.field}>
          <label style={S.label}>Username</label>
          <input
            type="text" style={S.input} placeholder="e.g. john.doe"
            value={assignUser} onChange={(e) => setAssignUser(e.target.value)}
          />
        </div>
        <div style={S.field}>
          <label style={S.label}>Role</label>
          <select style={S.select} value={assignRole} onChange={(e) => setAssignRole(e.target.value)}>
            {ROLE_DEFS.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </div>
        <div style={S.field}>
          <label style={S.label}>Namespaces (comma-separated, blank for all)</label>
          <input
            type="text" style={S.input} placeholder="default, kube-system"
            value={assignNamespaces} onChange={(e) => setAssignNamespaces(e.target.value)}
          />
        </div>
        <button
          style={{ ...S.btnPrimary, ...(assigning ? { opacity: 0.6 } : {}) }}
          onClick={assignRoleSubmit} disabled={assigning}
        >
          {assigning ? "Assigning..." : "Assign Role"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 4: Notifications                                               */
/* ------------------------------------------------------------------ */

function NotificationsTab() {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("Slack");
  const [newUrl, setNewUrl] = useState("");
  const [newEvents, setNewEvents] = useState([]);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState({});

  const loadChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/channels");
      const data = await res.json();
      setChannels(data.channels || data || []);
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadChannels(); }, [loadChannels]);

  const toggleEvent = (evt) => {
    setNewEvents((prev) => prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]);
  };

  const createChannel = async () => {
    if (!newName.trim() || !newUrl.trim()) { showToast("Name and URL required", "err"); return; }
    setCreating(true);
    try {
      const res = await fetch("/api/notifications/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), type: newType, url: newUrl.trim(), events: newEvents }),
      });
      showToast(res.ok ? "Channel created" : "Create failed", res.ok ? "ok" : "err");
      if (res.ok) {
        setNewName(""); setNewUrl(""); setNewEvents([]);
        loadChannels();
      }
    } catch {
      showToast("Create failed", "err");
    } finally {
      setCreating(false);
    }
  };

  const testChannel = async (id) => {
    setTesting((t) => ({ ...t, [id]: true }));
    try {
      const res = await fetch(`/api/notifications/channels/${id}/test`, { method: "POST" });
      showToast(res.ok ? "Test notification sent" : "Test failed", res.ok ? "ok" : "err");
    } catch {
      showToast("Test failed", "err");
    } finally {
      setTesting((t) => ({ ...t, [id]: false }));
    }
  };

  const deleteChannel = async (id) => {
    try {
      const res = await fetch(`/api/notifications/channels/${id}`, { method: "DELETE" });
      showToast(res.ok ? "Channel deleted" : "Delete failed", res.ok ? "ok" : "err");
      if (res.ok) loadChannels();
    } catch {
      showToast("Delete failed", "err");
    }
  };

  return (
    <div>
      {/* Existing channels */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: 14, ...S.mb8 }}>Notification Channels</div>
        {loading ? (
          <div style={S.muted}>Loading...</div>
        ) : channels.length === 0 ? (
          <div style={S.muted}>No channels configured.</div>
        ) : (
          channels.map((ch) => (
            <div key={ch.id || ch.name} style={{
              ...S.flexBetween, padding: "8px 0",
              borderBottom: "1px solid var(--border)",
            }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{ch.name}</div>
                <div style={S.muted}>{ch.type} -- {ch.events?.join(", ") || "all events"}</div>
              </div>
              <div style={S.gap8}>
                <button
                  style={{ ...S.btnOutline, ...(testing[ch.id] ? { opacity: 0.6 } : {}) }}
                  onClick={() => testChannel(ch.id || ch.name)}
                  disabled={testing[ch.id]}
                >
                  {testing[ch.id] ? "..." : "Test"}
                </button>
                <button style={S.btnDanger} onClick={() => deleteChannel(ch.id || ch.name)}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create new channel */}
      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: 14, ...S.mb8 }}>Create Channel</div>
        <div style={S.field}>
          <label style={S.label}>Channel Name</label>
          <input type="text" style={S.input} placeholder="e.g. ops-alerts" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div style={S.field}>
          <label style={S.label}>Type</label>
          <select style={S.select} value={newType} onChange={(e) => setNewType(e.target.value)}>
            {NOTIFICATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={S.field}>
          <label style={S.label}>URL / Webhook</label>
          <input type="url" style={S.input} placeholder="https://hooks.slack.com/..." value={newUrl} onChange={(e) => setNewUrl(e.target.value)} />
        </div>
        <div style={S.field}>
          <label style={S.label}>Event Types</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, ...S.mt8 }}>
            {EVENT_TYPES.map((evt) => (
              <button
                key={evt}
                style={{
                  ...S.btnOutline, fontSize: 11, padding: "3px 8px",
                  ...(newEvents.includes(evt) ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : {}),
                }}
                onClick={() => toggleEvent(evt)}
              >
                {evt}
              </button>
            ))}
          </div>
        </div>
        <button
          style={{ ...S.btnPrimary, ...(creating ? { opacity: 0.6 } : {}) }}
          onClick={createChannel} disabled={creating}
        >
          {creating ? "Creating..." : "Create Channel"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 5: Feature Flags                                               */
/* ------------------------------------------------------------------ */

function FeatureFlagsTab() {
  const [flags, setFlags] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/feature-flags")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) setFlags(data.flags || data || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={S.muted}>Loading feature flags...</div>;
  if (flags.length === 0) return <div style={S.muted}>No feature flags configured.</div>;

  return (
    <div>
      {flags.map((f) => (
        <div key={f.name || f.key} style={{ ...S.card, ...S.flexBetween }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{f.name || f.key}</div>
            {f.description && <div style={S.muted}>{f.description}</div>}
          </div>
          <span style={f.enabled ? S.pillOn : S.pillOff}>
            {f.enabled ? "ON" : "OFF"}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Private AI tab: Command Center switches + live prerequisites       */
/* ------------------------------------------------------------------ */

const PRE_ROWS = [["access", "Cluster access"], ["gpu", "GPU nodes"], ["models", "Models"], ["demo", "Demo app"], ["permissions", "Permissions"]];

/* Direct API access for the hub to the GPU cluster, used by the Command Center
   only (the rest of the console keeps reaching the cluster as before). Either
   the three values connect-gpu-cluster.sh prints (a limited, expiring service
   account — recommended) or a kubeconfig (your own login: quick, but with your
   rights and your login's expiry). Tokens never come back from the server. */
function AccessFacts({ r }) {
  if (!r || !("identity" in r)) return null;
  const rows = [
    ["Signed in as", `${r.identity || "unknown"}${r.kind ? ` (${r.kind})` : ""}`],
    ["Rights", r.clusterAdmin ? "cluster-admin — far more than the demo needs" : "limited"],
    ["Expiry", r.kind === "certificate login" ? "not kept — used once for the setup" : r.expiry || (r.permanent ? "does not expire" : "unknown")],
  ];
  return (
    <div style={{ fontSize: 12, margin: "0 0 10px", display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px" }}>
      {rows.map(([k, v]) => (
        <Fragment key={k}><span style={{ color: "var(--text2)" }}>{k}</span>
          <span style={{ color: (k === "Rights" && r.clusterAdmin) || (k === "Expiry" && r.permanent) ? "#f59e0b" : "var(--text)", fontWeight: 600 }}>{v}</span></Fragment>
      ))}
      {(r.notes || []).map((n) => <span key={n} style={{ gridColumn: "1 / -1", color: "#f59e0b" }}>{n}</span>)}
    </div>
  );
}

const dim = (off) => (off ? { opacity: 0.5, cursor: "not-allowed" } : null);

function ClusterAccessForm({ cluster, saved, onSaved }) {
  const [mode, setMode] = useState("values");
  const [f, setF] = useState({ apiUrl: saved?.apiUrl || "", token: "", caCert: "", kubeconfig: "", context: "" });
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [ackAdmin, setAckAdmin] = useState(false);
  const [hours, setHours] = useState(72);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setResult(null); setAckAdmin(false); };
  const body = () => (mode === "kubeconfig"
    ? { cluster, kubeconfig: f.kubeconfig, context: f.context || null, caCert: f.caCert.trim() || null, acknowledgeAdmin: ackAdmin, durationHours: hours }
    : { cluster, apiUrl: f.apiUrl.trim(), token: f.token.trim(), caCert: f.caCert.trim() || null, acknowledgeAdmin: ackAdmin });
  const ready = mode === "kubeconfig" ? f.kubeconfig.trim() : f.apiUrl.trim() && f.token.trim();
  const call = async (path, method, payload) => {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  };
  const run = async (what, fn) => {
    setBusy(what);
    try { await fn(); } catch (e) { setResult({ ok: false, message: e.message }); } finally { setBusy(null); }
  };
  const test = () => run("test", async () => {
    const j = await call("/api/private-ai/cluster-access/test", "POST", body());
    setResult(j);
    if (j.context && !f.context) setF((x) => ({ ...x, context: j.context }));
  });
  const save = (extra = {}) => run("save", async () => {
    const j = await call("/api/private-ai/cluster-access", "POST", { ...body(), ...extra });
    setResult(j);
    if (j.ok) { showToast(`Direct access to ${cluster} saved`, "ok"); setF({ apiUrl: j.apiUrl || "", token: "", caCert: "", kubeconfig: "", context: "" }); onSaved(); }
  });
  const remove = () => run("remove", async () => {
    await call(`/api/private-ai/cluster-access?cluster=${encodeURIComponent(cluster)}`, "DELETE");
    showToast(`Direct access to ${cluster} removed`, "ok"); onSaved();
  });
  const upload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => { setF((x) => ({ ...x, kubeconfig: t, context: "" })); setResult(null); });
    e.target.value = "";
  };
  // Saving a cluster-admin login needs an explicit yes once the test has shown it;
  // setting up limited access with it instead needs none.
  const needsAck = result?.clusterAdmin && !ackAdmin;
  const offer = result?.ok && result.setupOffer;
  const canSetUp = mode === "kubeconfig" && result?.clusterAdmin && ("identity" in result);
  const tab = (key, label) => (
    <button style={{ ...S.tabBtn(mode === key), fontSize: 11 }} onClick={() => { setMode(key); setResult(null); setAckAdmin(false); }}>{label}</button>
  );

  return (
    <div style={{ ...S.card, marginTop: 10, marginBottom: 0 }}>
      <div style={{ display: "flex", gap: 6, ...S.mb8 }}>
        {tab("values", "Limited access (recommended)")}
        {tab("kubeconfig", "Use a kubeconfig")}
      </div>
      {mode === "values" ? (
        <div style={{ ...S.muted, ...S.mb8 }}>
          On a machine logged in to {cluster}, run <code>deploy/demo/private-ai-ops/connect-gpu-cluster.sh --context &lt;{cluster} context&gt;</code> and paste what it prints.
          It creates access that can read the cluster and change only the demo namespace, and expires by itself (72 h by default).
        </div>
      ) : (
        <div style={{ ...S.muted, ...S.mb8 }}>
          Uses your own login from the kubeconfig: nothing to set up on {cluster}, but the hub acts with your rights, and stops working when your login expires (usually 24 h).
          A certificate login (such as the installer's admin kubeconfig) is never stored: it is used once to set up limited access.
        </div>
      )}

      {mode === "values" ? (
        <>
          <div style={S.field}>
            <label style={S.label}>API URL</label>
            <input style={S.input} placeholder="https://api.cluster02-gpu.example:6443" value={f.apiUrl} onChange={set("apiUrl")} />
          </div>
          <div style={S.field}>
            <label style={S.label}>Service account token</label>
            <input style={S.input} type="password" autoComplete="off" placeholder={saved ? "saved — paste a new one to replace it" : ""} value={f.token} onChange={set("token")} />
          </div>
        </>
      ) : (
        <>
          <div style={S.field}>
            <div style={{ ...S.flexBetween, marginBottom: 3 }}>
              <label style={{ ...S.label, marginBottom: 0 }}>Kubeconfig</label>
              <label style={{ ...S.btnOutline, padding: "3px 10px", fontSize: 11 }}>Upload file<input type="file" accept=".yaml,.yml,.conf,.config,*" style={{ display: "none" }} onChange={upload} /></label>
            </div>
            <textarea style={{ ...S.input, minHeight: 90, fontFamily: "var(--tcs-font-mono)", fontSize: 11 }} placeholder={"apiVersion: v1\nkind: Config\n…   (oc config view --minify --raw)"} value={f.kubeconfig} onChange={set("kubeconfig")} />
          </div>
          {result?.contexts?.length > 1 && (
            <div style={S.field}>
              <label style={S.label}>Context</label>
              <select style={S.select} value={f.context || result.context || ""} onChange={set("context")}>
                {result.contexts.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
        </>
      )}
      <div style={S.field}>
        <label style={S.label}>CA certificate <span style={{ fontWeight: 400 }}>(PEM; {mode === "kubeconfig" ? "taken from the kubeconfig when it has one" : "leave empty if the API certificate is already trusted"})</span></label>
        <textarea style={{ ...S.input, minHeight: 56, fontFamily: "var(--tcs-font-mono)", fontSize: 11 }} placeholder="-----BEGIN CERTIFICATE-----" value={f.caCert} onChange={set("caCert")} />
      </div>

      {result && <div style={{ fontSize: 12, marginBottom: 8, color: result.ok ? "#22c55e" : result.needsAck ? "#f59e0b" : "#ef4444", wordBreak: "break-word" }}>{result.message || result.error}</div>}
      <AccessFacts r={result} />
      {canSetUp && (
        <div style={{ ...S.card, background: "var(--card)", padding: 12, marginBottom: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{offer && result.certificateLogin ? "Set up limited access with this login (recommended)" : "Or set up limited access with this login instead (recommended)"}</div>
          <div style={{ color: "var(--text2)", marginBottom: 8 }}>
            The hub uses {result.identity || "this login"} once, to deploy the demo app and create a service account that can read {cluster} and change only the demo namespace, with a token that expires.
            {result.certificateLogin ? " The certificate is not stored." : " Your login is not stored."}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label style={{ ...S.label, marginBottom: 0 }}>Valid for</label>
            <select style={{ ...S.select, width: "auto" }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[[24, "24 hours"], [72, "3 days"], [168, "1 week"], [336, "2 weeks"]].map(([h, l]) => <option key={h} value={h}>{l}</option>)}
            </select>
            <button style={{ ...S.btnPrimary, ...dim(!!busy) }} disabled={!!busy} onClick={() => save({ setupLimited: true })}>{busy === "save" ? "Setting up..." : "Set up limited access"}</button>
          </div>
        </div>
      )}
      {result?.clusterAdmin && !offer && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, marginBottom: 10 }}>
          <input type="checkbox" checked={ackAdmin} onChange={(e) => setAckAdmin(e.target.checked)} />
          <span>I understand the Private AI Factory will act on {cluster} with cluster-admin rights, recorded as {result.identity || "this login"}.</span>
        </label>
      )}
      <div style={S.gap8}>
        <button style={{ ...S.btnOutline, ...dim(!ready || !!busy) }} disabled={!ready || !!busy} onClick={test}>{busy === "test" ? "Testing..." : "Test"}</button>
        {!offer && <button style={{ ...S.btnPrimary, ...dim(!ready || !!busy || needsAck) }} disabled={!ready || !!busy || needsAck} onClick={() => save()} title={needsAck ? "Confirm the cluster-admin warning first" : ""}>{busy === "save" ? "Connecting..." : "Test and save"}</button>}
        {saved && <button style={{ ...S.btnDanger, marginLeft: "auto" }} disabled={!!busy} onClick={remove}>Remove access</button>}
      </div>
    </div>
  );
}

function PrivateAITab() {
  const [data, setData] = useState(null);
  const [clusters, setClusters] = useState([]);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(null);
  const [err, setErr] = useState(null);
  const [showAccess, setShowAccess] = useState(false);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch("/api/private-ai/settings");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setData(j); setErr(null);
    } catch (e) { setErr(e.message); }
    finally { setChecking(false); }
  }, []);

  useEffect(() => {
    load();
    fetch("/api/agent/status").then((r) => (r.ok ? r.json() : null))
      .then((d) => setClusters((d?.agents || []).map((a) => a.name).filter(Boolean)))
      .catch(() => {});
  }, [load]);

  const save = async (patch, what) => {
    setSaving(what);
    try {
      const r = await fetch("/api/private-ai/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      refreshCommandCenterEnabled();
      showToast("Private AI settings saved", "ok");
      await load();
    } catch (e) { showToast(e.message, "err"); }
    finally { setSaving(null); }
  };

  if (!data && !err) return <div style={S.muted}>Checking prerequisites...</div>;
  if (!data) return <div style={{ ...S.card, color: "#ef4444", fontSize: 13 }}>{err}</div>;

  const { settings: st, prerequisites: pre, access: savedAccess, you } = data;
  const canEdit = you?.canManage && !st.lockedOff;
  const chatReady = !!pre.models?.chatReady;
  const switches = [
    { key: "commandCenter", label: "Private AI Factory", desc: "The Private AI Factory view and its launchers (workspace button, Ctrl+K)",
      needs: "Nothing. Acts whose prerequisites are missing show “not ready”.", disabled: false },
    { key: "banner", label: "Dashboard banner", desc: "The launch banner at the top of every cluster dashboard",
      needs: st.commandCenter ? "Private AI Factory on ✓" : "Turn the Private AI Factory on first", disabled: !st.commandCenter },
    { key: "routeChat", label: "Route platform AI to the on-prem models", desc: "AI Chat, incident root cause, VM assessment and background analysis use Private AI: each request answered by the right model on your GPUs",
      needs: chatReady ? "A chat model is answering ✓" : "A reasoning or fast-answer model must be answering", disabled: !st.routeChat && !chatReady },
  ];
  const sourceLabel = { settings: "set here", environment: "from the deployment", deployment: "locked by the deployment" };

  return (
    <div>
      <div style={{ ...S.muted, ...S.mb12 }}>
        Turn the Private AI Factory on and off. Each switch unlocks when what it needs is in place. Changes apply immediately for every user and are recorded in the Audit trail.
      </div>

      {st.lockedOff && (
        <div style={{ ...S.card, borderColor: "#f59e0b", fontSize: 12 }}>
          Switched off by the deployment (<code>PRIVATE_AI_OPS=false</code>, set by <code>disable.sh</code>). Run <code>enable.sh</code>, or remove that variable, to manage it here.
        </div>
      )}
      {!you?.canManage && <div style={{ ...S.muted, ...S.mb12 }}>Read-only: changing these needs the Admin role.</div>}

      <div style={S.card}>
        <div style={{ fontWeight: 600, fontSize: 13, ...S.mb8 }}>GPU cluster</div>
        <select style={S.select} value={st.cluster} disabled={!canEdit || saving === "cluster"} onChange={(e) => save({ cluster: e.target.value }, "cluster")}>
          <option value="local">Hub cluster (this platform)</option>
          {[...new Set([...clusters, ...(st.cluster !== "local" ? [st.cluster] : [])])].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div style={{ ...S.muted, ...S.mt8 }}>Where the GPUs, the models and the demo app run. The internet switch always applies to the platform itself.</div>
      </div>

      <div style={S.card}>
        <div style={{ ...S.flexBetween, ...S.mb8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Prerequisites <span style={{ ...S.muted, fontWeight: 400 }}>checked live on {st.cluster === "local" ? "the hub" : st.cluster}</span></div>
          <button style={S.btnOutline} onClick={load} disabled={checking}>{checking ? "Checking..." : "↻ Re-check"}</button>
        </div>
        {PRE_ROWS.filter(([k]) => pre[k]).map(([k, label]) => {
          const p = pre[k] || {};
          return (
            <div key={k} style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)", fontSize: 12 }}>
              <span aria-label={p.ok && !p.fix ? "met" : p.ok ? "met, with a warning" : "not met"} style={{ width: 18, flexShrink: 0, fontWeight: 800, color: p.ok && !p.fix ? "#22c55e" : "#f59e0b" }}>{p.ok && !p.fix ? "✓" : "!"}</span>
              <div style={{ minWidth: 0 }}>
                <div><b>{label}</b> <span style={{ color: "var(--text2)" }}>{p.detail}</span></div>
                {p.fix && <div style={{ ...S.muted, marginTop: 3 }}>Fix: <code style={{ wordBreak: "break-all" }}>{p.fix}</code></div>}
                {k === "access" && st.cluster !== "local" && canEdit && p.mode === "direct" && !p.expired && !showAccess && (
                  <button style={{ ...S.btnOutline, marginTop: 6 }} onClick={() => setShowAccess(true)}>{p.expiringSoon ? "Renew access" : "Update access"}</button>
                )}
              </div>
            </div>
          );
        })}
        {st.cluster !== "local" && canEdit && pre.access && (pre.access.mode !== "direct" || pre.access.expired || showAccess) && (
          <ClusterAccessForm key={st.cluster} cluster={st.cluster} saved={savedAccess} onSaved={() => { setShowAccess(false); load(); }} />
        )}
      </div>

      {switches.map((w) => (
        <div key={w.key} style={{ ...S.card, ...S.flexBetween, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{w.label}</div>
            <div style={S.muted}>{w.desc}</div>
            <div style={{ ...S.muted, marginTop: 4 }}>Needs: {w.needs} · <i>{sourceLabel[st.source?.[w.key]] || ""}</i></div>
          </div>
          <Toggle checked={!!st[w.key]} disabled={!canEdit || w.disabled || saving === w.key} onChange={() => save({ [w.key]: !st[w.key] }, w.key)} />
        </div>
      ))}

      {st.updatedBy && <div style={S.muted}>Last changed by {st.updatedBy} · {new Date(st.updatedAt).toLocaleString()}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab 6: Appearance                                                  */
/* ------------------------------------------------------------------ */

function AppearanceTab({ theme, toggleTheme }) {
  const [autoRefresh, setAutoRefresh] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mcp-auto-refresh") ?? "true"); } catch { return true; }
  });

  const toggleAutoRefresh = () => {
    setAutoRefresh((prev) => {
      const next = !prev;
      localStorage.setItem("mcp-auto-refresh", JSON.stringify(next));
      showToast(`Auto-refresh ${next ? "enabled" : "disabled"}`, "ok");
      return next;
    });
  };

  return (
    <div>
      <div style={S.card}>
        <div className="guardrail-item">
          <div className="gi-label"><span className="gi-icon">{theme === "dark" ? "☾" : "☀"}</span> Dark theme</div>
          <Toggle checked={theme === "dark"} onChange={toggleTheme} />
        </div>
      </div>
      <div style={S.card}>
        <div className="guardrail-item">
          <div className="gi-label"><span className="gi-icon">{"⟳"}</span> Auto-refresh dashboards</div>
          <Toggle checked={autoRefresh} onChange={toggleAutoRefresh} />
        </div>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Documents Tab                                                      */
/* ------------------------------------------------------------------ */

const DOCS = [
  { id: "hld-lld", title: "HLD & LLD Architecture Design", desc: "Complete high-level and low-level design with architecture diagrams", icon: "\u{1F3D7}" },
  { id: "network-arch", title: "Multi-Cluster Network Architecture", desc: "Network connectivity, firewall rules, DNS, and TLS requirements", icon: "\u{1F310}" },
  { id: "product-overview", title: "Product Overview", desc: "TCS Agentic AI product capabilities and features", icon: "\u{1F4CB}" },
  { id: "customer-benefits", title: "Customer Benefits", desc: "Business value and ROI analysis", icon: "\u{1F4C8}" },
  { id: "mcp-comparison", title: "MCP Comparison", desc: "TCS Agentic AI vs Official MCP feature comparison", icon: "\u{1F50D}" },
];

function DocumentsTab() {
  const [downloading, setDownloading] = useState(null);

  const downloadDoc = async (docId) => {
    setDownloading(docId);
    try {
      const res = await fetch(`/api/docs/download?doc=${docId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        showToast(err.error || "Download failed", "error");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `${docId}.docx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`Downloaded ${filename}`, "ok");
    } catch {
      showToast("Download failed — check server connection", "error");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--text2)", marginBottom: 12 }}>
        Download architecture and design documents in DOCX format.
        Open in Word, LibreOffice, or Google Docs. Use "Save as PDF" for PDF format.
      </p>
      {DOCS.map((doc) => (
        <div key={doc.id} style={S.card}>
          <div style={S.cardHeader}>
            <div style={S.cardTitle}>
              <span style={{ fontSize: 20 }}>{doc.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{doc.title}</div>
                <div style={{ fontSize: 11, color: "var(--text2)", fontWeight: 400, marginTop: 2 }}>{doc.desc}</div>
              </div>
            </div>
            <button
              style={{ ...S.btnPrimary, opacity: downloading === doc.id ? 0.6 : 1, minWidth: 90 }}
              disabled={downloading === doc.id}
              onClick={() => downloadDoc(doc.id)}
            >
              {downloading === doc.id ? "..." : "Download"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Main Panel                                                         */
/* ------------------------------------------------------------------ */

export function SettingsPanel({ open, onClose }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  const [activeTab, setActiveTab] = useState("llm");

  const [persona, setPersona] = useState(() => localStorage.getItem("mcp-persona") || "sre");
  const [guards, setGuards] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("mcp-guardrails") || "null") ||
        Object.fromEntries(GUARDRAILS.map((g) => [g.key, g.default]));
    } catch {
      return Object.fromEntries(GUARDRAILS.map((g) => [g.key, g.default]));
    }
  });

  const selectPersona = (key) => {
    setPersona(key);
    localStorage.setItem("mcp-persona", key);
    showToast(`Persona switched to ${key}`, "ok");
  };

  const toggleGuard = (key) => {
    setGuards((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("mcp-guardrails", JSON.stringify(next));
      return next;
    });
  };

  if (!open) return null;

  const renderTab = () => {
    switch (activeTab) {
      case "llm": return <LLMProvidersTab />;
      case "integrations": return <IntegrationsTab />;
      case "rbac": return <RBACTab />;
      case "notifications": return <NotificationsTab />;
      case "flags": return <FeatureFlagsTab />;
      case "privateai": return <PrivateAITab />;
      case "appearance": return <AppearanceTab theme={theme} toggleTheme={toggleTheme} />;
      case "docs": return <DocumentsTab />;
      default: return null;
    }
  };

  return (
    <>
      <div className="settings-slideout-overlay open" onClick={onClose} />
      <div className="settings-slideout open">
        <div className="settings-slideout-header">
          <h3>Settings</h3>
          <button className="settings-slideout-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-slideout-body">

          {/* ---- Global: AI Persona ---- */}
          <div className="so-section">
            <div className="so-section-title">AI Persona</div>
            <div className="persona-cards">
              {PERSONAS.map((p) => (
                <div
                  key={p.key}
                  className={"persona-card" + (persona === p.key ? " active" : "")}
                  onClick={() => selectPersona(p.key)}
                >
                  <div className="persona-icon">{p.icon}</div>
                  <div className="persona-name">{p.name}</div>
                  <div className="persona-desc">{p.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- Global: AI Safety Guardrails ---- */}
          <div className="so-section">
            <div className="so-section-title">AI Safety Guardrails</div>
            <div className="guardrail-list">
              {GUARDRAILS.map((g) => (
                <div className="guardrail-item" key={g.key}>
                  <div className="gi-label"><span className="gi-icon">{g.icon}</span> {g.label}</div>
                  <Toggle checked={!!guards[g.key]} onChange={() => toggleGuard(g.key)} />
                </div>
              ))}
            </div>
          </div>

          {/* ---- Tab Bar ---- */}
          <div className="so-section">
            <div style={S.tabBar}>
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  style={S.tabBtn(activeTab === tab.key)}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ---- Active Tab Content ---- */}
            {renderTab()}
          </div>

        </div>
      </div>
    </>
  );
}
