# Ops Twin

Automation Hub → **Ops Twin** rehearses a change on a live copy of a cluster
before anyone touches it. Pick a what-if, and the twin shows what moves where,
what cannot move, what would stop, the actions to take first, and a plan. The
result can be raised as a ServiceNow change request with the report attached.

Nothing is changed on the cluster: the twin only reads.

## What-ifs

| What-if | What the twin does |
|---|---|
| Drain a node | Evicts everything movable, honouring disruption budgets; VMs live-migrate if they can, else restart elsewhere |
| A node fails | Same loss, but sudden: budgets are not honoured and VMs restart, they do not migrate |
| A GPU fails | Moves the models and pods on that card to another card with enough free GPU memory |
| Rack loses power | Loses every node with that rack label at once |
| Add a model | Finds a card with enough free GPU memory (HAMi), or says how much is missing |
| Upgrade cluster | Checks a drain of every worker in turn, against the cluster as it is now |
| Migrate VMs in | Places N VMs of a given size and says whether one node's worth of room is left |

"Ask the twin" takes the same questions in plain words ("what if tcsaiinode1 goes
down?", "rack R2 loses power", "add a model of 40 GiB", "is the upgrade safe?").
In AI Chat, the agent has the same what-ifs as the `twin_simulate` and
`twin_overview` tools, also exposed on the MCP server.

## What it reads

Nodes, pods (requests, owners, tolerations, node selectors and required node
affinity), PodDisruptionBudgets, OpenShift Virtualization VMs and VMIs, KServe
InferenceServices (including stopped ones, for auto-wake), HAMi's per-card
register and allocations, and — when DCGM is scraped — power and temperature
per GPU. The platform's existing read access covers all of these.

## Racks

The twin groups nodes by the first of these labels it finds:
`tcs.io/rack`, `topology.kubernetes.io/rack`, `rack`, `topology.kubernetes.io/zone`
(or the label named in `OPS_TWIN_RACK_LABEL`). To enable "Rack loses power":

```bash
oc label node tcsaiinode1 tcs.io/rack=R2
oc label node tcsaiinode2 tcs.io/rack=R3
```

then press **Refresh twin**.

## Limits

The twin models CPU and memory requests, taints, node selectors, required node
affinity, GPU memory per card and disruption budgets. It does not model pod
affinity or anti-affinity, topology spread, storage zones, quotas, or rack power
feeds (it shows GPU power from DCGM only). Every result says so. Times are
estimates: about 1.5 minutes per pair of live migrations and 8 minutes per node
for an update and reboot.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OPS_TWIN_CACHE_MS` | `30000` | How long a read of the cluster is reused |
| `OPS_TWIN_RACK_LABEL` | — | A node label to use for racks before the defaults |
