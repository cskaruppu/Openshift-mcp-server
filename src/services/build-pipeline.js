// ---------------------------------------------------------------------------
// Building the thing — on the customer's own toolchain
// ---------------------------------------------------------------------------
/**
 * The step after the scaffold: what actually turns a Containerfile into a
 * running image, using tooling the customer already owns.
 *
 * Nothing here introduces a new product. A BuildConfig, an ImageStream and a
 * Tekton Pipeline all ship with OpenShift — the customer is already paying for
 * them, already patching them, and their security team has already signed them
 * off. That matters more than elegance: "we orchestrate what is in your
 * subscription" survives a procurement conversation that "we wrote a builder"
 * does not.
 *
 * TWO PATHS, because they answer different questions:
 *
 *   BINARY BUILD   — the demo and the first attempt. `oc start-build --from-dir`
 *                    uploads a directory, OpenShift builds it in-cluster with
 *                    the generated Containerfile. No git repository needed,
 *                    which matters because the application on a twelve-year-old
 *                    VM very often is not in one.
 *
 *   TEKTON PIPELINE— what it becomes once there IS a repository: clone, build
 *                    with Buildah, scan, deploy to a fenced namespace. This is
 *                    the shape that goes into a release process.
 *
 * Both are PROPOSED. Nothing here starts a build, pushes an image or creates
 * anything — same discipline as every other generator in this product, and for
 * the same reason: the first time a tool builds something a human did not read,
 * it stops being an assistant.
 *
 * Everything in this file is pure.
 */

import yaml from "js-yaml";

const dns = (s) => String(s || "app").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "app";
/**
 * lineWidth: -1 disables folding, which matters for exactly one field: the
 * Containerfile embedded in the BuildConfig. Folded (`>`) it round-trips
 * correctly but reads as a wall of double-spaced lines, and the first person to
 * hand-edit it breaks the folding without the YAML becoming invalid — so the
 * build silently gets a different file from the one that was reviewed. As a
 * literal block (`|`) it looks like what it is.
 */
const doc = (kind, name, json) => ({ kind, name, json, yaml: yaml.dump(json, { lineWidth: -1, noRefs: true }) });

/**
 * An ImageStream for the build's output.
 *
 * Deliberately the internal registry rather than an external one: it needs no
 * credential to demonstrate, and a customer who wants Quay changes one field.
 */
export function imageStream(name, namespace) {
  return doc("ImageStream", name, {
    apiVersion: "image.openshift.io/v1",
    kind: "ImageStream",
    metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } },
    spec: { lookupPolicy: { local: true } },
  });
}

/**
 * A binary BuildConfig carrying the generated Containerfile inline.
 *
 * `source.dockerfile` is the detail that makes this work without a repository:
 * OpenShift builds the uploaded directory against a Containerfile held in the
 * BuildConfig itself, so the scaffold this agent generated is what gets built,
 * exactly as reviewed, with no step where someone commits a different one.
 */
export function binaryBuildConfig({ name, namespace, containerfile, baseImage }) {
  return doc("BuildConfig", name, {
    apiVersion: "build.openshift.io/v1",
    kind: "BuildConfig",
    metadata: { name, namespace, labels: { app: name, "app.kubernetes.io/managed-by": "tcs-agentic-ai" } },
    spec: {
      source: { type: "Binary", binary: {}, dockerfile: containerfile },
      strategy: {
        type: "Docker",
        dockerStrategy: {
          // Named explicitly so the build does not silently pull a different
          // base from the one the assessment proposed.
          from: { kind: "DockerImage", name: `${baseImage}:latest` },
        },
      },
      output: { to: { kind: "ImageStreamTag", name: `${name}:latest` } },
      // A failed build that has been garbage-collected cannot be diagnosed, and
      // the first builds of a migrated workload all fail.
      successfulBuildsHistoryLimit: 5,
      failedBuildsHistoryLimit: 5,
      resources: { limits: { cpu: "2", memory: "4Gi" } },
    },
  });
}

/**
 * The Tekton pipeline, for once the application has a repository.
 *
 * Buildah rather than a Docker daemon, because there is no daemon on an
 * OpenShift node and a pipeline that assumes one fails at the first task with
 * an error nobody reads as "wrong builder".
 *
 * The scan task is a separate step with its own result on purpose: a build that
 * produces a vulnerable image has still produced an image, and merging the two
 * hides which one failed.
 */
