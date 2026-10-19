import { useState } from "react";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";

/**
 * The sign-in screen.
 *
 * Full-bleed artwork with the form inside it. Three things decide whether that
 * reads as considered or as a stock photo with a box on top, and all three are
 * in the CSS rather than here:
 *
 *   · The veil is directional. It stays near-clear over the face so the picture
 *     still carries the screen, and deepens toward the card so the form has a
 *     calm field to sit on.
 *   · The card sits right, where the plate is quietest. Centred, it lands on
 *     the busiest pixels in the image.
 *   · Nothing on this screen is a statistic. Counts of agents, clusters and
 *     tools belong after sign-in, where they are real; on the door they are
 *     decoration that has to be kept true.
 *
 * The artwork is dark in both themes, so the theme toggle flips the CARD rather
 * than the page — light theme gets an opaque panel, which is also the higher
 * contrast answer if anyone asks about the form over a photograph.
 *
 * Behaviour is unchanged from the previous version: same endpoint, same two
 * modes, same error handling. Only the markup and the class names moved.
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

      <button
        className="lg-theme"
        onClick={toggleTheme}
        title="Toggle light/dark theme"
        aria-label="Toggle light and dark theme"
        dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }}
      />

      <div className="lg-brand">
        <div className="lg-mark">
          <span className="lg-tcs">TCS</span> Agentic AI
        </div>
        <div className="lg-sub">Enterprise Intelligence Platform</div>
      </div>

      <p className="lg-claim">
        Humans and <em>intelligent agents</em>, running one hybrid estate.
      </p>

      <div className="lg-card">
        <h1 className="lg-title">Sign in</h1>
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
