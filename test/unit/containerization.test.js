/**
 * In-guest discovery and containerisation readiness.
 * Run with: node --test test/unit/containerization.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const {
  buildGuestPropertiesBody, buildListProcessesBody, buildProcessManagerLookupBody,
  parseGuestProperties, parseProcessList, parseProcessManager,
  describeGuestOpError, credentialFor, unreadableGuest, unescapeXml,
  UNREAD_WITHOUT_PROBE,
} = await import("../../src/services/guest-discovery.js");

const {
  scoreContainerisation, scoreSelection, containerisationFunnel, readinessCoverageNote,
  detectRuntimes, detectDatastores, distinctWorkloads, VERDICTS,
} = await import("../../src/services/containerization-readiness.js");

// ---------------------------------------------------------------------------
// Fixtures — shaped like the wire, not like the parser
// ---------------------------------------------------------------------------
const propsXml = `
<RetrievePropertiesExResponse><returnval>
  <objects>
    <obj type="VirtualMachine">vm-101</obj>
    <propSet><name>name</name><val xsi:type="xsd:string">sap-app-01</val></propSet>
    <propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>
    <propSet><name>guest.guestFullName</name><val xsi:type="xsd:string">Red Hat Enterprise Linux 9 (64-bit)</val></propSet>
    <propSet><name>guest.hostName</name><val xsi:type="xsd:string">sap-app-01.corp.local</val></propSet>
    <propSet><name>guest.toolsRunningStatus</name><val xsi:type="xsd:string">guestToolsRunning</val></propSet>
  </objects>
  <objects>
    <obj type="VirtualMachine">vm-202</obj>
    <propSet><name>name</name><val xsi:type="xsd:string">legacy-box</val></propSet>
    <propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOff</val></propSet>
  </objects>
</returnval></RetrievePropertiesExResponse>`;

const processXml = `
<ListProcessesInGuestResponse>
  <returnval><name>java</name><pid>1412</pid><owner>tomcat</owner>
    <cmdLine>/usr/lib/jvm/java-17/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap start</cmdLine>
    <startTime>2026-09-01T04:11:02Z</startTime></returnval>
  <returnval><name>sshd</name><pid>980</pid><owner>root</owner><cmdLine>/usr/sbin/sshd -D</cmdLine></returnval>
  <returnval><name>httpd</name><pid>1102</pid><owner>apache</owner><cmdLine>/usr/sbin/httpd -DFOREGROUND &amp;&amp; echo &quot;up&quot;</cmdLine></returnval>
</ListProcessesInGuestResponse>`;

const proc = (name, cmdLine, owner = "root") => ({ pid: 1, name, cmdLine, owner });

/**
 * What a real Linux guest is also running.
 *
 * Fixtures used to be one or two processes, which is not what a machine looks
 * like — and once partial-view detection landed, a two-process list correctly
 * stopped reading as a full inventory. Including the system processes makes
 * these fixtures a machine rather than a sketch.
 */
const SYSTEM = [
  proc("systemd", "/usr/lib/systemd/systemd --switched-root --system"),
  proc("sshd", "/usr/sbin/sshd -D"),
  proc("chronyd", "/usr/sbin/chronyd", "chrony"),
  proc("rsyslogd", "/usr/sbin/rsyslogd -n"),
  proc("crond", "/usr/sbin/crond -n"),
  proc("dbus-daemon", "/usr/bin/dbus-daemon --system", "dbus"),
  proc("agetty", "/sbin/agetty -o -p -- \\u --noclear tty1"),
  proc("polkitd", "/usr/lib/polkit-1/polkitd", "polkitd"),
];
const machine = (...procs) => [...procs, ...SYSTEM];
const guestWith = (processes, over = {}) => ({
  vmId: "vm-1", name: "vm-1", source: "vcenter-guest+processes", powerState: "poweredOn",
  os: { fullName: "Red Hat Enterprise Linux 9 (64-bit)", family: "linuxGuest", id: "rhel9_64Guest" },
  toolsRunning: true, processes, processReason: null, unread: [...UNREAD_WITHOUT_PROBE], ...over,
});

