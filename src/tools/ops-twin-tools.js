/**
 * Ops Twin as tools (services/ops-twin.js): AI Chat and any MCP client can ask
 * "what if" questions about the cluster the request is for. Read-only: the
 * twin simulates, it never changes the cluster.
 */
import { z } from "zod";
import { activeClusterContext } from "../utils/openshift-client.js";

// The twin is cached per cluster; inside a request for another cluster the
// connection's API URL tells them apart.
const key = () => `tool:${activeClusterContext()?.apiUrl || "local"}`;

const SCENARIO_HELP = "kind: drain | node-fail | gpu-fail | rack-fail | add-model | upgrade | add-vms. "
  + "node (drain, node-fail, gpu-fail), card (gpu-fail: index or UUID), rack (rack-fail), "
  + "gpuGiB + name (add-model), count + cpu + memGiB (add-vms).";

export async function twinOverview() {
  const OT = await import("../services/ops-twin.js");
  const o = OT.overview(await OT.snapshot(key()));
  return {
    counts: o.counts, racks: o.racks, racksKnown: o.racksKnown,
    nodes: o.nodes.map((n) => ({ name: n.name, rack: n.rack, roles: n.roles, ready: n.ready, schedulable: n.schedulable, pods: n.pods, vms: n.vms.length,
      cpuUsedPct: n.cpu.alloc ? Math.round((n.cpu.req / n.cpu.alloc) * 100) : null, memUsedPct: n.mem.alloc ? Math.round((n.mem.req / n.mem.alloc) * 100) : null,
      gpus: n.cards.map((c) => ({ index: c.index, freeGiB: Math.round(((c.totalMiB - c.slices.reduce((a, s) => a + s.mib, 0)) / 1024) * 10) / 10, holders: c.slices.map((s) => s.owner) })) })),
    models: o.models,
  };
}

export async function twinSimulate(args) {
  const OT = await import("../services/ops-twin.js");
  const twin = await OT.snapshot(key());
  const sc = args.question ? OT.parseQuestion(twin, args.question) : { ...args };
  if (!sc?.kind) return { error: "Could not tell which scenario that is. Name a node, a rack, a GPU, or say drain / fails / add a model of N GiB / upgrade / migrate N VMs.", scenarios: OT.SCENARIOS };
  const out = OT.simulate(twin, sc);
  return { report: OT.report(out), verdict: out.verdict, kpis: out.kpis };
}

/** For the agent loop (services/tools-registry.js). */
export const AGENT_TOOLS = [
  {
    name: "twin_overview",
    description: "Ops Twin: a compact model of this cluster — nodes by rack, CPU/memory booked, GPU cards with free memory and who holds them, VMs, models (including ones asleep). Use before answering capacity or 'where does X run' questions.",
    input_schema: { type: "object", properties: {}, required: [] },
    handler: () => twinOverview(),
  },
  {
    name: "twin_simulate",
    description: `Ops Twin what-if, simulated on a live copy of this cluster (nothing changes): what moves, what cannot, what stops, and what to do first. Either pass a plain question (e.g. "what if tcsaiinode1 goes down") or a scenario. ${SCENARIO_HELP}`,
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "A plain-English what-if question" },
        kind: { type: "string" }, node: { type: "string" }, card: { type: "string" }, rack: { type: "string" },
        gpuGiB: { type: "number" }, name: { type: "string" }, count: { type: "number" }, cpu: { type: "number" }, memGiB: { type: "number" },
      },
      required: [],
    },
    handler: (a) => twinSimulate(a || {}),
  },
];

/** For the MCP server. */
export function registerOpsTwinTools(server) {
  server.tool("twin_overview", AGENT_TOOLS[0].description, {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await twinOverview(), null, 2) }] }));
  server.tool("twin_simulate", AGENT_TOOLS[1].description, {
    question: z.string().optional(), kind: z.string().optional(), node: z.string().optional(), card: z.string().optional(), rack: z.string().optional(),
    gpuGiB: z.number().optional(), name: z.string().optional(), count: z.number().optional(), cpu: z.number().optional(), memGiB: z.number().optional(),
  }, async (a) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await twinSimulate(a), null, 2) }] }; }
    catch (e) { return { content: [{ type: "text", text: `Ops Twin: ${e.message}` }], isError: true }; }
  });
}
