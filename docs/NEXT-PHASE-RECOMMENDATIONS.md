# TCS Agentic AI — Next-Phase Recommendations

> Full-codebase analysis (backend, frontend, AI layer, deployment/data/ops) with a
> prioritized roadmap to take the product from "working platform" to
> "production-grade enterprise product". Analysis date: June 2026.
> Scope: 134 backend JS files (~85K LoC), ~12K LoC React console, Helm chart,
> hub/spoke deploy scripts, PostgreSQL/Redis data layer.

---

## 1. Executive Summary

**What's strong (keep and build on):**

| Area | Strength |
|---|---|
| Architecture | Hub/spoke federation follows the ACM/Rancher/ArgoCD pattern — same image everywhere, live proxying, heartbeat registration |
| Frontend | Cluster isolation *by construction* (TanStack Query keys + `clusterStore`), lean Zustand state (~200 LoC), correct SSE streaming with AbortController |
| Security posture | Non-root containers, read-only rootfs, seccomp, dropped capabilities, granular reader/remediator RBAC split (80+ API groups) |
| AI layer | Multi-provider abstraction (OpenAI / Azure / Anthropic / Ollama), fallback chain, prompt caching on Anthropic system prompts, per-call telemetry |
| Domain depth | 40+ MCP tools, 100+ pattern error-knowledge base, approval workflow state machine, ITSM/Ansible/ACM integrations |

**What blocks the next phase (the short version):**

1. **Test coverage is near zero** — 2 backend test files, 0 frontend tests, CI doesn't run tests at all.
2. **Two monoliths** — `src/chat-api.js` (17.6K LoC) and `src/index.js` (6K LoC) hold ~30% of the backend.
3. **TLS verification disabled in 6 places** (`rejectUnauthorized: false`) including LLM and K8s API calls.
4. **No DB backups, no HA** — single PostgreSQL replica; chat history and audit trail are unrecoverable on loss.
5. **In-memory state breaks horizontal scaling** — sessions, connected agents, and insights live in process Maps.
6. **LLM integration is a generation behind** — defaults to `gpt-4`/`claude-opus-4-7`, hand-rolled HTTP, and sends parameters that current Claude models reject (see §3).

---

## 2. Phased Roadmap

### Phase A — Harden (4–6 weeks): make what exists trustworthy
1. Fix the Anthropic 400-on-`temperature` bug and upgrade default models (§3.1 — small, immediate).
2. Centralize TLS config; verification on by default (§4.1).
3. Add input validation middleware (namespace names, limits, cluster URLs — SSRF/DoS) (§4.2).
4. Enable log redaction by default; replace silent `catch {}` with logged warnings (§4.3).
5. Wire `npm test` + ESLint into GitHub Actions; add Trivy image scan (§6.1).
6. PostgreSQL backup CronJob (`pg_dump` → S3/ODF) + documented restore runbook (§7.1).

### Phase B — Scale (6–10 weeks): make it multi-replica and operable
1. Move sessions/insights/agent-registry to Redis (read-through over PostgreSQL); refuse HA mode without Redis (§5.1).
2. Jitter + backoff on all polling loops; Redis advisory-lock probe election (§5.2).
3. Prometheus `/metrics` endpoint (prom-client) + structured logging (pino) (§7.2).
4. DB retention/archival jobs and partitioning for snapshot tables (§5.3).
5. Begin decomposition of `chat-api.js` and `index.js` behind the new test safety net (§6.2).

### Phase C — Differentiate (ongoing): the "agentic" in Agentic AI
1. Model-tiered AI routing and adaptive thinking for deep diagnostics (§3.2–3.3).
2. Structured outputs for intent classification — eliminate JSON-parse failures (§3.4).
3. True agentic loops for remediation: plan → tool calls → verify → report, with the existing approval workflow as the human-in-the-loop gate (§3.5).
4. Frontend decomposition, accessibility, and design-system adoption (§8).

---

## 3. AI / LLM Modernization (`src/services/llm.js`)

### 3.1 Bug + model refresh (do first — hours, not days)

`callAnthropic()` (`llm.js:426-456`) defaults to `claude-opus-4-7` and **always sends
`temperature`**. Claude Opus 4.7 and 4.8 removed sampling parameters — requests that
include `temperature`/`top_p`/`top_k` return **HTTP 400**. The current default Anthropic
path is therefore broken on the very model it targets.

Fixes:
- Omit `temperature` (and any `top_p`/`top_k`) when the model is Opus 4.7+ / Fable.
- Update defaults to the current line-up:

| Use case in this product | Recommended model | Pricing (in/out per MTok) |
|---|---|---|
| Deep diagnostics, upgrade planning, multi-step remediation | `claude-opus-4-8` | $5 / $25 |
| Default chat / high-volume Q&A | `claude-sonnet-4-6` | $3 / $15 |
| NLU fallback intent classification (`classifyJSON`), routing, summaries | `claude-haiku-4-5` | $1 / $5 |

