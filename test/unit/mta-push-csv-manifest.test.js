/**
 * The three joins: MTA inventory, CSV round trip, MTA-shaped discovery manifest.
 * Run with: node --test test/unit/mta-push-csv-manifest.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const { applicationPayload, applicationsFor, pushApplications } = await import("../../src/services/mta-client.js");
const { toMachineCsv, parseMachineCsv, splitCsvLine, csvTemplate, cell } = await import("../../src/services/machine-csv.js");
const { discoveryManifest, coordinates, manifestEntry } = await import("../../src/services/discovery-manifest.js");

const ready = { name: "sap-app-01", verdict: "container-ready", summary: "Apache Tomcat with no blockers found in what was read.",
  runtimes: [{ id: "tomcat", label: "Apache Tomcat", base: "registry.access.redhat.com/ubi9/openjdk-17-runtime", evidence: "java — …" }],
  blockers: [], concerns: [], unchecked: [{ fact: "listeningPorts", reason: "Needs a command inside the guest." }] };
const blocked = { name: "sap-db-01", verdict: "vm-only", summary: "PostgreSQL is running on this machine.",
  runtimes: [], blockers: [{ id: "local-datastore", title: "PostgreSQL is running on this machine", action: "Move the data first.", evidence: "postgres — …" }], concerns: [], unchecked: [] };

describe("pushing into MTA's inventory", () => {
  test("the record says outright that no artefact is attached", () => {
    const p = applicationPayload({ result: ready, coordinates: { instance: "https://vc-01", machineUuid: "421f-a" } });
    assert.equal(p.name, "sap-app-01");
    assert.match(p.description, /Apache Tomcat/);
    assert.match(p.description, /No repository or binary is attached/,
      "MTA analyses an artefact; a record without one returns nothing and the reason must be on the record");
    assert.equal(p.repository, undefined, "an empty repository block is worse than none — versions differ in what they accept");
  });

  test("a supplied repository is carried through in the Hub's shape", () => {
    const p = applicationPayload({ result: ready, repository: { url: "https://git/x.git", branch: "release", path: "svc" } });
    assert.deepEqual(p.repository, { kind: "git", url: "https://git/x.git", branch: "release", path: "svc" });
    assert.doesNotMatch(p.description, /No repository or binary/);
  });

  test("machines the assessment ruled out are not put in a modernisation backlog", () => {
    const { payloads, skipped } = applicationsFor([ready, blocked]);
    assert.equal(payloads.length, 1);
    assert.equal(skipped[0].name, "sap-db-01");
    assert.match(skipped[0].reason, /ruled out/);
  });

  test("nothing is written without confirmation", async () => {
    const out = await pushApplications("https://hub", [applicationPayload({ result: ready })]);
    assert.equal(out.wrote, false);
    assert.equal(out.created.length, 0);
    assert.equal(out.proposed.length, 1, "it returns exactly what it would have sent");
    assert.match(out.note, /Nothing has been written/);
  });
});

describe("the CSV round trip", () => {
  const vms = [
    { name: "sap-app-01", id: "vm-101", biosUuid: "421f-a", guestOS: "Red Hat Enterprise Linux 9 (64-bit), 64-bit", powerState: "poweredOn", cpuCount: 4, memoryGiB: 16 },
    { name: "win-01", id: "vm-202", guestOS: "Microsoft Windows Server 2019 (64-bit)", powerState: "poweredOff", cpuCount: 2, memoryGiB: 8 },
  ];

  test("what comes out goes back in, provenance block and all", () => {
    const csv = toMachineCsv(vms, { note: "Discovered from vCenter", source: "https://vc-01", at: "2026-09-28" });
    const back = parseMachineCsv(csv);
    assert.equal(back.vms.length, 2, "the provenance lines above the header must be skipped, not parsed");
    assert.equal(back.vms[0].name, "sap-app-01");
    assert.equal(back.vms[0].cpuCount, 4, "numbers come back as numbers");
    assert.equal(back.vms[0].guestOS, "Red Hat Enterprise Linux 9 (64-bit), 64-bit",
      "a guest OS string contains commas — splitting naively turns one machine into two columns of nonsense");
  });

  test("a quoted field containing commas and doubled quotes survives", () => {
    assert.deepEqual(splitCsvLine('"a,b","he said ""hi""",c'), ["a,b", 'he said "hi"', "c"]);
  });

  test("headers are matched by meaning, not by spelling", () => {
    const { vms: got } = parseMachineCsv('VM Name,Operating System,CPUs\nweb-01,RHEL 9,2');
    assert.equal(got[0].name, "web-01");
    assert.equal(got[0].guestOS, "RHEL 9");
    assert.equal(got[0].cpuCount, 2);
  });

  test("a row with no name is rejected with its line number, not silently named undefined", () => {
    const out = parseMachineCsv("Name,Guest OS\n,RHEL 9\nweb-01,RHEL 9");
    assert.equal(out.vms.length, 1);
    assert.equal(out.rejected[0].line, 2);
  });

  test("a file with no recognisable header says so instead of returning nothing", () => {
    const out = parseMachineCsv("alpha,beta\n1,2");
    assert.equal(out.vms.length, 0);
    assert.match(out.note, /No header row with a Name column/);
  });

  test("machines with no identifier are told they cannot be read or de-duplicated", () => {
    const out = parseMachineCsv("Name\nweb-01\nweb-02");
    assert.match(out.note, /neither a managed object id nor a BIOS UUID/);
  });

  test("a formula-injection cell is neutralised on export and unwrapped on import", () => {
    assert.equal(cell("=cmd|calc"), '"\'=cmd|calc"');
    assert.equal(parseMachineCsv(`Name\n${cell("=cmd|calc")}`).vms[0].name, "=cmd|calc");
  });

  test("the template carries the columns and one example row", () => {
    const t = parseMachineCsv(csvTemplate());
    assert.equal(t.vms.length, 1);
    assert.equal(t.vms[0].name, "example-vm-01");
  });
});

describe("the discovery manifest", () => {
  const entry = { vcenter: "https://vc-01.corp.local",
    vm: { id: "vm-101", name: "sap-app-01" },
    guest: { vmId: "vm-101", name: "sap-app-01", biosUuid: "421f-a", hostname: "sap-app-01.corp", powerState: "poweredOn",
      os: { fullName: "Red Hat Enterprise Linux 9 (64-bit)", id: "rhel9_64Guest" }, toolsRunning: true, ipAddress: "10.1.1.5",
      processes: [{ name: "java", owner: "tomcat", cmdLine: "/usr/bin/java -Dcatalina.base=/opt/tomcat" }] },
    result: ready };

  test("a coordinate states which identifier is stable and which is scoped", () => {
    const c = coordinates(entry);
    assert.equal(c.platform, "vsphere");
    assert.equal(c.machineUuid, "421f-a");
    assert.equal(c.managedObjectId, "vm-101");
    assert.match(c.managedObjectIdScope, /unique within https:\/\/vc-01/,
      "a MoRef without its vCenter is not an identity");
  });

  test("the manifest carries the disposition MTA has no field for", () => {
    const m = discoveryManifest([entry, { ...entry, result: blocked, guest: { ...entry.guest, name: "sap-db-01", biosUuid: "421f-b" } }], { actor: "operator" });
    assert.equal(m.kind, "DiscoveryManifest");
    assert.equal(m.sourcePlatform.type, "vsphere");
    assert.equal(m.applications.length, 2);
    assert.equal(m.summary.byVerdict["vm-only"], 1,
      "a vSphere estate contains machines that should stay machines; a manifest that could not say so describes a different estate");
    assert.equal(m.method.executedInGuest, false);
  });

  test("what was not read is part of the schema, not a footnote", () => {
    const e = manifestEntry(entry);
    assert.deepEqual(e.unread, [{ fact: "listeningPorts", reason: "Needs a command inside the guest." }]);
    assert.equal(e.observed.processes[0].commandLine, "/usr/bin/java -Dcatalina.base=/opt/tomcat",
      "the evidence every finding is drawn from must be in the document, or it cannot be argued with");
  });
});
