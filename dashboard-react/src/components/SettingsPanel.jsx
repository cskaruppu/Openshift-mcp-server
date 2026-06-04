import { useState, useEffect, useCallback } from "react";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";
import { useActiveCluster } from "../store/clusterStore";
import { useClusterQuery } from "../hooks/useClusterQuery";
import { showToast } from "../store/toastStore";

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

export function SettingsPanel({ open, onClose }) {
  const user = useAuthStore((s) => s.user);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const cluster = useActiveCluster();
  const { data: clusterData } = useClusterQuery("/api/dashboard/health");

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

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      useAuthStore.getState().logout();
      useAuthStore.getState().setUnauthenticated("password");
      showToast("Logged out", "ok");
      onClose();
    }
  }, [onClose]);

  if (!open) return null;

  const isAdmin = user?.role === "admin" || user?.name === "admin";

  return (
    <>
      <div className="settings-slideout-overlay open" onClick={onClose} />
      <div className="settings-slideout open">
        <div className="settings-slideout-header">
          <h3>Settings</h3>
          <button className="settings-slideout-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-slideout-body">

          {/* Cluster Context */}
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

          {/* AI Persona */}
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

          {/* AI Safety Guardrails */}
          <div className="so-section">
            <div className="so-section-title">AI Safety Guardrails</div>
            <div className="guardrail-list">
              {GUARDRAILS.map((g) => (
                <div className="guardrail-item" key={g.key}>
                  <div className="gi-label"><span className="gi-icon">{g.icon}</span> {g.label}</div>
                  <label className="guardrail-toggle">
                    <input type="checkbox" checked={!!guards[g.key]} onChange={() => toggleGuard(g.key)} />
                    <span className="gt-slider" />
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Appearance */}
          <div className="so-section">
            <div className="so-section-title">Appearance</div>
            <div className="guardrail-item">
              <div className="gi-label"><span className="gi-icon">{theme === "dark" ? "☾" : "☀"}</span> Dark theme</div>
              <label className="guardrail-toggle">
                <input type="checkbox" checked={theme === "dark"} onChange={toggleTheme} />
                <span className="gt-slider" />
              </label>
            </div>
          </div>

          {/* Account */}
          <div className="so-section">
            <div className="so-section-title">Account</div>
            {user && (
              <div style={{ fontSize: 13, marginBottom: 10 }}>
                Signed in as <strong>{user.display_name || user.name || "anonymous"}</strong>
                {user.role && <span className="scope-chip" style={{ marginLeft: 8 }}>{user.role}</span>}
              </div>
            )}
            {isAdmin && <UserManagement />}
            <button className="so-logout-btn" onClick={handleLogout}>Sign Out</button>
          </div>

        </div>
      </div>
    </>
  );
}

function UserManagement() {
  const [users, setUsers] = useState(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) return <div style={{ fontSize: 12, color: "var(--text2)" }}>Loading users…</div>;
  if (!users?.length) return <div style={{ fontSize: 12, color: "var(--text2)" }}>No users found.</div>;

  return (
    <div style={{ marginBottom: 12 }}>
      <table className="audit-table" style={{ marginBottom: 10 }}>
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.username}>
              <td style={{ fontWeight: 600 }}>{u.display_name || u.username}</td>
              <td><span className="pill" style={{ background: u.role === "admin" ? "var(--accent)" : "#3b82f6" }}>{u.role}</span></td>
              <td>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: u.active !== false ? "#22c55e" : "#666" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
