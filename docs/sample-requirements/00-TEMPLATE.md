# Application Requirement Template — App Deployment Agent

**TCS Agentic AI for Hybrid Infrastructure · fill this in, and the platform does the rest.**

This template becomes a running, verified application on OpenShift. Everything
written inside double angle brackets is yours to fill; everything else is a
working default you may keep. The agent REFUSES to generate while any
placeholder remains — so an unfinished template can never reach a cluster.

**How to use this template — five rules**

1. **The tables are the contract; the prose is guidance.** The agent reads only
   the tables. You can delete any guidance paragraph.
2. Replace every double-angle-bracket placeholder — the agent lists any you miss.
3. This scaffold is a three-tier app (`web`, `api`, `db`). Delete a tier
   section you don't need; copy one to add a fourth. Keep the `## Tier N —`
   heading style.
4. Leave a **space** in table cells you want empty — never collapse a cell.
5. Never write real credentials anywhere in this document. Secrets are
   generated with random values at deploy time.

A completed example of this exact template is
`04-ecommerce-online-boutique.md` — Google's Online Boutique, 12 tiers,
deployed and verified from one document. This file also exists as
`00-TEMPLATE.docx` — fill it in Word and upload it; tables survive intact.

## Application Overview

| Field | Value |
|---|---|
| Application Name | <<app-name>> |
| Description | <<app-description>> |
| Environment | demo |

*Application Name must be lowercase and DNS-safe (letters, digits, hyphens).*

## Target Platform

| Field | Value |
|---|---|
| Platform Type | openshift |
| Namespace | <<namespace>> |
| Deployment Order | db, api, web |

*The namespace is created if it doesn't exist. Keep the order database-first.*

## Shared Resources

*OPTIONAL — delete this whole section if no tier needs credentials. The keys
listed here are generated with random values and wired to the tiers named in
"Used By". They never appear in this document.*

| Secret Name | Keys | Used By |
|---|---|---|
| db-credentials | username, password, database | db, api |

## Tier 1 — Database (db)

*Pick an image that runs under OpenShift's restricted SCC (arbitrary UID).
The sclorg images are built for this: `quay.io/sclorg/postgresql-15-c9s:latest`
(port 5432, env `POSTGRESQL_USER/PASSWORD/DATABASE`, mount
`/var/lib/pgsql/data`) or `quay.io/sclorg/mysql-80-c9s:latest` (3306,
`MYSQL_*`, `/var/lib/mysql/data`). Delete this tier for a stateless app.*

| Field | Value |
|---|---|
| Component Name | db |
| Role | database |
| Container Image | <<db-image>> |
| Port | <<db-port>> |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 500m |
| Memory Request | 256Mi |
| Memory Limit | 512Mi |
| Storage Size | <<db-storage-size>> |
| Storage Mount Path | <<db-mount-path>> |
| Expose Externally | no |

### Environment Variables

*Adjust the names to what YOUR image expects; keep the secret wiring.*

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| POSTGRESQL_USER |   | db-credentials | username |
| POSTGRESQL_PASSWORD |   | db-credentials | password |
| POSTGRESQL_DATABASE |   | db-credentials | database |

### Health Probes

| Probe | Type | Port | Initial Delay | Period |
|---|---|---|---|---|
| liveness | tcp | <<db-port>> | 20 | 15 |
| readiness | tcp | <<db-port>> | 10 | 10 |

### Init SQL

*OPTIONAL (PostgreSQL only) — one line of SQL, no code fences. Runs as a Job
with the generated credentials once the database is ready: your functional
proof that credentials, DNS and network policy all work. Delete if unused.*

CREATE TABLE IF NOT EXISTS <<table-name>> (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW());

## Tier 2 — API Service (api)

*The image must run as non-root under an arbitrary UID and listen on the port
below. Probe type: `grpc` for gRPC services (needs OpenShift 4.14+), `http`
with a Path column for REST, `tcp` as the fallback.*