// ---------------------------------------------------------------------------
describe("guest discovery — request bodies", () => {
  test("a property read names every machine and every path", () => {
    const body = buildGuestPropertiesBody({ vmIds: ["vm-101", "vm-202"] });
    assert.match(body, /<obj type="VirtualMachine">vm-101<\/obj>/);
    assert.match(body, /<obj type="VirtualMachine">vm-202<\/obj>/);
    assert.match(body, /<pathSet>guest\.toolsRunningStatus<\/pathSet>/);
    assert.match(body, /<pathSet>runtime\.powerState<\/pathSet>/);
  });

  test("the process call asks for a non-interactive session", () => {
    const body = buildListProcessesBody({ processManager: "guestOperationsProcessManager", vmId: "vm-101", username: "svc", password: "p&w<d" });
    assert.match(body, /<interactiveSession>false<\/interactiveSession>/,
      "an interactive session needs a console login and turns a working read into InvalidGuestLogin");
    assert.match(body, /<username>svc<\/username>/);
    assert.match(body, /<password>p&amp;w&lt;d<\/password>/, "credentials must be XML-escaped, not injected raw");
  });

  test("the process manager is read off the guest operations manager", () => {
    const body = buildProcessManagerLookupBody({ guestOperationsManager: "guestOperationsManager" });
    assert.match(body, /<pathSet>processManager<\/pathSet>/);
  });
});

describe("guest discovery — parsing", () => {
  test("properties are kept per machine, never bled between them", () => {
    const m = parseGuestProperties(propsXml);
    assert.equal(m.size, 2);
    assert.equal(m.get("vm-101").hostname, "sap-app-01.corp.local");
    assert.equal(m.get("vm-101").toolsRunning, true);
    // vm-202 reported no guest block at all. The bug this guards is the second
    // machine inheriting the first machine's hostname and reading as healthy.
    assert.equal(m.get("vm-202").hostname, null);
    assert.equal(m.get("vm-202").powerState, "poweredOff");
  });

  test("tools status is tri-state — unreported is not 'stopped'", () => {
    const m = parseGuestProperties(propsXml);
    assert.equal(m.get("vm-202").toolsRunning, null, "not reported must not read as false");
    const stopped = parseGuestProperties(`<objects><obj type="VirtualMachine">vm-9</obj>
      <propSet><name>guest.toolsRunningStatus</name><val>guestToolsNotRunning</val></propSet></objects>`);
    assert.equal(stopped.get("vm-9").toolsRunning, false);
  });

  test("processes come back with their command lines, unescaped", () => {
    const p = parseProcessList(processXml);
    assert.equal(p.length, 3);
    assert.equal(p[0].pid, 1412);
    assert.equal(p[0].owner, "tomcat");
    assert.match(p[0].cmdLine, /catalina/);
    assert.match(p[2].cmdLine, /&& echo "up"/, "XML entities must be decoded or every command line is misread");
  });

  test("the process manager MoRef is extracted", () => {
    assert.equal(parseProcessManager(
      `<objects><propSet><name>processManager</name><val type="GuestProcessManager">guestOperationsProcessManager</val></propSet></objects>`),
      "guestOperationsProcessManager");
  });

  test("&amp; is decoded last so &amp;lt; does not become a tag", () => {
    assert.equal(unescapeXml("a &amp;lt; b"), "a &lt; b");
  });

  test("the four guest-operation failures get four different answers", () => {
    const seen = new Set([
      describeGuestOpError("InvalidGuestLogin"),
      describeGuestOpError("GuestOperationsUnavailable"),
      describeGuestOpError("NoPermission: GuestOperations.Query"),
      describeGuestOpError("NotSupported"),
    ]);
    assert.equal(seen.size, 4, "one message for four causes sends people to the wrong team");
    assert.match(describeGuestOpError("InvalidGuestLogin"), /not a vCenter login/i);
    assert.match(describeGuestOpError("NoPermission"), /Guest Operations/i);
  });

  test("a credential is per-machine, then wildcard, and never half-supplied", () => {
    const creds = { "vm-1": { username: "a", password: "b" }, "*": { username: "w", password: "x" } };
    assert.equal(credentialFor({ id: "vm-1" }, creds).username, "a");
    assert.equal(credentialFor({ id: "vm-9" }, creds).username, "w");
    assert.equal(credentialFor({ id: "vm-9" }, { "*": { username: "w" } }), null, "a password-less credential is not a credential");
  });

  test("an unreadable machine still lists what was not read", () => {
    const g = unreadableGuest({ id: "vm-5", name: "x" }, "Tools not running");
    assert.equal(g.processes, null, "null, never an empty array — those mean different things");
    assert.ok(g.unread.some((u) => u.fact === "listeningPorts"));
  });
});

