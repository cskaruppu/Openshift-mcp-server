/**
 * Inventory straight from vCenter — no migration operator required.
 * Run with: node --test test/unit/vcenter-inventory.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const {
  buildContainerViewBody, buildInventoryBody, buildContinueBody, buildDestroyViewBody,
  parseViewRef, parseToken, parseInventory, filterByName, listVcenterInventory,
} = await import("../../src/services/vcenter-inventory.js");

describe("walking the inventory", () => {
  test("the traversal goes ContainerView → view → VirtualMachine", () => {
    const b = buildInventoryBody({ view: "session[52f]view-1" });
    // Without this spec the call returns the view object and nothing else,
    // which looks exactly like an estate containing one machine.
    assert.match(b, /<selectSet xsi:type="TraversalSpec">/);
    assert.match(b, /<type>ContainerView<\/type><path>view<\/path>/);
    assert.match(b, /<skip>true<\/skip>/, "the view itself is not a machine");
  });

  test("the view is recursive, or only the root folder is searched", () => {
    assert.match(buildContainerViewBody({}), /<recursive>true<\/recursive>/);
    assert.match(buildContainerViewBody({}), /<type>VirtualMachine<\/type>/);
  });

  test("a view reference is escaped, not interpolated raw", () => {
    assert.match(buildDestroyViewBody('a"b'), /a&quot;b/);
    assert.match(buildContinueBody({ token: "t&1" }), /t&amp;1/);
  });
});

describe("parsing", () => {
  const xml = `
  <RetrievePropertiesExResponse><returnval>
    <objects>
      <obj type="VirtualMachine">vm-101</obj>
      <propSet><name>name</name><val>sap-app-01</val></propSet>
      <propSet><name>config.uuid</name><val>421f-aaaa</val></propSet>
      <propSet><name>config.hardware.numCPU</name><val>4</val></propSet>
      <propSet><name>config.hardware.memoryMB</name><val>16384</val></propSet>
      <propSet><name>runtime.powerState</name><val>poweredOn</val></propSet>
      <propSet><name>guest.guestFullName</name><val>Red Hat Enterprise Linux 9 (64-bit)</val></propSet>
    </objects>
    <objects>
      <obj type="VirtualMachine">vm-202</obj>
      <propSet><name>name</name><val>rhel9-template</val></propSet>
      <propSet><name>config.template</name><val>true</val></propSet>
    </objects>
    <token>page-2</token>
  </returnval></RetrievePropertiesExResponse>`;

  test("a machine comes back in the shape the pipeline already joins on", () => {
    const [vm, ...rest] = parseInventory(xml);
    assert.equal(vm.id, "vm-101");
    assert.equal(vm.name, "sap-app-01");
    assert.equal(vm.biosUuid, "421f-aaaa", "the de-duplication key must survive");
    assert.equal(vm.cpuCount, 4);
    assert.equal(vm.memoryGiB, 16);
    assert.equal(vm.poweredOn, true);
    assert.equal(vm.guestOS, "Red Hat Enterprise Linux 9 (64-bit)");
    // Templates carry no processes and cannot be read inside. Counting them
    // would inflate the denominator of every percentage this product reports.
    assert.equal(rest.length, 0, "a template is not a machine");
  });

  test("paging is detected rather than assumed to fit", () => {
    assert.equal(parseToken(xml), "page-2");
    assert.equal(parseToken("<objects/>"), null);
  });

  test("the view reference is read from the create response", () => {
    assert.equal(parseViewRef('<returnval type="ContainerView">session[52f]view-9</returnval>'), "session[52f]view-9");
  });

  test("the name filter matches the way MTV's search did", () => {
    const vms = [{ name: "sap-app-01" }, { name: "billing-web" }];
    assert.equal(filterByName(vms, "SAP").length, 1);
    assert.equal(filterByName(vms, "").length, 2);
  });
});

test("with no vCenter configured it degrades and says why — it never throws", async () => {
  const out = await listVcenterInventory({});
  assert.deepEqual(out.vms, []);
  assert.equal(out.source, "none");
  assert.ok(out.reason, "an empty inventory with no reason is indistinguishable from an empty estate");
});
