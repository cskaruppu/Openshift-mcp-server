# VM Guard

Vulnerabilities and configuration changes for OpenShift Virtualization VMs,
with nothing installed inside the guests. Shown in the Dashboard (new layout)
→ Explore → **Virtualization**, which appears when the cluster has VMs.

| What | Source | Needs |
|---|---|---|
| Configuration changes (CPU, memory, disks, NICs, Secure Boot, TPM, devices, run strategy) | The VirtualMachine objects, read every 5 minutes | Nothing new |
| Off baseline, waiting for restart | The approved shape per VM; the VM's `RestartRequired` condition | Nothing new |
| Who changed it | The tool that wrote the VM (`managedFields`: OpenShift console, oc/kubectl, GitOps, Ansible) | User names need the cluster audit log, which VM Guard does not read |
| Guest OS, end of life | KubeVirt's guest-agent report in the VMI status, else the OS template label | QEMU guest agent in the VM for the exact version |
| Exposure | LoadBalancer / NodePort Services and Routes that select the VM, bridged NICs | Nothing new |
| Package CVEs | Agentless disk scan with Trivy (below) | `VM_GUARD_SCAN=true`, `rbac.yaml`, storage with CSI snapshots |

## Turning on disk scans

A scan never touches the running VM. VM Guard takes a CSI snapshot of the
root disk, restores it to a temporary claim, runs `trivy vm` on that copy in a
Job in the VM's namespace, reads the JSON report from the job's log, and
deletes the job, the claim and the snapshot.

```bash
# On every cluster to scan (hub and spokes)
oc apply -f deploy/vm-guard/rbac.yaml

# On the platform (hub control plane, and each spoke agent)
oc -n openshift-mcp set env deploy/agentic-ai-control-plane VM_GUARD_SCAN=true
```

Options (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `VM_GUARD_SCAN` | off | `true` turns disk scans on |
| `VM_GUARD_SCANNER_IMAGE` | `docker.io/aquasec/trivy:0.57.1` | Scanner image; mirror it for disconnected clusters |
| `VM_GUARD_TRIVY_DB_REPO` | Trivy's default | Vulnerability database mirror (`TRIVY_DB_REPOSITORY`) for disconnected clusters |
| `VM_GUARD_SNAPSHOT_CLASS` | the default class | `VolumeSnapshotClass` to use |
| `VM_GUARD_SCAN_PARALLEL` | 2 | Scans running at the same time per cluster |
| `VM_GUARD_SCAN_TIMEOUT_MIN` | 45 | A scan that takes longer is marked failed and cleaned up |
| `VM_GUARD_SCANNER_SA` | the namespace default | Service account for the scan pod |

Limits:

- Linux guests (RHEL, CentOS, Rocky, Alma, Fedora, Ubuntu, Debian, SUSE) on ext4 or XFS. Windows guests get OS, end of life and configuration tracking, but no package CVEs.
- Encrypted disks (LUKS) cannot be read from outside; their scan fails with Trivy's message.
- Block-mode disks are read as a raw device. If the restricted SCC does not allow it on your storage, run the scan pod with a service account that may (`VM_GUARD_SCANNER_SA`).
- Container-disk VMs have no claim to snapshot; scan their image with the image scanner instead.

## Actions (Admin)

In the VM Guard window, per VM: **Scan disk now**, **Snapshot before patching**
(a `VirtualMachineSnapshot`), **Approve current as baseline**. Every action is
recorded in the audit trail.
