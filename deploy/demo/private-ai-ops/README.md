# Private AI Operations Center — runbook

Four live acts on 2× H100 under OpenShift AI, plus a scorecard. Everything is
off unless `PRIVATE_AI_OPS=true`; `disable.sh` turns it off again.

| Act | What the audience sees | What is real |
|---|---|---|
| 1 · Private by design | Each chat answer tagged with the model and GPU that served it; sensitive prompts forced on-prem; internet cut live | Router in `src/services/private-ai/router.js`, NetworkPolicy `tcs-private-ai-no-internet` |
| 2 · Incident at scale | Bad release → detected → RCA → ticket → rollback proposal → approve → verified, on a clock | `scenario-payments.yaml` + the platform's incident orchestrator |
| 3 · Secure the AI supply chain | Image risk, KEV CVEs, remediation in flight | Latest image scan and remediation records |
| 4 · Modernise at GPU speed | 2,000 VMs assessed in minutes, waves 1–3 | `vm-batch.js` (sample estate is labelled synthetic on screen) |

## One-time setup (before the event)

```bash
cd deploy/demo/private-ai-ops
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

./enable.sh            # or ./enable.sh --keep-llm to leave AI Chat's provider alone
```

## Rehearse

1. Workspace screen → **Command Center** button (also the dashboard banner and Ctrl+K → "Open Command Center").
2. Act 1: ask AI Chat a normal question, then one with a card number or password — the second shows "sensitive data kept on-prem". Press **Cut the internet**; chat keeps working.
3. Act 2: **Inject fault** → wait for detection (≈2 min) → **Approve fix** → clock stops at "verified". **Reset** afterwards.
4. Act 3: **Open the Vulnerability Center** (works from the dashboard).
5. Act 4: **Assess the 2,000-VM sample estate**.
6. Scorecard; **Start new session** clears the counters for the next audience.

## Turn it off

```bash
./disable.sh                 # restores internet, previous AI provider; hides every launcher
./disable.sh --remove-demo   # also deletes the tcs-demo-payments namespace
oc delete -k models/         # frees the GPUs
```

## Check on your cluster before the event

- vLLM flags (`--tool-call-parser openai`, `--limit-mm-per-prompt`) against the vLLM image your OpenShift AI version ships, if you swap the image.
- `oc get node <h100-node> -o json | jq .status.allocatable` shows `nvidia.com/mig-3g.40gb`, `mig-2g.20gb`, `mig-1g.10gb`.
- The platform's service account can patch Deployments in `tcs-demo-payments` (inject, reset, rollback) and manage NetworkPolicies in its own namespace.