// ---------------------------------------------------------------------------
describe("containerisation readiness — not assessed", () => {
  test("a powered-off machine is never scored", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(null, { powerState: "poweredOff" }) });
    assert.equal(r.verdict, VERDICTS.POWERED_OFF);
    assert.equal(r.confidence, "none");
  });

  test("processes not read is UNREADABLE, never ready", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(null, { processReason: "No guest credential was supplied." }) });
    assert.equal(r.verdict, VERDICTS.UNREADABLE);
    assert.match(r.summary, /No guest credential/);
  });

  test("an empty process list IS a reading — it is not the same as unread", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith([]) });
    assert.notEqual(r.verdict, VERDICTS.UNREADABLE);
    assert.equal(r.verdict, VERDICTS.INCONCLUSIVE);
  });
});

describe("containerisation readiness — verdicts", () => {
  const tomcat = proc("java", "/usr/lib/jvm/java-17/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap start");

  test("a lone app server with nothing else is a candidate", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat)) });
    assert.equal(r.verdict, VERDICTS.READY);
    assert.equal(r.runtimes[0].id, "tomcat");
    assert.equal(r.confidence, "medium", "confidence is capped — ports and units were never read");
    assert.match(r.summary, /Ports, unit files and config were not read/);
  });

  test("Tomcat is not also counted as a second Java workload", () => {
    const rts = detectRuntimes([tomcat]);
    assert.deepEqual(rts.map((r) => r.id), ["tomcat"]);
    assert.equal(distinctWorkloads(rts).length, 1,
      "counting the JVM separately would make every Java server a multi-app host");
  });

  test("a Spring application deployed on Tomcat is ONE workload", () => {
    // The commonest Java estate there is. Matching the JVM, the server and the
    // framework separately told the customer to split a machine that is whole.
    const springOnTomcat = proc("java",
      "/usr/lib/jvm/java-17/bin/java -Dcatalina.base=/opt/tomcat -classpath /opt/tomcat/lib:/opt/app/spring-boot-3.1.jar org.apache.catalina.startup.Bootstrap start");
    const rts = detectRuntimes([springOnTomcat]);
    assert.deepEqual(rts.map((r) => r.id), ["tomcat"]);
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(springOnTomcat)) });
    assert.equal(r.verdict, VERDICTS.READY);
    assert.ok(!r.concerns.some((c) => c.id === "multi-app-host"));
  });

  test("a standalone Spring Boot jar is still recognised on its own", () => {
    const rts = detectRuntimes([proc("java", "/usr/bin/java -Xmx2g -jar /opt/app/orders.jar")]);
    assert.deepEqual(rts.map((r) => r.id), ["springboot"]);
  });

  test("a web server in front of an app is an Ingress, not a second workload", () => {
    const rts = detectRuntimes([tomcat, proc("nginx", "nginx: master process /usr/sbin/nginx")]);
    assert.equal(distinctWorkloads(rts).length, 1);
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat, proc("nginx", "nginx: master process /usr/sbin/nginx"))) });
    assert.equal(r.verdict, VERDICTS.READY);
  });

  test("a local database blocks it, and says the data is the reason", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat, proc("postgres", "/usr/bin/postgres -D /var/lib/pgsql/data"))) });
    assert.equal(r.verdict, VERDICTS.VM_ONLY);
    const b = r.blockers.find((x) => x.id === "local-datastore");
    assert.ok(b, "a database on the box must block");
    assert.match(b.detail, /local disk/);
    assert.match(b.evidence, /pgsql/, "the finding must carry what we actually saw");
  });

  test("two application runtimes need splitting before anything is built", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat, proc("node", "/usr/bin/node /srv/api/server.js"))) });
    assert.equal(r.verdict, VERDICTS.WITH_WORK);
    assert.ok(r.concerns.some((c) => c.id === "multi-app-host" && c.required));
  });

  test("a desktop session, a cluster member and a licence daemon each block", () => {
    for (const [p, id] of [
      [proc("Xorg", "/usr/lib/Xorg :0"), "gui-workload"],
      [proc("corosync", "/usr/sbin/corosync -f"), "clustered-service"],
      [proc("lmgrd", "/opt/flexlm/lmgrd -c license.dat"), "licence-daemon"],
    ]) {
      const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat, p)) });
      assert.equal(r.verdict, VERDICTS.VM_ONLY, `${id} must block`);
      assert.ok(r.blockers.some((b) => b.id === id));
    }
  });

  test("a machine already running containers is not wrapped in another one", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(proc("dockerd", "/usr/bin/dockerd -H fd://"))) });
    assert.equal(r.verdict, VERDICTS.VM_ONLY);
    const b = r.blockers.find((x) => x.id === "already-container-host");
    assert.match(b.action, /retirement candidate/);
  });

  test("Windows is blocked for the node pool it needs, not dismissed", () => {
    const r = scoreContainerisation({
      vm: { id: "v" },
      guest: guestWith([proc("w3wp.exe", "c:\\windows\\system32\\inetsrv\\w3wp.exe")], {
        os: { fullName: "Microsoft Windows Server 2019 (64-bit)", family: "windowsGuest", id: "windows9Server64Guest" },
      }),
    });
    assert.equal(r.verdict, VERDICTS.VM_ONLY);
    const b = r.blockers.find((x) => x.id === "windows-guest");
    assert.match(b.detail, /Windows Machine Config Operator/, "the reason is the node pool, and that should be said");
  });

  test("agents are reported but do not block", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat, proc("splunkd", "/opt/splunkforwarder/bin/splunkd"))) });
    assert.equal(r.verdict, VERDICTS.READY, "a log forwarder is not a reason to keep a VM");
    assert.ok(r.concerns.some((c) => c.id === "agent-monitoring"));
  });

  test("nothing recognised is inconclusive, not a rejection", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(proc("acme-daemon", "/opt/acme/bin/acmed --config /etc/acme.conf"))) });
    assert.equal(r.verdict, VERDICTS.INCONCLUSIVE);
    assert.match(r.concerns.find((c) => c.id === "no-recognised-runtime").detail, /bespoke binary/);
  });

  test("an unreported guest OS makes the OS check not run, rather than pass", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat), { os: { fullName: null } }) });
    assert.ok(r.unchecked.some((u) => u.fact === "guestOS"));
    assert.ok(r.coverage.ran < r.coverage.total);
  });

  test("every scored machine lists the facts no process list can carry", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat)) });
    for (const f of ["listeningPorts", "services", "kernelModules"]) {
      assert.ok(r.unchecked.some((u) => u.fact === f), `${f} must be declared unread`);
    }
    assert.match(readinessCoverageNote(r), /could not be read without running a command inside the guest/);
  });
});

