# Sample Requirement Documents — Automation Hub

Three known-good requirement documents for the App Deployment Agent, plus one
that fails on purpose. Each is written to the deterministic extractor's
grammar (headings + key/value tables), so extraction is exact and repeatable —
**no LLM involved, same manifests every time**. The whole chain is pinned by
`test/unit/sample-docs.test.js`: if a change to the extractor or generator
would break these documents, the build breaks first.

| Document | What it proves | Time to green |
|---|---|---|
| `00-TEMPLATE.md` / `.docx` | **The customer-facing template** — guided three-tier scaffold with placeholders; the agent refuses to generate until every placeholder is filled, naming the missing ones | fill in ~15 min |
| `01-hello-web.md` | The pipeline end to end: one tier, TLS route, probes | ~1 min |
| `02-three-tier-orders.md` | The full production story: 3 tiers, Secret, ConfigMap, PVC, init SQL, zero-trust matrix, HPA | 2–4 min (image pulls + PVC bind) |
| `03-negative-broken-image.md` | The pyramid fails honestly — a green result means something | fails by design |
| `04-ecommerce-online-boutique.md` | A real e-commerce shop: Google's Online Boutique — 11 gRPC microservices + Redis + synthetic shoppers, 64 manifests, 19-row zero-trust matrix | 3–6 min (12 image pulls) |

The Generate button runs these documents through the **deterministic
extractor first** — same document, same 64 manifests, every time, and no LLM
is required at all (free-prose requirements still use the LLM path).
`04` needs cluster egress to `us-central1-docker.pkg.dev` (Google's public
registry); if your lab can't reach it, mirror the 12 images internally and
edit only the image rows. Its health probes use the kubelet-native `grpc`
type (OpenShift 4.14+): the boutique's images are distroless — no shell, no
probe binary — so exec probes would kill them in a liveness loop.

## How to run one

1. Automation Hub → **App Deployment Agent** → *Upload requirement doc* (pick
   the `.md` file) — or paste its contents into the text area.
2. **Generate Manifests**, review the YAML (optionally run the CIS + image
   checks on the generated code).
3. **Dry-run** — server-side validation, nothing created. Safe on every re-run.
4. **Deploy** — pick the cluster. Watch the pod table come up; when all pods
   are ready the **production verification pyramid runs by itself**:
   rollout → stability → service wiring → live URL probe.
5. The access panel ends the flow: the route URL, its live status, and
   **Open application**.
6. Every real deploy is recorded (`GET /api/automation/deployments`) with a
   change record when ServiceNow is configured. Rollback from the record
   deletes only what that deploy created.

## Why these exact images

Most tutorial images crash-loop on OpenShift because the **restricted SCC
runs containers as an arbitrary UID** — anything that binds port 80 as root
or writes to a root-owned path dies. These don't:

| Image | Why it works |
|---|---|
| `nginxinc/nginx-unprivileged` | Listens on 8080, runs as any UID (stock `nginx` does not) |
| `mendhak/http-https-echo` | Non-root Node echo server on 8080; reflects requests as JSON |
| `quay.io/sclorg/postgresql-15-c9s` | Red Hat's arbitrary-UID PostgreSQL; bootstrapped via `POSTGRESQL_*` env |

The cluster needs egress to docker.io and quay.io (or mirror the three images
into your internal registry and edit the image rows — nothing else changes).

## What "working" means here

`02-three-tier-orders.md` carries three genuinely different proofs:

- **Functional database** — the `db-init` Job connects with the generated
  credentials and creates the schema. Wrong Secret wiring, broken DNS or a
  missing network path and this Job fails, visibly, in its logs.
- **Zero-trust that still works** — every allowed row in the connectivity
  matrix generates an ingress rule on the target **and** an egress rule on
  the caller, DNS egress is granted as a precondition, and everything else is
  denied both directions. The last validation row in the document is the
  negative control: the web tier must NOT be able to open a socket to the
  database. Run it.
- **A URL a person can open** — the pyramid's final level probes the route
  from outside the pods and the console hands you the link.

## Adapting a document to your own application

Copy `02`, then edit the tables — the prose is documentation, the tables are
the contract:

- Tier sections must be headed `## Tier N — <name>` (or contain a component
  keyword) with a `Component Name`, `Container Image` and `Port` row.
- `### Environment Variables`, `### Health Probes`, `### Init SQL` subsections
  attach to the tier above them.
- Leave a **space** in empty table cells (`|   |`), don't collapse them.
- Secrets listed under `## Shared Resources` are generated with random
  credentials at manifest time — never write real credentials in a document.
- If you include a `## Network Connectivity Matrix`, list every path the app
  needs; anything unlisted is denied. If you omit the matrix entirely you get
  the OpenShift baseline instead (deny-all + allow-same-namespace).
