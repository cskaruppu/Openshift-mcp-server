// ---------------------------------------------------------------------------
// Containerisation readiness
// ---------------------------------------------------------------------------
/**
 * Whether a virtual machine should become a container, and if not, why not.
 *
 * This is NOT the same question as "can this VM be migrated", which
 * source-readiness.js answers. A machine can be perfectly migratable and a
 * terrible container, and the two verdicts have to be allowed to disagree —
 * the product's argument is that one discovery pass produces two dispositions.
 *
 * The honest position, stated here because the whole module depends on it:
 * of a typical estate, a minority of machines are containerisation candidates.
 * A scorer that returns "ready" for most of a fleet is not being generous, it
 * is being wrong, and the first customer to containerise a machine on its word
 * and find the database was local will never believe the tool again.
 *
 * So three rules:
 *
 *   1. A CHECK WITH NO DATA IS NOT A PASS. If the process list was not read,
 *      the machine is UNREADABLE, not "ready". There is no partial credit.
 *   2. CONFIDENCE IS CAPPED BY WHAT WAS READ. Listening ports, unit files and
 *      config are not available without running a command inside the guest,
 *      so nothing here ever claims high confidence.
 *   3. EVERY VERDICT CARRIES ITS EVIDENCE. The process that produced a finding
 *      is named, because the platform team will argue with it — and should be
 *      able to.
 *
 * Everything in this file is pure.
 */

// ---------------------------------------------------------------------------
// What a process tells you
// ---------------------------------------------------------------------------
/**
 * Application runtimes we can recognise and containerise.
 *
 * `base` is the suggested UBI image for the generation phase. It is a starting
 * point for a human, not an answer — the version still has to come from the
 * guest, and that is one of the facts this layer cannot read.
 */
export const RUNTIMES = Object.freeze([
  { id: "tomcat", label: "Apache Tomcat", re: /catalina|tomcat/i, base: "registry.access.redhat.com/ubi9/openjdk-17-runtime" },
  { id: "jboss", label: "JBoss EAP / WildFly", re: /jboss|wildfly|standalone\.sh|domain\.sh/i, base: "registry.redhat.io/jboss-eap-8/eap8-openjdk17-runtime-openshift-rhel9" },
  { id: "weblogic", label: "Oracle WebLogic", re: /weblogic/i, base: null },
  { id: "websphere", label: "IBM WebSphere", re: /websphere|\bwas\b.*server|com\.ibm\.ws/i, base: null },
  // Not a bare /spring/: a Spring library on an application server's classpath
  // is not a Spring Boot process, and matching it turned every Spring-on-Tomcat
  // estate — which is most of them — into a two-workload machine.
  { id: "springboot", label: "Spring Boot", re: /spring-?boot|java\s+(?:-\S+\s+)*-jar\s+\S+\.jar/i, base: "registry.access.redhat.com/ubi9/openjdk-17-runtime" },
  { id: "java", label: "Java (unidentified framework)", re: /(?:^|\/)java(?:\s|$)/i, base: "registry.access.redhat.com/ubi9/openjdk-17-runtime" },
  { id: "dotnet", label: ".NET", re: /(?:^|\/)dotnet(?:\s|$)|w3wp\.exe/i, base: "registry.access.redhat.com/ubi9/dotnet-80-runtime" },
  { id: "nodejs", label: "Node.js", re: /(?:^|\/)node(?:js)?(?:\s|$)|pm2/i, base: "registry.access.redhat.com/ubi9/nodejs-20-minimal" },
  { id: "python", label: "Python (WSGI/ASGI)", re: /gunicorn|uwsgi|uvicorn|manage\.py|(?:^|\/)python[\d.]*(?:\s|$)/i, base: "registry.access.redhat.com/ubi9/python-311" },
  { id: "php", label: "PHP", re: /php-fpm|php_fpm|(?:^|\/)php(?:\s|$)/i, base: "registry.access.redhat.com/ubi9/php-82" },
  { id: "ruby", label: "Ruby", re: /puma|unicorn|(?:^|\/)ruby(?:\s|$)/i, base: "registry.access.redhat.com/ubi9/ruby-33" },
  { id: "nginx", label: "nginx", re: /(?:^|\/)nginx(?:\s|:|$)/i, base: "registry.access.redhat.com/ubi9/nginx-124" },
  { id: "httpd", label: "Apache httpd", re: /(?:^|\/)(?:httpd|apache2)(?:\s|$)/i, base: "registry.access.redhat.com/ubi9/httpd-24" },
]);

/**
 * Datastores. Their presence is the single most common reason a VM must not
 * become a container as-is: the state lives on this machine's local disk, and
 * nothing in a Containerfile can move it.
 */
