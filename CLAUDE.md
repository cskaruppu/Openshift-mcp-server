# TCS Agentic AI — Design Contract

## PROTECTED — Do NOT Modify These

1. **App.jsx** — Header with 4 tabs (Dashboard, AI Chat, Audit, AI Intelligence), back pill, brand, actions
2. **ClusterPickerView.jsx** — Workspace selection screen with cluster cards, kebab menus, platform detection
3. **LoginOverlay.jsx** — Auth gate with password + token tabs, TCS branding
4. **styles.css** — All existing CSS classes (.app-header, .nav-tab, .brand, .login-*, .dash-*, .cp-*, .ac-*, .aud-*, .intel-*)
5. **NAV array in App.jsx** — Exactly 4 items: Dashboard, AI Chat, Audit, AI Intelligence. No additions without explicit approval.

## Existing Views — Do NOT Restructure

| Tab | View | Widgets/Features |
|---|---|---|
| Dashboard | DashboardView.jsx | 16 widgets (health, nodes, pods, ns, operators, alerts, risk, scores, vulns, changes, capacity, optimization, timeline, topology, heatmap, emergency) |
| AI Chat | ChatView.jsx + ChatTokens.jsx | Sidebar, conversation, fix proposals, ServiceNow, upgrade cards |
| Audit | AuditView.jsx | Compliance trail, CIS scoring, change requests |
| AI Intelligence | IntelligenceView.jsx | Risk predictions, anomaly detection, knowledge base, incident correlation |

## Design System (Available for Future Use)

Shared components in `src/design/` — ready to import when needed:
- `tokens.js` — Colors, fonts, spacing, radius (single source of truth)
- `StatusDot` — Health indicators
- `SeverityBadge` — SEV-1/2/3 badges
- `ExpandableSection` — Progressive disclosure
- `ConfirmDialog` — Destructive action confirmation
- `ActionCard` — Fix proposal cards
- `ProgressTimeline` — Step-by-step progress

Import: `import { StatusDot, SeverityBadge } from '../design'`

## Typography

- UI: Inter (400, 500, 600, 700, 800)
- Code: SF Mono / Fira Code
- NEVER use other fonts

## Cluster Architecture

- `useClusterQuery()` — all data queries key off active cluster
- `useActiveCluster()` — current cluster ID
- API client adds `?cluster=<id>` and `X-Cluster-Context` header
- Chat state is per-cluster (chatStore.js)
- ClusterPickerView handles workspace selection with full platform support

## Revert Instructions

```bash
# Revert design system only (keeps all existing code intact)
rm -rf dashboard-react/src/design/
git checkout HEAD -- dashboard-react/src/App.jsx
git commit -m "Remove design system components"
```
