# Private AI Operations Center — runbook

Four live acts on NVIDIA H100s under OpenShift AI, plus a scorecard. Everything is
off until an admin turns it on in **Settings → Private AI**; `disable.sh` turns
it off for good.

| Act | What the audience sees | What is real |
|---|---|---|
| 1 · Private by design | Each chat answer tagged with the model and GPU that served it; sensitive prompts forced on-prem; internet cut live | Router in `src/services/private-ai/router.js`, NetworkPolicy `tcs-private-ai-no-internet` |
| 2 · Incident at scale | Bad release → detected → RCA → ticket → rollback proposal → approve → verified, on a clock | `scenario-payments.yaml` + the platform's incident orchestrator |
| 3 · Secure the AI supply chain | Image risk, KEV CVEs, remediation in flight | Latest image scan and remediation records |
| 4 · Modernise at GPU speed | 2,000 VMs assessed in minutes, waves 1–3 | `vm-batch.js` (sample estate is labelled synthetic on screen) |

## One-time setup (before the event)

```bash
cd deploy/demo/private-ai-ops
# Run the model steps against the GPU cluster (e.g. oc config use-context <gpu-cluster-context>)
# Everything goes into the existing openshift-mcp namespace (no new namespace is created)
oc -n openshift-mcp create secret generic hf-token --from-literal=HF_TOKEN=<your token>

# GPUs: nothing to change. gpt-oss-120b gets a GPU node to itself; the three small models
# share another with memory caps. Works with whole GPUs and with GPU time-slicing.
# (models/10-gpu-mig.yaml is only for a cluster with exactly two whole GPUs.)

# Models (weights download once from Hugging Face into PVCs)
oc apply -f models-plain-openshift-mcp.yaml     # plain Deployments: needs only the GPU Operator (+ HAMi)
oc -n openshift-mcp get pods -l tcs.com/demo=private-ai-ops -w   # wait for 1/1 Running on all four
# Or through OpenShift AI (KServe healthy): its own vLLM runtime, models in its dashboard:
#   rhoai/deploy-rhoai.sh --dashboard        (one model at a time: --only llama-3-1-8b)
#   rhoai/models.sh status|stop|start        free the GPUs when not demoing (weights kept)

# Connect the platform to the models. Run with the PLATFORM (hub) cluster as the
# current context; --models-context names the GPU cluster when it is a different one
# (each model is then exposed with a Route the hub can reach).
./enable.sh --models-context <gpu-cluster-context>
# or, with the GPU cluster in its own kubeconfig file:
./enable.sh --models-kubeconfig /path/to/gpu.kubeconfig
```

If the GPU cluster is a different cluster from the platform and is connected
through its agent, give the hub direct API access to it. Two ways:

- **Limited, expiring access (recommended).** A service account that can read the cluster and
  change workloads only in `tcs-demo-payments`, with a token that stops working by itself. Also
  deploys the demo app. Re-run to renew.
  ```bash
  ./connect-gpu-cluster.sh --context <gpu-cluster-context>                  # 72 h (default)
  ./connect-gpu-cluster.sh --context <gpu-cluster-context> --duration 168h  # a week
  ```