export const DATASTORES = Object.freeze([
  { id: "postgres", label: "PostgreSQL", re: /postgres|postmaster/i },
  { id: "mysql", label: "MySQL / MariaDB", re: /mysqld|mariadbd/i },
  { id: "oracle", label: "Oracle Database", re: /ora_pmon|oracle.*tnslsnr|tnslsnr/i },
  { id: "mssql", label: "SQL Server", re: /sqlservr|sqlagent/i },
  { id: "mongodb", label: "MongoDB", re: /mongod(?:\s|$)/i },
  { id: "redis", label: "Redis", re: /redis-server/i },
  { id: "elasticsearch", label: "Elasticsearch", re: /elasticsearch|opensearch/i },
  { id: "cassandra", label: "Cassandra", re: /cassandra/i },
  { id: "db2", label: "Db2", re: /db2sysc|db2wdog/i },
  { id: "kafka", label: "Kafka", re: /kafka\.Kafka|zookeeper/i },
]);

/** Things that make a container the wrong answer regardless of the runtime. */
export const HARD_BLOCKERS = Object.freeze([
  {
    id: "gui-workload", label: "Desktop session", re: /Xorg|gnome-shell|kdeinit|xrdp|vncserver|Xvnc/i,
    title: "A desktop session is running",
    detail: "Containers have no display server and no console for a user to sit at. A workload someone logs into graphically is not a container workload.",
    action: "Keep this machine as a VM on OpenShift Virtualization.",
  },
  {
    id: "clustered-service", label: "OS-level clustering", re: /pacemaker|corosync|rgmanager|clvmd|keepalived|ocssd|crsd/i,
    title: "This machine is a member of an OS-level cluster",
    detail: "Cluster membership is built on node identity, shared storage and fencing — none of which survive being turned into a pod. The cluster would have to be redesigned, not converted.",
    action: "Keep as a VM, or replace the clustering with Kubernetes-native replicas as a separate project.",
  },
  {
    id: "licence-daemon", label: "Licence server", re: /lmgrd|flexlm|lmadmin|hasplmd|aksusbd|sentinel|rlm(?:\s|$)/i,
    title: "A node-locked licence daemon is running",
    detail: "These licences bind to a MAC address, a hostname or a hardware dongle. A pod gets a new identity on every restart, so the licence stops working the first time it is rescheduled.",
    action: "Keep as a VM. Re-hosting requires the vendor to reissue the licence, which is a commercial conversation, not a technical one.",
  },
  {
    id: "hypervisor-role", label: "Virtualisation host", re: /libvirtd|qemu-system|vmware-vmx|virtualbox/i,
    title: "This machine is itself running virtual machines",
    detail: "Nested virtualisation inside a pod is not a supported pattern.",
    action: "Keep as a VM and treat the guests it hosts as the real migration scope.",
  },
]);

/** Agents that will not come with the workload, and do not block it either. */
export const AGENTS = Object.freeze([
  { id: "backup", label: "Backup agent", re: /veeam|bpcd|nbdisco|commvault|cvd(?:\s|$)|dsmc|tsm|rubrik|cohesity|avagent/i,
    note: "Backup of a container is a backup of its persistent volume, not of its filesystem. The backup policy has to be rewritten, not carried over." },
  { id: "monitoring", label: "Monitoring agent", re: /splunkd|datadog-agent|zabbix_agentd|nrpe|nagios|dynatrace|oneagent|appdynamics|newrelic|telegraf|collectd/i,
    note: "The agent is replaced by the platform's own metrics and logs. Confirm the dashboards and alerts that depend on it have an equivalent before cutover." },
  { id: "security", label: "Security / EDR agent", re: /crowdstrike|falcon-sensor|cbagentd|carbonblack|mcafee|trendmicro|ds_agent|qualys|nessus|tanium/i,
    note: "Endpoint agents generally do not run in a container and are replaced by image scanning and admission policy. Security will need to sign that off." },
  { id: "config-mgmt", label: "Configuration management", re: /puppet|chef-client|salt-minion|ansible-pull|cfengine/i,
    note: "Configuration becomes the image and the manifest. Whatever this agent manages has to be found and moved into one of the two." },
]);

/** Already containerised — the workload is the containers, not the machine. */
const CONTAINER_HOST = /dockerd|containerd|(?:^|\/)podman|crio|kubelet/i;

/** Directory integration — a concern, since identity has to be re-established. */
const DIRECTORY = /winbindd|sssd|adclient|centrifydc|nslcd/i;