| Field | Value |
|---|---|
| Component Name | api |
| Role | app |
| Container Image | <<api-image>> |
| Port | <<api-port>> |
| Replicas Min | 2 |
| Replicas Max | 4 |
| CPU Request | 50m |
| CPU Limit | 250m |
| Memory Request | 64Mi |
| Memory Limit | 256Mi |
| Expose Externally | no |
| Depends On | db |

*Replicas Min < Max generates a HorizontalPodAutoscaler automatically.*

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| DATABASE_HOST | db |   |   |
| DATABASE_PORT | <<db-port>> |   |   |
| DATABASE_USER |   | db-credentials | username |
| DATABASE_PASSWORD |   | db-credentials | password |
| DATABASE_NAME |   | db-credentials | database |

### Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | http | <<api-health-path>> | <<api-port>> | 5 | 10 |
| readiness | http | <<api-health-path>> | <<api-port>> | 3 | 5 |

## Tier 3 — Web Frontend (web)

*The only tier the internet reaches. TLS `edge` gives you HTTPS on the
cluster's wildcard certificate; the Route hostname is assigned automatically.*

| Field | Value |
|---|---|
| Component Name | web |
| Role | frontend |
| Container Image | <<web-image>> |
| Port | <<web-port>> |
| Replicas | 2 |
| CPU Request | 50m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Expose Externally | yes |
| TLS | edge |
| Run As Non-Root | yes |
| Depends On | api |

### Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | http | / | <<web-port>> | 5 | 10 |
| readiness | http | / | <<web-port>> | 3 | 5 |

## Network Connectivity Matrix

*Zero-trust: anything not listed here is denied, in BOTH directions. Every
allowed row generates an ingress rule on the target AND an egress rule on the
caller; DNS is granted automatically. List denied rows too — they document
intent and become your negative tests. If you delete this section entirely,
the namespace gets the OpenShift baseline instead (deny-all +
allow-same-namespace).*

| From | To | Port | Protocol | Allowed |
|---|---|---|---|---|
| internet | web | <<web-port>> | TCP | yes |
| web | api | <<api-port>> | TCP | yes |
| api | db | <<db-port>> | TCP | yes |
| internet | db | <<db-port>> | TCP | no |

## Post-Deploy Validation

*What "working" means for YOUR application — shown with the deploy record.
The four-level verification pyramid (rollout → stability → wiring → URL) runs
automatically regardless.*

| Test | Command | Expected |
|---|---|---|
| <<your-acceptance-test>> | <<command-or-manual-step>> | <<expected-result>> |
| Denied path is denied | oc -n <<namespace>> exec deploy/web -- timeout 3 bash -c "</dev/tcp/db/<<db-port>>" | timeout |

## Rollback Criteria

- Any rollout incomplete after 5 minutes
- The route probe does not return HTTP 200
- <<your-rollback-criterion>>

---

## Field reference — what each entry generates

| Field | Required | Allowed values | What the agent generates from it |
|---|---|---|---|
| Component Name | yes | dns-safe name | Deployment, Service, labels — and the DNS name other tiers use |
| Role | yes | frontend · app · database | Deploy ordering, Recreate strategy for databases |
| Container Image | yes | full image ref, pinned tag | The container. Must run non-root under an arbitrary UID |
| Port | yes | integer | containerPort, Service port, probe target, matrix wiring |
| Replicas / Min / Max | no (default 1) | integers | Replicas; Min<Max adds an HPA |
| CPU/Memory Request/Limit | recommended | k8s quantities | Resource requests and limits |
| Storage Size + Mount Path | for stateful tiers | 1Gi… + path | PVC, volume mount, Recreate strategy |
| Expose Externally + TLS | no (default no) | yes/no · edge | Route with edge TLS + router ingress policy |
| Depends On | no | tier names | Deploy ordering |
| Environment Variables | no | value OR secret ref | env / valueFrom secretKeyRef |
| Health Probes | recommended | http · tcp · grpc · exec | liveness/readiness probes (grpc needs OCP 4.14+) |
| Init SQL | no | one-line SQL | A Job proving the database functionally works |
| Network matrix | recommended | tier names + internet | Zero-trust policies, both directions |
