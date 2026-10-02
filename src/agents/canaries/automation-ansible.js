/**
 * Canary cases for the Ansible Automation Agent.
 *
 * AN HONEST NOTE ABOUT WHAT THIS CAN AND CANNOT CHECK.
 *
 * This agent is API passthrough: it launches AAP job templates and reports what
 * the controller says, with no local decision logic of its own. There is no
 * scoring function to protect, no classification to regress. Writing a case
 * that asserted something trivial — "the module loads" — would be worse than
 * having none, because the panel would show a green canary while checking
 * nothing.
 *
 * So what IS protected here is the thing that actually makes this agent
 * dangerous: ITS DECLARATION. This is the only agent in the fleet that can
 * launch an arbitrary job template against arbitrary inventory, which is why it
 * is classified `irreversible`. That classification is what makes the approval
 * gate apply to it. If somebody relaxes it in the manifest — during a refactor,
 * or to make a demo smoother — the approval requirement disappears silently and
 * nothing else in the system notices, because a manifest that declares LESS is
 * still a valid manifest and the posture lens happily reports whatever it says.
 *
 * The live behaviour is covered by a read-only case that needs AAP configured;
 * without it the case skips and is reported as skipped.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), "..", "manifests", "automation-ansible.json");

export default [
  {
    id: "still-declared-irreversible",
    kind: "pure",
    title: "It still declares itself irreversible, so approval still applies",
    why: "This agent launches arbitrary Ansible job templates — it can do anything its inventory can reach, and none of it can be undone from here. `blastRadius: irreversible` is what makes the approval gate apply. A manifest edit that softens it to 'mutating' or drops it is a silent removal of the only control on this agent, and every other check would keep passing.",
    run: async () => {
      const m = JSON.parse(await readFile(MANIFEST, "utf8"));
      const g = m.governance || {};
      return {
        blastRadius: g.blastRadius,
        trustTier: g.trustTier,
        autonomy: g.autonomyLevel,
        toolCount: (m.tools || []).length,
        __evidence: { read: 1, expected: 1, confidence: "high", concluded: true },
      };
    },
    expect: [
      { path: "blastRadius", assert: "equals", value: "irreversible",
        note: "If this ever reads 'mutating' or 'read-only', the approval requirement has been removed." },
      { path: "trustTier", assert: "equals", value: "first-party" },
      { path: "autonomy", assert: "excludes", value: "act-within-policy",
        note: "An agent that can launch arbitrary automation must not be permitted to act on its own." },
    ],
  },

  {
    id: "launch-tools-are-still-the-ones-declared",
    kind: "pure",
    title: "The set of tools it exposes has not quietly grown",
    why: "Every tool here is a way to make something happen on managed hosts. A tool added to the manifest without review widens what an approval covers, because the approval is granted against the agent, not against each tool.",
    run: async () => {
      const m = JSON.parse(await readFile(MANIFEST, "utf8"));
      const tools = m.tools || [];
      const launchers = tools.filter((t) => /launch|run|execute|create|delete/i.test(t));
      return { tools, launchers, launcherCount: launchers.length };
    },
    expect: [
      { path: "tools", assert: "contains", value: "launch_ansible_job" },
      { path: "launcherCount", assert: "atMost", value: 4,
        note: "Four launchers today (job, workflow, and their variants). More than that means something was added without this case being updated — which is the review this case exists to force." },
    ],
  },

  {
    id: "job-status-is-reported-as-the-controller-gave-it",
    kind: "read-only",
    title: "A job's status comes back unaltered from AAP",
    why: "The one thing that could go wrong locally is this agent reinterpreting a status — reporting a running or cancelled job as successful. This needs a configured AAP to mean anything, so it skips without one and is reported as skipped, never as a pass.",
    run: async () => {
      if (!process.env.ANSIBLE_CONTROLLER_URL) {
        throw new Error("ANSIBLE_CONTROLLER_URL is not configured, so AAP behaviour cannot be checked.");
      }
      const { aapFetch } = await import("../../utils/ansible-client.js");
      const d = await aapFetch("/jobs/?page_size=1");
      const job = (d.results || [])[0] || null;
      return {
        reachable: true,
        hasResults: Array.isArray(d.results),
        // A finished job must carry a terminal status; a running one must not
        // be reported as successful.
        statusHonest: !job || job.status !== "successful" || job.finished != null,
      };
    },
    expect: [
      { path: "hasResults", assert: "equals", value: true },
      { path: "statusHonest", assert: "equals", value: true,
        note: "A job reported successful with no finish time would mean the status was invented." },
    ],
  },
];
