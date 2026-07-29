# Deployment Requirement — CUSTOM IMAGE Application (Private Registry)

**Application:** Payments Service (customer-built images)
**Architecture:** 2-tier — Payments API (custom image) + Redis cache
**Document owner:** Platform Engineering
**Requested by:** Payments Team
**Target platform:** OpenShift 4.x / Kubernetes 1.28+
**Compliance baseline:** CIS Kubernetes Benchmark · Pod Security Standards "restricted"

> This sample shows how to deploy **customer-built container images** from a
> **private registry** (instead of public images). Upload it to the
> **App Deployment Agent**; before deploying, edit the image references and
> pull-secret credentials in the generated YAML to match your registry.

---

## 1. Overview

Deploy the Payments Service using **our own pre-built images** — not public
Docker Hub images:

- **Payments API (stateless):** image `registry.acme.internal/payments/payments-api:1.4.2`
  — 2 replicas, REST API on port 8080. Web-facing.
- **Redis cache (stateful):** image `registry.acme.internal/platform/redis:7.2-hardened`
  — 1 replica, port 6379, persistent.

## 2. Private Registry Access (IMPORTANT)

- Both images live in the **private registry `registry.acme.internal`**.
- Generate an image **pull Secret** of type `kubernetes.io/dockerconfigjson`
  named `acme-registry-pull` (use a placeholder `.dockerconfigjson` value the
  user must replace before deploy).
- Reference it via `imagePullSecrets` on **every pod spec**.
- Pin images by exact tag (never `:latest`); digests preferred.

## 3. Namespace & Isolation

- Dedicated namespace: `payments-svc`, Pod Security **"restricted"** labels.
- **Default-deny NetworkPolicy**; allow only router → API (8080) and API → Redis (6379).
- **ResourceQuota** + **LimitRange**.

## 4. RBAC (least privilege)

- Dedicated ServiceAccounts (`payments-api`, `payments-cache`) — never `default`.
- Namespace-scoped Role + RoleBinding only.

## 5. Security ("restricted")

- `runAsNonRoot: true`, drop ALL capabilities, `allowPrivilegeEscalation: false`,
  `seccompProfile: RuntimeDefault`.
- Redis password from a **Secret** (`payments-redis-auth`), never inline.

## 6. Storage, Monitoring, Exposure

- Redis: **5Gi** `ReadWriteOnce` PVC.
- **ServiceMonitor** on the API `metrics` port; readiness/liveness probes on both tiers.
- API exposed via Service + **Route (edge TLS)**; Redis internal only.

## 7. Sizing

| Tier | Replicas | CPU req | CPU limit | Mem req | Mem limit |
|------|----------|---------|-----------|---------|-----------|
| API  | 2        | 150m    | 500m      | 256Mi   | 512Mi     |
| Redis| 1        | 100m    | 500m      | 128Mi   | 256Mi     |

## 8. Acceptance Criteria

- [ ] Pull Secret `acme-registry-pull` generated and referenced by every pod
- [ ] Custom image references used exactly as specified (pinned tags)
- [ ] Restricted namespace, default-deny NetworkPolicy, quota/limits
- [ ] Least-privilege RBAC, Secrets for credentials, PVC for Redis
- [ ] ServiceMonitor + probes; API routed, Redis internal
- [ ] User edits registry credentials in the YAML before deploy