describe("the funnel", () => {
  const tomcat = proc("java", "/usr/bin/java -Dcatalina.base=/opt/t org.apache.catalina.startup.Bootstrap");
  test("unread machines are not counted as candidates, and both rates are shown", () => {
    const results = [
      scoreContainerisation({ vm: { id: "1" }, guest: guestWith(machine(tomcat)) }),                                   // ready
      scoreContainerisation({ vm: { id: "2" }, guest: guestWith(machine(tomcat, proc("node", "/usr/bin/node a.js"))) }), // with work
      scoreContainerisation({ vm: { id: "3" }, guest: guestWith(machine(proc("Xorg", "/usr/lib/Xorg :0"))) }),           // vm-only
      scoreContainerisation({ vm: { id: "4" }, guest: guestWith(null, { processReason: "no credential" }) }),     // unreadable
      scoreContainerisation({ vm: { id: "5" }, guest: guestWith(null, { powerState: "poweredOff" }) }),           // off
    ];
    const f = containerisationFunnel(results);
    assert.equal(f.total, 5);
    assert.equal(f.assessed, 3);
    assert.equal(f.candidates, 2);
    assert.equal(f.candidatePctOfEstate, 40, "40% of the estate");
    assert.equal(f.candidatePctOfAssessed, 67, "67% of what answered — the number competitors quote");
    assert.match(f.note, /could not be read and are not counted as a candidate or as blocked/);
  });

  test("scoreSelection joins on id then name", () => {
    const guests = new Map([["vm-1", guestWith(machine(tomcat), { vmId: "vm-1" })]]);
    const out = scoreSelection([{ id: "vm-1", name: "a" }, { id: "vm-2", name: "b" }], guests);
    assert.equal(out[0].verdict, VERDICTS.READY);
    assert.equal(out[1].verdict, VERDICTS.UNREADABLE, "a machine with no guest record is unread, not ready");
  });
});

// ---------------------------------------------------------------------------
const { proposeContainerBuild, proposeForSelection, planRefusal } =
  await import("../../src/services/containerization-plan.js");
const { containerfileFor, CONVENTIONAL_PORT, NO_BASE_IMAGE } =
  await import("../../src/services/containerfile-templates.js");

