# Deployment Requirement — Customer Portal (Web App + PostgreSQL)

**Document owner:** Platform Engineering
**Requested by:** Application Team — Customer Portal
**Target platform:** OpenShift 4.x (Kubernetes 1.28+)
**Compliance baseline:** CIS Kubernetes Benchmark, Pod Security Standards "restricted"

---

## 1. Overview

Deploy a two-tier business application to OpenShift following **global industry
standard** best practices:

- **Frontend/API tier:** a stateless web application (`nginx`-based, 2 replicas).
- **Database tier:** a **PostgreSQL 16** database (stateful, single instance)
  with persistent storage.

The application must be production-ready, secure by default, observable, and
deployable to any connected cluster through the App Deployment Agent.

## 2. Namespace & Isolation (best practice)

- Create a **dedicated namespace**: `customer-portal`.
- The namespace must be **restricted** — no workload outside this namespace may
  reach these pods except through the defined Service/Route.
- Apply a **default-deny NetworkPolicy** so only explicitly allowed traffic
  flows: frontend → database on port 5432, and ingress to the frontend only
  from the OpenShift router.
- Apply a **ResourceQuota** and **LimitRange** to cap CPU/memory for the
  namespace and set sane per-container defaults.

## 3. Role-Based Access Control (RBAC)

- Create a dedicated **ServiceAccount** for each tier (`portal-web`, `portal-db`).
- Pods must **not** use the `default` service account.
- Grant **least-privilege** access only:
  - A `Role` scoped to the `customer-portal` namespace.
  - A `RoleBinding` binding each ServiceAccount to that Role.
  - No cluster-wide permissions. No `cluster-admin`. No wildcard verbs.

## 4. Security Recommendations (Pod Security "restricted")

- `runAsNonRoot: true`, drop **ALL** Linux capabilities.
- `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` where feasible.
- `seccompProfile: RuntimeDefault`.
- No privileged containers, no host network/PID/IPC, no hostPath volumes.
- Database credentials must come from a **Secret**, never hard-coded in the
  Deployment.
- Images should be scannable by the platform's **CIS/security scanner** (Trivy /
  Quay) — prefer pinned tags or digests over `:latest`.

## 5. Persistent Storage (PVC)

- The PostgreSQL tier requires a **PersistentVolumeClaim**:
  - Size: **10Gi**
  - Access mode: `ReadWriteOnce`
  - Mounted at the Postgres data directory.
- The web tier is stateless and needs **no** PVC.

## 6. Monitoring & Observability

- Expose application metrics and enable monitoring on the **correct side**:
  - Add a **ServiceMonitor** (Prometheus Operator) so the platform scrapes the
    web tier's `/metrics` endpoint.
  - Ensure the Service exposes a named `metrics` port.
- Set **readiness** and **liveness** probes on both tiers.
- Label all objects with `app`, `tier`, and `app.kubernetes.io/*` recommended
  labels so dashboards and alerts can group them.

## 7. Networking / Exposure

- Expose the web tier via a **Service** (ClusterIP) and an OpenShift **Route**
  (edge TLS) for external users.
- The database must **not** be exposed via a Route — internal Service only.

## 8. Resource Sizing

| Tier      | Replicas | CPU request | CPU limit | Mem request | Mem limit |
|-----------|----------|-------------|-----------|-------------|-----------|
| Web/API   | 2        | 100m        | 500m      | 128Mi       | 256Mi     |
| PostgreSQL| 1        | 250m        | 1         | 256Mi       | 512Mi     |

## 9. Acceptance Criteria

- [ ] Dedicated namespace with default-deny NetworkPolicy, ResourceQuota, LimitRange
- [ ] Dedicated ServiceAccounts with least-privilege Role/RoleBinding (no default SA)
- [ ] Pod Security "restricted" securityContext on every pod
- [ ] DB credentials sourced from a Secret
- [ ] 10Gi RWO PVC bound to PostgreSQL
- [ ] ServiceMonitor + readiness/liveness probes for observability
- [ ] Web tier exposed via Route (edge TLS); DB internal only
- [ ] Passes the platform CIS/security scan after deployment
