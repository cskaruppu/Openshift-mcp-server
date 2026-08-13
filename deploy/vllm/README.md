# Self-hosted LLM on your own GPUs

Serve an open-weight model on the cluster and point the platform at it. **No application code
changes are required** — the `openai` provider already builds its URL from `LLM_API_URL` and
supports tool calling and streaming, and vLLM speaks the OpenAI API.

```
LLM_PROVIDER=openai
LLM_API_URL=https://vllm-llm-serving.apps.<cluster-domain>
LLM_MODEL=<the model id you served>
LLM_API_KEY=<the token in the vllm-api-key secret>
```

---

## What this is, and is not

| | |
|---|---|
| **Serving** an open-weight model | what these manifests do — days of work |
| **Fine-tuning** one on your own incident history | the real differentiator, and a later step |
| **Training a foundation model from scratch** | thousands of GPUs and months. Not viable, and not where the value is |

Your advantage was never going to be a base model. It is the corpus of RCAs, remediation decisions
and verified outcomes that UC-05 is generating — data nobody else has.

---

## Sizing against your hardware

Two nodes × 2 × H100 NVL 94 GB = **376 GB** total.

| Model size | Precision | Weights | Fits |
|---|---|---|---|
| ~70B | BF16 | ~140 GB | tensor-parallel across **2 GPUs on one node** |
| ~70B | FP8 | ~70 GB | **a single H100** |
| ~120B MoE | FP8 | ~120 GB | 2 GPUs on one node |

**That means you can run two models at once** — a large one for RCA narrative on one node, a small
fast one for extraction and classification on the other. Which maps exactly onto how this product
uses the LLM: a few hard calls, and a great many easy high-volume ones.

Leave headroom. KV cache grows with context length and concurrency; `--gpu-memory-utilization 0.90`
is a sensible ceiling, not a target to exceed.

---

## Deploy

```bash
# 1. namespace + storage for the model cache (models are tens of GB — do not
#    re-download them on every pod restart)
oc apply -f 01-namespace.yaml
oc apply -f 02-model-cache-pvc.yaml

# 2. credentials: a Hugging Face token for gated models, and the bearer token
#    the platform will present to vLLM
oc -n llm-serving create secret generic hf-token --from-literal=token='hf_...'
oc -n llm-serving create secret generic vllm-api-key --from-literal=key="$(openssl rand -hex 32)"

# 3. serve
oc apply -f 03-vllm-deployment.yaml
oc apply -f 04-service-route.yaml

# first start downloads the weights — watch it
oc -n llm-serving logs -f deploy/vllm
```

Edit `MODEL_ID` and `TENSOR_PARALLEL_SIZE` in `03-vllm-deployment.yaml` before applying.

---

## Verify before wiring it in

```bash
ROUTE=$(oc -n llm-serving get route vllm -o jsonpath='{.spec.host}')
KEY=$(oc -n llm-serving get secret vllm-api-key -o jsonpath='{.data.key}' | base64 -d)

curl -sk -H "Authorization: Bearer $KEY" "https://$ROUTE/v1/models" | python3 -m json.tool
```

Then **measure it on this product's actual tasks** rather than trusting a leaderboard:

```bash
node test/evals/model-bench.mjs \
  --endpoint "https://$ROUTE" --model <model-id> --key "$KEY" --verbose
```

The bench scores extraction faithfulness, strict JSON, tool selection, remediation judgement and
prompt-injection resistance — the five things that actually break this product. A model that writes
beautifully but invents a namespace is unusable here, and a generic benchmark will not tell you that.

Compare candidates side by side, including a hosted one as the control:

```bash
node test/evals/model-bench.mjs \
  --endpoint "https://$ROUTE"           --model llama-3.3-70b-instruct --key "$KEY" \
  --endpoint https://openrouter.ai/api  --model qwen/qwen-2.5-72b-instruct --key "$OPENROUTER_KEY"
```

---

## Choosing a model

Check current options on Hugging Face — this moves faster than any document. What matters for
**this** workload, in order:

1. **Faithful structured extraction** — never inventing a name or namespace
2. **Strict JSON** with no prose wrapper (`classifyJSON` parses it)
3. **Reliable tool calling** — the agentic loop depends on it
4. **Long context** — logs, events and manifests add up quickly
5. Prose quality — genuinely last. RCA narrative is the easiest thing you ask of it

Filter Hugging Face for text-generation instruct models with tool-calling support, and prefer ones
with a permissive licence you can actually ship to a client.

---

## OpenRouter's role

Not the primary. It is genuinely useful for three things:

- **Comparing many models cheaply** before committing GPU time to one
- **Burst and fallback** when the local server is down, restarting, or saturated
- **Frontier access** for the hardest calls, if you route by task

It is an OpenAI-compatible endpoint, so it needs no code either — the same `openai` provider with a
different `LLM_API_URL`.

---

## Route by task, do not replace wholesale

The honest position: a self-hosted 70B will be weaker than a frontier model at the hardest agentic
reasoning. But most of what this product asks is not hard:

| Task | Suggested | Why |
|---|---|---|
| VM intent extraction (UC-06) | **local** | Easy, high-volume, and SSH keys never leave the estate |
| Severity / category classification | **local** | Easy, constant, cheap |
| RCA narrative | **measure it** | Often fine locally; the bench will tell you |
| Agentic tool loop | frontier, initially | The hardest call, and the one worth paying for |

The product already selects a provider per request, so this is configuration rather than a rewrite.

---

## The reason to do this at all

It is not token cost. For clients in regulated sectors, **cluster logs, manifests and configuration
never leaving the estate** is frequently the deciding factor. That is the argument worth leading
with — and it is one a hosted API cannot answer at any price.