/** Windows guest OS strings. */
const WINDOWS = /windows|microsoft/i;
/** Windows guests that are a desktop rather than a server. */
const WINDOWS_DESKTOP = /windows\s*(?:xp|vista|7|8|8\.1|10|11)\b/i;

const matches = (procs, re) => procs.filter((p) => re.test(p.cmdLine || "") || re.test(p.name || ""));
const first = (procs, re) => matches(procs, re)[0] || null;
/** The evidence string a finding carries: what we saw, trimmed to readable. */
const evidenceOf = (p) => (p ? `${p.name}${p.cmdLine ? ` — ${String(p.cmdLine).slice(0, 160)}` : ""}` : null);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
/**
 * Which application runtimes are running.
 *
 * Ordered by specificity and de-duplicated: a Tomcat is also a `java` process,
 * and reporting both as two runtimes would turn every Java server into a
 * "multi-app host" that needs splitting. The generic entries only stand when
 * nothing more specific matched.
 */
export function detectRuntimes(processes = []) {
  const hits = [];
  for (const rt of RUNTIMES) {
    const p = first(processes, rt.re);
    if (p) hits.push({ ...rt, evidence: evidenceOf(p), pid: p.pid });
  }
  // An application server SUBSUMES what runs inside it. A Spring application
  // deployed on Tomcat is one workload that matches three patterns — the JVM,
  // the server and the framework — and reporting three would tell the customer
  // to split a machine that does not need splitting.
  const hasAppServer = hits.some((h) => APP_SERVERS.includes(h.id));
  const kept = hasAppServer ? hits.filter((h) => !FRAMEWORKS.includes(h.id)) : hits;
  const specific = kept.filter((h) => h.id !== "java");
  const java = kept.find((h) => h.id === "java");
  return specific.length || !java ? specific : [java];
}

/** Servers that host an application, rather than being one. */
const APP_SERVERS = ["tomcat", "jboss", "weblogic", "websphere"];
/** What runs inside one of those, and must not be counted again beside it. */
const FRAMEWORKS = ["springboot", "java"];

/** Datastores running on this machine. */
export function detectDatastores(processes = []) {
  return DATASTORES
    .map((d) => { const p = first(processes, d.re); return p ? { ...d, evidence: evidenceOf(p) } : null; })
    .filter(Boolean);
}

/**
 * Distinct application workloads, for the multi-app-host judgement.
 *
 * A web server fronting one app is one workload. Two application runtimes on
 * one machine is two, and it is the most common reason a "simple" VM turns out
 * not to be simple.
 */
