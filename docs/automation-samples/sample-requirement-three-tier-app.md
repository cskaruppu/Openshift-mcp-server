# Deployment Requirement — THREE-TIER Application (Frontend + API + PostgreSQL)

**Application:** Retail Inventory Portal
**Architecture:** 3-tier — Presentation (Frontend) + Application (Backend API) + Data (PostgreSQL)
**Document owner:** Platform Engineering
**Requested by:** Retail Applications Team
**Target platform:** OpenShift 4.x / Kubernetes 1.28+
**Compliance baseline:** CIS Kubernetes Benchmark · Pod Security Standards "restricted"

> Upload this document to the **App Deployment Agent**. It will generate the
> hardened Kubernetes/OpenShift manifests, which you can review/edit, dry-run,
> and deploy to **any connected cluster**.

---

## 1. Overview

Deploy a classic **three-tier** business application:

- **Tier 1 — Frontend / Presentation (stateless):** an `nginx`-served web UI,
  **2 replicas**. The only web-facing tier.
- **Tier 2 — Backend API / Application (stateless):** a `node`-based REST API,
  **3 replicas**. Reached only by the frontend; talks to the database.
- **Tier 3 — Database / Data (stateful):** a **PostgreSQL 16** instance with
  persistent storage. Reached only by the API.

Production-ready, secure by default, observable, and deployable to any cluster.

## 2. Namespace & Isolation

- Dedicated namespace: `inventory-portal`.
- Enforce **Pod Security "restricted"** (enforce/audit/warn labels).
- **Default-deny NetworkPolicy**, then allow ONLY the tier-to-tier hops:
  - OpenShift router → Frontend (port 8080).
  - Frontend → Backend API (port 8080).
  - Backend API → PostgreSQL (port 5432).
  - No other pod-to-pod traffic; database is never reachable from the frontend directly.
- Add a **ResourceQuota** and a **LimitRange**.

## 3. RBAC (least privilege)

- A dedicated **ServiceAccount** per tier (`inv-frontend`, `inv-api`, `inv-db`) — never `default`.
- Namespace-scoped **Role** + **RoleBinding** per tier. No ClusterRole, no wildcard verbs, no cluster-admin.

## 4. Security (Pod Security "restricted")

- `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, drop **ALL** capabilities,
  `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem` where feasible.
- No privileged containers, no host network/PID/IPC, no hostPath.
- **Database credentials + API secrets come from Secrets** (secretKeyRef / envFrom) — never inline.
- Pin image tags (no `:latest`) for deterministic Trivy/Quay/CIS scanning.

## 5. Persistent Storage (PVC)

- PostgreSQL requires a **PersistentVolumeClaim**: **10Gi**, `ReadWriteOnce`, mounted at the data dir.
- Frontend and Backend API tiers are stateless — no PVC.

## 6. Monitoring & Observability

- Add a **ServiceMonitor** for the Frontend and the Backend API (named `metrics` port each).
- **Readiness** and **liveness** probes on all three tiers.
- Recommended `app.kubernetes.io/*` labels (`part-of: inventory-portal`) for grouping.

## 7. Networking / Exposure

- **Frontend** exposed via **Service** (ClusterIP) + OpenShift **Route** (edge TLS).
- **Backend API**: internal **Service** only (reached by the frontend) — not routed.
- **PostgreSQL**: internal **Service** only (reached by the API) — never routed.

## 8. Resource Sizing

| Tier         | Replicas | CPU req | CPU limit | Mem req | Mem limit |
|--------------|----------|---------|-----------|---------|-----------|
| Frontend     | 2        | 100m    | 500m      | 128Mi   | 256Mi     |
| Backend API  | 3        | 150m    | 750m      | 256Mi   | 512Mi     |
| PostgreSQL   | 1        | 250m    | 1         | 256Mi   | 512Mi     |

## 9. Acceptance Criteria

- [ ] Dedicated restricted namespace with default-deny NetworkPolicy + tier-to-tier allows + quota/limits
- [ ] Least-privilege ServiceAccount + Role/RoleBinding per tier (no default SA)
- [ ] "restricted" securityContext on every pod
- [ ] DB/API credentials from Secrets; images pinned
- [ ] 10Gi RWO PVC bound to PostgreSQL
- [ ] ServiceMonitor + readiness/liveness probes on all tiers
- [ ] Frontend routed (edge TLS); API and DB internal only
- [ ] Passes the platform CIS/security scan after deployment
- [ ] Deployable end-to-end to any connected cluster from the agent
