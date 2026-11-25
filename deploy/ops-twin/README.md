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
| Migrate VMs in | Places N VMs of a given size; if they do not fit, how many nodes to add (and one more as a spare) and how many such VMs fit per node |
| Site or zone fails | Loses every node of a site or zone at once (`tcs.io/site`, `topology.kubernetes.io/zone` or `topology.kubernetes.io/region`) |
| Peak load | Adds replicas of every Deployment and StatefulSet in the chosen namespaces (×1.1 to ×10): what fits, what does not, quotas that stop it, nodes needed |
| Maintenance window | Upgrade check, then fits the node-by-node drains into N hours: clean nodes first, blocked ones listed, and how many windows are needed |
| Retire nodes | Drains the chosen nodes together and says what it saves in energy (and money, when costs are set) |
| Security blast radius | For a node or a service account: the pods, service-account tokens and secrets reachable, roles those accounts hold, privileged pods, and isolation steps. Read-only |
| DR failover | Can another cluster run everything from this one (outside OpenShift's own namespaces)? Worked out on the hub from both clusters' twins |

**Critical apps.** Most what-ifs take a list of namespaces (`payments`, `ehr-*`)
whose apps must not stop: a single replica there becomes a blocking finding,
not a brief restart.

## Risk score

Every result carries a risk score from 0 to 100 (Low below 34, Medium below 67,
High above), with the reasons that made it: the verdict, findings that stop the
change or need action, items with nowhere to run, downtime, duration, critical
apps moved, and whether the cluster is production (`OPS_TWIN_PROD_PATTERN`,
default `prod`). It is deterministic and goes into the ServiceNow change as its
risk.

**Guardrail.** A change the twin says would stop something, or that scores
High, is not raised in ServiceNow. An Admin can override it with a reason,
which goes into the change and the audit trail. `OPS_TWIN_GUARDRAIL=false`
turns this off.

**Evidence pack.** A text file for auditors: the risk score and its reasons,
the full report, and how the twin works.

## Trust in the twin

- **Resilience (N+1)** — the twin fails each worker in turn and gives the share
  that would not cause an outage, with the nodes that would. Checked every 6
  hours (`OPS_TWIN_TICK_MS`) and on **Check N+1 now**; a daily trend is kept and
  a drop is sent to the notification channels.
- **Placement accuracy** — every drain simulation is kept as a prediction.
  Once that node has really been drained, the twin checks where each workload
  actually landed and counts it right when it is on the node it named. The
  share over all real drains is shown. Kubernetes may legitimately pick another
  node that fits; that still counts as a miss, so the number is conservative.

## Industry scenarios

Ready-made what-ifs for customer conversations, each a preset of the above on
the live cluster:

| Sector | Scenario |
|---|---|
| Retail | Festive sale at ×3 traffic |
| Banking | Month-end batch at ×2; DR failover drill |
| Manufacturing | Patch every node inside a 4-hour line maintenance window |
| Healthcare | Zero-downtime patching, with clinical namespaces (`ehr`, `pacs`, `lab`…) marked critical |
| Telecom | Fleet upgrade plan: the upgrade check on every cluster, dev first, production last |
| Private AI | Add a 70B model (about 140 GiB); a GPU fails |
| VMware exit | Bring 300 VMs of 4 vCPU and 16 GiB: nodes needed |
| Security | A compromised node |
| Data centre | Site or zone outage |
| Sustainability | Retire a node: energy and cost saved |

"Ask the twin" takes the same questions in plain words ("what if tcsaiinode1 goes
down?", "rack R2 loses power", "add a model of 40 GiB", "is the upgrade safe?",
"can payments take 3x traffic?", "patch everything in a 4 hour window",
"what if worker-04 is compromised?").
In AI Chat, the agent has the same what-ifs as the `twin_simulate` and
`twin_overview` tools, also exposed on the MCP server.

## What it reads

Nodes, pods (requests, owners, tolerations, node selectors and required node
affinity), PodDisruptionBudgets, OpenShift Virtualization VMs and VMIs, KServe
InferenceServices (including stopped ones, for auto-wake), HAMi's per-card
register and allocations, and — when DCGM is scraped — power and temperature
per GPU. Also PersistentVolumeClaims and PersistentVolumes (volumes that attach
only to some nodes), ResourceQuotas, and role bindings of service accounts (for
the blast radius). The platform's existing read access covers all of these.

**Real usage.** When Prometheus answers, the twin reads the 95th percentile of
CPU and memory over 7 days for the 200 busiest pods and warns when a node that
receives work would run above 85% by real use, even if requests fit.
`OPS_TWIN_USAGE=false` turns this off.

**DR checks** need the spoke agent on both clusters (the hub reads each
cluster's twin from `/api/ops-twin/export`, which carries no secrets).

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
affinity, required pod anti-affinity, topology spread (DoNotSchedule), volumes
that attach only to some nodes, namespace quotas for new pods, GPU memory per
card and disruption budgets. It does not model preferred (soft) rules, network
or storage throughput, NetworkPolicies (for the blast radius), data replication
between sites, or rack power feeds (it shows GPU power from DCGM only). Every
result says so. Times are
estimates: about 1.5 minutes per pair of live migrations and 8 minutes per node
for an update and reboot.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OPS_TWIN_CACHE_MS` | `30000` | How long a read of the cluster is reused |
| `OPS_TWIN_RACK_LABEL` | — | A node label to use for racks before the defaults |
| `OPS_TWIN_SITE_LABEL` | — | A node label to use for sites before the defaults |
| `OPS_TWIN_PROD_PATTERN` | `prod` | Cluster names that count as production in the risk score |
| `OPS_TWIN_GUARDRAIL` | `true` | Block High-risk or blocking changes from ServiceNow unless an Admin overrides |
| `OPS_TWIN_CRITICAL_NAMESPACES` | — | Critical apps for the periodic N+1 check |
| `OPS_TWIN_TICK_MS` | `21600000` | How often N+1 and accuracy are checked (6 h) |
| `OPS_TWIN_USAGE` | `true` | Read real usage from Prometheus |
| `OPS_TWIN_NODE_WATTS` | `350` | Power per node, for retire savings (GPUs measured come on top) |
| `OPS_TWIN_NODE_COST_MONTH`, `OPS_TWIN_KWH_PRICE`, `OPS_TWIN_CURRENCY` | — | Money saved by retiring nodes |
| `OPS_TWIN_STATE_DIR` | `/data` | Where accuracy and resilience records go without a database |
