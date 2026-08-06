import { z } from "zod";
import { ocpGet, ocpPost, ocpFetch } from "../utils/openshift-client.js";

const KUBEVIRT_API = "apis/kubevirt.io/v1";

/**
 * Detect whether a KubeVirt API error is a "not installed" 404 and return a
 * friendly message instead of a raw stack trace.
 */
function isKubeVirtNotInstalled(err) {
  const msg = err?.message || "";
  return (
    msg.includes("404") &&
    (msg.includes("kubevirt.io") || msg.includes("the server could not find"))
  );
}

function notInstalledResponse() {
  return {
    content: [
      {
        type: "text",
        text: "KubeVirt does not appear to be installed on this cluster. Install the KubeVirt operator and try again.",
      },
    ],
    isError: true,
  };
}

function errorResponse(err) {
  if (isKubeVirtNotInstalled(err)) return notInstalledResponse();
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    isError: true,
  };
}

export function registerKubeVirtTools(server) {
  // ---------- List Virtual Machines ----------
  server.tool(
    "kubevirt_list_vms",
    "List KubeVirt virtual machines in a namespace (or all namespaces)",
    {
      namespace: z
        .string()
        .optional()
        .describe("Namespace to list VMs from (omit for all namespaces)"),
      allNamespaces: z
        .boolean()
        .optional()
        .default(false)
        .describe("List VMs across all namespaces"),
    },
    async ({ namespace, allNamespaces }) => {
      try {
        const path =
          namespace && !allNamespaces
            ? `/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines`
            : `/${KUBEVIRT_API}/virtualmachines`;

        const data = await ocpGet(path);
        const vms = (data.items || []).map((vm) => ({
          name: vm.metadata.name,
          namespace: vm.metadata.namespace,
          running: vm.spec?.running ?? vm.spec?.runStrategy ?? "unknown",
          created: vm.metadata.creationTimestamp,
          conditions: (vm.status?.conditions || []).map((c) => ({
            type: c.type,
            status: c.status,
          })),
          ready: vm.status?.ready,
          printableStatus: vm.status?.printableStatus,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(vms, null, 2) }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ---------- Get VM Details ----------
  server.tool(
    "kubevirt_get_vm",
    "Get detailed information about a specific KubeVirt virtual machine",
    {
      name: z.string().describe("Name of the virtual machine"),
      namespace: z.string().describe("Namespace of the virtual machine"),
    },
    async ({ name, namespace }) => {
      try {
        const vm = await ocpGet(
          `/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines/${name}`
        );

        const detail = {
          name: vm.metadata.name,
          namespace: vm.metadata.namespace,
          uid: vm.metadata.uid,
          created: vm.metadata.creationTimestamp,
          labels: vm.metadata.labels,
          running: vm.spec?.running ?? vm.spec?.runStrategy ?? "unknown",
          template: {
            cpu: vm.spec?.template?.spec?.domain?.cpu,
            memory: vm.spec?.template?.spec?.domain?.resources?.requests?.memory,
            disks: (vm.spec?.template?.spec?.domain?.devices?.disks || []).map(
              (d) => ({ name: d.name, bus: d.disk?.bus })
            ),
            interfaces: (
              vm.spec?.template?.spec?.domain?.devices?.interfaces || []
            ).map((i) => ({ name: i.name, model: i.model, type: Object.keys(i).find((k) => k !== "name" && k !== "model") })),
          },
          volumes: (vm.spec?.template?.spec?.volumes || []).map((v) => ({
            name: v.name,
            type: Object.keys(v).find((k) => k !== "name"),
          })),
          status: vm.status,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ---------- Start VM ----------
  server.tool(
    "kubevirt_start_vm",
    "Start a KubeVirt virtual machine by creating a VirtualMachineInstance",
    {
      name: z.string().describe("Name of the virtual machine to start"),
      namespace: z.string().describe("Namespace of the virtual machine"),
    },
    async ({ name, namespace }) => {
      try {
        await ocpFetch(
          `/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines/${name}/start`,
          { method: "PUT", body: JSON.stringify({}) }
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "vm_started",
                  name,
                  namespace,
                  message: `Virtual machine ${name} in namespace ${namespace} is starting.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ---------- Stop VM ----------
  server.tool(
    "kubevirt_stop_vm",
    "Stop a running KubeVirt virtual machine",
    {
      name: z.string().describe("Name of the virtual machine to stop"),
      namespace: z.string().describe("Namespace of the virtual machine"),
    },
    async ({ name, namespace }) => {
      try {
        await ocpFetch(
          `/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines/${name}/stop`,
          { method: "PUT", body: JSON.stringify({}) }
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "vm_stopped",
                  name,
                  namespace,
                  message: `Virtual machine ${name} in namespace ${namespace} is stopping.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ---------- Restart VM ----------
  server.tool(
    "kubevirt_restart_vm",
    "Restart a running KubeVirt virtual machine",
    {
      name: z.string().describe("Name of the virtual machine to restart"),
      namespace: z.string().describe("Namespace of the virtual machine"),
    },
    async ({ name, namespace }) => {
      try {
        await ocpFetch(
          `/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines/${name}/restart`,
          { method: "PUT", body: JSON.stringify({}) }
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "vm_restarted",
                  name,
                  namespace,
                  message: `Virtual machine ${name} in namespace ${namespace} is restarting.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ---------- List VM Instances ----------
  server.tool(
    "kubevirt_list_vmis",
    "List running KubeVirt VirtualMachineInstances (VMIs) in a namespace or cluster-wide",
    {
      namespace: z
        .string()
        .optional()
        .describe(
          "Namespace to list VMIs from (omit for all namespaces)"
        ),
    },
    async ({ namespace }) => {
      try {
        const path = namespace
          ? `/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachineinstances`
          : `/${KUBEVIRT_API}/virtualmachineinstances`;

        const data = await ocpGet(path);
        const vmis = (data.items || []).map((vmi) => ({
          name: vmi.metadata.name,
          namespace: vmi.metadata.namespace,
          phase: vmi.status?.phase,
          nodeName: vmi.status?.nodeName,
          ipAddresses: (vmi.status?.interfaces || []).map((i) => ({
            name: i.name,
            ip: i.ipAddress,
          })),
          created: vmi.metadata.creationTimestamp,
          guestOS: vmi.status?.guestOSInfo,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(vmis, null, 2) }],
        };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ---------- Create VM ----------
  server.tool(
    "kubevirt_create_vm",
    "Provision an OpenShift Virtualization (KubeVirt) virtual machine with a PERSISTENT root disk and cloud-init access. Supports dry-run. Prefer a golden image (sourceDataSource) plus an instanceType/preference over raw cpu/memory.",
    {
      name: z.string().describe("Name for the new virtual machine"),
      namespace: z.string().describe("Namespace to create the VM in"),

      // ----- Sizing: golden template first, explicit values as a fallback -----
      instanceType: z.string().optional()
        .describe("VirtualMachineClusterInstancetype, e.g. u1.medium. The KubeVirt-native way to express a golden size. Takes precedence over cpuCores/memoryMi."),
      preference: z.string().optional()
        .describe("VirtualMachineClusterPreference, e.g. rhel.9 or windows.11. Sets guest-appropriate devices, bus types and features."),
      cpuCores: z.number().optional().default(2).describe("vCPU cores (ignored when instanceType is set)"),
      memoryMi: z.number().optional().default(4096).describe("Memory in MiB (ignored when instanceType is set)"),

      // ----- Root disk: persistent by default -----
      sourceDataSource: z.string().optional()
        .describe("Golden image DataSource to clone, e.g. rhel9. This is the recommended source — it yields a persistent, PVC-backed root disk."),
      sourceDataSourceNamespace: z.string().optional().default("openshift-virtualization-os-images")
        .describe("Namespace holding the DataSource"),
      sourceRegistryUrl: z.string().optional()
        .describe("Alternative source: container disk image to IMPORT into a PVC, e.g. docker://quay.io/containerdisks/fedora:latest. Still persistent, unlike a containerDisk volume."),
      sourceHttpUrl: z.string().optional()
        .describe("Alternative source: HTTP(S) URL of a qcow2/raw image to import"),
      diskSizeGi: z.number().optional().default(30).describe("Root disk size in GiB"),
      storageClass: z.string().optional().describe("Storage class for the root disk (empty = cluster default)"),

      // ----- Access -----
      sshKey: z.string().optional()
        .describe("SSH public key injected via cloud-init. Without this (or a password) nobody can log in to the VM."),
      username: z.string().optional().default("cloud-user").describe("Cloud-init user to create"),
      hostname: z.string().optional().describe("Guest hostname (defaults to the VM name)"),
      cloudInitUserData: z.string().optional()
        .describe("Raw cloud-init #cloud-config to use verbatim instead of the generated one"),

      // ----- Networking -----
      networkAttachmentDefinition: z.string().optional()
        .describe("NetworkAttachmentDefinition name for bridge/VLAN attachment, e.g. vlan300 or my-ns/vlan300. Omit for pod networking."),

      // ----- Lifecycle -----
      runStrategy: z.enum(["Always", "Halted", "RerunOnFailure", "Manual"]).optional().default("Always")
        .describe("Always = start it now and keep it running. Halted = create stopped."),

      // ----- Provenance: what makes day-2 ownership possible -----
      owner: z.string().optional().describe("Requesting user or team — recorded on the VM"),
      costCentre: z.string().optional().describe("Cost centre / chargeback code"),
      environment: z.string().optional().describe("dev | test | prod"),
      requestId: z.string().optional().describe("Change request or ticket reference"),
      expiresOn: z.string().optional().describe("ISO date after which this VM should be decommissioned"),
      sizingRationale: z.string().optional().describe("Why this size was chosen — read back later when right-sizing"),

      dryRun: z.boolean().optional().default(false)
        .describe("Validate against the live API server without creating anything (server-side dryRun=All)"),
    },
    async (a) => {
      try {
        const ns = a.namespace;
        const hasSource = Boolean(a.sourceDataSource || a.sourceRegistryUrl || a.sourceHttpUrl);
        if (!hasSource) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: "No boot source specified.",
              detail: "A VM needs a root disk image. Pass sourceDataSource (recommended — clones a golden image into a persistent PVC), or sourceRegistryUrl / sourceHttpUrl to import one.",
              hint: "Run kubevirt_list_templates to see the golden images and instance types available on this cluster.",
            }, null, 2) }],
            isError: true,
          };
        }
        if (!a.sshKey && !a.cloudInitUserData) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: "No access method specified.",
              detail: "Without an SSH key (or explicit cloud-init) the VM will boot but nobody will be able to log in to it.",
              hint: "Pass sshKey with a public key, or cloudInitUserData with your own #cloud-config.",
            }, null, 2) }],
            isError: true,
          };
        }

        // ---- Root disk: a DataVolume template, so the disk is a real PVC that
        // survives restarts. containerDisk/emptyDisk are ephemeral and are not
        // used here — that is the difference between a demo and a provisioned VM.
        const dvName = `${a.name}-rootdisk`;
        const source = a.sourceDataSource
          ? { sourceRef: { kind: "DataSource", name: a.sourceDataSource, namespace: a.sourceDataSourceNamespace } }
          : a.sourceRegistryUrl
            ? { source: { registry: { url: a.sourceRegistryUrl } } }
            : { source: { http: { url: a.sourceHttpUrl } } };

        const dataVolumeTemplate = {
          metadata: { name: dvName },
          spec: {
            ...source,
            storage: {
              resources: { requests: { storage: `${a.diskSizeGi}Gi` } },
              ...(a.storageClass ? { storageClassName: a.storageClass } : {}),
            },
          },
        };

        // ---- cloud-init: the difference between a VM and an unreachable VM ----
        const hostname = a.hostname || a.name;
        const userData = a.cloudInitUserData || [
          "#cloud-config",
          `hostname: ${hostname}`,
          "ssh_pwauth: false",
          "users:",
          `  - name: ${a.username}`,
          "    sudo: ALL=(ALL) NOPASSWD:ALL",
          "    groups: wheel",
          "    shell: /bin/bash",
          "    ssh_authorized_keys:",
          `      - ${a.sshKey}`,
        ].join("\n");

        // ---- Networking ----
        const useNad = Boolean(a.networkAttachmentDefinition);
        const iface = useNad
          ? { name: "nic-0", bridge: {} }
          : { name: "default", masquerade: {} };
        const network = useNad
          ? { name: "nic-0", multus: { networkName: a.networkAttachmentDefinition } }
          : { name: "default", pod: {} };

        // ---- Provenance. Cheap to write, and it is what lets the agent recognise
        // its own work later: "this VM was provisioned by CHG0041022, sized for X".
        const labels = {
          "kubevirt.io/vm": a.name,
          "app.kubernetes.io/managed-by": "tcs-agentic-ai",
          ...(a.environment ? { "tcs.ai/environment": a.environment } : {}),
          ...(a.owner ? { "tcs.ai/owner": String(a.owner).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63) } : {}),
          ...(a.costCentre ? { "tcs.ai/cost-centre": String(a.costCentre).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63) } : {}),
        };
        const annotations = {
          "tcs.ai/provisioned-at": new Date().toISOString(),
          "tcs.ai/provisioned-by": "tcs-agentic-ai",
          ...(a.owner ? { "tcs.ai/owner": a.owner } : {}),
          ...(a.requestId ? { "tcs.ai/request-id": a.requestId } : {}),
          ...(a.expiresOn ? { "tcs.ai/expires-on": a.expiresOn } : {}),
          ...(a.sizingRationale ? { "tcs.ai/sizing-rationale": a.sizingRationale } : {}),
        };

        const vmManifest = {
          apiVersion: "kubevirt.io/v1",
          kind: "VirtualMachine",
          metadata: { name: a.name, namespace: ns, labels, annotations },
          spec: {
            runStrategy: a.runStrategy,
            dataVolumeTemplates: [dataVolumeTemplate],
            template: {
              metadata: { labels: { "kubevirt.io/vm": a.name, ...(a.environment ? { "tcs.ai/environment": a.environment } : {}) } },
              spec: {
                domain: {
                  devices: {
                    disks: [
                      { name: "rootdisk", disk: { bus: "virtio" } },
                      { name: "cloudinit", disk: { bus: "virtio" } },
                    ],
                    interfaces: [iface],
                  },
                },
                networks: [network],
                volumes: [
                  { name: "rootdisk", dataVolume: { name: dvName } },
                  { name: "cloudinit", cloudInitNoCloud: { userData } },
                ],
              },
            },
          },
        };

        // Golden sizing via instance type + preference, or explicit values.
        if (a.instanceType) {
          vmManifest.spec.instancetype = { kind: "VirtualMachineClusterInstancetype", name: a.instanceType };
        } else {
          vmManifest.spec.template.spec.domain.cpu = { cores: a.cpuCores };
          vmManifest.spec.template.spec.domain.memory = { guest: `${a.memoryMi}Mi` };
        }
        if (a.preference) {
          vmManifest.spec.preference = { kind: "VirtualMachineClusterPreference", name: a.preference };
        }

        const path = `/${KUBEVIRT_API}/namespaces/${ns}/virtualmachines`
          + (a.dryRun ? "?dryRun=All" : "");
        const created = await ocpPost(path, vmManifest);

        const summary = {
          action: a.dryRun ? "vm_create_dry_run" : "vm_created",
          dryRun: a.dryRun,
          name: created.metadata.name,
          namespace: created.metadata.namespace,
          ...(a.dryRun ? {} : { uid: created.metadata.uid }),
          rootDisk: { persistent: true, kind: "DataVolume", name: dvName, size: `${a.diskSizeGi}Gi`, storageClass: a.storageClass || "(cluster default)" },
          bootSource: a.sourceDataSource
            ? `DataSource ${a.sourceDataSourceNamespace}/${a.sourceDataSource}`
            : (a.sourceRegistryUrl || a.sourceHttpUrl),
          sizing: a.instanceType ? `instanceType ${a.instanceType}` : `${a.cpuCores} vCPU / ${a.memoryMi}Mi`,
          preference: a.preference || null,
          network: useNad ? `NetworkAttachmentDefinition ${a.networkAttachmentDefinition}` : "pod network (masquerade)",
          access: a.cloudInitUserData ? "custom cloud-init" : `SSH as ${a.username}`,
          runStrategy: a.runStrategy,
          provenance: {
            owner: a.owner || null, costCentre: a.costCentre || null, environment: a.environment || null,
            requestId: a.requestId || null, expiresOn: a.expiresOn || null,
          },
          message: a.dryRun
            ? `Dry-run accepted by the API server. Nothing was created. Re-run with dryRun=false to provision ${a.name}.`
            : `Virtual machine ${created.metadata.name} created in ${created.metadata.namespace}. The root disk is importing; the VM boots when the DataVolume is ready. Use kubevirt_get_vm to watch progress.`,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        return errorResponse(err);
      }
    }
  );

  // ---------- List golden images, instance types and preferences ----------
  // Answers "what can I provision here?" so the AI proposes real options that
  // exist on THIS cluster rather than inventing plausible-looking names.
  server.tool(
    "kubevirt_list_templates",
    "List what can be provisioned on this cluster: golden image DataSources, VirtualMachineClusterInstancetypes (sizes) and VirtualMachineClusterPreferences (guest OS tuning).",
    {
      dataSourceNamespace: z.string().optional().default("openshift-virtualization-os-images")
        .describe("Namespace holding golden image DataSources"),
    },
    async ({ dataSourceNamespace }) => {
      const out = { images: [], instanceTypes: [], preferences: [], notes: [] };
      try {
        const ds = await ocpGet(`/apis/cdi.kubevirt.io/v1beta1/namespaces/${dataSourceNamespace}/datasources`);
        out.images = (ds.items || []).map((d) => {
          const ready = (d.status?.conditions || []).find((c) => c.type === "Ready");
          return { name: d.metadata.name, namespace: d.metadata.namespace, ready: ready?.status === "True" };
        });
      } catch { out.notes.push(`No DataSources readable in ${dataSourceNamespace} — CDI may not be installed, or the images live elsewhere.`); }

      try {
        const it = await ocpGet(`/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterinstancetypes`);
        out.instanceTypes = (it.items || []).map((i) => ({
          name: i.metadata.name,
          cpu: i.spec?.cpu?.guest ?? null,
          memory: i.spec?.memory?.guest ?? null,
        })).sort((x, y) => (x.cpu ?? 0) - (y.cpu ?? 0));
      } catch { out.notes.push("No cluster instance types found — size with cpuCores/memoryMi instead."); }

      try {
        const pr = await ocpGet(`/apis/instancetype.kubevirt.io/v1beta1/virtualmachineclusterpreferences`);
        out.preferences = (pr.items || []).map((p) => p.metadata.name).sort();
      } catch { /* preferences are optional */ }

      if (!out.images.length && !out.instanceTypes.length) {
        return { content: [{ type: "text", text: JSON.stringify({
          ...out,
          message: "Nothing provisionable was discovered. Check that OpenShift Virtualization and CDI are installed and that this service account can read DataSources and instance types.",
        }, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );
}
