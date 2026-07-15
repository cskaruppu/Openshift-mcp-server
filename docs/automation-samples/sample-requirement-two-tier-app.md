# Deployment Requirement — TWO-TIER Application (Web + MySQL)

**Application:** Employee Feedback Portal
**Architecture:** 2-tier — Web/API tier + MySQL database tier
**Document owner:** Platform Engineering
**Requested by:** HR Applications Team
**Target platform:** OpenShift 4.x / Kubernetes 1.28+
**Compliance baseline:** CIS Kubernetes Benchmark · Pod Security Standards "restricted"

> Upload this document to the **App Deployment Agent**. It will generate the
> hardened Kubernetes/OpenShift manifests, which you can review/edit, dry-run,
> and deploy to **any connected cluster**.

---

## 1. Overview

Deploy a classic **two-tier** business application:

- **Tier 1 — Web/API (stateless):** an `nginx`-based web application, **2 replicas**,
  serving the UI and REST API. Web-facing.
- **Tier 2 — Database (stateful):** a **MySQL 8** instance with persistent storage.

The result must be production-ready, secure by default, observable, and
deployable to any cluster through the agent.

## 2. Namespace & Isolation

- Dedicated namespace: `feedback-portal`.
- Namespace must enforce **Pod Security "restricted"** (enforce/audit/warn labels).
- **Default-deny NetworkPolicy**, then allow only:
  - OpenShift router → Web tier (port 8080).
  - Web tier → MySQL (port 3306).
- Add a **ResourceQuota** and a **LimitRange** with sane container defaults.

## 3. RBAC (least privilege)

- A dedicated **ServiceAccount** per tier (`feedback-web`, `feedback-db`) — never `default`.
- A namespace-scoped **Role** + **RoleBinding** only. No ClusterRole, no wildcard verbs, no cluster-admin.

## 4. Security (Pod Security "restricted")

- `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, drop **ALL** capabilities,
  `seccompProfile: RuntimeDefault`, `readOnlyRootFilesystem` where feasible.
- No privileged containers, no host network/PID/IPC, no hostPath.
- **MySQL root/app credentials come from a Secret** (secretKeyRef / envFrom) — never inline.
- Pin image tags (no `:latest`) so Trivy/Quay/CIS scans are deterministic.

## 5. Persistent Storage (PVC)

- MySQL requires a **PersistentVolumeClaim**: **8Gi**, `ReadWriteOnce`, mounted at the data dir.
- The Web tier is stateless — no PVC.

## 6. Monitoring & Observability

- Add a **ServiceMonitor** (Prometheus Operator) scraping the Web tier's `metrics` port.
- **Readiness** and **liveness** probes on both tiers.
- Recommended `app.kubernetes.io/*` labels for dashboard grouping.

## 7. Networking / Exposure

- Web tier exposed via a **Service** (ClusterIP) + an OpenShift **Route** (edge TLS).
- MySQL is an **internal Service only** — never routed externally.

## 8. Resource Sizing

| Tier  | Replicas | CPU req | CPU limit | Mem req | Mem limit |
|-------|----------|---------|-----------|---------|-----------|
| Web   | 2        | 100m    | 500m      | 128Mi   | 256Mi     |
| MySQL | 1        | 250m    | 1         | 256Mi   | 512Mi     |

## 9. Acceptance Criteria

- [ ] Dedicated restricted namespace with default-deny NetworkPolicy + quota/limits
- [ ] Least-privilege ServiceAccounts + Role/RoleBinding (no default SA)
- [ ] "restricted" securityContext on every pod
- [ ] MySQL credentials from a Secret; images pinned
- [ ] 8Gi RWO PVC bound to MySQL
- [ ] ServiceMonitor + readiness/liveness probes
- [ ] Web routed (edge TLS); MySQL internal only
- [ ] Passes the platform CIS/security scan after deployment
- [ ] Deployable end-to-end to any connected cluster from the agent
