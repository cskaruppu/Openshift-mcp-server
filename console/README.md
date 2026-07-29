# TCS Agentic AI — Phase 2 Dashboard (React + TanStack Query)

This is the **Phase 2** rewrite of the multi-cluster dashboard. It runs **in
parallel** with the legacy single-file dashboard (`../dashboard/index.html`):

| App | Route | Status |
|-----|-------|--------|
| Legacy (vanilla JS) | `/` | Production — fully featured |
| Phase 2 (React) | `/next` | In progress — incremental migration |

The legacy app is **never deleted** during the migration, so you can always
fall back to it.

## Why this architecture eliminates cross-cluster data leaks

Isolation is **structural**, not hand-enforced:

1. **One source of truth for the active cluster** — `store/clusterStore.js`.
2. **Every data query is keyed by cluster** — `hooks/useClusterQuery.js` puts
   the cluster id into the TanStack Query key `[path, cluster]`. When the
   cluster changes:
   - in-flight requests for the old cluster are **cancelled automatically**
     (React Query aborts the `signal`),
   - the old cluster's cached data becomes **structurally unreachable**,
   - widgets re-render from the new cluster's cache or a loading state.
3. **No manual guards** — there are no `clusterGeneration` counters,
   `AbortController`s, or `clearDashboardMetrics()` calls. They are unnecessary
   because the framework enforces isolation by construction.

This is the same model used by Lens (MobX + per-cluster store), Rancher, and
Argo CD (per-cluster informer caches).

## Develop

```bash
cd console
npm install
npm run dev        # http://localhost:5174/next/  (proxies /api to :8080)
```

## Build (outputs to ../dashboard/next, served by the backend at /next)

```bash
npm run build
```

## Migration roadmap (22 widgets total)

- [x] Foundation: cluster store, cluster-aware API client, useClusterQuery
- [x] Cluster Health
- [x] Nodes
- [x] Namespaces
- [ ] Cluster Operators
- [ ] Node Topology
- [ ] Health Timeline
- [ ] Namespace Heatmap
- [ ] AI Risk Predictions
- [ ] CIS Compliance
- [ ] GitOps Sync Status
- [ ] DR Readiness
- [ ] Application Change Watcher
- [ ] Image Vulnerability Scanner
- [ ] Resource Optimization
- [ ] Active Alerts
- [ ] Pods at Risk
- [ ] AI Insights
- [ ] Multicluster (ACM)
- [ ] Emergency Actions
- [ ] Ansible Automation Platform
- [ ] AI Chat
- [ ] Audit

Each widget is migrated by creating a component under `components/widgets/`
that calls `useClusterQuery("/api/<endpoint>")` — isolation is automatic.