describe("build proposal", () => {
  const tomcat = proc("java", "/usr/lib/jvm/java-17/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap start");
  const score = (procs, over) => scoreContainerisation({ vm: { id: "vm-1" }, guest: guestWith(procs && machine(...procs), over) });

  test("a candidate gets a Containerfile and manifests", () => {
    const p = proposeContainerBuild(score([tomcat]), { appName: "sap-app" });
    assert.equal(p.ok, true);
    assert.equal(p.containerfiles.length, 1);
    assert.match(p.containerfiles[0].containerfile, /^FROM registry\.access\.redhat\.com\/ubi9\/openjdk-17-runtime/m);
    assert.ok(p.manifests.some((m) => m.kind === "Deployment"));
    assert.ok(p.manifests.some((m) => m.kind === "Service"));
    assert.ok(p.manifests.some((m) => m.kind === "Route"), "the primary tier is reachable");
  });

  test("the image never runs as root, because OpenShift will not let it", () => {
    const cf = proposeContainerBuild(score([tomcat])).containerfiles[0].containerfile;
    assert.match(cf, /^USER 1001$/m);
    assert.doesNotMatch(cf, /systemd|sshd|rsyslog/i, "a container runs one process");
  });

  test("the assumed port is declared as an assumption, not presented as a finding", () => {
    const p = proposeContainerBuild(score([tomcat]));
    assert.equal(p.tiers[0].port, CONVENTIONAL_PORT.tomcat);
    const a = p.assumptions.find((x) => x.id.startsWith("port-"));
    assert.ok(a, "the port must be listed as assumed");
    assert.match(a.why, /never read/i);
  });

  test("the scaffold says outright that the application files were not seen", () => {
    const p = proposeContainerBuild(score([tomcat]));
    const a = p.assumptions.find((x) => x.id === "artifact");
    assert.match(a.why, /cannot extract/i);
    assert.match(p.containerfiles[0].containerfile, /THIS IS A SCAFFOLD/);
  });

  test("resources are left unset rather than copied from the VM's shape", () => {
    const p = proposeContainerBuild(score([tomcat]));
    assert.equal(p.tiers[0].resources, undefined);
    assert.ok(p.assumptions.some((a) => a.id === "resources" && /not set/.test(a.value)));
  });

  test("a blocked machine is refused, with the blocker as the reason", () => {
    const p = proposeContainerBuild(score([tomcat, proc("postgres", "/usr/bin/postgres -D /var/lib/pgsql/data")]));
    assert.equal(p.ok, false);
    assert.equal(p.refusal.code, "local-datastore");
    assert.match(p.refusal.message, /PostgreSQL/);
  });

  test("an unread machine is refused — a scaffold from no data is a guess in YAML", () => {
    const p = proposeContainerBuild(score(null, { processReason: "No guest credential was supplied." }));
    assert.equal(p.ok, false);
    assert.equal(p.refusal.code, "unreadable");
  });

  test("a powered-off machine and an inconclusive one refuse differently", () => {
    assert.equal(planRefusal(score(null, { powerState: "poweredOff" })).code, "powered-off");
    assert.equal(planRefusal(score([proc("acme", "/opt/acme/bin/acmed")])).code, "inconclusive");
  });

  test("two workloads become two tiers, and only one is exposed", () => {
    const p = proposeContainerBuild(score([tomcat, proc("node", "/usr/bin/node /srv/api/server.js")]), { appName: "billing" });
    assert.equal(p.ok, true);
    assert.equal(p.tiers.length, 2);
    assert.equal(p.tiers.filter((t) => t.expose).length, 1);
    assert.ok(p.assumptions.some((a) => a.id === "exposure"));
    assert.match(p.nextSteps[0], /Resolve first/, "the split comes before the build");
  });

  test("a reverse proxy does not become a second image", () => {
    const p = proposeContainerBuild(score([tomcat, proc("nginx", "nginx: master process /usr/sbin/nginx")]));
    assert.equal(p.tiers.length, 1, "nginx in front of an app is a Route, not an image to build");
  });

  test("licensed runtimes are refused rather than given a made-up base image", () => {
    const r = containerfileFor({ id: "weblogic", label: "Oracle WebLogic" }, { machine: "x" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /licens/i);
    assert.ok(NO_BASE_IMAGE.websphere);
  });

  test("a selection keeps its refusals visible beside its proposals", () => {
    const out = proposeForSelection([
      score([tomcat]),
      score([tomcat, proc("postgres", "/usr/bin/postgres -D /var/lib/pgsql")]),
      score(null, { processReason: "no credential" }),
    ]);
    assert.equal(out.plans.length, 1);
    assert.equal(out.refused.length, 2);
    assert.match(out.note, /1 of 3/);
  });
});

test("the proposed Deployment is hardened, not merely generated", () => {
  const tomcat = proc("java", "/usr/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap");
  const p = proposeContainerBuild(scoreContainerisation({ vm: { id: "vm-1" }, guest: guestWith(machine(tomcat)) }));
  const dep = p.manifests.find((m) => m.kind === "Deployment").json;
  const pod = dep.spec.template.spec;
  assert.equal(pod.securityContext.runAsNonRoot, true);
  const c = pod.containers[0].securityContext;
  assert.equal(c.allowPrivilegeEscalation, false);
  assert.equal(c.readOnlyRootFilesystem, true);
  assert.deepEqual(c.capabilities.drop, ["ALL"]);
  // A workload lifted off a VM is the likeliest thing in the estate to have
  // assumed root; taking it away in the proposal makes it a review argument
  // rather than an audit finding.
});

describe("partial process views", () => {
  const tomcat = proc("java", "/usr/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap", "tomcat");

  test("a list showing only the credential's own processes cannot read as ready", () => {
    // The blind spot this closes: an unprivileged guest account sees its own
    // processes and little else, so the database beside the app stays invisible
    // and the machine scores clean.
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith([tomcat, proc("java", "/usr/bin/java -jar helper.jar", "tomcat")]) });
    assert.notEqual(r.verdict, VERDICTS.READY);
    const c = r.concerns.find((x) => x.id === "partial-process-view");
    assert.ok(c && c.required);
    assert.match(c.detail, /owned by "tomcat"/);
    assert.match(c.action, /root or a sudo-capable account/);
  });

  test("a handful of processes on a running Linux guest is a slice, not an inventory", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith([tomcat, proc("sshd", "/usr/sbin/sshd -D")]) });
    assert.ok(r.concerns.some((x) => x.id === "partial-process-view"));
  });

  test("a real machine's process list does not trip it", () => {
    const r = scoreContainerisation({ vm: { id: "v" }, guest: guestWith(machine(tomcat)) });
    assert.equal(r.verdict, VERDICTS.READY);
    assert.ok(!r.concerns.some((x) => x.id === "partial-process-view"));
  });

  test("Windows is exempt from the count rule — it genuinely runs fewer", () => {
    const r = scoreContainerisation({
      vm: { id: "v" },
      guest: guestWith([proc("w3wp.exe", "c:\\inetsrv\\w3wp.exe", "IIS APPPOOL"), proc("services.exe", "c:\\windows\\services.exe", "SYSTEM")],
        { os: { fullName: "Microsoft Windows Server 2019 (64-bit)" } }),
    });
    assert.ok(!r.concerns.some((x) => x.id === "partial-process-view"));
  });
});

