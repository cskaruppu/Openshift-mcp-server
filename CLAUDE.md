# TCS Agentic AI — Design Contract

## Protected Layout Elements — NEVER Remove or Bypass

1. **LoginOverlay** (`src/components/LoginOverlay.jsx`) — Auth gate, wraps entire app
2. **AppShell** (`src/design/layouts/AppShell.jsx`) — Master wrapper, all routes inside
3. **TopBar** (`src/design/layouts/TopBar.jsx`) — Brand + actions, always visible
4. **ClusterStrip** (`src/design/layouts/ClusterStrip.jsx`) — Workspace selector, always visible
5. **LeftNav** (`src/design/layouts/LeftNav.jsx`) — Navigation, max 7 items (defined in tokens.js)
6. **PersistentAIBar** (`src/design/layouts/PersistentAIBar.jsx`) — AI chat input, always at bottom
7. **Footer** — TCS branding, always visible

All routes MUST render inside `<AppShell>`. No exceptions.

## Design Tokens — MANDATORY

All visual values come from `src/design/tokens.js`:
- Colors: Import from `tokens.color` — never use raw hex in new components
- Fonts: Import from `tokens.font` — never use raw font strings
- Spacing: Import from `tokens.space` — use the 4px scale
- Radius: Import from `tokens.radius` — card:8, modal:12, pill:20
- Navigation items: Import from `tokens.nav` — single source for all nav

## Shared Components — USE THESE

- `StatusDot` — Health indicators (green/yellow/red with pulse)
- `SeverityBadge` — SEV-1/2/3 or critical/warning/info badges
- `ExpandableSection` — Progressive disclosure (expand/collapse)
- `ConfirmDialog` — Destructive action confirmation modal
- `ActionCard` — Fix proposals, diagnosis cards
- `ProgressTimeline` — Step-by-step progress (upgrades)

Import from `src/design` barrel: `import { StatusDot, SeverityBadge } from '../design'`

## Typography

- UI: Inter (400, 500, 600, 700, 800)
- Code/terminal: SF Mono / Fira Code / Cascadia Code
- NEVER use other fonts

## Views

| View Key | File | Template |
|---|---|---|
| dashboard | views/DashboardView.jsx | Widget grid |
| chat | views/ChatView.jsx | Split (sidebar + conversation) |
| observe | views/ObserveView.jsx | List (pod health, resources) |
| operate | views/OperateView.jsx | Detail (fix proposals, actions) |
| upgrade | views/UpgradeView.jsx | Detail (progress timeline) |
| tickets | views/TicketsView.jsx | List (ServiceNow incidents) |
| audit | views/AuditView.jsx | List (compliance trail) |
| intelligence | views/IntelligenceView.jsx | Dashboard (AI predictions) |

## Cluster Architecture

- Every data query uses `useClusterQuery()` hook — keys off active cluster
- `useActiveCluster()` returns current cluster ID
- API client automatically adds `?cluster=<id>` and `X-Cluster-Context` header
- Cluster switching cancels in-flight queries (via TanStack Query signal)
- Chat state is per-cluster (chatStore.js)

## Revert Instructions

To revert to pre-design-system state:
```bash
git checkout pre-design-system -- dashboard-react/src/
git checkout pre-design-system -- CLAUDE.md
git commit -m "Revert design system to pre-design-system tag"
```
