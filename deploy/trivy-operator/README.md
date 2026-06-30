# Enable Live CVE Scanning (Trivy Operator)

By default the **Image Vulnerability Scanner** widget runs in **Static Analysis**
mode (image-hygiene heuristics — CIS 5.5.1/5.5.2, registry trust). Installing the
**Trivy Operator** turns it into a **dynamic, real-CVE scanner** — the badge flips
to a green **"Live CVE · Trivy"** and the list fills with real `CVE-xxxx-xxxx`
findings (package, installed → fixed version, CVSS, advisory link).

Trivy Operator is **vendor-neutral** — the same steps work on **OpenShift, EKS,
AKS, and GKE**. It scans workloads continuously and refreshes its vulnerability
database (~every 6h) from NVD + GitHub Security Advisories + OS vendor feeds + OSV.

No application change is needed — the dashboard auto-detects the operator's
`VulnerabilityReport` CRDs and switches modes on the next scan.

---

## Two steps

### Step 1 — Install the Trivy Operator (pick one)

**A) OpenShift OperatorHub (recommended, GUI)**
1. Console → **Operators → OperatorHub**
2. Search **"Trivy"** → **Trivy Operator** → **Install**
3. Namespace **`trivy-system`** (create it), watch scope **All namespaces**
4. Wait for status **Succeeded**

**B) Helm (any K8s — OpenShift/EKS/AKS/GKE)**
```bash
helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm repo update
helm install trivy-operator aqua/trivy-operator \
  --namespace trivy-system --create-namespace \
  --set="trivy.ignoreUnfixed=false" \
  --set="operator.scannerReportTTL=24h"
```

**C) Static manifest (pure CLI, pin the version)**
```bash
oc apply -f https://raw.githubusercontent.com/aquasecurity/trivy-operator/v0.24.1/deploy/static/trivy-operator.yaml
```
> Check the latest release at https://github.com/aquasecurity/trivy-operator/releases and pin to it.

**OpenShift SCC note:** if scan jobs fail to start, allow the operator's SA:
```bash
oc adm policy add-scc-to-user nonroot -z trivy-operator -n trivy-system
```

### Step 2 — Grant the dashboard read access to the reports
```bash
oc apply -k deploy/trivy-operator/
```
This applies a ClusterRole + binding so the server's service account
(`agentic-ai-server` in `openshift-mcp` by default) can read
`vulnerabilityreports`. **Edit `rbac.yaml`** if your server uses a different
service account or namespace.

---

## Verify

```bash
# Trivy is scanning workloads:
oc get vulnerabilityreports -A

# The server can read them (impersonating its SA):
oc auth can-i list vulnerabilityreports.aquasecurity.github.io \
  --as=system:serviceaccount:openshift-mcp:agentic-ai-server -A
```

Once reports exist, click **Scan** in the widget (or wait for auto-refresh).
The badge turns green **"Live CVE · Trivy"** and real CVEs appear. The severity
filters, **🪄 AI Fix**, and **Dry Run / Apply & Raise CR** flow all work on the
live data unchanged.

---

## How the dashboard chooses a scanner

`detectScannerType()` (src/tools/image-vulnerability-scanner.js) prefers, in order:

1. **Trivy Operator** — `aquasecurity.github.io/v1alpha1/vulnerabilityreports`
2. **Quay CSO / Clair** — `secscan.quay.redhat.com/v1alpha1/imagemanifestvulns`
3. **OpenShift Image API**
4. **Static Analysis** (heuristic fallback)

If Trivy is installed but hasn't produced reports yet, the dashboard falls back to
static so the widget is never blank, and the badge reflects the active source.

---

## Cloud notes

| Platform | Works? | Notes |
|---|---|---|
| OpenShift | ✅ | OperatorHub is easiest; apply the SCC note if scan jobs fail |
| EKS / AKS / GKE | ✅ | Use Helm (Step 1B). No SCC needed |

## References
- Trivy Operator: https://aquasecurity.github.io/trivy-operator/
- VulnerabilityReport CRD: https://aquasecurity.github.io/trivy-operator/latest/docs/crds/vulnerability-report/
- CIS Kubernetes Benchmark 5.5 (image provenance), NIST SP 800-190, CVSS v3.1, CISA KEV, EPSS
