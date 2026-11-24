# UC-15 — Ops Twin

**TCS Agentic AI for Hybrid Infrastructure · Change Assurance**

> *Before you touch production, rehearse the change on a live twin of the cluster
> and see what breaks first.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-15 |
| Name | Ops Twin |
| Where | Automation Hub → Ops Twin · AI Chat (`twin_simulate`, `twin_overview` tools) |
| Trigger | Human-initiated: a what-if, picked or asked in plain words |
| Input | Live cluster state: nodes, pods and requests, PDBs, VMs, KServe models, HAMi GPU slices, DCGM power |
| Output | Verdict, expected impact with fixes, checks, plan, report; optional ServiceNow change request |
| Demo time | 3 minutes |
| Prerequisite | None; rack labels (`tcs.io/rack`) for the rack what-if |

## 2. The problem

Teams find out what a node drain, an upgrade or a new model will break while
it is happening: a disruption budget that never lets go, a VM that cannot
live-migrate, a model with nowhere to fit. Change boards approve on judgment.

## 3. What it does

1. Seven what-ifs: drain a node, a node fails, a GPU fails, a rack loses power, add a model, rolling upgrade, migrate VMs in.
2. Replays every displaced pod, VM and model through a scheduler model: CPU and memory requests, taints, node selectors, required node affinity, GPU memory per card.
3. Checks disruption budgets, VM live-migration, single replicas, pods without controllers, and whether sleeping models could still wake.
4. Gives a verdict ("Safe with 3 actions first"), each problem with its fix, and an ordered plan.
5. Raises a ServiceNow change request with the report and plan attached. Read-only: nothing on the cluster changes.

## 4. Who does what

| Actor | Steps |
|---|---|
| ⚙️ Automatic | Reading the cluster, placement, checks, verdict, plan, report |
| 🤖 AI | Only when asked in AI Chat: the agent calls the twin and explains its result |
| 👤 Human | Chooses the what-if, applies the fixes, raises and approves the change |

## 5. Business value

| Metric | Without | UC-15 |
|---|---|---|
| Finding a blocking disruption budget | Mid-drain, at night | Before the window, with the fix |
| Evidence for the change board | Judgment | A simulation report attached to the change |
| "Will this model fit?" | Try it | Answered per card, with the reason |

## 6. Demo script (short)

Ops Twin → Drain a node → tcsaiinode1 → Simulate. Show the red node and green receivers, the verdict, the disruption-budget fix, "gpt-oss-120b can't wake meanwhile", then Raise change in ServiceNow.

## 7. Implementation map

| Part | Where |
|---|---|
| Engine | `src/services/ops-twin.js` |
| Tools | `src/tools/ops-twin-tools.js` |
| Console | `console/src/components/opstwin/OpsTwin.jsx` |
| Setup and limits | `deploy/ops-twin/README.md` |

## 8. Verification status

| Claim | Status |
|---|---|
| Twin building, all seven what-ifs, question parsing | ✅ Unit-tested (`ops-twin.test.js`) |
| On the lab clusters | 🔶 To be run live |
| Not modelled | Pod affinity, topology spread, storage zones, quotas, rack power feeds — stated on every result |

## 9. Related

UC-02 (upgrade pre-check) · UC-10 (will the VMs fit) · UC-12 (auto-wake during a change).