export function tektonPipeline({ name, namespace, imageRef, deployNamespace }) {
  const pipeline = doc("Pipeline", name, {
    apiVersion: "tekton.dev/v1",
    kind: "Pipeline",
    metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "tcs-agentic-ai" } },
    spec: {
      params: [
        { name: "git-url", type: "string", description: "Repository holding the application and its Containerfile" },
        { name: "git-revision", type: "string", default: "main" },
        { name: "image", type: "string", default: imageRef },
      ],
      workspaces: [{ name: "source" }],
      tasks: [
        {
          name: "clone",
          taskRef: { name: "git-clone", kind: "ClusterTask" },
          workspaces: [{ name: "output", workspace: "source" }],
          params: [
            { name: "url", value: "$(params.git-url)" },
            { name: "revision", value: "$(params.git-revision)" },
          ],
        },
        {
          name: "build",
          runAfter: ["clone"],
          taskRef: { name: "buildah", kind: "ClusterTask" },
          workspaces: [{ name: "source", workspace: "source" }],
          params: [
            { name: "IMAGE", value: "$(params.image)" },
            { name: "DOCKERFILE", value: "./Containerfile" },
          ],
        },
        {
          name: "scan",
          runAfter: ["build"],
          // Named as a Task rather than a ClusterTask: the scanner a customer
          // uses is theirs to choose, and pinning one here would be the single
          // piece of this pipeline they have to unpick.
          taskRef: { name: "image-scan" },
          params: [{ name: "IMAGE", value: "$(params.image)" }],
        },
        {
          name: "deploy-to-sandbox",
          runAfter: ["scan"],
          taskRef: { name: "openshift-client", kind: "ClusterTask" },
          params: [{
            name: "SCRIPT",
            value: `oc -n ${deployNamespace} set image deployment/${name} ${name}=$(params.image) --record`,
          }],
        },
      ],
    },
  });

  const run = doc("PipelineRun", `${name}-run`, {
    apiVersion: "tekton.dev/v1",
    kind: "PipelineRun",
    metadata: { generateName: `${name}-`, namespace },
    spec: {
      pipelineRef: { name },
      params: [{ name: "git-url", value: "https://git.example.com/CONFIRM/your-repo.git" }],
      workspaces: [{ name: "source", volumeClaimTemplate: { spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } } }],
    },
  });

  return [pipeline, run];
}

/**
 * Everything needed to build one proposal, plus the commands to run it.
 *
 * @param {object} plan  one entry from proposeForSelection().plans
 * @returns {{ok:boolean, manifests:Array, commands:Array, caveats:Array}}
 */
export function proposeBuildPipeline(plan, opts = {}) {
  if (!plan?.ok) return { ok: false, reason: "No build was proposed for this machine, so there is nothing to pipeline." };

  const buildNs = dns(opts.buildNamespace || plan.namespace);
  const manifests = [];
  const commands = [];

  for (const cf of plan.containerfiles) {
    const name = dns(cf.tier);
    manifests.push(imageStream(name, buildNs));
    manifests.push(binaryBuildConfig({ name, namespace: buildNs, containerfile: cf.containerfile, baseImage: cf.base }));
    commands.push(
      `# ${name} — build from a local directory, no git repository required`,
      `oc apply -n ${buildNs} -f imagestream-${name}.yaml -f buildconfig-${name}.yaml`,
      `cd <the directory holding your build output>`,
      `oc start-build ${name} --from-dir=. --follow -n ${buildNs}`,
      "",
    );
  }

  const primary = dns(plan.containerfiles[0].tier);
  const pipeline = tektonPipeline({
    name: primary,
    namespace: buildNs,
    imageRef: `image-registry.openshift-image-registry.svc:5000/${buildNs}/${primary}:latest`,
    deployNamespace: plan.namespace,
  });
  manifests.push(...pipeline);

  return {
    ok: true,
    namespace: buildNs,
    manifests,
    commands,
    toolchain: [
      { component: "Build", tool: "OpenShift BuildConfig (Docker strategy)", provenance: "Ships with OpenShift" },
      { component: "Registry", tool: "OpenShift internal registry / ImageStream", provenance: "Ships with OpenShift" },
      { component: "Pipeline", tool: "Tekton — OpenShift Pipelines", provenance: "Red Hat operator, CNCF project" },
      { component: "Image build in pipeline", tool: "Buildah ClusterTask", provenance: "Ships with OpenShift Pipelines" },
      { component: "Scan", tool: "your scanner as a Task", provenance: "Customer's choice — deliberately not pinned" },
    ],
    // Caveats, not warnings. Each is something that WILL bite on the first run.
    caveats: [
      {
        id: "binary-source",
        title: "The binary build uploads a directory you have to assemble",
        detail: "`oc start-build --from-dir` sends the contents of a local directory. The agent never read the application's files, so assembling that directory — the war, the jar, the publish output — is yours.",
      },
      {
        id: "scan-task",
        title: "The scan task is not defined here",
        detail: "The pipeline references a Task called image-scan rather than pinning a scanner. Point it at Trivy, Quay's scanner or whatever your security team already approved.",
      },
      {
        id: "cluster-tasks",
        title: "ClusterTasks must exist on the cluster",
        detail: "git-clone, buildah and openshift-client come with OpenShift Pipelines. Newer versions ship them as resolver-based references instead of ClusterTasks; if the run fails to resolve a task, that is the version difference and not a broken pipeline.",
      },
      {
        id: "first-build-fails",
        title: "Expect the first build to fail",
        detail: "Every placeholder path in the Containerfile is a guess this agent was honest about. The first build failing on a missing COPY source is the system working.",
      },
    ],
  };
}
