# Requirement Document — Orders, a Three-Tier Application

The full production-grade exercise: web tier, API tier, PostgreSQL with
persistent storage, an auto-generated credentials Secret, schema
initialisation, a zero-trust network matrix, autoscaling on the API, and an
edge-TLS route. Every image runs under OpenShift's restricted SCC with an
arbitrary UID — no security grants required.

The database initialisation Job is the real functional test in this document:
it connects to PostgreSQL with the generated credentials and creates the
schema. If credentials, DNS, or the network policies are wrong, that Job
fails — visibly.

## Application Overview

| Field | Value |
|---|---|
| Application Name | orders |
| Description | Three-tier order service: nginx web front, HTTP echo API, PostgreSQL 15 with persistent storage |
| Environment | demo |

## Target Platform

| Field | Value |
|---|---|
| Platform Type | openshift |
| Namespace | demo-orders |
| Deployment Order | db, api, web |

## Shared Resources

Credential values are generated at manifest time — they never appear in this
document or in the chat.

| Secret Name | Keys | Used By |
|---|---|---|
| db-credentials | username, password, database | db, api |

| ConfigMap Name | Data | Used By |
|---|---|---|
| app-config | APP_MODE=demo, FEATURE_ORDERS=on | api |

## Tier 1 — Database (PostgreSQL)

The sclorg PostgreSQL image is built for OpenShift: it initialises under an
arbitrary UID and takes its bootstrap user, password and database from
environment variables — wired below from the generated Secret.

| Field | Value |
|---|---|
| Component Name | db |
| Role | database |
| Container Image | quay.io/sclorg/postgresql-15-c9s:latest |
| Port | 5432 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 500m |
| Memory Request | 256Mi |
| Memory Limit | 512Mi |
| Storage Size | 2Gi |
| Storage Mount Path | /var/lib/pgsql/data |
| Expose Externally | no |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| POSTGRESQL_USER |   | db-credentials | username |
| POSTGRESQL_PASSWORD |   | db-credentials | password |
| POSTGRESQL_DATABASE |   | db-credentials | database |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | pg_isready -h 127.0.0.1 | 5432 | 20 | 15 |
| readiness | exec | pg_isready -h 127.0.0.1 | 5432 | 10 | 10 |

### Init SQL

CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, item TEXT NOT NULL, qty INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ DEFAULT NOW()); INSERT INTO orders (item, qty) SELECT 'sample-widget', 3 WHERE NOT EXISTS (SELECT 1 FROM orders);

## Tier 2 — API Service

An HTTP echo service standing in for the order API: it answers every request
with a JSON reflection of what it received. It proves the Secret and ConfigMap
wiring, the service path from web to api, and gives the verification pyramid a
real HTTP endpoint — it does not itself execute SQL (the Init SQL Job covers
the database functionally).

| Field | Value |
|---|---|
| Component Name | api |
| Role | app |
| Container Image | docker.io/mendhak/http-https-echo:33 |
| Port | 8080 |
| Replicas Min | 2 |
| Replicas Max | 4 |
| CPU Request | 50m |
| CPU Limit | 250m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Expose Externally | no |
| Depends On | db |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| HTTP_PORT | 8080 |   |   |
| DATABASE_HOST | db |   |   |
| DATABASE_PORT | 5432 |   |   |
| DATABASE_USER |   | db-credentials | username |
| DATABASE_PASSWORD |   | db-credentials | password |
| DATABASE_NAME |   | db-credentials | database |

### Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | http | /health | 8080 | 5 | 10 |
| readiness | http | /health | 8080 | 3 | 5 |

## Tier 3 — Frontend Web Server

| Field | Value |
|---|---|
| Component Name | web |
| Role | frontend |
| Container Image | docker.io/nginxinc/nginx-unprivileged:1.27 |
| Port | 8080 |
| Replicas | 2 |
| CPU Request | 50m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Expose Externally | yes |
| TLS | edge |
| Run As Non-Root | yes |
| Drop Capabilities | yes |
| Depends On | api |

### Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | http | / | 8080 | 5 | 10 |
| readiness | http | / | 8080 | 3 | 5 |

## Network Connectivity Matrix

Zero-trust: everything not listed here is denied, in both directions. Each
allowed row becomes an ingress rule on the target AND an egress rule on the
caller; DNS egress is granted to all pods as a precondition. The denied row is
enforced by the default-deny policy — it is listed to make the intent
auditable.

| From | To | Port | Protocol | Allowed |
|---|---|---|---|---|
| internet | web | 8080 | TCP | yes |
| web | api | 8080 | TCP | yes |
| api | db | 5432 | TCP | yes |
| internet | db | 5432 | TCP | no |

## Post-Deploy Validation

| Test | Command | Expected |
|---|---|---|
| Schema initialised | oc -n demo-orders logs job/db-init | CREATE TABLE, INSERT 0 1 (or 0 rows on re-run) |
| API answers through the service | oc -n demo-orders exec deploy/web -- curl -s http://api:8080/health | JSON echo response |
| Route answers | curl -k https://<route-host>/ | HTTP 200 |
| Denied path is denied | oc -n demo-orders exec deploy/web -- timeout 3 bash -c "</dev/tcp/db/5432" | timeout (web must not reach the database) |

## Rollback Criteria

- The db-init Job fails after 3 attempts (credentials, DNS or network policy fault)
- Any rollout incomplete after 5 minutes
- The route probe does not return HTTP 200

## Expected Result

First deploy takes 2–4 minutes (image pulls plus PVC bind). The pyramid goes
green level by level: three rollouts complete, no restarts, three Services
with ready endpoints, and the web route answering HTTP 200. The db-init Job
log shows the schema being created with the generated credentials — the
functional proof. The last validation row is the negative control: run it and
confirm the web tier CANNOT open a socket to the database.
