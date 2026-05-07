import { z } from "zod";
import { ocpGet, ocpPost, ocpDelete, ocpFetch } from "../utils/openshift-client.js";

export function registerBenchmarkTools(server) {
  // ---------- Run Kube-Burner Cluster Density Test ----------
  server.tool(
    "run_kube_burner",
    "Run kube-burner cluster density/stress tests. Creates a Job that runs kube-burner with the specified workload profile.",
    {
      profile: z.enum(["cluster-density-v2", "node-density", "pvc-density", "crd-scale"])
        .describe("Benchmark profile to run"),
      iterations: z.number().min(1).max(1000).default(10)
        .describe("Number of iterations/namespaces to create"),
      namespace: z.string().default("benchmark-kube-burner")
        .describe("Namespace to run the benchmark in"),
      qps: z.number().default(20).describe("Queries per second for API calls"),
      burst: z.number().default(40).describe("Burst for API calls"),
      cleanup: z.boolean().default(true).describe("Clean up benchmark resources after completion"),
    },
    async ({ profile, iterations, namespace, qps, burst, cleanup }) => {
      try {
        await ensureNamespace(namespace);
        const jobName = `kube-burner-${profile}-${Date.now().toString(36)}`;
        const job = {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name: jobName, namespace, labels: { app: "kube-burner", profile } },
          spec: {
            backoffLimit: 0,
            ttlSecondsAfterFinished: cleanup ? 300 : 86400,
            template: {
              spec: {
                restartPolicy: "Never",
                serviceAccountName: "default",
                containers: [{
                  name: "kube-burner",
                  image: "quay.io/kube-burner/kube-burner:latest",
                  command: ["kube-burner", "ocp", profile,
                    "--iterations", String(iterations),
                    "--qps", String(qps),
                    "--burst", String(burst),
                  ],
                  resources: { requests: { cpu: "200m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
                }],
              },
            },
          },
        };
        await ocpPost(`/apis/batch/v1/namespaces/${namespace}/jobs`, job);
        return {
          content: [{
            type: "text",
            text: `Kube-burner benchmark started.\n\nProfile: ${profile}\nIterations: ${iterations}\nJob: ${jobName}\nNamespace: ${namespace}\nQPS/Burst: ${qps}/${burst}\n\nMonitor with:\n  oc logs job/${jobName} -n ${namespace} -f\n  oc get job/${jobName} -n ${namespace}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Run FIO Storage Benchmark ----------
  server.tool(
    "run_storage_benchmark",
    "Run FIO storage performance benchmarks. Tests IOPS, throughput, and latency for a given storage class.",
    {
      testType: z.enum(["sequential-read", "sequential-write", "random-read", "random-write", "mixed"])
        .describe("Type of storage test to run"),
      storageClass: z.string().default("")
        .describe("Storage class to test (empty = default)"),
      size: z.string().default("1Gi")
        .describe("Size of the test volume"),
      blockSize: z.string().default("4k")
        .describe("Block size for I/O operations"),
      duration: z.number().default(60)
        .describe("Test duration in seconds"),
      namespace: z.string().default("benchmark-storage")
        .describe("Namespace to run the benchmark in"),
    },
    async ({ testType, storageClass, size, blockSize, duration, namespace }) => {
      try {
        await ensureNamespace(namespace);
        const fioProfiles = {
          "sequential-read":  { rw: "read",     name: "seq-read" },
          "sequential-write": { rw: "write",    name: "seq-write" },
          "random-read":      { rw: "randread", name: "rand-read" },
          "random-write":     { rw: "randwrite",name: "rand-write" },
          "mixed":            { rw: "randrw",   name: "mixed-rw" },
        };
        const fio = fioProfiles[testType];
        const pvcName = `fio-bench-${fio.name}-${Date.now().toString(36)}`;
        const jobName = `fio-${fio.name}-${Date.now().toString(36)}`;

        const pvc = {
          apiVersion: "v1", kind: "PersistentVolumeClaim",
          metadata: { name: pvcName, namespace },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: size } },
            ...(storageClass ? { storageClassName: storageClass } : {}),
          },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/persistentvolumeclaims`, pvc);

        const fioCmd = `fio --name=${fio.name} --ioengine=libaio --direct=1 --rw=${fio.rw} --bs=${blockSize} --size=${size} --runtime=${duration} --time_based --numjobs=4 --group_reporting --filename=/data/testfile --output-format=json`;
        const job = {
          apiVersion: "batch/v1", kind: "Job",
          metadata: { name: jobName, namespace, labels: { app: "fio-benchmark" } },
          spec: {
            backoffLimit: 0, ttlSecondsAfterFinished: 600,
            template: {
              spec: {
                restartPolicy: "Never",
                containers: [{
                  name: "fio",
                  image: "ljishen/fio:latest",
                  command: ["sh", "-c", fioCmd],
                  volumeMounts: [{ name: "data", mountPath: "/data" }],
                  resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
                }],
                volumes: [{ name: "data", persistentVolumeClaim: { claimName: pvcName } }],
              },
            },
          },
        };
        await ocpPost(`/apis/batch/v1/namespaces/${namespace}/jobs`, job);
        return {
          content: [{
            type: "text",
            text: `FIO storage benchmark started.\n\nTest: ${testType}\nBlock Size: ${blockSize}\nVolume: ${size}${storageClass ? ` (${storageClass})` : " (default SC)"}\nDuration: ${duration}s\nJob: ${jobName}\nPVC: ${pvcName}\n\nMonitor:\n  oc logs job/${jobName} -n ${namespace} -f`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Run Network Benchmark (iperf3) ----------
  server.tool(
    "run_network_test",
    "Test network throughput, latency, or packet loss between pods using iperf3.",
    {
      testType: z.enum(["throughput", "latency", "packet-loss"]).default("throughput")
        .describe("Type of network test"),
      protocol: z.enum(["tcp", "udp"]).default("tcp")
        .describe("Network protocol to test"),
      duration: z.number().default(30)
        .describe("Test duration in seconds"),
      namespace: z.string().default("benchmark-network")
        .describe("Namespace to run the test in"),
      parallel: z.number().default(1).describe("Number of parallel streams"),
    },
    async ({ testType, protocol, duration, namespace, parallel }) => {
      try {
        await ensureNamespace(namespace);
        const suffix = Date.now().toString(36);

        // Create iperf3 server pod
        const serverPod = {
          apiVersion: "v1", kind: "Pod",
          metadata: { name: `iperf3-server-${suffix}`, namespace, labels: { app: "iperf3-server", run: suffix } },
          spec: {
            containers: [{
              name: "iperf3-server",
              image: "networkstatic/iperf3:latest",
              command: ["iperf3", "-s"],
              ports: [{ containerPort: 5201 }],
              resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "500m", memory: "128Mi" } },
            }],
            restartPolicy: "Never",
          },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/pods`, serverPod);

        // Create server service
        const svc = {
          apiVersion: "v1", kind: "Service",
          metadata: { name: `iperf3-svc-${suffix}`, namespace },
          spec: { selector: { app: "iperf3-server", run: suffix }, ports: [{ port: 5201, targetPort: 5201 }] },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/services`, svc);

        // Build iperf3 client command
        let clientArgs = ["iperf3", "-c", `iperf3-svc-${suffix}`, "-t", String(duration), "-P", String(parallel), "--json"];
        if (protocol === "udp") clientArgs.push("-u");
        if (testType === "latency") clientArgs.push("--bidir");

        const clientPod = {
          apiVersion: "v1", kind: "Pod",
          metadata: { name: `iperf3-client-${suffix}`, namespace, labels: { app: "iperf3-client" } },
          spec: {
            containers: [{
              name: "iperf3-client",
              image: "networkstatic/iperf3:latest",
              command: ["sh", "-c", `sleep 5 && ${clientArgs.join(" ")}`],
              resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "500m", memory: "128Mi" } },
            }],
            restartPolicy: "Never",
          },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/pods`, clientPod);

        return {
          content: [{
            type: "text",
            text: `Network benchmark started (${testType} / ${protocol}).\n\nServer: iperf3-server-${suffix}\nClient: iperf3-client-${suffix}\nDuration: ${duration}s\nStreams: ${parallel}\n\nGet results:\n  oc logs iperf3-client-${suffix} -n ${namespace}\n\nCleanup:\n  oc delete pod,svc -l run=${suffix} -n ${namespace}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Run CPU/Memory Stress Test ----------
  server.tool(
    "run_cpu_stress_test",
    "Run CPU and/or memory stress tests on worker nodes using stress-ng.",
    {
      cpuWorkers: z.number().default(4).describe("Number of CPU stress workers"),
      memoryWorkers: z.number().default(0).describe("Number of memory stress workers (0 = skip)"),
      memorySize: z.string().default("256M").describe("Memory per worker (e.g. 256M, 1G)"),
      duration: z.number().default(60).describe("Test duration in seconds"),
      nodeSelector: z.string().default("").describe("Target specific node (label selector, e.g. kubernetes.io/hostname=worker-1)"),
      namespace: z.string().default("benchmark-stress").describe("Namespace to run the test in"),
    },
    async ({ cpuWorkers, memoryWorkers, memorySize, duration, nodeSelector, namespace }) => {
      try {
        await ensureNamespace(namespace);
        const suffix = Date.now().toString(36);
        let args = ["stress-ng"];
        if (cpuWorkers > 0) args.push("--cpu", String(cpuWorkers), "--cpu-method", "all");
        if (memoryWorkers > 0) args.push("--vm", String(memoryWorkers), "--vm-bytes", memorySize);
        args.push("--timeout", `${duration}s`, "--metrics-brief");

        const nodeSelectorObj = {};
        if (nodeSelector) {
          const [key, val] = nodeSelector.split("=");
          if (key && val) nodeSelectorObj[key] = val;
        }

        const pod = {
          apiVersion: "v1", kind: "Pod",
          metadata: { name: `stress-test-${suffix}`, namespace, labels: { app: "stress-test" } },
          spec: {
            ...(Object.keys(nodeSelectorObj).length > 0 ? { nodeSelector: nodeSelectorObj } : {}),
            containers: [{
              name: "stress-ng",
              image: "alexeiled/stress-ng:latest",
              command: args,
              resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: String(cpuWorkers + 1), memory: memoryWorkers > 0 ? `${parseInt(memorySize) * memoryWorkers * 2}M` : "256Mi" } },
            }],
            restartPolicy: "Never",
          },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/pods`, pod);

        return {
          content: [{
            type: "text",
            text: `Stress test started.\n\nCPU Workers: ${cpuWorkers}\nMemory Workers: ${memoryWorkers}${memoryWorkers > 0 ? ` (${memorySize} each)` : ""}\nDuration: ${duration}s\n${nodeSelector ? `Node: ${nodeSelector}\n` : ""}Pod: stress-test-${suffix}\n\nMonitor:\n  oc logs stress-test-${suffix} -n ${namespace} -f\n  oc top pod stress-test-${suffix} -n ${namespace}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ---------- Run Database Benchmark ----------
  server.tool(
    "run_database_benchmark",
    "Run database performance benchmarks using pgbench (PostgreSQL) or sysbench (MySQL).",
    {
      dbType: z.enum(["postgresql", "mysql"]).describe("Database type to benchmark"),
      testType: z.enum(["oltp-read", "oltp-write", "oltp-mixed", "tpcb-like"]).default("tpcb-like")
        .describe("Benchmark workload type"),
      scaleFactor: z.number().default(10).describe("Scale factor for data generation"),
      clients: z.number().default(10).describe("Number of concurrent clients"),
      duration: z.number().default(60).describe("Test duration in seconds"),
      dbHost: z.string().describe("Database host (service name or IP)"),
      dbPort: z.number().default(5432).describe("Database port"),
      dbName: z.string().default("benchdb").describe("Database name"),
      dbUser: z.string().default("bench").describe("Database user"),
      dbPassword: z.string().default("benchpass").describe("Database password"),
      namespace: z.string().default("benchmark-db").describe("Namespace"),
    },
    async ({ dbType, testType, scaleFactor, clients, duration, dbHost, dbPort, dbName, dbUser, dbPassword, namespace }) => {
      try {
        await ensureNamespace(namespace);
        const suffix = Date.now().toString(36);
        let cmd;

        if (dbType === "postgresql") {
          const initCmd = `PGPASSWORD=${dbPassword} pgbench -i -s ${scaleFactor} -h ${dbHost} -p ${dbPort} -U ${dbUser} ${dbName}`;
          const runCmd = `PGPASSWORD=${dbPassword} pgbench -c ${clients} -j ${Math.min(clients, 4)} -T ${duration} -h ${dbHost} -p ${dbPort} -U ${dbUser} ${dbName}`;
          cmd = `${initCmd} && echo '--- Benchmark Results ---' && ${runCmd}`;
        } else {
          const profile = testType === "oltp-read" ? "oltp_read_only" : testType === "oltp-write" ? "oltp_write_only" : "oltp_read_write";
          const prepCmd = `sysbench ${profile} --mysql-host=${dbHost} --mysql-port=${dbPort} --mysql-user=${dbUser} --mysql-password=${dbPassword} --mysql-db=${dbName} --table-size=${scaleFactor * 10000} --tables=4 prepare`;
          const runCmd = `sysbench ${profile} --mysql-host=${dbHost} --mysql-port=${dbPort} --mysql-user=${dbUser} --mysql-password=${dbPassword} --mysql-db=${dbName} --table-size=${scaleFactor * 10000} --tables=4 --threads=${clients} --time=${duration} --report-interval=10 run`;
          cmd = `${prepCmd} && echo '--- Benchmark Results ---' && ${runCmd}`;
        }

        const image = dbType === "postgresql" ? "postgres:16-alpine" : "severalnines/sysbench:latest";
        const pod = {
          apiVersion: "v1", kind: "Pod",
          metadata: { name: `db-bench-${suffix}`, namespace, labels: { app: "db-benchmark" } },
          spec: {
            containers: [{
              name: "benchmark",
              image,
              command: ["sh", "-c", cmd],
              resources: { requests: { cpu: "200m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
            }],
            restartPolicy: "Never",
          },
        };
        await ocpPost(`/api/v1/namespaces/${namespace}/pods`, pod);

        return {
          content: [{
            type: "text",
            text: `Database benchmark started.\n\nDB: ${dbType}\nTest: ${testType}\nScale: ${scaleFactor}\nClients: ${clients}\nDuration: ${duration}s\nTarget: ${dbHost}:${dbPort}/${dbName}\nPod: db-bench-${suffix}\n\nMonitor:\n  oc logs db-bench-${suffix} -n ${namespace} -f`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}

async function ensureNamespace(ns) {
  try {
    await ocpGet(`/api/v1/namespaces/${ns}`);
  } catch {
    await ocpPost("/api/v1/namespaces", {
      apiVersion: "v1", kind: "Namespace",
      metadata: { name: ns, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-benchmark" } },
    });
  }
}
