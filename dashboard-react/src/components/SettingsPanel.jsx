import { useState, useEffect, useCallback } from "react";
import { useThemeStore } from "../store/themeStore";
import { useActiveCluster } from "../store/clusterStore";
import { useClusterQuery } from "../hooks/useClusterQuery";
import { showToast } from "../store/toastStore";

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
  { key: "appearance", label: "Appearance" },
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
    display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8,
    borderBottom: "1px solid var(--border)", marginBottom: 16,
    scrollbarWidth: "none", msOverflowStyle: "none",
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

function Toggle({ checked, onChange }) {
  return (
    <label className="guardrail-toggle">
      <input type="checkbox" checked={checked} onChange={onChange} />
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
/*  Main Panel                                                         */
/* ------------------------------------------------------------------ */

export function SettingsPanel({ open, onClose }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const cluster = useActiveCluster();
  const { data: clusterData } = useClusterQuery("/api/dashboard/health");

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
      case "appearance": return <AppearanceTab theme={theme} toggleTheme={toggleTheme} />;
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

          {/* ---- Global: Cluster Context ---- */}
          <div className="so-section">
            <div className="so-section-title">Cluster Context</div>
            <div className="cluster-ctx">
              <div className="ctx-title">
                <span className="ctx-dot" style={{ background: clusterData?.status === "Healthy" ? "#22c55e" : "#f59e0b" }} />
                {cluster === "local" ? "Hub (local)" : cluster}
              </div>
              <div className="ctx-row"><span>Health</span><span className="ctx-val">{clusterData?.status || "--"}</span></div>
              <div className="ctx-row"><span>Nodes</span><span className="ctx-val">{clusterData?.nodes ?? "--"}</span></div>
              <div className="ctx-row"><span>Namespaces</span><span className="ctx-val">{clusterData?.namespaces ?? "--"}</span></div>
              <div className="ctx-row"><span>Version</span><span className="ctx-val">{clusterData?.version || "--"}</span></div>
            </div>
          </div>

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
