/**
 * Containerisation assessment tools.
 *
 * The VM Migration Agent answers "can this machine move". These answer the
 * different question "should this machine still be a machine" — and the two
 * are allowed to disagree, which is the point. One discovery pass, two
 * dispositions, both landing on the same cluster.
 *
 * Read-only by construction. Nothing here builds an image, writes to a guest
 * or creates anything on the target: the assessment is what a human argues
 * with before any of that is proposed.
 */

import { z } from "zod";
import { discoverVMs } from "../services/vm-migration.js";
import { discoverGuests } from "../services/guest-discovery.js";
import {
  scoreSelection, containerisationFunnel, readinessCoverageNote, VERDICT_LABEL,
} from "../services/containerization-readiness.js";
import { proposeContainerBuild } from "../services/containerization-plan.js";
import { mtaReadiness, applicationIssues, effortSummary, combinedView } from "../services/mta-client.js";
import { proposeBuildPipeline } from "../services/build-pipeline.js";
import { resolveForProvider } from "../services/vcenter-registry.js";
import { ocpGet } from "../utils/openshift-client.js";

const text = (s) => ({ content: [{ type: "text", text: s }] });

/**
 * Guest credentials are a policy decision, not a convenience.
 *
 * They are accepted per call and never persisted — a stored credential that
 * can log in to every machine in an estate is a bigger liability than the
 * assessment is worth. Without one, the tool still reports OS, power state and
 * tools status, and says plainly that nothing inside was read.
 */
const credShape = {
  guestUsername: z.string().optional().describe("Account INSIDE the guest (local or domain), not a vCenter login. Omit to assess without reading processes."),
  guestPassword: z.string().optional().describe("Password for the guest account. Never stored."),
};