- **A kubeconfig.** Paste or upload it (`oc config view --minify --raw`) in Settings → **Test**.
  - A **certificate login** (e.g. the installer's `admin` kubeconfig, `system:admin`) is never
    stored: **Set up limited access** uses it once to do what `connect-gpu-cluster.sh` does
    (demo app, limited service account, expiring token — 24 h to 2 weeks) and keeps only that token.
  - A **token login** (`oc login`) can be saved as is — the hub then acts with that login's rights
    (you must confirm if it is cluster-admin) until it expires (usually 24 h) — or, better, used the
    same way to set up limited access.

Settings and the Command Center header show who the access acts as and when it expires, and warn
from 24 h before; an expired access blocks the checks with the fix. Apply the demo app yourself on
this path: `oc --context <gpu-cluster-context> apply -f scenario-payments.yaml`.

Then, in the console: **Settings (gear) → Private AI**

1. **GPU cluster**: pick the cluster with the GPUs (e.g. `cluster02-gpu`). If **Cluster access** says
   "connected through its agent", choose **Limited access** (paste the three values from
   `connect-gpu-cluster.sh`) or **Use a kubeconfig** → **Test** → **Test and save**.
   This access is used by the Command Center only; the rest of the console reaches the cluster as before.
2. **Prerequisites**: GPU nodes, models, demo app and permissions are checked live, each with the fix when it is missing. **Re-check** after fixing.
3. Switches (admins only, recorded in the Audit trail, saved across restarts):
   - **Command Center**: needs nothing; the workspace button and Ctrl+K appear immediately.
   - **Dashboard banner**: needs the Command Center on.
   - **Route AI Chat to the on-prem models**: unlocks once a reasoning or fast-answer model answers.

Check from the hub that a model Route answers before the event:
`oc -n openshift-mcp exec deploy/agentic-ai-control-plane -- curl -s http://<route-host>/v1/models`

## Rehearse

1. Workspace screen → **Command Center** button (also the dashboard banner and Ctrl+K → "Open Command Center").
2. Act 1: ask AI Chat a normal question, then one with a card number or password — the second shows "sensitive data kept on-prem". Press **Cut the internet**; chat keeps working.
3. Act 2: **Inject fault** → wait for detection (≈2 min) → **Approve fix** → clock stops at "verified". **Reset** afterwards.
4. Act 3: **Open the Vulnerability Center** (works from the dashboard).
5. Act 4: **Assess the 2,000-VM sample estate**.
6. Scorecard; **Start new session** clears the counters for the next audience.

## Turn it off

```bash
# Day to day: Settings → Private AI → Command Center off (also restores internet).
./disable.sh                 # off for good: PRIVATE_AI_OPS=false overrides Settings,
                             # restores internet and the previous AI provider
./disable.sh --remove-demo --models-context <gpu-cluster-context>   # also deletes the demo namespace
oc --context <gpu-cluster-context> delete -k models/   # frees the GPUs
oc --context <gpu-cluster-context> delete -f gpu-cluster-access.yaml   # removes the hub's access
# (and Settings → Private AI → Cluster access → Remove access)
```

## Check on your cluster before the event

- vLLM flags (`--tool-call-parser openai`, `--limit-mm-per-prompt`) against the vLLM image your OpenShift AI version ships, if you swap the image.
- Two GPU nodes (`oc get nodes -L nvidia.com/gpu.count`): gpt-oss-120b needs one to itself. On one GPU node, use gpt-oss-20b instead (edit `20-gpt-oss-120b.yaml`: model `openai/gpt-oss-20b`, `--gpu-memory-utilization 0.30`, drop the `affinity` block).
- Nothing else heavy on the GPU node gpt-oss-120b lands on: with time-slicing, other pods' GPU memory counts against its 80 GB.
- The platform's service account can patch Deployments in `tcs-demo-payments` (inject, reset, rollback) and manage NetworkPolicies in its own namespace.

## Factory floor (Private AI Factory, first tab)

Live view of the GPUs and models, read from what the GPU cluster already reports:

| Panel | Source |
|---|---|
| Headline figures: answers on-prem, saved vs cloud, first-token time, tokens/s, guardrail stops, GPU energy | Router log, each model's `/metrics`, DCGM `DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION` |
| GPU factory floor: each H100, which model owns which slice, utilisation, temperature, power | DCGM + HAMi's `hami.io/vgpu-devices-allocated` pod annotation |
| Model performance, Stop / Start | vLLM / TEI `/metrics`; OpenShift AI `serving.kserve.io/stop` |
| Guardrails | Router: prompt-injection attempts refused before any model; sensitive requests kept on-prem |
| Side by side | The same question to the fast and the reasoning model |
| Evidence pack | Printable session report (Save as PDF) |

Settings (hub, `agentic-ai-control-plane` env): `PRIVATE_AI_CLOUD_PRICE_PER_MTOK` (default 5),
`PRIVATE_AI_GRID_KG_PER_KWH` (default 0.4), `PRIVATE_AI_GUARDRAILS=false` to switch the injection check off.

Stop / Start from the console needs the hub's access to patch InferenceServices in `openshift-mcp`
on the GPU cluster. Re-apply the access manifest once (adds only that Role):

```bash
oc --kubeconfig "$GPU_KC" apply -f deploy/demo/private-ai-ops/gpu-cluster-access.yaml
```

## Several GPU clusters (GPU fleet tab)

Each GPU cluster keeps its own models; the router uses all of them.

1. For every GPU cluster: save its access in Settings → Private AI → Cluster access (or run
   `connect-gpu-cluster.sh`), and apply `gpu-cluster-access.yaml` on it (lets the hub find the
   models, expose each with a Route, and stop / start them).
2. Deploy the models on it with `rhoai/deploy-rhoai.sh`.
3. In the Private AI Factory → **GPU fleet**, press **Discover models** on that cluster's tile.
4. Per cluster: **Answers AI requests** (on/off), **Sensitive data allowed** (data residency),
   and a region label. Fleet-wide: **Selected cluster first** or **Least loaded**.

The header switcher chooses which cluster the Factory floor and the acts show. If the
selected cluster's model is down, the same model on another cluster answers, and AI traffic
and the evidence pack record which cluster answered each request. The models set by
`enable.sh` still work and count as the selected cluster's.

## Model catalogue (Private AI Factory → Models)

The approved models, whether each runs, whether it fits on the GPUs now (HAMi free
memory per card, best fit so whole cards stay free for big models), and **Deploy…**
(Admin, audited). Sources: an **OpenShift AI catalog image** (`oci://registry.redhat.io/…`,
pasted from the OpenShift AI model catalog in the Deploy panel — no download, no token) or
**Hugging Face** (downloaded once into `<model>-cache`, the same steps as `rhoai/deploy-rhoai.sh`).
After deploy the model is connected to the router automatically.

Needs: the serving runtimes (run `rhoai/deploy-rhoai.sh` once), and the GPU-cluster access
re-applied so the hub may create storage, download jobs and model services in openshift-mcp:
`oc --kubeconfig "$GPU_KC" apply -f deploy/demo/private-ai-ops/gpu-cluster-access.yaml`.
The list lives in `src/services/private-ai/catalogue.js`.
