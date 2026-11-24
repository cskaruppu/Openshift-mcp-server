# UC-14 — VM Guard: Agentless VM Security

**TCS Agentic AI for Hybrid Infrastructure · Virtualization Security**

> *Every OpenShift Virtualization VM, on every cluster: its vulnerabilities, its
> end-of-life risk, its exposure and every change to its shape — without an agent
> inside the guest.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-14 |
| Name | VM Guard — Agentless VM Security |
| Where | Dashboard (new layout) → Virtualization · Automation Hub → VM Security Agent (all clusters) |
| Trigger | Continuous (every 5 minutes) · on demand for disk scans |
| Input | VirtualMachines, VMIs, Services, Routes; optional Trivy scan of a VM disk snapshot |
| Output | Per-VM risk tier (Fix now → Hygiene), findings with fix commands, configuration changes, ServiceNow incidents |
| Demo time | 4 minutes |
| Prerequisite | OpenShift Virtualization; for disk scans, `VM_GUARD_SCAN=true` and `deploy/vm-guard/rbac.yaml` |

## 2. The problem

VMs moved to OpenShift often lose their security tooling, and many cannot run
an agent. Nobody sees that a VM runs an end-of-life OS, is exposed on a
LoadBalancer, or had its CPU, RAM or disks changed by hand last night.

## 3. What it does

1. Reads each VM's shape (CPU, memory, disks, NICs, devices) and records every change against an approved baseline, with who made it.
2. Identifies the guest OS (from the guest agent or template) and checks it against an end-of-life table.
3. Works out exposure: LoadBalancer or NodePort Services, Routes, bridged NICs.
4. Optionally scans a VM disk without touching the VM: snapshot → restored copy → Trivy → cleanup.
5. Ranks findings by real-world risk (CISA KEV, FIRST EPSS) and gives the update command for the guest's package manager.
6. Shows every VM across every cluster in one table, and raises a ServiceNow incident per VM (one open ticket per VM).

## 4. Business value

| Metric | Without | UC-14 |
|---|---|---|
| VMs without a security agent | Unscanned | Scanned agentlessly |
| Hand changes to a VM | Unnoticed | Recorded with who and when |
| Prioritisation | CVSS score only | Known-exploited and likely-exploited first |

## 5. Implementation map

| Part | Where |
|---|---|
| Engine | `src/services/vm-guard.js` |
| Console | `console/src/components/vmguard/VmGuard.jsx`, `VmFleetAgent.jsx` |
| Setup | `deploy/vm-guard/README.md`, `rbac.yaml` |

## 6. Verification status

| Claim | Status |
|---|---|
| Shape diff, weakening, end of life, exposure, Trivy parsing, fix commands | ✅ Unit-tested (`vm-guard.test.js`) |
| Disk scan end to end on a real VM | 🔶 To be run live |

## 7. Related

UC-06 (VM lifecycle) · UC-10 (migration) · UC-04 (security and compliance).