describe("every agent declares what it can do to the estate", () => {
  // The governance lens exists, the scorecard exists, and both were scoring
  // seventeen agents on defaults because no manifest carried a governance
  // block. Blast radius and autonomy are facts about an agent's tools, so they
  // are declared and asserted; owner and certification are claims only a person
  // can make, so they stay absent and the scorecard rightly deducts for them.
  test("blast radius, trust tier and autonomy are declared on all of them", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const dir = resolve(import.meta.dirname, "../../src/agents/manifests");
    const RADII = ["read-only", "mutating", "irreversible"];
    const AUTONOMY = ["advisory", "propose-and-wait", "act-within-policy"];

    const missing = [];
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json"))) {
      const d = JSON.parse(await readFile(resolve(dir, f), "utf8"));
      const g = d.governance || {};
      if (!RADII.includes(g.blastRadius)) missing.push(`${d.id}: blastRadius`);
      if (!AUTONOMY.includes(g.autonomyLevel)) missing.push(`${d.id}: autonomyLevel`);
      if (!g.trustTier) missing.push(`${d.id}: trustTier`);
      // An owner that nobody agreed to is worse than none — the governance
      // module reports an undeclared field as undeclared on purpose.
      if (g.owner) missing.push(`${d.id}: declares an owner nobody claimed`);
    }
    assert.deepEqual(missing, []);
  });

  test("an agent that can destroy never claims it may act alone", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const dir = resolve(import.meta.dirname, "../../src/agents/manifests");
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json"))) {
      const d = JSON.parse(await readFile(resolve(dir, f), "utf8"));
      const g = d.governance || {};
      if (g.blastRadius === "irreversible") {
        assert.notEqual(g.autonomyLevel, "act-within-policy",
          `${d.id} can destroy and claims it may act without a person`);
      }
    }
  });
});
