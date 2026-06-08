import { useState } from "react";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";

export function LoginOverlay() {
  const { checked, authenticated, authMode } = useAuthStore();
  const toggleTheme = useThemeStore((s) => s.toggle);
  const theme = useThemeStore((s) => s.theme);
  const [tab, setTab] = useState("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!checked || authenticated) return null;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const payload =
      tab === "token"
        ? { token: token.trim() }
        : { username: username.trim(), password };
    if (tab === "token" && !payload.token) {
      setError("Please enter a token");
      return;
    }
    if (tab === "password" && (!payload.username || !payload.password)) {
      setError("Please enter username and password");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        useAuthStore.getState().setAuth(data.user);
      } else {
        setError(data.error || "Invalid credentials");
      }
    } catch (err) {
      setError("Connection error: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-overlay">
      <button
        className="login-theme-toggle"
        onClick={toggleTheme}
        title="Toggle light/dark theme"
        dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }}
      />
      <div className="login-wrapper">
        <div className="login-hero">
          <div className="login-hero-logo">
            <svg viewBox="0 0 72 72" fill="none" width="72" height="72">
              <circle cx="36" cy="36" r="34" stroke="url(#lg2)" strokeWidth="2" fill="none" opacity=".6"/>
              <circle cx="36" cy="36" r="24" stroke="url(#lg2)" strokeWidth="1.5" fill="none" opacity=".3"/>
              <circle cx="36" cy="22" r="4" fill="#818cf8" opacity=".8"/>
              <circle cx="22" cy="44" r="3.5" fill="#a78bfa" opacity=".7"/>
              <circle cx="50" cy="44" r="3.5" fill="#6366f1" opacity=".7"/>
              <line x1="36" y1="26" x2="23" y2="41" stroke="#818cf8" strokeWidth="1.5" opacity=".5"/>
              <line x1="36" y1="26" x2="49" y2="41" stroke="#818cf8" strokeWidth="1.5" opacity=".5"/>
              <line x1="25" y1="44" x2="47" y2="44" stroke="#a78bfa" strokeWidth="1" opacity=".3"/>
              <defs>
                <linearGradient id="lg2" x1="0" y1="0" x2="72" y2="72">
                  <stop stopColor="#6366f1"/>
                  <stop offset=".5" stopColor="#a78bfa"/>
                  <stop offset="1" stopColor="#818cf8"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div className="login-hero-brand">
            <span className="tcs">TCS</span>{" "}
            <span className="agentic">Agentic</span>{" "}
            <span className="ai">AI</span>
          </div>
          <div className="login-hero-sub">Enterprise Intelligence Platform</div>
        </div>

        <div className="login-card">
          {authMode !== "none" && (
            <div className="login-tabs">
              <button
                className={"login-tab-btn" + (tab === "password" ? " active" : "")}
                onClick={() => setTab("password")}
              >
                Password
              </button>
              <button
                className={"login-tab-btn" + (tab === "token" ? " active" : "")}
                onClick={() => setTab("token")}
              >
                API Token
              </button>
            </div>
          )}

          <form onSubmit={submit}>
            {tab === "token" ? (
              <>
                <label className="login-label">API Token</label>
                <input
                  className="login-input"
                  type="password"
                  placeholder="Enter your MCP_API_TOKEN"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="current-password"
                />
              </>
            ) : (
              <>
                <label className="login-label">Username</label>
                <input
                  className="login-input"
                  type="text"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  autoComplete="username"
                  style={{ marginBottom: 14 }}
                />
                <label className="login-label">Password</label>
                <input
                  className="login-input"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </>
            )}
            <button className="login-btn" type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign In"}
            </button>
          </form>
          {error && <div className="login-error">{error}</div>}
        </div>
        <div className="login-footer-tagline">MCP Gateway · Multi-Cluster AI</div>
      </div>
    </div>
  );
}