export function distinctWorkloads(runtimes = []) {
  return runtimes.filter((r) => !["nginx", "httpd", "java"].includes(r.id));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
export const VERDICTS = Object.freeze({
  POWERED_OFF: "powered-off",
  UNREADABLE: "unreadable",
  INCONCLUSIVE: "inconclusive",
  VM_ONLY: "vm-only",
  WITH_WORK: "container-with-work",
  READY: "container-ready",
});

/** Human sentence per verdict, so the console and the report agree. */
export const VERDICT_LABEL = Object.freeze({
  [VERDICTS.POWERED_OFF]: "Powered off — not assessed",
  [VERDICTS.UNREADABLE]: "Could not read inside — not assessed",
  [VERDICTS.INCONCLUSIVE]: "Nothing recognisable running",
  [VERDICTS.VM_ONLY]: "Keep as a VM",
  [VERDICTS.WITH_WORK]: "Containerisable with work",
  [VERDICTS.READY]: "Containerisation candidate",
});

/**
 * Score one machine.
 *
 * @param {object} vm     the VM shell, as the migration inventory reports it
 * @param {object} guest  the record from guest-discovery
 * @returns {{verdict, confidence, runtimes, blockers, concerns, unchecked, coverage, summary}}
 */
export function scoreContainerisation({ vm = {}, guest = null } = {}) {
  const name = guest?.name || vm.name || null;
  const base = {
    vmId: guest?.vmId || vm.id || null,
    name,
    runtimes: [],
    datastores: [],
    blockers: [],
    concerns: [],
    unchecked: guest?.unread ? [...guest.unread] : [],
    coverage: { ran: 0, total: 0 },
  };

  // ── Not assessed, and said so ──────────────────────────────────────────
  const power = guest?.powerState || vm.powerState || null;
  if (power && !/poweredOn/i.test(power)) {
    return {
      ...base, verdict: VERDICTS.POWERED_OFF, confidence: "none",
      summary: `The machine is ${power}. A machine nobody has started is a retirement question before it is a containerisation question.`,
    };
  }

  const processes = guest?.processes;
  if (!Array.isArray(processes)) {
    return {
      ...base, verdict: VERDICTS.UNREADABLE, confidence: "none",
      summary: guest?.processReason
        || "What runs inside this machine was not read, so it has not been scored. An unread machine is not a machine without blockers.",
    };
  }

  // ── Assessed ───────────────────────────────────────────────────────────
  const blockers = [], concerns = [], skipped = [];
  let total = 0, ran = 0;
  const check = (fn) => { total++; ran++; const f = fn(); if (f) (f.blocks ? blockers : concerns).push(f); };
  /** A check whose input is missing does not run, and is not a pass. */
  const checkIf = (fact, id, label, fn) => {
    total++;
    if (fact === null || fact === undefined || fact === "") { skipped.push({ fact: id, reason: `${label} was not reported, so this check did not run.` }); return; }
    ran++;
    const f = fn(fact);
    if (f) (f.blocks ? blockers : concerns).push(f);
  };

  const runtimes = detectRuntimes(processes);
  const datastores = detectDatastores(processes);
  const workloads = distinctWorkloads(runtimes);

  // Windows first: it is not a blocker to containerising in principle, but it
  // is a blocker to containerising onto the Linux nodes this cluster has.
  const osName = guest?.os?.fullName || vm.guestOS || vm.osType || "";
  checkIf(osName || null, "guestOS", "The guest operating system", () => {
    if (!WINDOWS.test(osName)) return null;
    if (WINDOWS_DESKTOP.test(osName)) {
      return {
        id: "windows-desktop", blocks: true, severity: "critical", title: `${osName} is a desktop operating system`,
        detail: "There is no container form of a Windows desktop.",
        action: "Keep as a VM on OpenShift Virtualization.", evidence: osName,
      };
    }
    return {
      id: "windows-guest", blocks: true, severity: "critical", title: `${osName} needs Windows worker nodes`,
      detail: "A Windows container only runs on a Windows node. OpenShift supports those through the Windows Machine Config Operator, but this is a separate node pool and a separate licensing conversation — it is not the same target as the rest of the wave.",
      action: "Keep as a VM unless the cluster already has Windows nodes, in which case assess it as a separate stream.",
      evidence: osName,
    };
  });

  for (const b of HARD_BLOCKERS) {
    check(() => {
      const p = first(processes, b.re);
      return p && { id: b.id, blocks: true, severity: "critical", title: b.title, detail: b.detail, action: b.action, evidence: evidenceOf(p) };
    });
  }

  check(() => {
    const p = first(processes, CONTAINER_HOST);
    return p && {
      id: "already-container-host", blocks: true, severity: "info",
      title: "This machine is already running containers",
      detail: "The workload here is the containers, not the machine hosting them. Converting the host would wrap containers in a container.",
      action: "Move the container workloads directly. The host itself is then a retirement candidate.",
      evidence: evidenceOf(p),
    };
  });

  check(() => datastores.length > 0 && {
    id: "local-datastore", blocks: true, severity: "critical",
    title: `${datastores.map((d) => d.label).join(", ")} ${datastores.length === 1 ? "is" : "are"} running on this machine`,
    detail: "The data lives on this machine's local disk. Nothing in a Containerfile moves it, and a container that loses its filesystem on restart loses the database with it.",
    action: "Move the data to a managed service, an operator-run database, or a StatefulSet with persistent volumes — as its own project, before the application in front of it is containerised.",
    evidence: datastores.map((d) => d.evidence).filter(Boolean).join(" | ") || null,
  });

  check(() => workloads.length > 1 && {
    id: "multi-app-host", blocks: false, severity: "warning", required: true,
    title: `${workloads.length} application runtimes share this machine`,
    detail: `${workloads.map((w) => w.label).join(", ")}. One container runs one workload, so this machine becomes more than one deployment — and whatever they share on local disk has to be found first.`,
    action: "Split into one workload per container, or containerise the primary application and leave the rest.",
    evidence: workloads.map((w) => w.evidence).filter(Boolean).join(" | ") || null,
  });

  check(() => {
    const p = first(processes, DIRECTORY);
    return p && {
      id: "directory-joined", blocks: false, severity: "warning", required: true,
      title: "The machine is joined to a directory",
      detail: "Machine identity does not follow a pod. Anything authenticating as this host, or relying on a keytab bound to it, stops working.",
      action: "Establish how the application authenticates before cutover — a service account and a mounted secret, rather than machine identity.",
      evidence: evidenceOf(p),
    };
  });

  for (const a of AGENTS) {
    check(() => {
      const p = first(processes, a.re);
      return p && {
        id: `agent-${a.id}`, blocks: false, severity: "info", required: false,
        title: `${a.label} present`, detail: a.note,
        action: "No action before assessment. Confirm the replacement before cutover.",
        evidence: evidenceOf(p),
      };
    });
  }

  check(() => runtimes.length === 0 && {
    id: "no-recognised-runtime", blocks: false, severity: "warning", required: true,
    title: "No recognised application runtime is running",
    detail: `${processes.length} process${processes.length === 1 ? "" : "es"} were read and none of them matched a runtime this assessment knows how to containerise. That is not the same as "nothing runs here" — it may be a bespoke binary, which can containerise perfectly well.`,
    action: "Have the application owner identify the process that serves this machine's purpose.",
    evidence: processes.slice(0, 5).map((p) => p.name).join(", ") || null,
  });

  base.coverage = { ran, total };
  base.runtimes = runtimes;
  base.datastores = datastores;
  base.blockers = blockers;
  base.concerns = concerns;
  base.unchecked = [...(guest?.unread || []), ...skipped];

  // ── The verdict ────────────────────────────────────────────────────────
  // Confidence is capped at medium by construction: ports, unit files and
  // config were not read, and no amount of process evidence substitutes for
  // them. Nothing in this module returns "high".
  const confidence = "medium";

  if (blockers.length) {
    return { ...base, verdict: VERDICTS.VM_ONLY, confidence,
      summary: `${blockers[0].title}. ${blockers.length > 1 ? `${blockers.length - 1} further blocker${blockers.length > 2 ? "s" : ""}. ` : ""}This machine should be migrated as a VM.` };
  }
  if (!runtimes.length) {
    return { ...base, verdict: VERDICTS.INCONCLUSIVE, confidence: "low",
      summary: `Read ${processes.length} process${processes.length === 1 ? "" : "es"} and recognised none of them as an application runtime. Needs an owner to identify the workload.` };
  }
  const needsWork = concerns.filter((c) => c.required);
  if (needsWork.length) {
    return { ...base, verdict: VERDICTS.WITH_WORK, confidence,
      summary: `${runtimes[0].label} detected. ${needsWork.length} thing${needsWork.length === 1 ? "" : "s"} to resolve first: ${needsWork.map((c) => c.title).join("; ")}.` };
  }
  return { ...base, verdict: VERDICTS.READY, confidence,
    summary: `${runtimes.map((r) => r.label).join(" + ")} with no blockers found in what was read. Ports, unit files and config were not read — confirm those before generating a build.` };
}

/** Score a whole selection. `guests` is the Map from discoverGuests. */
export function scoreSelection(vms = [], guests = new Map()) {
  return vms.map((vm) => scoreContainerisation({ vm, guest: guests.get(vm.id || vm.name) || null }));
}

/**
 * The funnel, which is the number a customer actually wants.
 *
 * Reported against the WHOLE selection rather than against the machines that
 * happened to be readable — a 90% candidate rate calculated over the 10% of an
 * estate that answered is the kind of statistic that ends a pilot.
 */
export function containerisationFunnel(results = []) {
  const counts = Object.fromEntries(Object.values(VERDICTS).map((v) => [v, 0]));
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  const total = results.length;
  const assessed = total - counts[VERDICTS.POWERED_OFF] - counts[VERDICTS.UNREADABLE];
  const candidates = counts[VERDICTS.READY] + counts[VERDICTS.WITH_WORK];
  return {
    total, assessed, notAssessed: total - assessed, counts, candidates,
    // Both percentages, deliberately. The first is the honest one; the second
    // is the one every competitor quotes, and showing them side by side is the
    // argument.
    candidatePctOfEstate: total ? Math.round((candidates / total) * 100) : 0,
    candidatePctOfAssessed: assessed ? Math.round((candidates / assessed) * 100) : 0,
    note: assessed === total
      ? `All ${total} machines were assessed.`
      : `${assessed} of ${total} machines were assessed. ${total - assessed} ${total - assessed === 1 ? "could not be read and is" : "could not be read and are"} not counted as a candidate or as blocked.`,
  };
}

/** One line on how much of the assessment was possible, for the verdict row. */
export function readinessCoverageNote(result) {
  if (!result) return null;
  const unread = result.unchecked?.length || 0;
  if (!unread) return `${result.coverage.ran} checks ran.`;
  return `${result.coverage.ran} checks ran against the process list. ${unread} fact${unread === 1 ? "" : "s"} could not be read without running a command inside the guest: ${result.unchecked.slice(0, 3).map((u) => u.fact).join(", ")}${unread > 3 ? ` +${unread - 3} more` : ""}.`;
}
