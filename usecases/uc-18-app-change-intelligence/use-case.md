# UC-18 — Application Change Intelligence

**TCS Agentic AI for Hybrid Infrastructure · Application Operations**

> *Every change to an application — what changed, who changed it, how risky it
> is, what to watch for — and one click to put it back.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-18 |
| Name | Application Change Intelligence |
| Agent | Application Change Intelligence Agent |
| Trigger | Continuous watch of selected namespaces |
| Input | Workloads in watched namespaces; Kubernetes events; Argo CD / OpenShift GitOps applications |
| Output | A change history with risk score, author and AI analysis; GitOps drift; rollback to the previous baseline |

## 2. The problem

Most incidents follow a change: a new image, an edited environment variable, a
replica count changed by hand. When something breaks, teams dig through events
and Git to find what changed, and GitOps drift goes unnoticed.

## 3. What it does

1. Watches chosen namespaces (kept in a ConfigMap) for image updates, configuration and environment changes, and replica changes.
2. Records who made each change and how (user, tool), scores its risk, and correlates it with events.
3. Has the AI write a short analysis per change: impact, risk assessment, recommendation, what to watch for.
4. Detects drift between Git and the live state for Argo CD / OpenShift GitOps applications.
5. Rolls a workload back to its baseline (image, environment, replicas) and records the change on the timeline.

## 4. Business value

| Metric | Without | UC-18 |
|---|---|---|
| "What changed before it broke?" | Event and Git archaeology | One history per application |
| Hand edits bypassing GitOps | Unnoticed | Drift reported |
| Undoing a bad change | Manual | One-click rollback |

## 5. Implementation map

| Part | Where |
|---|---|
| Watcher, history, AI analysis, rollback, GitOps drift | `src/tools/app-change-watcher.js` |
| Agent manifest | `src/agents/manifests/application-change-intelligence.json` |

## 6. Verification status

| Claim | Status |
|---|---|
| Tools present and registered | ✅ `manifest-tools-exist.test.js` |
| Behaviour on a live cluster | 🔶 Confirm before demonstrating |

## 7. Related

UC-08 (cluster configuration drift) · UC-05 (incidents that follow a change) · UC-14 (VM configuration changes).
