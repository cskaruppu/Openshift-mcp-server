# App Deployment Agent — Sample Requirement Documents

Upload any of these documents to the **Automation Hub → App Deployment Agent**.
The agent analyzes the requirement, generates **hardened, standards-aligned**
Kubernetes/OpenShift manifests, and lets you review/edit, dry-run, and deploy
to **any connected cluster**.

## Available samples

| Document | Architecture | Tiers |
|---|---|---|
| `sample-requirement-two-tier-app.md` | **Two-tier** | Web/API + MySQL |
| `sample-requirement-three-tier-app.md` | **Three-tier** | Frontend + Backend API + PostgreSQL |
| `sample-requirement-webapp-postgres.md` | Two-tier | Web app + PostgreSQL |
| `sample-requirement-microservice-redis.md` | Two-tier | API microservice + Redis |

All samples request the same governance baseline: dedicated **restricted**
namespace, default-deny **NetworkPolicy**, least-privilege **RBAC**, Pod
Security **"restricted"** securityContext, **Secret**-sourced credentials,
**PVCs** for stateful tiers, **ServiceMonitor** + probes, and Route (edge TLS)
for web-facing tiers only.

## End-to-end workflow (works on any cluster)

1. **Upload** the document (`.md` / `.pdf` / `.docx` / `.txt`) in the App Deployment Agent.
2. **Generate** — the agent produces the full manifest set as editable YAML.
3. **Review / edit** any value (image tags, replicas, sizes, limits).
4. **Pre-deploy checks** (optional) — CIS Benchmark + image vulnerability scan on the generated code.
5. **Choose a cluster** from the dropdown (hub or any connected spoke).
6. **Dry-run**, then **Deploy** — objects are applied in dependency-safe order.
7. **Verify security** — CIS + image scan on the deployed namespace.

The deploy runs in the selected cluster's context, so the same document
deploys seamlessly to any cluster in the fleet.
