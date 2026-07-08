# Fleet-Wide Image Vulnerability Scanning

Aggregates image-vulnerability findings from the hub **and every connected
spoke cluster** into the single Image Vulnerability Scanner panel — no scanner
operator required on each spoke.

## Design principle — extend, don't change
- **Additive & feature-flagged.** Default OFF → the panel behaves exactly as
  before (single cluster). Nothing in the existing scan path is modified.
- **Reuses existing plumbing.** Fleet mode merges the hub's own scan with the
  per-cluster `image-vulns` snapshots that connected spokes already report to
  the hub agent cache — **no new cross-cluster scan calls**.
- **Reversible.** Set `FLEET_SCAN_ENABLED=false` (or unset) to instantly revert.

## How it works
```
Hub scan (runImageScan)  ─┐
Spoke A cached snapshot  ─┤─►  buildFleetImageVulns()  ─►  one panel
Spoke B cached snapshot  ─┘    - tag each finding by cluster
                               - dedupe by cluster::image
                               - recompute fleet totals + per-cluster summary
```
Each spoke's snapshot arrives through the existing agent bridge / cluster store,
so the hub never scans remote clusters directly.

## Enable it
```bash
oc set env deploy/agentic-ai-agent -n openshift-mcp \
  FLEET_SCAN_ENABLED=true HUB_CLUSTER_NAME=<hub-display-name>
oc rollout status deploy/agentic-ai-agent -n openshift-mcp
```
Open the Image Vulnerability Scanner → a **Fleet Coverage** strip appears with
one chip per cluster (grade, image count, C/H counts, scan source), and every
row in *Top Vulnerable Images* is tagged with its cluster.

## Disable / rollback
```bash
oc set env deploy/agentic-ai-agent -n openshift-mcp FLEET_SCAN_ENABLED-
oc rollout restart deploy/agentic-ai-agent -n openshift-mcp
```

## Response shape (additive fields)
```jsonc
{
  "...": "all existing fields unchanged",
  "fleet": {
    "enabled": true,
    "totalClusters": 3,
    "clusters": [
      { "cluster": "hub", "images": 12, "critical": 0, "high": 15,
        "grade": "F", "scannerType": "trivy-operator" }
    ]
  },
  "topImages": [ { "...": "…", "cluster": "hub" } ]  // + per-row cluster tag
}
```
When `FLEET_SCAN_ENABLED` is off, `fleet` is absent and `topImages` carry no
`cluster` field — identical to the current contract.

## Requirements
- Connected spokes report their `image-vulns` snapshot to the hub (existing
  agent bridge / cluster store).
- For real CVEs per cluster, that cluster needs a live scanner (Trivy Operator
  or Quay/Clair CSO); otherwise its chip shows `Static`.
