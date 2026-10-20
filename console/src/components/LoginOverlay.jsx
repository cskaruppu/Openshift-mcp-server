import { useState } from "react";
import { useAuthStore } from "../store/authStore";
import { useThemeStore } from "../store/themeStore";

/**
 * The sign-in screen.
 *
 * A panel of artwork beside the form, not behind it — and the reason is
 * arithmetic rather than taste. The usable crop of the source is 598 x 646:
 * everything right of it holds a baked-in "AGENTIC AI" wordmark that cannot be
 * retouched off circuitry, and everything below it held a stray UI button. Run
 * that crop full-bleed on a 2560px display and it is a four-times upscale,
 * which is exactly what "dull and blurry" looks like. In a panel it is scaled
 * about 1.2x and the colour survives, which is the whole point of using it.
 *
 * Three things carry the design, all of them in the CSS:
 *
 *   · The veil is almost nothing — only enough gradient under the brand line
 *     and the claim to keep them legible. The earlier version dimmed the whole
 *     plate to hide that wordmark; with the wordmark cropped out, the picture
 *     can simply be the picture.
 *   · The field beside it picks up the artwork's own deep blue, so the two
 *     halves read as one screen rather than a photo glued to a panel.
 *   · The robot faces right, so it looks into the form. Two pointers carry
 *     that across the seam, drawn in the cyan of the gaze beam the image
 *     already has.
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
      <div className="lg-plate">
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

        <div className="lg-brand">
          <div className="lg-mark">
            <span className="lg-tcs">TCS</span> Agentic AI
          </div>
          <div className="lg-sub">Enterprise Intelligence Platform</div>
        </div>

        <p className="lg-claim">
          Humans and <em>intelligent agents</em>, running one hybrid estate.
        </p>
      </div>

      {/* The pointers. Both leave the eye and diverge to the top and the
          bottom of the card — the agent showing you the way in. Drawn in the
          cyan the artwork already uses for the gaze beam, so they read as that
          beam continuing. Decorative, so hidden from assistive tech. */}
      <svg className="lg-point" viewBox="0 0 240 420" fill="none" aria-hidden="true" focusable="false">
        <defs>
          <marker id="lgArrow" viewBox="0 0 10 10" refX="8.5" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        <path className="lg-arc" d="M4,210 C84,202 142,146 224,78" markerEnd="url(#lgArrow)" />
        <path className="lg-arc lg-arc2" d="M4,210 C84,218 142,274 224,342" markerEnd="url(#lgArrow)" />
      </svg>

      <button
        className="lg-theme"
        onClick={toggleTheme}
        title="Toggle light/dark theme"
        aria-label="Toggle light and dark theme"
        dangerouslySetInnerHTML={{ __html: theme === "light" ? "&#x2600;" : "&#x263E;" }}
      />

      <div className="lg-field">
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
    </div>
  );
}
