# UC-12 — Smart Model Routing, Auto-Sleep & Wake

**TCS Agentic AI for Hybrid Infrastructure · Private AI**

> *The right model for every question, and no GPU held by a model nobody is using.*

## 1. Summary

| Field | Value |
|---|---|
| Use case ID | UC-12 |
| Name | Smart Model Routing, Auto-Sleep & Wake |
| Where | Automatic in AI Chat · Private AI Factory → Models → Auto-sleep… on each model |
| Trigger | Every Private AI request (routing, wake) · a 60-second tick (sleep) |
| Input | The question (text, code, screenshot, tools needed), each model's auto-sleep setting, GPU memory per card |
| Output | The answer from the right model; idle models stopped; sleeping models started when needed |
| Demo time | 3 minutes |
| Prerequisite | UC-11; auto-sleep turned on for the models it may sleep and wake |

## 2. The problem

A large reasoning model gives the best root-cause answers but holds most of an
H100. Leaving it running all day wastes the GPU; stopping it by hand means
nobody remembers to start it when a hard question comes. Users should not have
to pick a model either.

## 3. What it does

1. **Routing.** Picks a model per question: screenshots → vision, code or YAML → coder or large, tool use and "why" questions → large, short questions → small. Users can force one with `@deep`, `@fast`, `@vision`, `@code`.
2. **Auto-sleep.** A model with auto-sleep on is stopped in OpenShift AI after its idle limit (10 minutes to 4 hours). Keep-awake hours and "always on" are respected. Nothing is deleted.
3. **Wake on demand.** When the router wants a sleeping model, it starts it, and a faster model answers meanwhile. In AI Chat a note says so, and the same question is asked again automatically when the big model is up; its answer appears below.
4. **Make room.** Before starting a model, it checks HAMi free memory on each card. If none has room, it puts to sleep the quietest models that allow it, on the card that needs the fewest; otherwise it refuses and says why ("needs 74 GiB on one card, the most free is 64 GiB"). Other teams' workloads are never touched.
5. Every sleep, wake and refusal is in the audit trail.

## 4. Who does what

| Actor | Steps |
|---|---|
| ⚙️ Automatic | Routing rules, idle tracking, sleep, wake, make-room, re-asking the question |
| 🤖 AI | The answers |
| 👤 Human | Turns auto-sleep on per model, sets idle limits and keep-awake hours |

## 5. Business value

| Metric | Without | UC-12 |
|---|---|---|
| GPU held by an idle 120B model | All day | Only while it is used |
| Choosing a model | The user's job | Automatic, overridable |
| Hard question while the big model is off | Weaker answer or nothing | Fast answer now, deeper answer follows |

## 6. Demo script (short)

Turn on auto-sleep for gpt-oss-120b → ask "Why is payments-api restarting? Find the root cause." in AI Chat → llama answers, a note says gpt-oss-120b is waking → its answer appears below when up.

## 7. Implementation map

| Part | Where |
|---|---|
| Routing and wake hooks | `src/services/private-ai/router.js` |
| Auto-sleep, wake, make-room | `src/services/private-ai/autosleep.js` |
| Console | `console/src/components/commandcenter/AutoSleep.jsx`, `console/src/components/DeeperAnswer.jsx` |
| Docs | `deploy/demo/private-ai-ops/README.md` (Auto-sleep; The router wakes the right model) |

## 8. Verification status

| Claim | Status |
|---|---|
| Sleep after idle, keep-awake, always on, started-by-hand detection | ✅ Unit-tested (`private-ai-autosleep.test.js`) |
| Router wakes the wanted model and a stand-in answers | ✅ Unit-tested (`private-ai-wake-route.test.js`) |
| Make-room choice and refusal | ✅ Unit-tested |
| Real wake times on the GPU cluster | 🔶 To be measured live |

## 9. Related

UC-11 (the Factory) · UC-13 (GPU fleet) · UC-15 (Ops Twin checks whether a sleeping model could wake during a change).
