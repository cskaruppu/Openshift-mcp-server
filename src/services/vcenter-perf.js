// ---------------------------------------------------------------------------
// vCenter performance history — QueryPerf
// ---------------------------------------------------------------------------
/**
 * The fix for "15 of 15 machines: no utilisation history was found".
 *
 * This agent runs inside the destination cluster, so its Prometheus has no
 * history for a machine still running on VMware. vCenter has had that history
 * all along — it just is not in Forklift's inventory, and there is no REST
 * endpoint for it either. Performance data lives in the Web Services API,
 * behind QueryPerf, and that is a SOAP call.
 *
 * Two counters, chosen deliberately:
 *
 *   cpu.usagemhz.average  — megahertz actually consumed, which divides by the
 *     host's per-core clock into cores used. The percentage counter would need
 *     the same division anyway and loses precision first.
 *
 *   mem.active.average    — the working set the guest genuinely touches, in KB.
 *     NOT mem.consumed: consumed includes memory the hypervisor has backed but
 *     the guest has stopped using, which on VMware is normal and on KubeVirt is
 *     irrelevant — a migrated VM requests its configured RAM in full, so the
 *     question right-sizing answers is "how much does this guest need", and
 *     active is the honest answer to that.
 *
 * What comes back depends on the vCenter statistics level. At the default
 * level 1 the rollups are 5-minute for a day, 30-minute for a week, 2-hour for
 * a month, daily for a year — so a 30-day window is real but coarse. That is
 * fine, and it is stated: coverageOf() in rightsizing.js refuses anything too
 * thin rather than averaging it into a recommendation.
 *
 * The envelope builder and the response parser are pure, which is the part
 * that matters: they are the half that can be tested without a vCenter.
 */
import { vcSoap, vcenterConfig, xmlEscape } from "../utils/vcenter-client.js";

/** Counter names, in the order they are requested. */
export const COUNTERS = Object.freeze({ cpu: "cpu.usagemhz.average", memory: "mem.active.average" });
/** Default megahertz per core when the host's clock cannot be read. */
export const DEFAULT_MHZ_PER_CORE = 2400;
/** Longest window worth asking for. Beyond a year vCenter has nothing anyway. */
export const MAX_WINDOW_DAYS = 365;

/**
 * The QueryPerf body for one batch of VMs. Pure.
 *
 * intervalId 7200 is the 2-hour rollup, which is what a 30-day window actually
 * has at the default statistics level. Asking for 300 (5-minute) over 30 days
 * returns nothing on most appliances — vCenter does not keep it that long —
 * and an empty answer reads exactly like "this VM is idle". That confusion is
 * why the interval is derived from the window rather than hardcoded.
 */
export function intervalForWindow(days) {
  if (days <= 1) return 300;        // 5 minutes, kept for a day
  if (days <= 7) return 1800;       // 30 minutes, kept for a week
  if (days <= 31) return 7200;      // 2 hours, kept for a month
  return 86400;                     // daily, kept for a year
}

export function buildQueryPerfBody({ perfManager, entities, counterIds, days = 30, maxSample = 400 }) {
  const interval = intervalForWindow(days);
  const start = new Date(Date.now() - days * 86400_000).toISOString();
  const specs = entities.map((e) => (
    `<querySpec><entity type="VirtualMachine">${xmlEscape(e)}</entity>`
    + `<startTime>${start}</startTime>`
    + `<maxSample>${maxSample}</maxSample>`
    + counterIds.map((id) => `<metricId><counterId>${id}</counterId><instance></instance></metricId>`).join("")
    + `<intervalId>${interval}</intervalId></querySpec>`
  )).join("");
  return `<QueryPerf><_this type="PerformanceManager">${xmlEscape(perfManager)}</_this>${specs}</QueryPerf>`;
}

/** Ask the PerformanceManager which counter ids our two names map to. Pure body. */
export function buildCounterLookupBody(perfManager) {
  return `<RetrievePropertiesEx><_this type="PropertyCollector">propertyCollector</_this>`
    + `<specSet><propSet><type>PerformanceManager</type><pathSet>perfCounter</pathSet></propSet>`
    + `<objectSet><obj type="PerformanceManager">${xmlEscape(perfManager)}</obj></objectSet></specSet>`
    + `<options/></RetrievePropertiesEx>`;
}

/**
 * Map our two counter names onto this vCenter's numeric ids. Pure.
 *
 * The ids are not stable across versions, which is the trap: hardcoding
 * "counterId 6" works on one appliance and silently measures something else on
 * the next. They are always resolved by name.
 */
export function parseCounterIds(xml = "") {
  const out = {};
  // Each PerfCounterInfo carries key, nameInfo/key, groupInfo/key, rollupType.
  const blocks = xml.split(/<PerfCounterInfo|<perfCounter[ >]/).slice(1);
  for (const b of blocks) {
    const key = /<key>(\d+)<\/key>/.exec(b)?.[1];
    const group = /<groupInfo[^>]*>[\s\S]*?<key>([^<]+)<\/key>/.exec(b)?.[1];
    const name = /<nameInfo[^>]*>[\s\S]*?<key>([^<]+)<\/key>/.exec(b)?.[1];
    const rollup = /<rollupType>([^<]+)<\/rollupType>/.exec(b)?.[1];
    if (!key || !group || !name || !rollup) continue;
    const full = `${group}.${name}.${rollup}`;
    for (const [slot, want] of Object.entries(COUNTERS)) if (full === want) out[slot] = Number(key);
  }
  return out;
}

