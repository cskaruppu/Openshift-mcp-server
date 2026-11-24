# UC-13 — GPU Fleet Optimisation

**TCS Agentic AI for Hybrid Infrastructure · Private AI / Capacity**

> *Who holds each GPU, how hard it is working, and which ones are paid for but idle.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-13 |
| Name | GPU Fleet Optimisation |
| Where | Dashboard GPU widget · Private AI Factory → Infrastructure |
| Trigger | Continuous |
| Input | Kubernetes API (nodes, pods), HAMi annotations, NVIDIA GPU Feature Discovery labels, DCGM metrics |
| Output | Physical card counts, per-card holders, utilisation, temperature, power, idle and health alerts |
| Demo time | 2 minutes |

## 2. The problem

GPU sharing confuses the usual tools: HAMi advertises each H100 as 10 slices,
so dashboards show "20 GPUs" on a 2-card node, every card as "free", or "6 of
4 in use". Idle cards held by a pod look busy, and shared cards look wasted.

## 3. What it does

1. Counts physical cards from HAMi's register or GPU Feature Discovery, and shows slices separately ("In use 2/4 · 6 of 40 slices").
2. Maps each pod to the card it holds and the memory it reserved ("Who holds each GPU": node → card → pods).
3. Adds DCGM utilisation, memory, temperature, power and error counters per card when scraped; works without them.
4. Separates idle allocated cards from quiet shared cards, so only real waste is flagged.
5. Raises GPU health alerts (temperature, XID errors, ECC) and shows a 24-hour usage chart.

## 4. Business value

| Metric | Without | UC-13 |
|---|---|---|
| "How many GPUs are really in use?" | Wrong under sharing | Physical cards and slices, both shown |
| Idle GPUs | Hidden | Named, with the pod holding them |
| Reaction to a failing card | After the job fails | Health alert from DCGM |

## 5. Implementation map

| Part | Where |
|---|---|
| Inventory, HAMi parsing, DCGM enrichment | `src/tools/gpu-metrics.js` |
| Console | `console/src/components/widgets/GpuOverviewWidget.jsx`, Private AI Factory Infrastructure tab |

## 6. Verification status

| Claim | Status |
|---|---|
| HAMi register and allocation parsing, physical counts | ✅ Unit-tested (`gpu-sharing.test.js`) |
| Display on the lab GPU cluster | ✅ Live, corrected after field feedback |

## 7. Related

UC-11 · UC-12 (auto-sleep gives idle GPUs back) · UC-15 (Ops Twin uses the same card map).
