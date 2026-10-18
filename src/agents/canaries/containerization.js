/**
 * Canary cases for the Workload Modernization Agent.
 *
 * What these are protecting: this agent decides whether a machine becomes a
 * container or stays a VM, across a whole estate, and a customer plans a
 * migration wave on the answer. The dangerous regressions are all the same
 * shape — the agent becoming MORE willing to say yes:
 *
 *   · an unread machine scored as having no blockers
 *   · a database on local disk no longer blocking
 *   · a partial process list treated as a complete one
 *
 * None of those throws. All of them would raise the candidate rate, which looks
 * like the product getting better.
 *
 * Every case is `pure` — the readiness scorer is a function over a guest
 * reading, so no vCenter and no credentials are needed to check it.
 */

import { scoreContainerisation, VERDICTS, distinctWorkloads, detectRuntimes, dataMounts } from "../../services/containerization-readiness.js";
import { listeningPorts, reconcilePort } from "../../services/guest-ports.js";
import { redact, readable } from "../../services/guest-files.js";

// `cmdLine` is the field vSphere's ListProcessesInGuest returns, and the one
// the detector matches on. Spelling it any other way makes every command-line
// pattern silently miss and every machine look like it runs nothing — which is
// exactly the kind of quiet wrongness these cases exist to catch.
const proc = (name, cmdLine, owner = "root") => ({ name, cmdLine, owner });

