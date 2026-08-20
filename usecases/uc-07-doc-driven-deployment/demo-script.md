# TCS Agentic AI — App Deployment Agent (UC-07)
## Complete demo script · 5 minutes

**TCS Agentic AI for Hybrid Infrastructure → Container & Kubernetes Operations → App Deployment Agent (UC-07)**

The single script for the recorded end-to-end demo: a versioned requirement document
becomes a verified, governed e-commerce application, on camera, with the proof being a
placed order.

| | |
|---|---|
| **Runtime** | **4 minutes 47 seconds** — 639 spoken words at a measured 135 wpm |
| **Structure** | Take 1 · document → dry-run (2:29) → Take 2 · deploy → placed order (1:39) → Take 3 · the honest failure + close (0:39) |
| **Read** | the **SAY** column aloud · the **SHOW** column is what is on screen |
| **Companion** | `narration-only.txt` — the same words in TTS/teleprompter blocks |

> Timings are cumulative at an unhurried 135 words per minute. Aim slightly **under** each
> marker — adding a pause in the edit is easy, cutting words out of a recording is not.

---

## Before you record

The single biggest risk on camera is **image pull time**. Twelve images from Google's
registry take 3–6 minutes on first pull — dead air that kills a demo. Warm everything first.

| # | Do this | Why |
|---|---|---|
| 1 | **30–40 min before:** run the entire flow once — Load from Git → Generate → Deploy → wait for the green pyramid. Then **Rollback** from the deployment record | The 12 images stay cached on the nodes. The on-camera deploy reaches Ready in ~60–90 seconds instead of five minutes |
| 2 | Confirm the rollback finished: `oc get ns demo-boutique` should be gone (or empty) | Deploying over leftovers shows "configured" instead of "created" — a different, weaker story |
| 3 | Tab 1: **GitHub**, open on `docs/sample-requirements/04-ecommerce-online-boutique.md` (rendered view, scrolled to the tier tables) | Take 1 opens here — the audience must see tables, not YAML |
| 4 | Tab 2: **the dashboard**, Automation Hub → App Deployment Agent, target cluster pre-selected | No navigation fumbling on camera |
| 5 | Tab 3 (optional): **ServiceNow**, change list filtered to today | One 5-second cutaway at 2:50; skip the cutaway if ServiceNow is slow |
| 6 | Copy the GitHub URL of the document to the clipboard | The paste at 1:12 must be one gesture |
| 7 | Pre-fill nothing else — the empty textarea IS the story | The audience watches the document arrive from Git |
| 8 | Browser zoom **110–125 %** · close Slack, Teams, notifications | Text must survive video compression |
| 9 | For Take 3: have `03-negative-broken-image.md` ready to load | The honest-failure encore is pre-staged, not improvised |

**If the pyramid shows anything red on camera:** do not stop. Read the failing level aloud —
"and this is exactly what this screen is for" — and either fix live or cut. A red level
explained confidently is a stronger demo than a green one narrated nervously.

**Record in three takes**, joined with hard cuts (no transition effects):
Take 1 = 0:00 → 2:29 · Take 2 = 2:29 → 4:08 · Take 3 = 4:08 → 4:47.

---

# Take 1 · The document becomes manifests

### 0:00 – 0:18 · The portfolio

**SHOW:** Title slide — *TCS Agentic AI for Hybrid Infrastructure* (or the portfolio view).

> **SAY:**
> "TCS Agentic AI for Hybrid Infrastructure is a comprehensive agentic solution across
> infrastructure services — compute, platform, storage, network and service management.
>
> Within that portfolio, this is the App Deployment Agent. Use case zero seven —
> document-driven application deployment."

---

### 0:18 – 0:46 · What it replaces

**SHOW:** UC-07 deck, slide 2 (the problem), or stay on the title.

> **SAY:**
> "Today, turning a requirement into a running application takes days. Someone reads the
> document, writes about two thousand lines of YAML by hand, gets it reviewed, deploys it —
> and hopes.
>
> And when the pods go green, nobody actually proves the application works. The first real
> test is a user hitting a broken page.
>
> The App Deployment Agent removes every step except the decisions."

---

### 0:46 – 1:12 · The document, in Git

**SHOW:** Tab 1 — the boutique document on GitHub. Scroll slowly through one tier table and
the network matrix while speaking.

> **SAY:**
> "This is the deployment. Not YAML — a requirement document. Application overview, tiers,
> environment variables, health probes, and a network connectivity matrix. The tables are
> the contract; the prose is documentation.
>
> It lives in Git. It is reviewed like code and versioned like code. And the same document
> works as Markdown or as a Word file."

