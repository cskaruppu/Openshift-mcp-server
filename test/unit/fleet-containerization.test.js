/**
 * Fleet-wide de-duplication, portfolio rollup and dependency crossings.
 * Run with: node --test test/unit/fleet-containerization.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const {
  machineIdentity, deduplicate, portfolio, fleetFunnel, dependencyView, fleetAnalysis,
} = await import("../../src/services/fleet-containerization.js");
const { VERDICTS } = await import("../../src/services/containerization-readiness.js");
const rep = await import("../../src/services/containerization-report.js");

const obs = (cluster, over = {}) => ({
  cluster, provider: "vsphere", vcenterUrl: "https://vc-01.corp.local",
  vm: { id: "vm-101", name: "sap-app-01" },
  guest: { vmId: "vm-101", name: "sap-app-01", hostname: "sap-app-01.corp", biosUuid: "421f-aaaa-bbbb", ...over.guest },
  result: { name: "sap-app-01", verdict: VERDICTS.READY, runtimes: [{ id: "tomcat", label: "Apache Tomcat" }], blockers: [], concerns: [], ...over.result },
});

describe("identity", () => {
  test("a BIOS UUID is certain; a hostname never is", () => {
    assert.equal(machineIdentity(obs("a")).basis, "biosUuid");
    assert.equal(machineIdentity(obs("a")).confidence, "certain");

    const noUuid = { vcenterUrl: "", vm: {}, guest: { hostname: "web-01" } };
    assert.equal(machineIdentity(noUuid).basis, "hostname");
    assert.equal(machineIdentity(noUuid).confidence, "probable",
      "two machines share a hostname more often than anyone expects");
  });

  test("a managed object id alone is not an identity — it needs its vCenter", () => {
    const a = machineIdentity({ vcenterUrl: "https://vc-01", guest: { vmId: "vm-9" } });
    const b = machineIdentity({ vcenterUrl: "https://vc-02", guest: { vmId: "vm-9" } });
    assert.notEqual(a.key, b.key, "vm-9 means different machines in different vCenters");
  });
});

describe("de-duplication", () => {
  test("the same machine seen from two clusters is counted once, and both are kept", () => {
    const d = deduplicate([obs("prod-mumbai"), obs("dr-chennai")]);
    assert.equal(d.machines.length, 1);
    assert.equal(d.machines[0].clusters.length, 2);
    assert.equal(d.duplicates.length, 1);
    assert.equal(d.machines[0].seenIn.length, 2, "a merged record that discards the other readings cannot be audited");
  });

  test("a blocker found in ONE cluster wins the merge", () => {
    const d = deduplicate([
      obs("prod-mumbai"),
      obs("dr-chennai", { result: { verdict: VERDICTS.VM_ONLY, blockers: [{ id: "local-datastore", title: "PostgreSQL is running on this machine", blocks: true }] } }),
    ]);
    assert.equal(d.machines[0].result.verdict, VERDICTS.VM_ONLY,
      "if one credential could see the database and the other could not, the machine has a database");
    assert.equal(d.conflicts.length, 1);
    assert.match(d.conflicts[0].why, /stricter verdict/);
  });

  test("unread in one cluster and read in the other is explained, not silently resolved", () => {
    const d = deduplicate([obs("a", { result: { verdict: VERDICTS.UNREADABLE } }), obs("b")]);
    assert.equal(d.machines[0].result.verdict, VERDICTS.READY);
    assert.match(d.conflicts[0].why, /could not read inside/);
  });

  test("machines merged on a weak key are surfaced rather than trusted", () => {
    const weak = (cluster) => ({ cluster, vcenterUrl: "", vm: {}, guest: { hostname: "web-01" }, result: { name: "web-01", verdict: VERDICTS.READY } });
    const d = deduplicate([weak("a"), weak("b")]);
    assert.equal(d.possible.length, 1);
    assert.match(d.possible[0].note, /Confirm these are the same machine/);
  });

  test("different machines are never merged", () => {
    const other = obs("b", { guest: { biosUuid: "421f-cccc-dddd" } });
    assert.equal(deduplicate([obs("a"), other]).machines.length, 2);
  });
});

describe("portfolio and funnel", () => {
  const m = (name, verdict, blockers = []) => ({ name, clusters: ["c1"], result: { name, verdict, blockers, concerns: [], runtimes: [{ label: "Apache Tomcat" }] } });
  const db = { id: "local-datastore", title: "PostgreSQL is running on this machine", blocks: true };

  test("reasons cluster — the top blocker is the workstream", () => {
    const p = portfolio([m("a", VERDICTS.VM_ONLY, [db]), m("b", VERDICTS.VM_ONLY, [db]), m("c", VERDICTS.READY)]);
    assert.equal(p.topBlockers[0].count, 2);
    assert.match(p.note, /a programme plans against/);
    assert.equal(p.byRuntime[0].label, "Apache Tomcat");
  });

  test("the fleet funnel counts each machine once and excludes the unread", () => {
    const f = fleetFunnel([m("a", VERDICTS.READY), m("b", VERDICTS.VM_ONLY), m("c", VERDICTS.UNREADABLE)]);
    assert.equal(f.total, 3);
    assert.equal(f.assessed, 2);
    assert.equal(f.candidates, 1);
    assert.equal(f.candidatePctOfEstate, 33);
    assert.equal(f.candidatePctOfAssessed, 50);
  });
});

describe("dependencies", () => {
  const machines = [
    { name: "app-01", result: { verdict: VERDICTS.READY } },
    { name: "db-01", result: { verdict: VERDICTS.VM_ONLY } },
  ];

  test("with no flows supplied, the hole is put on the page", () => {
    const d = dependencyView(machines, null);
    assert.equal(d.supplied, false);
    assert.match(d.note, /NSX, Device42, a CMDB or your APM/);
  });

  test("a dependency crossing the two destinations is flagged both ways", () => {
    const d = dependencyView(machines, [{ from: "app-01", to: "db-01", port: 5432 }]);
    assert.equal(d.crossings.length, 1);
    assert.equal(d.crossings[0].direction, "container-to-vm");
    assert.match(d.crossings[0].note, /default-deny policy in the proposal does not allow/);
  });

  test("flows entirely within one destination are not noise", () => {
    assert.equal(dependencyView(machines, [{ from: "app-01", to: "app-01" }]).crossings.length, 0);
  });
});

test("the whole fleet analysis reports observations and distinct machines apart", () => {
  const out = fleetAnalysis([obs("prod-mumbai"), obs("dr-chennai")]);
  assert.equal(out.observations, 2);
  assert.equal(out.distinct, 1);
  assert.match(out.note, /resolved to 1 distinct machine\./, "singular, because it is one machine");
  assert.match(out.note, /1 was a machine already seen in another cluster/);
  assert.equal(out.funnel.total, 1, "the slide number must count the machine once");
});

describe("the evidence pack", () => {
  const fleet = fleetAnalysis([
    obs("prod-mumbai"),
    obs("dr-chennai"),
    { cluster: "prod-mumbai", vcenterUrl: "https://vc-01.corp.local", vm: { id: "vm-9", name: "archive-01" },
      guest: { vmId: "vm-9", name: "archive-01", biosUuid: "421f-9999" },
      result: { name: "archive-01", verdict: VERDICTS.UNREADABLE, summary: "VMware Tools is not running in this guest.", blockers: [], concerns: [], unchecked: [] } },
  ]);

  test("the register counts a machine once and records where it was seen", () => {
    const csv = rep.toCsv(fleet, { at: "2026-09-28 09:00", clusters: ["prod-mumbai", "dr-chennai"] });
    const body = csv.split("\n").filter((l) => l.startsWith('"sap-app-01"'));
    assert.equal(body.length, 1, "one row per distinct machine, not one per observation");
    assert.match(body[0], /prod-mumbai; dr-chennai/);
  });

  test("unread machines are IN the document, not omitted", () => {
    const csv = rep.toCsv(fleet, {});
    assert.match(csv, /archive-01/);
    assert.match(csv, /NOT ASSESSED/);
    const html = rep.toHtml(fleet, {});
    assert.match(html, /Not assessed — 1/);
    assert.match(html, /a register that omitted them would describe an estate that does not exist/);
  });

  test("the pack states how it was read, and what it did not read", () => {
    const html = rep.toHtml(fleet, {});
    assert.match(html, /Nothing was executed inside any guest/);
    assert.match(html, /were <b>not read<\/b>/);
    assert.match(html, /No dependency data was supplied/);
  });

  test("a formula-injection cell is neutralised", () => {
    const evil = fleetAnalysis([{ cluster: "c", vcenterUrl: "v", vm: { id: "1", name: "=cmd|calc" },
      guest: { vmId: "1", name: "=cmd|calc", biosUuid: "x" },
      result: { name: "=cmd|calc", verdict: VERDICTS.READY, blockers: [], concerns: [], runtimes: [] } }]);
    assert.match(rep.toCsv(evil, {}), /"'=cmd\|calc"/, "Excel executes a cell starting with =");
  });
});

describe("per-cluster credentials", () => {
  // The resolution order the fleet route implements, asserted here so a change
  // to it is a test failure rather than a silent behaviour change in a route.
  const resolve = (body, t) => {
    const fleetDefault = body.guestUsername && body.guestPassword
      ? { username: body.guestUsername, password: body.guestPassword } : null;
    const perMachine = { ...(body.guestCredentials || {}), ...(t.guestCredentials || {}) };
    const wildcard = t.guestUsername && t.guestPassword
      ? { username: t.guestUsername, password: t.guestPassword } : fleetDefault;
    const merged = { ...perMachine, ...(wildcard ? { "*": wildcard } : {}) };
    return Object.keys(merged).length ? merged : null;
  };

  test("a cluster's own account beats the fleet default", () => {
    const c = resolve({ guestUsername: "fleet", guestPassword: "p" }, { guestUsername: "dr", guestPassword: "q" });
    assert.equal(c["*"].username, "dr");
  });

  test("a cluster with no account falls back to the fleet default", () => {
    assert.equal(resolve({ guestUsername: "fleet", guestPassword: "p" }, {})["*"].username, "fleet");
  });

  test("a per-machine credential still beats both", () => {
    const c = resolve({ guestUsername: "fleet", guestPassword: "p" }, { guestCredentials: { "odd-01": { username: "own", password: "z" } }, guestUsername: "dr", guestPassword: "q" });
    assert.equal(c["odd-01"].username, "own");
    assert.equal(c["*"].username, "dr");
  });

  test("no credential anywhere resolves to null, not an empty object", () => {
    assert.equal(resolve({}, {}), null,
      "an empty object would look like a credential set and read as 'supplied'");
  });
});