export default [
  {
    id: "unread-machine-is-never-a-candidate",
    kind: "pure",
    title: "A machine it could not read is reported unread, not clean",
    why: "This is the agent's central promise and the easiest thing to lose in a refactor: an unread machine must never score as a machine without blockers. Losing it inflates the candidate rate on exactly the machines nobody checked, and a customer plans a wave on that number.",
    run: async () => {
      const r = scoreContainerisation({
        vm: { id: "vm-1", name: "unreadable-01", powerState: "poweredOn" },
        guest: { vmId: "vm-1", name: "unreadable-01", powerState: "poweredOn", processes: null,
          processReason: "VMware Tools did not answer." },
      });
      return {
        verdict: r.verdict, confidence: r.confidence, blockers: r.blockers.length,
        summary: r.summary,
        __evidence: { read: 0, expected: 1, confidence: r.confidence, concluded: false },
      };
    },
    expect: [
      { path: "verdict", assert: "equals", value: VERDICTS.UNREADABLE },
      { path: "confidence", assert: "equals", value: "none" },
      { path: "verdict", assert: "excludes", value: VERDICTS.READY },
    ],
  },

  {
    id: "local-database-blocks",
    kind: "pure",
    title: "A database on the machine blocks, with the data as the reason",
    why: "Containerising a host that holds the data is the mistake that loses the data. If this check weakens, the agent starts recommending exactly the migrations that cause an outage.",
    run: async () => {
      const r = scoreContainerisation({
        vm: { id: "vm-2", name: "app-db-01", powerState: "poweredOn" },
        guest: { vmId: "vm-2", name: "app-db-01", powerState: "poweredOn", processes: [
          proc("java", "/usr/bin/java -jar /opt/app/app.jar"),
          proc("postgres", "/usr/lib/postgresql/14/bin/postgres -D /var/lib/postgresql/14/main", "postgres"),
        ] },
      });
      return {
        verdict: r.verdict,
        blockerTitles: r.blockers.map((b) => b.title),
        blockers: r.blockers.length,
        datastores: r.datastores.map((d) => d.label || d.id || d),
      };
    },
    expect: [
      { path: "verdict", assert: "equals", value: VERDICTS.VM_ONLY },
      { path: "blockers", assert: "atLeast", value: 1 },
    ],
  },

  {
    id: "confidence-is-never-high",
    kind: "pure",
    title: "It never claims high confidence, because it cannot read enough to earn it",
    why: "Ports, unit files, packages and config are not read — the agent executes nothing in the guest. High confidence would be a claim about facts nobody has. The boundary is in the manifest; this proves the code still honours it.",
    run: async () => {
      const clean = scoreContainerisation({
        vm: { id: "vm-3", name: "web-01", powerState: "poweredOn" },
        guest: { vmId: "vm-3", name: "web-01", powerState: "poweredOn", processes: [
          proc("nginx", "nginx: master process /usr/sbin/nginx"),
        ] },
      });
      return { verdict: clean.verdict, confidence: clean.confidence };
    },
    expect: [
      { path: "confidence", assert: "oneOf", value: ["none", "low", "medium"] },
      { path: "confidence", assert: "excludes", value: "high" },
    ],
  },

  {
    id: "app-server-subsumes-what-runs-inside-it",
    kind: "pure",
    title: "Spring on Tomcat is one workload, not three",
    why: "Counting a framework, its app server and its JVM as three workloads triples the estate figure a customer is quoted on. It was a real defect once; this stops it coming back.",
    run: async () => {
      const runtimes = detectRuntimes([
        proc("java", "/usr/bin/java -Dcatalina.base=/opt/tomcat -cp /opt/tomcat/lib/spring-core-5.3.jar org.apache.catalina.startup.Bootstrap start"),
      ]);
      const workloads = distinctWorkloads(runtimes);
      return { runtimes: runtimes.length, workloads: workloads.length };
    },
    expect: [
      { path: "workloads", assert: "equals", value: 1, note: "One running process serving one application is one workload, whatever is on its classpath." },
    ],
  },

  {
    id: "powered-off-is-not-assessed",
    kind: "pure",
    title: "A powered-off machine is a retirement question, not a candidate",
    why: "Scoring a machine nobody has started is scoring nothing. Counting it as a candidate pads the number that gets presented.",
    run: async () => {
      const r = scoreContainerisation({
        vm: { id: "vm-4", name: "old-01", powerState: "poweredOff" },
        guest: { vmId: "vm-4", name: "old-01", powerState: "poweredOff", processes: null },
      });
      return { verdict: r.verdict, confidence: r.confidence };
    },
    expect: [
      { path: "verdict", assert: "equals", value: VERDICTS.POWERED_OFF },
      { path: "confidence", assert: "equals", value: "none" },
    ],
  },

  {
    id: "an-unread-mount-table-is-not-an-empty-one",
    kind: "pure",
    title: "A machine whose mounts were not reported is not reported as carrying no data",
    why: "guest.disk is the newest input to the decision and it arrives from vCenter, so it is absent far more often than it is wrong — an older appliance, a guest with no Tools, a property read that partially failed. If a missing mount table ever reads as 'no attached storage', every machine vCenter stayed quiet about becomes a clean container candidate, which is the same empty-list mistake this product has already had to fix six times elsewhere.",
    run: async () => {
      const tomcat = [proc("java", "/usr/lib/jvm/java-17/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap start", "tomcat")];
      const unread = scoreContainerisation({
        vm: { id: "vm-1", name: "app01" },
        guest: { powerState: "poweredOn", processes: tomcat, disks: null, os: { fullName: "RHEL 9" } },
      });
      const reallyNone = scoreContainerisation({
        vm: { id: "vm-2", name: "app02" },
        guest: { powerState: "poweredOn", processes: tomcat, disks: [{ path: "/", capacityBytes: 5e10, freeBytes: 4e10 }], os: { fullName: "RHEL 9" } },
      });
      return {
        unreadRecordsTheGap: unread.unchecked.some((u) => u.fact === "mounts"),
        unreadRaisesNoFinding: ![...unread.blockers, ...unread.concerns].some((f) => f.id === "data-mounts"),
        readRecordsNoGap: !reallyNone.unchecked.some((u) => u.fact === "mounts"),
        __evidence: { read: 0, expected: 1, confidence: "high", concluded: true, unread: ["the guest mount table"] },
      };
    },
    expect: [
      { path: "unreadRecordsTheGap", assert: "equals", value: true,
        note: "An unreported mount table must appear in `unchecked`, so the report can say which checks did not run." },
      { path: "unreadRaisesNoFinding", assert: "equals", value: true,
        note: "It must also not invent a finding it had no data for." },
      { path: "readRecordsNoGap", assert: "equals", value: true,
        note: "A table that WAS read and holds only OS mounts is a real answer, not a gap." },
    ],
  },

  {
    id: "a-data-mount-is-found-and-the-os-is-not",
    kind: "pure",
    title: "A 400GB /var/lib/pgsql is a finding; / and /boot are not",
    why: "The whole value of reading the mount table is separating storage somebody attached on purpose from the operating system every machine has. If the OS filter ever inverts or widens, either every machine raises a data-mount finding — which trains the operator to ignore it — or none does, and a database volume ships as a container with an empty filesystem.",
    run: async () => {
      const disks = [
        { path: "/", capacityBytes: 53687091200, freeBytes: 40000000000 },
        { path: "/boot", capacityBytes: 1073741824, freeBytes: 900000000 },
        { path: "/var/lib/pgsql", capacityBytes: 429496729600, freeBytes: 171798691840 },
      ];
      const data = dataMounts(disks);
      const scored = scoreContainerisation({
        vm: { id: "vm-1", name: "db01" },
        guest: { powerState: "poweredOn", os: { fullName: "RHEL 9" }, disks,
          processes: [proc("java", "/usr/bin/java -Dcatalina.home=/opt/tomcat org.apache.catalina.startup.Bootstrap", "tomcat")] },
      });
      const finding = [...scored.blockers, ...scored.concerns].find((f) => f.id === "data-mounts");
      return {
        paths: data.map((d) => d.path),
        findingRaised: !!finding,
        namesThePath: !!finding && /\/var\/lib\/pgsql/.test(finding.detail),
      };
    },
    expect: [
      { path: "paths", assert: "equals", value: ["/var/lib/pgsql"],
        note: "Only the attached mount. / and /boot are in every container image already." },
      { path: "findingRaised", assert: "equals", value: true },
      { path: "namesThePath", assert: "equals", value: true,
        note: "A count is not actionable; the operator needs the path to decide PVC, operator or drop." },
    ],
  },

  {
    id: "only-listening-sockets-count-as-ports",
    kind: "pure",
    title: "/proc/net/tcp yields listening ports, in hex, excluding established connections",
    why: "This retires the agent's most expensive assumption — the container port — so it has to be exactly right. Two ways to be quietly wrong: reading the hex port as decimal gives a plausible number that is not the port, and counting non-LISTEN sockets turns every outbound connection into a port the proposal would expose. Both produce a Containerfile that builds, starts, passes a TCP probe and serves nothing.",
    run: async () => {
      const table = [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 24680 1",
        "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 13579 1",
        "   2: 0100007F:8AE2 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1001        0 31337 1",
      ].join("\n");
      const read = listeningPorts({ tcp: table });
      return {
        ports: read.ports.map((p) => p.port),
        confirmed: reconcilePort(8080, read).status,
        unreadKeepsConvention: reconcilePort(8080, null),
        emptyIsNotRead: listeningPorts({}).read,
      };
    },
    expect: [
      { path: "ports", assert: "equals", value: [22, 8080],
        note: "1F90 is 8080 read as hex. An established socket on 8AE2 is not a listening port." },
      { path: "confirmed", assert: "equals", value: "confirmed" },
      { path: "unreadKeepsConvention.status", assert: "equals", value: "unread",
        note: "No read means the convention stands and is still labelled an assumption." },
      { path: "emptyIsNotRead", assert: "equals", value: false,
        note: "Reading nothing is not reading that nothing listens." },
    ],
  },

  {
    id: "guest-reads-stay-on-the-allow-list-and-redact",
    kind: "pure",
    title: "Only named paths are readable, and secrets never leave the guest",
    why: "This agent now reads files out of machines a customer owns, using a credential they supplied for assessment. Two regressions would turn that from a feature into an incident: a path parameter that reaches the guest unchecked, which is an exfiltration primitive with a product banner on it, and a config read that carries a production password into a report, a model prompt and a log aggregator in one step. Neither throws, and neither is visible in a demo.",
    run: async () => {
      const leaky = [
        "spring.datasource.password=hunter2",
        "<password>hunter2</password>",
        "jdbc:postgresql://app:hunter2@db.internal:5432/orders",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIB\n-----END RSA PRIVATE KEY-----",
      ].join("\n");
      const cleaned = redact(leaky);
      return {
        allowListed: !!readable("net-tcp"),
        arbitraryPathRefused: readable("/etc/shadow") === null,
        traversalRefused: readable("../../etc/passwd") === null,
        passwordGone: !cleaned.includes("hunter2"),
        keyGone: !cleaned.includes("MIIEowIB"),
      };
    },
    expect: [
      { path: "allowListed", assert: "equals", value: true },
      { path: "arbitraryPathRefused", assert: "equals", value: true,
        note: "A caller must never be able to name the path. The readable set is fixed in code." },
      { path: "traversalRefused", assert: "equals", value: true },
      { path: "passwordGone", assert: "equals", value: true,
        note: "Redaction runs on the way in, so nothing downstream can leak what this module chose not to hold." },
      { path: "keyGone", assert: "equals", value: true },
    ],
  },
];
