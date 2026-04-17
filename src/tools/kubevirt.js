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
    "Create a new KubeVirt virtual machine with the specified configuration",
    {
      name: z.string().describe("Name for the new virtual machine"),
      namespace: z.string().describe("Namespace to create the VM in"),
      instanceType: z
        .string()
        .optional()
        .describe(
          "VirtualMachineClusterInstancetype name (e.g. u1.medium). When set, cpu/memory from the instance type take precedence."
        ),
      image: z
        .string()
        .optional()
        .describe(
          "Container disk image for the VM (e.g. quay.io/containerdisks/fedora:latest)"
        ),
      cpuCores: z
        .number()
        .optional()
        .default(1)
        .describe("Number of CPU cores (ignored when instanceType is set)"),
      memoryMi: z
        .number()
        .optional()
        .default(1024)
        .describe(
          "Memory in MiB (ignored when instanceType is set)"
        ),
    },
    async ({ name, namespace, instanceType, image, cpuCores, memoryMi }) => {
      try {
        const vmManifest = {
          apiVersion: "kubevirt.io/v1",
          kind: "VirtualMachine",
          metadata: {
            name,
            namespace,
          },
          spec: {
            running: false,
            template: {
              metadata: {
                labels: {
                  "kubevirt.io/vm": name,
                },
              },
              spec: {
                domain: {
                  devices: {
                    disks: [
                      {
                        name: "rootdisk",
                        disk: { bus: "virtio" },
                      },
                    ],
                    interfaces: [
                      {
                        name: "default",
                        masquerade: {},
                      },
                    ],
                  },
                },
                networks: [
                  {
                    name: "default",
                    pod: {},
                  },
                ],
                volumes: [],
              },
            },
          },
        };

        // Apply instance type or explicit cpu/memory
        if (instanceType) {
          vmManifest.spec.instancetype = {
            kind: "VirtualMachineClusterInstancetype",
            name: instanceType,
          };
        } else {
          vmManifest.spec.template.spec.domain.cpu = { cores: cpuCores };
          vmManifest.spec.template.spec.domain.resources = {
            requests: { memory: `${memoryMi}Mi` },
          };
        }

        // Apply container disk image or an empty volume placeholder
        if (image) {
          vmManifest.spec.template.spec.volumes.push({
            name: "rootdisk",
            containerDisk: { image },
          });
        } else {
          vmManifest.spec.template.spec.volumes.push({
            name: "rootdisk",
            emptyDisk: { capacity: "2Gi" },
          });
        }

        const created = await ocpPost(
          `/${KUBEVIRT_API}/namespaces/${namespace}/virtualmachines`,
          vmManifest
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: "vm_created",
                  name: created.metadata.name,
                  namespace: created.metadata.namespace,
                  uid: created.metadata.uid,
                  message: `Virtual machine ${created.metadata.name} created in namespace ${created.metadata.namespace}. Use kubevirt_start_vm to start it.`,
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
}