---

### 1:12 – 1:47 · Load from Git → Generate

**SHOW:** Tab 2. Paste the URL into **Load from Git** → the textarea fills. Click
**Generate Manifests** → the summary line appears: *Deterministic build … 12 tiers → 64 manifests*.

> **SAY:**
> "I paste the GitHub link, and the platform pulls the document straight from version control.
>
> Now — generate. Twelve tiers become sixty-four manifests in about a second. Deterministic:
> no AI paraphrase, no token limits. The same commit produces the same YAML, every time.
> That is an audit property no generative step can offer.
>
> If I had pasted free prose instead, the AI lane takes over, and the model architects the
> manifests under the same security contract."

---

### 1:47 – 2:11 · Review and shift-left checks

**SHOW:** Scroll the editable YAML briefly. Click **CIS Benchmark check**, then
**Image vulnerability scan**; let both result cards render.

> **SAY:**
> "Everything is reviewable and editable before anything touches a cluster. What I edit here
> is what gets deployed.
>
> Two shift-left checks run on the generated code itself: a CIS benchmark check, and an
> image vulnerability scan. Security is not a review meeting after the fact — it is
> generated in, then verified."

---

### 2:11 – 2:29 · Dry-run

**SHOW:** Click **Dry-run**. The result renders: 64 ok, with per-object chips.

> **SAY:**
> "Dry-run. The API server validates all sixty-four objects through full admission —
> quotas, schemas, policies — and creates nothing. The result names every object it
> checked. First-time deploys validate cleanly because the platform prepares the
> namespace first."

**[HARD CUT — end of Take 1]**

---

# Take 2 · Deploy, prove, purchase

### 2:29 – 2:57 · Deploy and governance

**SHOW:** Click **Deploy**. The result chips render (created ×64) with the record id and the
change number. Optional 5-second cutaway to Tab 3 showing the CR.

> **SAY:**
> "Deploy. Server-side apply, in dependency order. Every object reports what happened to
> it — created, configured, or unchanged — the way kubectl apply would say it.
>
> And governance is automatic: a durable deployment record, and a ServiceNow change request
> raised with the implementation plan, the backout plan, and a citation of the exact
> document version that produced this deploy."

---

### 2:57 – 3:40 · The pod watch and the pyramid

**SHOW:** The live pod table streams. When all pods are Ready, the **Production
verification** panel runs itself — four level cards turning green. Point at each as you name it.

> **SAY:**
> "The pod watch streams live while twelve services come up.
>
> And the moment they are ready, the platform does something most pipelines never do. It
> proves the application works. Four levels, each stronger than the last.
>
> Rollout complete — this generation, not leftovers of the old one. Workloads stable —
> nothing crash-looping. Services wired — every service has real endpoints behind it; this
> is the check that catches the label mismatch behind most 'route says 503' incidents. And
> finally: the platform itself browses to the route, from outside, and reads the response."

---

### 3:40 – 4:08 · Open the application, place an order

**SHOW:** Click **Open application ↗**. The storefront renders. Add an item to the cart,
place the order, land on the confirmation page with the tracking ID.

> **SAY:**
> "All four levels green. One click — and this is the acceptance test: a working shop.
>
> I will place an order. That single click crosses nine microservices and a Redis cart, and
> every hop crosses a network policy the document declared. Synthetic shoppers have been
> browsing since the moment it came up.
>
> Review, deploy, and this click. Those are the only manual steps."

**[HARD CUT — end of Take 2]**

---

# Take 3 · The honest failure, and the close

### 4:08 – 4:47 · Red is possible · closing line

**SHOW:** Load `03-negative-broken-image.md` → Generate → Deploy. The pyramid stops red at
level 1 with *"0/1 new replicas rolled out"*. Hold on the red card for two beats, then cut
to the closing slide.

> **SAY:**
> "One more thing — because green only means something if red is possible. This sample
> document is deliberately broken; the image tag does not exist. The pyramid fails,
> honestly, at level one, and no URL is ever offered. When a level goes red in production,
> the RCA agent picks up the evidence from there.
>
> The requirement document is the deployment. Versioned in Git. Deterministic on the wire.
> Verified until a human can click the URL.
>
> Generation may be creative — verification never is."

---

## The 2-minute cut

For a slot that only allows two minutes, keep, in order: **1:12–1:47** (Load from Git →
Generate) · **2:29–2:57** (Deploy + governance) · **3:20–3:40** (pyramid finishing, spoken
over the last two levels only) · **3:40–4:08** (the purchase). Open cold on the GitHub tab
with one sentence: *"This document is about to become a verified e-commerce platform —
watch."*
