import { useState } from "react";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";

/**
 * The sign-in screen.
 *
 * The artwork fills the page and the card floats on it. The whole picture is
 * kept — globe, HUD, its own wordmark — so the only things removed are the
 * two that were never part of it: a five-pixel white strip the source
 * screenshot carried at the top, and a stray UI button below the robot's chin.
 *
 * What makes this read as composed rather than as a box dropped on a photo is
 * entirely in the CSS: the veil is light, so the blues survive, and it deepens
 * only under the card and behind the brand line, which are the two places
 * text has to stay legible over whatever the picture is doing.
 *
 * Nothing here is a statistic. Counts of agents, clusters and tools are real
 * after sign-in and decoration on the door.
 *
 * Behaviour is unchanged: same endpoint, same two modes, same error handling.
 */
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
    <div className="lg-screen">
      {/* The plate. A deep neutral sits behind it in CSS, so a missing file
          leaves a designed screen rather than a broken frame. */}
      <picture>
        <source srcSet="/brand/login-hero.webp" type="image/webp" />
        <img
          className="lg-art"
          src="/brand/login-hero.jpg"
          alt=""
          aria-hidden="true"
          decoding="async"
          fetchPriority="high"
        />
      </picture>
      <div className="lg-veil" aria-hidden="true" />

      {/* A co-brand lockup: the corporate mark, a hairline, then the product.
          Side by side rather than stacked, because stacked puts the TCS of the
          logo directly above the TCS of the product name and reads as a
          stutter. The rule is what makes it one lockup instead of two things
          that happen to be near each other.

          The white logo, because the photograph behind it is dark in both
          themes — only the card flips. The black one ships alongside for
          anywhere this lands on a light ground. */}
      <div className="lg-brand">
        <img className="lg-logo" src="/brand/tcs-logo-white.png"
             alt="Tata Consultancy Services" width="1000" height="238" />
        <span className="lg-rule" aria-hidden="true" />
        <h1 className="lg-mark">TCS Agentic AI for Hybrid Infrastructure</h1>
      </div>

      <p className="lg-claim">
        Humans and <em>intelligent agents</em>, running one hybrid estate.
      </p>

      <button
        className="lg-theme"
        onClick={toggleTheme}
        title="Toggle light/dark theme"
        aria-label="Toggle light and dark theme"
        dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }}
      />

      <div className="lg-card">
        <h2 className="lg-title">Sign in</h2>
        <p className="lg-lede">Platform account or API token</p>

        {authMode !== "none" && (
          <div className="lg-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "password"}
              className={"lg-tab" + (tab === "password" ? " on" : "")}
              onClick={() => setTab("password")}
            >
              Password
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "token"}
              className={"lg-tab" + (tab === "token" ? " on" : "")}
              onClick={() => setTab("token")}
            >
              API Token
            </button>
          </div>
        )}

        <form onSubmit={submit}>
          {tab === "token" ? (
            <>
              <label className="lg-label" htmlFor="lg-token">API Token</label>
              <input
                id="lg-token"
                className="lg-input"
                type="password"
                placeholder="Enter your MCP_API_TOKEN"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="current-password"
              />
            </>
          ) : (
            <>
              <label className="lg-label" htmlFor="lg-user">Username</label>
              <input
                id="lg-user"
                className="lg-input"
                type="text"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
              />
              <label className="lg-label" htmlFor="lg-pass">Password</label>
              <input
                id="lg-pass"
                className="lg-input"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </>
          )}
          <button className="lg-btn" type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        {error && <div className="lg-error" role="alert">{error}</div>}
        <div className="lg-fine">MCP Gateway · Multi-cluster</div>
      </div>
    </div>
  );
}
