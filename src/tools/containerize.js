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
