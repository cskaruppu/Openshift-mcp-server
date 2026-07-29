# 1. Application Overview

| Field | Value |
| --- | --- |
| Application Name | bookstore |
| Description | Three-tier bookstore demo: nginx frontend, Node.js API, PostgreSQL DB |
| Business Owner | Demo Apps Team |
| Technical Owner | platform-team@example.com |
| Environment | dev |

# 2. Target Platform

| Field | Value |
| --- | --- |
| Platform Type | openshift |
| Cluster Name | dev-cluster |
| Namespace | bookstore-dev |
| Deployment Order | bookstore-db, bookstore-app, bookstore-web |

# 3. Shared Resources

## Secrets

| Secret Name | Keys | Used By | Auto Generate |
| --- | --- | --- | --- |
| bookstore-db-credentials | username, password, database | bookstore-db, bookstore-app | yes |

## ConfigMaps

| ConfigMap Name | Data | Used By |
| --- | --- | --- |
| bookstore-app-config | LOG_LEVEL=info, API_VERSION=v1 | bookstore-app |

# 4. Tier 1 — Database (PostgreSQL)

| Field | Value |
| --- | --- |
| Component Name | bookstore-db |
| Role | database |
| Container Image | registry.redhat.io/rhel9/postgresql-15:latest |
| Replicas Min | 1 |
| Replicas Max | 1 |
| Port | 5432 |
| Protocol | TCP |
| CPU Request | 200m |
| CPU Limit | 1000m |
| Memory Request | 512Mi |
| Memory Limit | 2Gi |
| Storage Size | 10Gi |
| Storage Mount Path | /var/lib/pgsql/data |
| Storage Class | default |
| Access Mode | ReadWriteOnce |
| Expose Externally | no |
| Run As Non Root | yes |
| Read Only Root Filesystem | no |
| Drop Capabilities | yes |

## Environment Variables

| Name | Value | From Secret | Secret Key |
| --- | --- | --- | --- |
| POSTGRESQL_USER | | bookstore-db-credentials | username |
| POSTGRESQL_PASSWORD | | bookstore-db-credentials | password |
| POSTGRESQL_DATABASE | | bookstore-db-credentials | database |

## Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
| --- | --- | --- | --- | --- | --- |
| Liveness | exec | pg_isready -U $POSTGRESQL_USER | 5432 | 30 | 10 |
| Readiness | exec | pg_isready -U $POSTGRESQL_USER | 5432 | 5 | 5 |

## Init SQL

CREATE TABLE IF NOT EXISTS books(id SERIAL PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, price NUMERIC(10,2), created_at TIMESTAMP DEFAULT NOW())

# 5. Tier 2 — Application (Node.js API)

| Field | Value |
| --- | --- |
| Component Name | bookstore-app |
| Role | app |
| Container Image | quay.io/myorg/bookstore-api:v1.0.0 |
| Replicas Min | 2 |
| Replicas Max | 6 |
| Port | 3000 |
| Protocol | TCP |
| CPU Request | 100m |
| CPU Limit | 500m |
| Memory Request | 256Mi |
| Memory Limit | 1Gi |
| Expose Externally | no |
| Run As Non Root | yes |
| Read Only Root Filesystem | true |
| Drop Capabilities | yes |
| Depends On | bookstore-db |

## Environment Variables

| Name | Value | From Secret | Secret Key |
| --- | --- | --- | --- |
| DB_HOST | bookstore-db.bookstore-dev.svc.cluster.local | | |
| DB_PORT | 5432 | | |
| DB_USER | | bookstore-db-credentials | username |
| DB_PASSWORD | | bookstore-db-credentials | password |
| DB_NAME | | bookstore-db-credentials | database |

## Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
| --- | --- | --- | --- | --- | --- |
| Liveness | http | /healthz | 3000 | 20 | 10 |
| Readiness | http | /ready | 3000 | 5 | 5 |

# 6. Tier 3 — Frontend (nginx)

| Field | Value |
| --- | --- |
| Component Name | bookstore-web |
| Role | frontend |
| Container Image | registry.redhat.io/rhel9/nginx-122:latest |
| Replicas Min | 2 |
| Replicas Max | 4 |
| Port | 8080 |
| Protocol | TCP |
| CPU Request | 50m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 256Mi |
| Expose Externally | yes |
| Hostname | bookstore.apps.example.com |
| TLS | edge |
| Run As Non Root | yes |
| Read Only Root Filesystem | false |
| Drop Capabilities | yes |
| Depends On | bookstore-app |

## Reverse Proxy

| Path | Upstream |
| --- | --- |
| /api/* | http://bookstore-app:3000 |

## Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
| --- | --- | --- | --- | --- | --- |
| Liveness | http | / | 8080 | 10 | 10 |
| Readiness | http | / | 8080 | 5 | 5 |

# 7. Network Connectivity Matrix

| From | To | Port | Protocol | Allowed |
| --- | --- | --- | --- | --- |
| internet | bookstore-web | 8080 | TCP | yes |
| bookstore-web | bookstore-app | 3000 | TCP | yes |
| bookstore-app | bookstore-db | 5432 | TCP | yes |
| bookstore-web | bookstore-db | 5432 | TCP | no |
| internet | bookstore-app | 3000 | TCP | no |
| internet | bookstore-db | 5432 | TCP | no |

# 8. Validation Tests

| Description | Command | Expected |
| --- | --- | --- |
| Frontend health | curl https://bookstore.apps.example.com | 200 OK |
| API health | curl http://bookstore-app:3000/healthz | 200 OK |
| List books | curl http://bookstore-app:3000/api/v1/books | 200 OK, returns [] |
| All pods ready | oc get pods -n bookstore-dev | All Running/Ready |
| No CrashLoopBackOff | oc get events -n bookstore-dev | No BackOff events |

# 9. Rollback Criteria

- Any tier fails to become Ready within 3 minutes
- Post-deployment validation fails
- Any pod enters CrashLoopBackOff within 5 minutes
- Database init job fails after 3 retries
