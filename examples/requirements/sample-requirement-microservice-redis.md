# Deployment Requirement — Orders Microservice (API + Redis Cache)

**Document owner:** SRE / Platform Team
**Requested by:** Orders Service Team
**Target platform:** OpenShift 4.x / Kubernetes 1.28+
**Compliance baseline:** CIS Kubernetes Benchmark, Pod Security Standards "restricted"

---

## 1. Overview

Deploy a stateless **Orders REST microservice** — image
`hashicorp/http-echo:1.0` with args `["-listen=:8080","-text=orders-ok"]`
(non-root, port 8080), 3 replicas — backed by a **Redis** cache — image
`bitnami/redis:7.2` (non-root), env `REDIS_PASSWORD` from a Secret, persistent
data at `/bitnami/redis/data` (single instance). Follow global
industry-standard security, isolation, storage and monitoring practices so the
workload is production-ready and passes the platform's CIS/security scanners.

## 2. Namespace & Isolation

- Dedicated namespace: `orders-svc`.
- **Default-deny NetworkPolicy**; allow only:
  - Router ingress → orders API (port 8080).
  - Orders API → Redis (port 6379).
- **ResourceQuota** + **LimitRange** on the namespace.

## 3. RBAC (least privilege)

- Dedicated `ServiceAccount` `orders-api` (do not use `default`).
- Namespace-scoped `Role` + `RoleBinding` only. No cluster roles, no wildcards.

## 4. Security (Pod Security "restricted")

- `runAsNonRoot: true`, drop ALL capabilities, `allowPrivilegeEscalation: false`,
  `seccompProfile: RuntimeDefault`.
- Redis password from a **Secret**.
- Pin image tags (no `:latest`) so Trivy/Quay scanning is deterministic.

## 5. Persistent Storage (PVC)

- Redis requires a **5Gi** `ReadWriteOnce` PVC for append-only persistence.
- The API tier is stateless — no PVC.

## 6. Monitoring

- **ServiceMonitor** scraping the API `/metrics` endpoint (named `metrics` port).
- Readiness/liveness probes on API and Redis.
- Recommended `app.kubernetes.io/*` labels for dashboard grouping.

## 7. Exposure

- API exposed via **Service** (ClusterIP) + **Route** (edge TLS).
- Redis internal Service only — never routed externally.

## 8. Sizing

| Tier   | Replicas | CPU req | CPU limit | Mem req | Mem limit |
|--------|----------|---------|-----------|---------|-----------|
| API    | 3        | 100m    | 500m      | 128Mi   | 256Mi     |
| Redis  | 1        | 100m    | 500m      | 128Mi   | 256Mi     |

## 9. Acceptance Criteria

- [ ] Dedicated namespace with default-deny NetworkPolicy + quota/limits
- [ ] Least-privilege ServiceAccount/Role/RoleBinding (no default SA)
- [ ] "restricted" securityContext on all pods
- [ ] Redis password from Secret; images pinned
- [ ] 5Gi RWO PVC for Redis
- [ ] ServiceMonitor + probes
- [ ] API routed (edge TLS); Redis internal only
- [ ] Passes CIS/security scan post-deploy