- Replace the hardcoded `"gpt-4"` default (`llm.js:21`) with a per-provider default map so
  the Anthropic path never inherits an OpenAI model name.
- Raise the 2,000-token `maxTokens` default (`llm.js:81`) — agentic answers with tool
  results routinely need 8–16K.

### 3.2 Adopt the official SDKs under the provider abstraction

Keep the multi-provider interface (it's a product feature), but back the Anthropic branch
with `@anthropic-ai/sdk` instead of hand-rolled `undici` + SSE parsing. Gains: typed errors
(`RateLimitError`, `OverloadedError`), automatic retry with `retry-after`, streaming
helpers (`stream.finalMessage()`), and no maintenance of the SSE parser in
`readSSE()`. Same argument applies to the `openai` package for the OpenAI/Azure branches.

### 3.3 Adaptive thinking + effort for hard problems

For diagnostics and upgrade-planning intents, enable reasoning:

```js
// Opus 4.8 / Sonnet 4.6 — no budget_tokens, no temperature
{ model: "claude-opus-4-8",
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },   // "xhigh" for long agentic remediation runs
  max_tokens: 16000, ... }
```

Route by intent: `effort: "low"` (or Haiku) for lookups, `high`/`xhigh` for root-cause
analysis. This is the single biggest quality lever available without changing product UX.

### 3.4 Structured outputs instead of fence-stripping

`classifyJSON()` (`llm.js:174-193`) strips markdown fences and substring-slices `{...}` —
brittle, and silently returns `null`. Replace with structured outputs:

```js
output_config: { format: { type: "json_schema", schema: intentSchema } }
```

The response is then guaranteed schema-valid JSON. Pair this with the missing NLU
confidence threshold (chat-api currently executes intents regardless of confidence —
add `MIN_NLU_CONFIDENCE = 0.5`, `0.7` for destructive verbs).

### 3.5 Deeper prompt caching + long-context

- System-prompt `cache_control` is already in place — good. Extend a breakpoint to the
  conversation prefix (last content block of the latest turn) so multi-turn chats reuse
  history; keep the tool list deterministic (sorted) so it doesn't invalidate the cache.
  Note the minimum cacheable prefix on Opus 4.8 is 4,096 tokens — short prompts silently
  won't cache.
- Current Claude models have a 1M-token context window: large cluster-state dumps
  (operator lists, event streams, audit windows) can go into the prompt directly rather
  than being aggressively truncated.
- For very long chat sessions, consider the server-side compaction beta rather than
  client-side history trimming.

### 3.6 Agentic remediation loop

Today the chat layer does one LLM call + tool dispatch. The next-phase differentiator is a
bounded agent loop: the model plans, calls MCP tools, inspects results, and iterates until
done — with the existing `pending_actions` approval workflow as the gate for any
mutating tool, and a hard iteration/token cap. The pieces (tool registry, approval state
machine, audit tables) already exist; this is orchestration work in `chat-api.js`, best done
as part of its decomposition (§6.2).

---

## 4. Security Hardening (Phase A)

### 4.1 TLS verification
`rejectUnauthorized: false` appears in `k8s-client.js:18`, `llm.js:37-39`,
`spoke-proxy.js:234`, `db.js`, and `index.js`. Centralize in `utils/tls-config.js`:
default verify-on, honor `NODE_EXTRA_CA_CERTS` for private CAs, and gate insecure mode
behind an explicit `ACCEPT_SELF_SIGNED=true` that logs loudly at startup.

### 4.2 Input validation
- `?namespace=` — validate against the K8s DNS-label regex.
- `?limit=` — clamp (`1..1000`); currently unbounded `parseInt` (memory DoS).
- Cluster API URLs registered via the admin UI — validate scheme/host and reject
  link-local/metadata addresses (SSRF). `zod` is already a dependency — use it as
  consistent request-validation middleware instead of ad-hoc parsing.

### 4.3 Secrets & error handling
- Flip `redactIfEnabled` to redact-by-default; add a recursive `redactObject()` for keys
  matching `password|token|api_key|secret`.
- Replace the ~15 silent `catch {}` / `.catch(() => {})` sites (auth.js, chat-api.js,
  proactive-agent.js, index.js) with logged warnings so DB outages are visible.
- Move the PostgreSQL password out of plaintext Secrets — External Secrets Operator or
  sealed secrets.
- The remediator ClusterRoleBinding is always applied despite being documented as
  optional — make it an actual deploy flag.

---

## 5. Reliability & Scale (Phase B)

### 5.1 Externalize in-memory state
`_connectedAgents` (index.js:327), user `sessions` (index.js:1981), `_insights`
(proactive-agent.js:39), `_preflightCache` (chat-api.js:150) all die with the pod and
diverge across replicas. Move to Redis (read-through over PostgreSQL for durable items);
refuse to start in HA mode without Redis.

### 5.2 Polling hygiene
Add jitter to every `setInterval` (probes at index.js:1954, proactive agent at 60s/300s/1800s),
exponential backoff on failing probes, and Redis `SET NX EX` advisory locks so only one
replica probes each cluster.

### 5.3 Data lifecycle
`messages`, `query_log`, `executed_actions` grow unboundedly. Add a retention config
(default 90 days) with an archival CronJob, and partition `cluster_snapshots` by cluster.

### 5.4 High availability
- PostgreSQL: streaming replication or a managed/operator-based HA setup (e.g. CloudNativePG).
- Dashboard: ≥2 replicas (already stateless).
- Hub failover strategy for spokes (warm standby + re-registration) — currently a hub
  outage blinds every spoke.

---

## 6. Engineering Quality (Phases A–B)

### 6.1 Tests + CI (the highest-leverage investment in the repo)
- Backend: grow from the 2 existing node-test files. Priority targets: NLU parser,
  command-validator (security-critical), cluster resolver, LLM fallback chain.
- Frontend: add Vitest + Testing Library. Priority: the `ChatTokens` parser (1.6K LoC of
  regex-driven rendering, currently untested), `useClusterQuery` isolation on cluster switch.
- CI: run `npm test` + ESLint on every PR; build both images (current workflow only builds
  the legacy agent image); Trivy scan before push; tag releases semantically instead of
  `:latest`-only.

### 6.2 Decompose the monoliths (after tests exist)
- `src/services/chat-api.js` (17.6K LoC) → `conversation-handler`, `llm-bridge`,
  `intent-router`, `response-builder`, per-feature modules (CR tracking, upgrades).
- `src/index.js` (6K LoC) → `api-server` (routing), `hub-manager` (cluster registry),
  `sse-transport`.
- Extract the cluster-lookup logic repeated in 5+ places into `utils/cluster-resolver.js`.

### 6.3 Tooling
Add ESLint + Prettier, `pino` structured logging with request correlation IDs, `helmet`
for HTTP headers, and a distributed rate limiter on the chat/auth endpoints.

---

## 7. Operations & Observability

### 7.1 Backups / DR (critical)
No automated backups exist. Add a `pg_dump` CronJob to object storage (the RBAC already
permits OADP/Velero), define RPO/RTO, and write restore + spoke-troubleshooting runbooks
(DNS, hub unreachable, registration failures — today's top MTTR drivers).

### 7.2 Metrics & logging
- Expose `/metrics` (prom-client): request latency, tool invocation counts/outcomes, LLM
  call latency/cost/error-class (telemetry hooks already collect this — surface it),
  spoke heartbeat freshness.
- Ship a Grafana dashboard + alert rules in the Helm chart — this product *sells*
  observability; it should exemplify it.

### 7.3 Portability
Remove hardcoded `quay.io/karuppucs` registry and caaslab DNS from deploy scripts —
parametrize via the Helm values that already exist.

---

## 8. Frontend Next Steps (Phase C, respects PROTECTED files)

1. **Tests first** (see §6.1) — zero today across 12K LoC.
2. **Decompose** (non-protected files): `ChatTokens.jsx` (1,633 LoC) → pure
   `tokenParser.js` + `SegmentRenderer` + per-card components; `ChatView.jsx` (1,119) →
   sidebar/message-window/input/provider-dropdown; `SettingsPanel.jsx` (1,103) →
   per-provider forms.
3. **Adopt the design system** — `src/design/` (StatusDot, SeverityBadge, ConfirmDialog…)
   is built and exported but has zero production imports.
4. **Error UX** — map raw `500 Internal Server Error` strings to friendly messages.
5. **Accessibility** — 12 aria attributes total today; add focus traps on modals,
   semantic roles, and an axe/Pa11y check in CI (enterprise procurement increasingly
   requires WCAG).

---

## 9. Suggested 90-Day Sequence

| Weeks | Theme | Items |
|---|---|---|
| 1–2 | Quick wins | §3.1 model fix/upgrade, CI tests+lint, limit clamping, redaction default-on |
| 3–6 | Harden | TLS config, input validation, silent-catch cleanup, pg backups + runbooks, Trivy |
| 7–10 | Scale | Redis state, poll jitter + probe election, `/metrics`, structured logging, retention jobs |
| 11–13 | Differentiate | Model tiering + adaptive thinking, structured-output classification, start chat-api decomposition, frontend test scaffold |

The platform's architecture is genuinely sound — the gap to "next phase of life" is not a
rewrite, it's hardening (security + data durability), a test safety net, and catching the
AI layer up to the current model generation so the "Agentic" promise can be delivered as
real multi-step, approval-gated remediation loops.
