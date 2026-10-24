# Private AI Operations Center — runbook

Four live acts on 2× H100 under OpenShift AI, plus a scorecard. Everything is
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
# Run the GPU, MIG and model steps against the GPU cluster (e.g. oc config use-context <gpu-cluster-context>)
oc apply -f models/00-namespace.yaml
oc -n tcs-private-ai create secret generic hf-token --from-literal=HF_TOKEN=<your token>

# Split GPU 1 with MIG (see the comments in models/10-gpu-mig.yaml)
oc apply -f models/10-gpu-mig.yaml
oc patch clusterpolicy gpu-cluster-policy --type merge \
  -p '{"spec":{"mig":{"strategy":"mixed"},"migManager":{"config":{"name":"tcs-mig-config","default":"all-disabled"}}}}'
oc label node <h100-node> nvidia.com/mig.config=tcs-demo --overwrite

# Models (weights download once from Hugging Face into PVCs)
oc apply -k models/
oc -n tcs-private-ai get inferenceservice -w     # wait for READY=True on all four

# Connect the platform to the models. Run with the PLATFORM (hub) cluster as the
# current context; --models-context names the GPU cluster when it is a different one
# (each model is then exposed with a Route the hub can reach).
./enable.sh --models-context <gpu-cluster-context>
```

If the GPU cluster is a different cluster from the platform and is connected
through its agent, give the hub direct API access to it (read cluster-wide,
write only in `tcs-demo-payments`). This also deploys the demo app:

```bash
./connect-gpu-cluster.sh --context <gpu-cluster-context>   # prints API URL, token, CA
```

Then, in the console: **Settings (gear) → Private AI**

1. **GPU cluster**: pick the cluster with the GPUs (e.g. `cluster02-gpu`). If **Cluster access** says
   "connected through its agent", paste the three values from `connect-gpu-cluster.sh` → **Test and save**.
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
- `oc get node <h100-node> -o json | jq .status.allocatable` shows `nvidia.com/mig-3g.40gb`, `mig-2g.20gb`, `mig-1g.10gb`.
- The platform's service account can patch Deployments in `tcs-demo-payments` (inject, reset, rollback) and manage NetworkPolicies in its own namespace.
