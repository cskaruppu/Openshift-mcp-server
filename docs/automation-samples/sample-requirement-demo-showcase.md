# Deployment Requirement — DEMO SHOWCASE (Autoscaling + Jobs + Rich Topology)

**Application:** Analytics Platform (demo)
**Architecture:** Frontend + API (autoscaled) + PostgreSQL + nightly report job
**Document owner:** Platform Engineering
**Target platform:** OpenShift 4.x / Kubernetes 1.28+
**Compliance baseline:** CIS Kubernetes Benchmark · Pod Security Standards "restricted"

> Purpose-built for **demos**: it produces the widest variety of resource
> kinds (Deployments, HPA, CronJob, PVC, Secrets, NetworkPolicies,
> ServiceMonitors, Route) so the **Namespace Heatmap → topology popup** shows a
> rich, multi-branch graph. Uses public pinned images so it deploys and goes
> green without edits.

---

## 1. Overview

- **Frontend (stateless):** image `nginx:1.25-alpine`, **2 replicas**, port 8080. Web-facing.
- **Analytics API (stateless, autoscaled):** image `node:20-alpine` running a simple
  HTTP server, **2 replicas**, port 8080, plus a **HorizontalPodAutoscaler**
  (min 2, max 5, target 70% CPU).
- **PostgreSQL (stateful):** image `postgres:16-alpine`, 1 replica, port 5432,
  credentials from a Secret, **8Gi** RWO PVC.
- **Nightly report CronJob:** image `busybox:1.36`, schedule `0 2 * * *`,
  runs a short report command and exits.

## 2. Namespace & Isolation

- Dedicated namespace: `analytics-demo`, Pod Security **"restricted"** labels.
- **Default-deny NetworkPolicy**; allow only router → Frontend (8080),
  Frontend → API (8080), API → PostgreSQL (5432).
- **ResourceQuota** + **LimitRange**.

## 3. RBAC, Security, Monitoring (standard baseline)

- Dedicated ServiceAccount per tier; namespace-scoped Role + RoleBinding only.
- "restricted" securityContext everywhere (runAsNonRoot, drop ALL,
  no privilege escalation, seccomp RuntimeDefault).
- DB credentials from Secret `analytics-db-auth`.
- **ServiceMonitor** for Frontend and API; readiness/liveness probes on all tiers.
- Frontend exposed via Service + **Route (edge TLS)**; API and DB internal only.

## 4. Sizing

| Tier       | Replicas | CPU req | CPU limit | Mem req | Mem limit |
|------------|----------|---------|-----------|---------|-----------|
| Frontend   | 2        | 100m    | 300m      | 128Mi   | 256Mi     |
| API        | 2 (HPA 2–5) | 150m | 500m      | 256Mi   | 512Mi     |
| PostgreSQL | 1        | 250m    | 1         | 256Mi   | 512Mi     |
| CronJob    | —        | 50m     | 200m      | 64Mi    | 128Mi     |

## 5. Acceptance Criteria

- [ ] All four workload types present (2 web tiers, DB, CronJob) + HPA
- [ ] Restricted namespace, default-deny NetworkPolicy, quota/limits
- [ ] Least-privilege RBAC; Secret-sourced DB creds; 8Gi PVC
- [ ] ServiceMonitors + probes; Frontend routed, everything else internal
- [ ] Deploys green with no edits (public pinned images)
