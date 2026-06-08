import { useState, useEffect, useCallback } from "react";
import { useAuthStore } from "../store/authStore";
import { showToast } from "../store/toastStore";

const ROLE_DEFS = [
  { key: "admin", name: "Admin", desc: "Full access — manage users, settings, all clusters", color: "#ef4444" },
  { key: "operator", name: "Operator", desc: "Read + write — deploy, scale, restart", color: "#3b82f6" },
  { key: "viewer", name: "Viewer", desc: "Read-only — dashboards, logs, metrics", color: "#6b7280" },
];

const S = {
  card: {
    background: "var(--bg)", border: "1px solid var(--border)",
    borderRadius: 10, padding: 16, marginBottom: 12,
  },
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
  muted: { fontSize: 12, color: "var(--text2)" },
};

export function UserManagementPanel({ open, onClose }) {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "admin" || user?.name === "admin";

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState("");
  const [newDisplay, setNewDisplay] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("viewer");
  const [newNamespaces, setNewNamespaces] = useState("");
  const [creating, setCreating] = useState(false);

  const [changePw, setChangePw] = useState("");
  const [changePwSaving, setChangePwSaving] = useState(false);

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

  useEffect(() => {
    if (open) loadUsers();
  }, [open, loadUsers]);

  const createUser = async () => {
    if (!newUser.trim()) { showToast("Username required", "err"); return; }
    if (!newPassword || newPassword.length < 8) { showToast("Password must be 8+ characters", "err"); return; }
    setCreating(true);
    try {
      const res = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUser.trim(),
          display_name: newDisplay.trim() || newUser.trim(),
          password: newPassword,
          role: newRole,
          namespaces: newNamespaces ? newNamespaces.split(",").map((s) => s.trim()).filter(Boolean) : ["*"],
        }),
      });
      showToast(res.ok ? "User created" : "Create failed", res.ok ? "ok" : "err");
      if (res.ok) {
        setNewUser(""); setNewDisplay(""); setNewPassword(""); setNewNamespaces("");
        loadUsers();
      }
    } catch {
      showToast("Create failed", "err");
    } finally {
      setCreating(false);
    }
  };

  const deleteUser = async (username) => {
    if (!confirm(`Delete user "${username}"?`)) return;
    try {
      const res = await fetch(`/api/auth/users/${encodeURIComponent(username)}`, { method: "DELETE" });
      showToast(res.ok ? "User deleted" : "Delete failed", res.ok ? "ok" : "err");
      if (res.ok) loadUsers();
    } catch {
      showToast("Delete failed", "err");
    }
  };

  const changePassword = async () => {
    if (!changePw || changePw.length < 8) { showToast("Password must be 8+ characters", "err"); return; }
    setChangePwSaving(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: changePw }),
      });
      showToast(res.ok ? "Password changed" : "Change failed", res.ok ? "ok" : "err");
      if (res.ok) setChangePw("");
    } catch {
      showToast("Change failed", "err");
    } finally {
      setChangePwSaving(false);
    }
  };

  const handleLogout = async () => {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    useAuthStore.getState().logout();
    useAuthStore.getState().setUnauthenticated("password");
    showToast("Signed out", "ok");
    onClose();
  };

  if (!open) return null;

  return (
    <>
      <div className="settings-slideout-overlay open" onClick={onClose} />
      <div className="settings-slideout open">
        <div className="settings-slideout-header">
          <h3>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle", marginRight: 8 }}>
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            User Management
          </h3>
          <button className="settings-slideout-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-slideout-body">
          {/* Current user info */}
          <div style={S.card}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Current Session</div>
            {user && (
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                Signed in as <strong>{user.display_name || user.name || "anonymous"}</strong>
                {user.role && <span className="pill" style={{ marginLeft: 8, background: user.role === "admin" ? "var(--accent)" : "#3b82f6" }}>{user.role}</span>}
              </div>
            )}
            {user?.email && <div style={S.muted}>Email: {user.email}</div>}
          </div>

          {/* Password Policy */}
          <div style={S.card}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Security Policy</div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
              <div style={S.muted}>Password expiration: <strong>90 days</strong></div>
              <div style={S.muted}>Min length: <strong>8 chars</strong></div>
              <div style={S.muted}>Session TTL: <strong>24h</strong></div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Change My Password</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="password" style={{ ...S.input, flex: 1 }}
                  placeholder="New password (min 8 chars)"
                  value={changePw} onChange={(e) => setChangePw(e.target.value)}
                />
                <button
                  style={{ ...S.btnPrimary, whiteSpace: "nowrap", ...(changePwSaving ? { opacity: 0.6 } : {}) }}
                  onClick={changePassword} disabled={changePwSaving}
                >
                  {changePwSaving ? "Saving..." : "Update"}
                </button>
              </div>
            </div>
          </div>

          {/* Role definitions */}
          <div style={S.card}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Role Definitions</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {ROLE_DEFS.map((r) => (
                <div key={r.key} style={{
                  flex: 1, minWidth: 140, padding: "8px 12px",
                  borderRadius: 8, border: `1px solid var(--border)`,
                  borderTop: `3px solid ${r.color}`,
                  background: "var(--card)",
                }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text2)", lineHeight: 1.4 }}>{r.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* User list */}
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>All Users</div>
              <button style={S.btnOutline} onClick={loadUsers}>Refresh</button>
            </div>
            {loading ? (
              <div style={S.muted}>Loading users...</div>
            ) : users.length === 0 ? (
              <div style={S.muted}>No users found.</div>
            ) : (
              <table className="audit-table" style={{ width: "100%", marginBottom: 0 }}>
                <thead>
                  <tr><th>User</th><th>Role</th><th>Status</th>{isAdmin && <th>Actions</th>}</tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.username}>
                      <td style={{ fontWeight: 600 }}>{u.display_name || u.username}</td>
                      <td>
                        <span className="pill" style={{
                          background: u.role === "admin" ? "var(--accent)" : u.role === "operator" ? "#3b82f6" : "#6b7280"
                        }}>{u.role}</span>
                      </td>
                      <td>
                        <span style={{
                          display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11,
                        }}>
                          <span style={{
                            width: 8, height: 8, borderRadius: "50%",
                            background: u.active !== false ? "#22c55e" : "#666",
                          }} />
                          {u.active !== false ? "Active" : "Inactive"}
                        </span>
                      </td>
                      {isAdmin && (
                        <td>
                          {u.username !== user?.name && (
                            <button style={{ ...S.btnDanger, padding: "2px 8px", fontSize: 11 }} onClick={() => deleteUser(u.username)}>
                              Remove
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Create new user (admin only) */}
          {isAdmin && (
            <div style={S.card}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Create New User</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div style={S.field}>
                  <label style={S.label}>Username</label>
                  <input type="text" style={S.input} placeholder="e.g. john.doe" value={newUser} onChange={(e) => setNewUser(e.target.value)} />
                </div>
                <div style={S.field}>
                  <label style={S.label}>Display Name</label>
                  <input type="text" style={S.input} placeholder="John Doe" value={newDisplay} onChange={(e) => setNewDisplay(e.target.value)} />
                </div>
              </div>
              <div style={S.field}>
                <label style={S.label}>Password</label>
                <input type="password" style={S.input} placeholder="Min 8 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div style={S.field}>
                  <label style={S.label}>Role</label>
                  <select style={S.select} value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                    {ROLE_DEFS.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                  </select>
                </div>
                <div style={S.field}>
                  <label style={S.label}>Namespaces (comma-sep, * = all)</label>
                  <input type="text" style={S.input} placeholder="*, default, kube-system" value={newNamespaces} onChange={(e) => setNewNamespaces(e.target.value)} />
                </div>
              </div>
              <button
                style={{ ...S.btnPrimary, width: "100%", ...(creating ? { opacity: 0.6 } : {}) }}
                onClick={createUser} disabled={creating}
              >
                {creating ? "Creating..." : "Create User"}
              </button>
            </div>
          )}

          {/* Sign out */}
          <button className="so-logout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </div>
    </>
  );
}