export function registerContainerizeTools(server) {
  server.tool(
    "containerize_assess",
    "Assess which VMs on a source provider should become containers rather than being migrated as VMs. Reads what is running inside each guest and scores it, naming the blockers.",
    {
      provider: z.string().describe("MTV source provider uid or name (the vSphere provider holding these VMs)"),
      search: z.string().optional().describe("Filter the VM inventory by name"),
      limit: z.number().optional().default(25).describe("Maximum machines to assess in one call"),
      ...credShape,
    },
    async ({ provider, search = "", limit = 25, guestUsername, guestPassword }) => {
      let vms;
      try {
        vms = await discoverVMs(provider, { search });
      } catch (e) {
        return text(`Could not read the VM inventory for provider "${provider}": ${e.message}`);
      }
      if (!vms?.length) return text(`No VMs found on provider "${provider}"${search ? ` matching "${search}"` : ""}.`);

      const selection = vms.slice(0, Math.max(1, limit));
      const cfg = await resolveVcenterFor(provider);
      const creds = guestUsername && guestPassword ? { "*": { username: guestUsername, password: guestPassword } } : null;
      const { guests, coverage, reason } = await discoverGuests(selection, { cfg, guestCredentials: creds });
      const results = scoreSelection(selection, guests);
      const funnel = containerisationFunnel(results);

      const lines = [
        `# Containerisation assessment — ${funnel.total} machine${funnel.total === 1 ? "" : "s"}`,
        "",
        funnel.note,
        `Candidates: ${funnel.candidates} — ${funnel.candidatePctOfEstate}% of the machines asked about, ${funnel.candidatePctOfAssessed}% of those that answered.`,
        "",
      ];
      if (reason) lines.push(`Discovery: ${reason}`, "");
      if (!creds) {
        lines.push("No guest credential was supplied, so nothing inside these machines was read. Every machine below is reported as not assessed — which is not the same as having no blockers.", "");
      } else {
        lines.push(`Read the process list on ${coverage.processes} of ${coverage.total} machines.`, "");
      }

      for (const r of results) {
        lines.push(`## ${r.name || r.vmId} — ${VERDICT_LABEL[r.verdict]}`);
        lines.push(r.summary);
        for (const b of r.blockers) lines.push(`- **Blocker — ${b.title}.** ${b.detail} _Action:_ ${b.action}${b.evidence ? `\n  _Seen:_ \`${b.evidence}\`` : ""}`);
        for (const c of r.concerns.filter((x) => x.required)) lines.push(`- **Needs work — ${c.title}.** ${c.detail}`);
        const note = readinessCoverageNote(r);
        if (note) lines.push(`_${note}_`);
        lines.push("");
      }
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "containerize_inspect_guest",
    "Read what is running inside one virtual machine — guest OS, VMware Tools state, and the process list with command lines. Read-only; nothing is executed in the guest.",
    {
      provider: z.string().describe("MTV source provider uid or name"),
      vm: z.string().describe("VM name as the source inventory reports it"),
      ...credShape,
    },
    async ({ provider, vm, guestUsername, guestPassword }) => {
      let vms;
      try {
        vms = await discoverVMs(provider, { search: vm });
      } catch (e) {
        return text(`Could not read the VM inventory: ${e.message}`);
      }
      const match = (vms || []).find((v) => v.name === vm) || (vms || [])[0];
      if (!match) return text(`No VM named "${vm}" was found on provider "${provider}".`);

      const cfg = await resolveVcenterFor(provider);
      const creds = guestUsername && guestPassword ? { "*": { username: guestUsername, password: guestPassword } } : null;
      const { guests } = await discoverGuests([match], { cfg, guestCredentials: creds });
      const g = guests.get(match.id || match.name);
      if (!g) return text(`Nothing came back for "${vm}".`);

      const out = [
        `# ${g.name || vm}`,
        `- Power state: ${g.powerState || "not reported"}`,
        `- Guest OS: ${g.os?.fullName || "not reported"}`,
        `- Hostname: ${g.hostname || "not reported"}`,
        `- Address: ${g.ipAddress || "not reported"}`,
        `- VMware Tools: ${g.toolsRunning === null ? "not reported" : g.toolsRunning ? "running" : "not running"}`,
        "",
      ];
      if (!Array.isArray(g.processes)) {
        out.push(`**Processes were not read.** ${g.processReason || ""}`);
      } else if (!g.processes.length) {
        out.push("**No processes are running.** The guest answered with an empty list — that is a reading, not a failure to read.");
      } else {
        out.push(`## ${g.processes.length} processes`, "");
        for (const p of g.processes.slice(0, 60)) {
          out.push(`- \`${p.name}\`${p.owner ? ` (${p.owner})` : ""}${p.cmdLine ? ` — ${p.cmdLine.slice(0, 180)}` : ""}`);
        }
        if (g.processes.length > 60) out.push(`- …and ${g.processes.length - 60} more`);
      }
      out.push("", "Facts no process list can carry, and which were therefore NOT read:");
      for (const u of g.unread || []) out.push(`- ${u.fact}: ${u.reason}`);
      return text(out.join("\n"));
    },
  );

  server.tool(
    "containerize_plan",
    "Propose a Containerfile and OpenShift manifests for a VM the assessment cleared. Proposes only — nothing is built, pushed or deployed — and refuses for any machine that was blocked or could not be read.",
    {
      provider: z.string().describe("MTV source provider uid or name"),
      vm: z.string().describe("VM name as the source inventory reports it"),
      namespace: z.string().optional().describe("Target namespace for the proposal"),
      ...credShape,
    },
    async ({ provider, vm, namespace, guestUsername, guestPassword }) => {
      let vms;
      try { vms = await discoverVMs(provider, { search: vm }); }
      catch (e) { return text(`Could not read the VM inventory: ${e.message}`); }
      const match = (vms || []).find((v) => v.name === vm) || (vms || [])[0];
      if (!match) return text(`No VM named "${vm}" was found on provider "${provider}".`);

      const cfg = await resolveVcenterFor(provider);
      const creds = guestUsername && guestPassword ? { "*": { username: guestUsername, password: guestPassword } } : null;
      const { guests } = await discoverGuests([match], { cfg, guestCredentials: creds });
      const [result] = scoreSelection([match], guests);
      const plan = proposeContainerBuild(result, { namespace, appName: match.name });

      if (!plan.ok) {
        return text([
          `# ${match.name} — no build proposed`, "",
          plan.refusal.message, "",
          "Nothing was generated. A scaffold built from a machine that was blocked, or that could not be read, is a guess wearing YAML.",
        ].join("\n"));
      }

      const out = [
        `# ${plan.machine} — proposed build`, "",
        `Namespace \`${plan.namespace}\` · ${plan.tiers.length} tier${plan.tiers.length === 1 ? "" : "s"} · verdict ${plan.verdict}`,
        "", "**Nothing has been built, pushed or deployed.**", "",
      ];
      for (const cf of plan.containerfiles) {
        out.push(`## Containerfile — ${cf.tier} (${cf.runtimeLabel})`, "", "```dockerfile", cf.containerfile, "```", "");
      }
      out.push("## Manifests", "");
      for (const m of plan.manifests) out.push(`### ${m.kind} / ${m.name}`, "", "```yaml", m.yaml.trim(), "```", "");
      out.push("## Assumptions — every one of these needs confirming", "");
      for (const a of plan.assumptions) out.push(`- **${a.field}** = \`${a.value}\`. ${a.why} _${a.confirm}_`);
      out.push("", "## Next", "");
      plan.nextSteps.forEach((n, i) => out.push(`${i + 1}. ${n}`));
      return text(out.join("\n"));
    },
  );

  server.tool(
    "containerize_toolchain_check",
    "Check the open-source toolchain this agent hands work to: Red Hat MTA for code analysis, and what is needed to build. Reports exactly why anything is unusable rather than reporting it as absent.",
    {},
    async () => {
      const mta = await mtaReadiness();
      const lines = ["# Toolchain", "",
        "| Layer | Tool | Status |", "|---|---|---|",
        "| VM migration | MTV / Konveyor Forklift | integrated |",
        `| Code analysis | Red Hat MTA${mta.flavour ? ` (${mta.flavour})` : ""} | ${mta.ok ? `reachable at ${mta.hubUrl}` : "not usable — see below"} |`,
        "| Build | OpenShift BuildConfig, Buildah | proposed per machine |",
        "| Pipeline | Tekton / OpenShift Pipelines | proposed per machine |",
        "| Run | OpenShift, KubeVirt | integrated |", ""];
      for (const b of mta.blocking || []) lines.push(`**Blocked — ${b.code}.** ${b.message}`);
      for (const w of mta.warnings || []) lines.push(`_Warning — ${w.code}._ ${w.message}`);
      if (mta.ok) lines.push(`MTA Hub discovered via ${mta.hubUrlSource}${mta.namespace ? ` in namespace ${mta.namespace}` : ""}.`);
      return text(lines.join("\n"));
    },
  );

  server.tool(
    "containerize_code_analysis",
    "Fetch Red Hat MTA's findings for an application and show them beside this agent's findings from the running machine. The two are never blended: MTA reports what is wrong inside the code, the agent what is wrong around it.",
    {
      application: z.string().describe("The application's name or id as MTA knows it"),
      provider: z.string().optional().describe("MTV source provider, to pair the findings with a machine assessment"),
      vm: z.string().optional().describe("VM name to assess alongside"),
      ...credShape,
    },
    async ({ application, provider, vm, guestUsername, guestPassword }) => {
      const ready = await mtaReadiness();
      if (!ready.ok) {
        const why = (ready.blocking || [])[0]?.message || (ready.warnings || [])[0]?.message || "MTA is not usable on this cluster.";
        return text(`Red Hat MTA is not usable here, so there is no code column to show.\n\n${why}`);
      }
      let mta;
      try { mta = await applicationIssues(ready.hubUrl, application); }
      catch (e) { return text(`MTA is reachable but would not return findings for "${application}": ${e.message}`); }

      let assessment = null;
      if (provider && vm) {
        try {
          const vms = await discoverVMs(provider, { search: vm });
          const match = (vms || []).find((v) => v.name === vm) || (vms || [])[0];
          if (match) {
            const cfg = await resolveVcenterFor(provider);
            const creds = guestUsername && guestPassword ? { "*": { username: guestUsername, password: guestPassword } } : null;
            const { guests } = await discoverGuests([match], { cfg, guestCredentials: creds });
            [assessment] = scoreSelection([match], guests);
          }
        } catch { /* the code column stands on its own */ }
      }

      const view = combinedView(assessment, { ok: true, flavour: ready.flavour, ...mta });
      const out = [`# ${application}`, "", view.division, ""];
      out.push(`## ${view.platform.source}`, "");
      if (view.platform.verdict) {
        out.push(`**${view.platform.verdict}** — ${view.platform.summary}`, "");
        for (const b of view.platform.blockers) out.push(`- Blocker: ${b.title}`);
        for (const c of view.platform.concerns) out.push(`- Needs work: ${c.title}`);
      } else {
        out.push("_No machine was assessed alongside this application._");
      }
      out.push("", `## ${view.code.source}`, "", mta.effort.note, "");
      for (const i of mta.issues.slice(0, 40)) {
        out.push(`- **${i.title}** \`${i.id}\`${i.category ? ` · ${i.category}` : ""}${i.effort != null ? ` · ${i.effort} pts × ${i.incidents || 1}` : ""}`);
        if (i.files.length) out.push(`  ${i.files.join(", ")}`);
      }
      if (mta.issues.length > 40) out.push(`- …and ${mta.issues.length - 40} more`);
      return text(out.join("\n"));
    },
  );

  server.tool(
    "containerize_build_manifests",
    "Propose the build for an assessed machine on the customer's own toolchain: an ImageStream, a BuildConfig carrying the reviewed Containerfile inline, and a Tekton pipeline. Proposes only — starts nothing.",
    {
      provider: z.string().describe("MTV source provider uid or name"),
      vm: z.string().describe("VM name as the source inventory reports it"),
      buildNamespace: z.string().optional(),
      ...credShape,
    },
    async ({ provider, vm, buildNamespace, guestUsername, guestPassword }) => {
      let vms;
      try { vms = await discoverVMs(provider, { search: vm }); }
      catch (e) { return text(`Could not read the VM inventory: ${e.message}`); }
      const match = (vms || []).find((v) => v.name === vm) || (vms || [])[0];
      if (!match) return text(`No VM named "${vm}" was found.`);

      const cfg = await resolveVcenterFor(provider);
      const creds = guestUsername && guestPassword ? { "*": { username: guestUsername, password: guestPassword } } : null;
      const { guests } = await discoverGuests([match], { cfg, guestCredentials: creds });
      const [result] = scoreSelection([match], guests);
      const plan = proposeContainerBuild(result, { appName: match.name });
      if (!plan.ok) return text(`# ${match.name} — no build proposed\n\n${plan.refusal.message}`);

      const build = proposeBuildPipeline(plan, { buildNamespace });
      const out = [`# ${plan.machine} — build proposal`, "", "**Nothing has been built or started.**", "",
        "| Layer | Tool | Where it comes from |", "|---|---|---|"];
      for (const t of build.toolchain) out.push(`| ${t.component} | ${t.tool} | ${t.provenance} |`);
      out.push("", "## Run it", "", "```bash", ...build.commands, "```", "", "## Manifests", "");
      for (const m of build.manifests) out.push(`### ${m.kind} / ${m.name}`, "", "```yaml", m.yaml.trim(), "```", "");
      out.push("## Before you do", "");
      for (const c of build.caveats) out.push(`- **${c.title}.** ${c.detail}`);
      return text(out.join("\n"));
    },
  );
}

/** The vCenter credential MTV already holds for this provider. */
async function resolveVcenterFor(provider) {
  try {
    const { checkMtvReadiness } = await import("../services/vm-migration.js");
    const mtv = await checkMtvReadiness().catch(() => null);
    const sp = (mtv?.sources || []).find((s) => s.uid === provider || s.name === provider) || null;
    return await resolveForProvider(sp, {}, async (name, ns) => ocpGet(`/api/v1/namespaces/${ns}/secrets/${name}`));
  } catch {
    return null; // discoverGuests falls back to the configured credential and reports why
  }
}
