/**
 * MTA integration and the build layer.
 * Run with: node --test test/unit/mta-and-build.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert";

const {
  mtaAccessVerdict, routeHost, normaliseIssues, effortSummary, combinedView, MTA_GROUPS,
} = await import("../../src/services/mta-client.js");
const {
  imageStream, binaryBuildConfig, tektonPipeline, proposeBuildPipeline,
} = await import("../../src/services/build-pipeline.js");
const { scoreContainerisation } = await import("../../src/services/containerization-readiness.js");
const { proposeContainerBuild } = await import("../../src/services/containerization-plan.js");

describe("MTA readiness signals", () => {
  test("403 is 'installed but not readable', never 'not installed'", () => {
    const v = mtaAccessVerdict({ status: 403 });
    assert.equal(v.rbacDenied, true);
    assert.match(v.message, /installed/);
    // Reporting a permissions problem as absence sends someone to reinstall a
    // product that is running — the same trap the MTV check already avoids.
    assert.equal(mtaAccessVerdict({ status: 404 }), null);
  });

  test("all three API groups MTA has shipped under are checked", () => {
    const groups = MTA_GROUPS.map((g) => g.group);
    assert.ok(groups.includes("mta.konveyor.io"));
    assert.ok(groups.includes("tackle.konveyor.io"));
    assert.ok(groups.includes("konveyor.io"), "a customer's cluster carries whichever came with their subscription");
  });

  test("a Route's scheme follows its TLS block", () => {
    assert.equal(routeHost({ spec: { host: "mta.apps.x", tls: { termination: "edge" } } }), "https://mta.apps.x");
    assert.equal(routeHost({ spec: { host: "mta.apps.x" } }), "http://mta.apps.x");
    assert.equal(routeHost({ status: { ingress: [{ host: "a.b" }] } }), "http://a.b");
    assert.equal(routeHost({}), null);
  });
});

describe("MTA findings", () => {
  const mta6 = [{ rule: "weblogic-01", description: "WebLogic proprietary API", category: "mandatory", effort: 3,
    incidents: [{ file: "src/A.java", message: "uses weblogic.jndi" }, { file: "src/B.java" }] }];
  const mta7 = { issues: [{ ruleset: "eap8", rule: "jndi-02", description: "JNDI lookup", category: "potential", effort: 1, totalIncidents: 4 }] };
  const konveyor = { violations: [{ name: "hardcoded-ip", description: "Hardcoded IP address", effort: 1, incidents: [{ uri: "conf/app.properties" }] }] };

  test("three response shapes all normalise, none is guessed at", () => {
    for (const [raw, id] of [[mta6, "weblogic-01"], [mta7, "eap8/jndi-02"], [konveyor, "hardcoded-ip"]]) {
      const [i] = normaliseIssues(raw);
      assert.equal(i.id, id);
      assert.equal(i.source, "mta", "attribution is the point of the integration");
    }
  });

  test("effort counts incidents, not rules", () => {
    const s = effortSummary(normaliseIssues(mta6));
    assert.equal(s.points, 6, "3 points broken in 2 files is 6, not 3");
    const withUnknown = effortSummary([...normaliseIssues(mta6), { effort: null, incidents: 2 }]);
    assert.equal(withUnknown.unknown, 1);
    assert.match(withUnknown.note, /not in the total/, "an unestimated finding must not silently score zero");
  });

  test("the two columns stay separate and attributed", () => {
    const a = scoreContainerisation({
      vm: { id: "v", name: "sap-app-01" },
      guest: { name: "sap-app-01", powerState: "poweredOn", os: { fullName: "RHEL 9" }, unread: [],
        processes: [{ pid: 1, name: "java", cmdLine: "/usr/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap" }] },
    });
    const v = combinedView(a, { ok: true, flavour: "MTA 7.x", issues: normaliseIssues(mta7), effort: effortSummary(normaliseIssues(mta7)) });
    assert.match(v.platform.source, /running machine/);
    assert.match(v.code.source, /Red Hat MTA/);
    assert.equal(v.code.analysed, true);
    assert.ok(!("score" in v), "the two must not be blended into one number");
  });

  test("no artefact is an explained gap, not a silent empty column", () => {
    const v = combinedView({ name: "x", verdict: "container-ready" }, null);
    assert.equal(v.code.analysed, false);
    assert.match(v.code.reason, /cannot extract/i);
  });
});

describe("the build layer", () => {
  const tomcat = { pid: 1, name: "java", cmdLine: "/usr/bin/java -Dcatalina.base=/opt/tomcat org.apache.catalina.startup.Bootstrap" };
  const plan = proposeContainerBuild(scoreContainerisation({
    vm: { id: "v", name: "sap-app-01" },
    guest: { name: "sap-app-01", powerState: "poweredOn", os: { fullName: "RHEL 9" }, unread: [], processes: [tomcat] },
  }), { appName: "sap-app" });

  test("the BuildConfig carries the reviewed Containerfile inline", () => {
    const bc = binaryBuildConfig({ name: "sap-app", namespace: "ns", containerfile: "FROM ubi9\nUSER 1001", baseImage: "registry.access.redhat.com/ubi9/openjdk-17-runtime" });
    assert.equal(bc.json.spec.source.type, "Binary");
    assert.match(bc.json.spec.source.dockerfile, /USER 1001/,
      "inline, so what was reviewed is what gets built — no step where a different one is committed");
    assert.equal(bc.json.spec.strategy.dockerStrategy.from.kind, "DockerImage");
  });

  test("build history is kept, because the first builds all fail", () => {
    const bc = binaryBuildConfig({ name: "a", namespace: "ns", containerfile: "FROM x", baseImage: "x" });
    assert.ok(bc.json.spec.failedBuildsHistoryLimit >= 1);
  });

  test("the pipeline builds with Buildah — there is no Docker daemon on a node", () => {
    const [p] = tektonPipeline({ name: "a", namespace: "ns", imageRef: "img", deployNamespace: "dep" });
    const names = p.json.spec.tasks.map((t) => t.taskRef.name);
    assert.deepEqual(names, ["git-clone", "buildah", "image-scan", "openshift-client"]);
    assert.doesNotMatch(JSON.stringify(p.json), /docker\.sock|dind/i);
  });

  test("the scanner is deliberately not pinned", () => {
    const [p] = tektonPipeline({ name: "a", namespace: "ns", imageRef: "img", deployNamespace: "dep" });
    const scan = p.json.spec.tasks.find((t) => t.name === "scan");
    assert.equal(scan.taskRef.kind, undefined, "a plain Task the customer supplies, not a ClusterTask we chose for them");
  });

  test("a full proposal yields manifests, commands and a named toolchain", () => {
    const out = proposeBuildPipeline(plan);
    assert.equal(out.ok, true);
    const kinds = out.manifests.map((m) => m.kind);
    for (const k of ["ImageStream", "BuildConfig", "Pipeline", "PipelineRun"]) assert.ok(kinds.includes(k), `${k} missing`);
    assert.ok(out.commands.some((c) => /oc start-build .* --from-dir/.test(c)), "the no-repository path must be spelled out");
    assert.ok(out.toolchain.every((t) => t.provenance), "every component states where it comes from");
    assert.ok(out.caveats.some((c) => c.id === "binary-source"));
  });

  test("nothing is pipelined for a machine that got no build proposal", () => {
    const out = proposeBuildPipeline({ ok: false });
    assert.equal(out.ok, false);
    assert.match(out.reason, /nothing to pipeline/);
  });

  test("every generated manifest round-trips, the Containerfile byte for byte", async () => {
    const yaml = (await import("js-yaml")).default;
    for (const m of proposeBuildPipeline(plan).manifests) {
      const back = yaml.load(m.yaml);
      assert.equal(back.kind, m.json.kind, `${m.kind} did not round-trip`);
      if (m.kind === "BuildConfig") {
        assert.equal(back.spec.source.dockerfile, m.json.spec.source.dockerfile,
          "the embedded Containerfile must survive exactly — the whole claim is that what was reviewed is what gets built");
        assert.match(m.yaml, /dockerfile: \|/,
          "a literal block, not folded: folded survives a machine round-trip but not a human editing it");
      }
    }
  });
});
