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

import { scoreContainerisation, VERDICTS, distinctWorkloads, detectRuntimes } from "../../services/containerization-readiness.js";

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
];