/**
 * Turn a QueryPerf response into per-entity sample arrays. Pure.
 *
 * Returns raw counter values in vCenter's own units — MHz for CPU, KB for
 * memory. Converting is a separate step because it needs the host clock, and
 * mixing the two would make the parser untestable.
 */
export function parsePerfResponse(xml = "", counterIds = {}) {
  const byEntity = new Map();
  const idFor = (n) => Object.keys(counterIds).find((k) => counterIds[k] === n) || null;

  for (const chunk of xml.split(/<returnval[\s>]/).slice(1)) {
    const entity = /<entity[^>]*>([^<]+)<\/entity>/.exec(chunk)?.[1];
    if (!entity) continue;
    const rec = byEntity.get(entity) || { cpu: [], memory: [] };

    // A PerfMetricIntSeries is <id><counterId>N</counterId>…</id> followed by
    // one <value> element PER SAMPLE — not a comma-separated list, which is
    // only how pyVmomi prints it. So each series runs from its counterId to
    // the next one, and every <value> in between is a sample. Commas are
    // accepted too, because some proxies and exporters do collapse them.
    const marks = [...chunk.matchAll(/<counterId>(\d+)<\/counterId>/g)];
    for (let i = 0; i < marks.length; i++) {
      const slot = idFor(Number(marks[i][1]));
      if (!slot) continue;
      const from = marks[i].index + marks[i][0].length;
      const to = i + 1 < marks.length ? marks[i + 1].index : chunk.length;
      for (const m of chunk.slice(from, to).matchAll(/<value>([-\d,\s]+)<\/value>/g)) {
        for (const n of m[1].split(",")) {
          const x = Number(String(n).trim());
          // vCenter writes -1 for "no sample in this interval". Averaging that
          // in would drag every busy machine towards idle.
          if (Number.isFinite(x) && x >= 0) rec[slot].push(x);
        }
      }
    }
    byEntity.set(entity, rec);
  }
  return byEntity;
}

/** MHz → cores, KB → GiB. Pure. */
export function toSamples(raw = { cpu: [], memory: [] }, { mhzPerCore = DEFAULT_MHZ_PER_CORE, windowDays = 30 } = {}) {
  const mhz = mhzPerCore > 0 ? mhzPerCore : DEFAULT_MHZ_PER_CORE;
  return {
    cpu: raw.cpu.map((v) => Number((v / mhz).toFixed(3))),
    memory: raw.memory.map((v) => Number((v / 1024 / 1024).toFixed(3))),
    windowDays,
  };
}

/**
 * Read utilisation for these VMs. Returns the shape readUtilisation() expects,
 * keyed by VM NAME, because that is what the rest of the pipeline joins on.
 *
 * Never throws. A vCenter that will not answer leaves every machine unmeasured
 * and says why — which is exactly what the panel is built to render.
 */
export async function readVcenterUtilisation(vms = [], { days = 30, mhzPerCore = null } = {}) {
  const cfg = vcenterConfig();
  if (!cfg.configured) return { source: "none", samples: {}, reason: cfg.reason };

  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Number(days) || 30));
  const withIds = vms.filter((v) => v.id);
  if (!withIds.length) {
    return { source: "none", samples: {}, reason: "No machine in this wave carries a vCenter managed object id, so its history cannot be looked up." };
  }

  try {
    let counterIds = {};
    const counterXml = await vcSoap((s) => buildCounterLookupBody(s.perfManager), { timeoutMs: 45_000 });
    counterIds = parseCounterIds(counterXml);
    if (counterIds.cpu == null || counterIds.memory == null) {
      return {
        source: "error", samples: {},
        reason: `This vCenter does not expose ${counterIds.cpu == null ? COUNTERS.cpu : COUNTERS.memory}. Raise the statistics level, or supply utilisation from your own monitoring.`,
      };
    }

    // Batched: one QueryPerf per 50 machines keeps the response parseable and
    // the call inside vCenter's own timeout.
    const raw = new Map();
    for (let i = 0; i < withIds.length; i += 50) {
      const batch = withIds.slice(i, i + 50);
      const xml = await vcSoap((s) => buildQueryPerfBody({
        perfManager: s.perfManager,
        entities: batch.map((v) => v.id),
        counterIds: [counterIds.cpu, counterIds.memory],
        days: windowDays,
      }), { timeoutMs: 90_000 });
      for (const [k, v] of parsePerfResponse(xml, counterIds)) raw.set(k, v);
    }

    const samples = {};
    let measured = 0;
    for (const vm of withIds) {
      const r = raw.get(vm.id);
      if (!r || (!r.cpu.length && !r.memory.length)) continue;
      samples[vm.name] = toSamples(r, { mhzPerCore: mhzPerCore || DEFAULT_MHZ_PER_CORE, windowDays });
      measured++;
    }

    return {
      source: measured ? "vcenter" : "none",
      samples,
      basis: measured
        ? `Read from vCenter over ${windowDays} days at the ${intervalForWindow(windowDays) / 60}-minute rollup — ${measured} of ${vms.length} machines returned history.`
        : null,
      reason: measured ? null
        : `vCenter returned no samples for any of these ${vms.length} machines over ${windowDays} days. Either the statistics level is too low to keep history that long, or these machines were powered off for the window.`,
    };
  } catch (e) {
    return { source: "error", samples: {}, reason: `vCenter performance history could not be read (${e.message}). Every machine stays unmeasured rather than being sized from a guess.` };
  }
}
