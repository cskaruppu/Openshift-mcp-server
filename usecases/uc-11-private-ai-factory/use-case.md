# UC-11 — Private AI Factory

**TCS Agentic AI for Hybrid Infrastructure · Private AI**

> *The platform's AI, running on GPUs in your own data centre — with the proof
> that no question, log or screenshot ever left it.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-11 |
| Name | Private AI Factory |
| Where | Workspace header → Private AI Factory (tabs: Overview, Models, Infrastructure, Usage & cost, Governance) · Settings → Private AI |
| Trigger | Continuous: every AI request made with the Private AI provider |
| Input | Models served by Red Hat OpenShift AI (KServe, vLLM, TEI) on a GPU cluster |
| Output | On-prem answers in AI Chat, a masked usage record, cloud cost avoided, an evidence export for auditors |
| Demo time | 9 minutes (see the Private AI Factory demo video script) |
| Prerequisite | A GPU cluster with OpenShift AI; `deploy/demo/private-ai-ops/enable.sh` run against it |

## 2. The problem

Operations teams want AI help with incidents, but cloud AI means sending logs,
cluster data and sometimes secrets outside the company. Banks, government and
other regulated customers often cannot. Running models yourself is possible,
but nobody can then show which model answered, what it cost, or that the data
stayed inside.

## 3. What it does

1. Serves the platform's AI from models on the customer's GPUs: llama-3-1-8b (fast answers), qwen2-5-vl-7b (screenshots), bge-m3 (incident memory), gpt-oss-120b (deep reasoning).
2. Puts every question through the router first: guardrails block risky questions before any model sees them.
3. Records every request with sensitive values masked, and shows which model answered, how fast (tokens per second) and how busy it was.
4. Shows the GPU floor: which cards are in use, by which model, with HAMi sharing several models on one H100.
5. Prices each request at cloud rates to show the cost avoided.
6. Exports evidence that data stayed on-prem, for auditors.
7. Repairs itself: discovers models, fixes Route ports, explains why a model is Down.

## 4. Who does what

| Actor | Steps |
|---|---|
| 🤖 AI | The models answer the questions |
| ⚙️ Automatic | Guardrails, routing, masking, usage record, cost model, health checks, Route repair |
| 👤 Human | Turns the Factory on, chooses models, starts or stops them, exports evidence |

## 5. Business value

| Metric | Cloud AI | UC-11 |
|---|---|---|
| Data leaving the site | Every question | None |
| Proof for auditors | Vendor statement | Evidence export from the usage record |
| Cost | Per token, grows with use | GPUs already owned; cloud cost avoided shown per request |
| Works without internet | No | Yes, after the models are deployed |

## 6. Demo script (short)

| Min | Beat |
|---|---|
| 0–1 | AI Chat with Private AI selected: ask a question; Overview shows it answered on-prem |
| 1–2 | Paste a screenshot: the vision model answers; Governance shows the record |
| 2–3 | Ask a risky question: blocked before any model |
| 3–5 | Models, Infrastructure, Usage & cost, Governance — one sentence and one number each |

## 7. Implementation map

| Part | Where |
|---|---|
| Router, guardrails, fallback | `src/services/private-ai/router.js` |
| Factory state, model stats, health, Route repair | `src/services/private-ai/factory.js`, `fleet.js` |
| Console | `console/src/components/commandcenter/` |
| Enablement | `deploy/demo/private-ai-ops/` (README, `enable.sh`, `gpu-cluster-access.yaml`) |
| Collateral | Audience guide, demo video script, deck, market comparison (shared separately) |

## 8. Verification status

| Claim | Status |
|---|---|
| Routing, guardrails, usage record, cost model | ✅ Unit-tested (`private-ai*.test.js`); live on the lab GPU cluster |
| Model discovery and Route self-repair | ✅ Unit-tested; fixed a live 503 in the lab |
| Tokens per second from vLLM metrics | ✅ Live |

## 9. Related

UC-12 (which model answers, and sleeping models) · UC-13 (the GPU fleet) · UC-05 (its RCA uses the same AI).
