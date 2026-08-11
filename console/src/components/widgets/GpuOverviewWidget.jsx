import { useMemo } from "react";
import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { useActiveCluster } from "../../store/clusterStore";
import { useChatStore } from "../../store/chatStore";
import { useViewStore } from "../../store/viewStore";
import { WidgetCard } from "../WidgetCard";

/* GPU utilization → color. Restrained, threshold-only palette:
   idle (blue, wasteful) · light (slate) · busy (green) · saturated (amber/red). */
function utilColor(pct) {
  if (pct == null) return "var(--border)";
  if (pct >= 90) return "#ef4444";
  if (pct >= 70) return "#22c55e";
  if (pct >= 30) return "#3b82f6";
  if (pct >= 5) return "#64748b";
  return "#1e293b"; // effectively idle
}
function tempColor(t) {
  if (t == null) return "var(--text2)";
  if (t >= 87) return "#ef4444";
  if (t >= 80) return "#f59e0b";
  return "#22c55e";
}
const HEALTH_TONE = { healthy: "#22c55e", warning: "#f59e0b", critical: "#ef4444" };

function Stat({ label, value, sub, tone, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 108 }}>
      {/* Proportional figures, not tabular — tabular gives every digit the width
          of a zero, which reads loose at display sizes. Tabular is for columns. */}
      <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.05, color: tone || "var(--text)" }}>{value}</span>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text2)", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</span>
      {children}
      {sub && <span style={{ fontSize: 11, color: "var(--text2)" }}>{sub}</span>}
    </div>
  );
}

/* A meter is for ONE ratio against a real limit. The fill carries severity; the
   unfilled track is a lighter step of the same colour, so the state reads across
   the whole bar rather than only where the fill stops. */
function Meter({ pct, tone, width = 96 }) {
  if (pct == null) return null;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ width, height: 6, borderRadius: 999, overflow: "hidden",
      background: `color-mix(in srgb, ${tone} 16%, transparent)` }}>
      <div style={{ width: `${p}%`, height: "100%", background: tone,
        borderRadius: 999, transition: "width .35s ease-out" }} />
    </div>
  );
}

/* Four GPUs is not a ratio worth a meter — it is four things. Discrete pips read
   the count at a glance and stay honest at small n. */
function Pips({ total, filled, tone = "#22c55e", max = 16 }) {
  if (!total || total > max) return null;
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} style={{
          width: 10, height: 6, borderRadius: 2,
          background: i < filled ? tone : "color-mix(in srgb, var(--text2) 22%, transparent)",
        }} />
      ))}
    </div>
  );
}

/* Status never rides on colour alone — icon and label travel with it. */
function HealthBadge({ health, affected }) {
  const M = {
    healthy:  { tone: "#22c55e", icon: "✓", label: "OK" },
    warning:  { tone: "#f59e0b", icon: "!", label: "Warn" },
    critical: { tone: "#ef4444", icon: "✕", label: "Critical" },
    unknown:  { tone: "var(--text2)", icon: "?", label: "Unknown" },
  };
  const s = M[health] || M.unknown;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 108 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 20, fontWeight: 800, color: s.tone, lineHeight: 1.05 }}>
        <span aria-hidden="true" style={{
          width: 20, height: 20, borderRadius: 999, fontSize: 12, fontWeight: 700,
          display: "grid", placeItems: "center", color: s.tone,
          background: `color-mix(in srgb, ${s.tone} 18%, transparent)`,
        }}>{s.icon}</span>
        {s.label}
      </span>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text2)", textTransform: "uppercase", letterSpacing: ".04em" }}>Health</span>
      <span style={{ fontSize: 11, color: "var(--text2)" }}>{affected > 0 ? `${affected} affected` : "all nominal"}</span>
    </div>
  );
}

export function GpuOverviewWidget() {
  const cluster = useActiveCluster();
  const setSeed = useChatStore((s) => s.setSeed);
  const setActiveView = useViewStore((s) => s.setActiveView);

  const { data, isLoading, isError } = useClusterQuery("/api/dashboard/gpu", {
    refetchInterval: REFRESH.STANDARD,
  });

  const s = data?.summary;
  const gpus = useMemo(() => (Array.isArray(data?.gpus) ? data.gpus : []), [data]);
  const waste = useMemo(() => (Array.isArray(data?.waste) ? data.waste : []), [data]);

  function askAI(seed) {
    setSeed(cluster, seed);
    setActiveView("chat");
  }

  // ── Empty / not-detected state ──────────────────────────────────────────
  const notAvailable = data && data.available === false;

  return (
    <WidgetCard
      title="GPU Fleet"
      className="span-all"
      linkTo="chat"
      linkLabel="Ask AI about GPUs"
    >
      {isLoading && <div className="metric-skeleton" />}
      {isError && !data && (
        <div className="metric-error"><span className="metric-error-msg">Couldn’t load GPU metrics</span></div>
      )}

      {!isLoading && notAvailable && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "18px 6px" }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10, flexShrink: 0,
            display: "grid", placeItems: "center",
            background: data.reason === "no-gpu-hardware" || data.reason === "operator-without-hardware"
              ? "color-mix(in srgb, var(--text2) 8%, transparent)"
              : "color-mix(in srgb, #f59e0b 14%, transparent)",
            color: data.reason === "no-gpu-hardware" || data.reason === "operator-without-hardware"
              ? "var(--text2)" : "#f59e0b",
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10v4M11 10v4M15 10v4" /><path d="M3 9h-1M3 15h-1M22 9h-1M22 15h-1" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
              {{
                "no-gpu-hardware":         "No GPUs on this cluster",
                "operator-missing":        "GPU hardware found — NVIDIA GPU Operator not installed",
                "operator-not-working":    "GPU Operator installed, but GPUs are not available to Kubernetes",
                "operator-without-hardware": "GPU Operator installed — no GPU hardware present",
                "gpu-nodes-without-metrics": "GPUs detected — metrics pending",
                "metrics-unreachable":     "GPU status unknown — metrics backend unreachable",
                "inventory-unreadable":    "GPU status unknown — cannot read this cluster",
                "cluster-unreachable":     "Cluster unreachable",
              }[data.reason] || "No GPUs on this cluster"}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text2)", lineHeight: 1.55, maxWidth: 620 }}>
              {data.message}
            </div>
            {data.stack && (data.stack.pciGpuNodes > 0 || data.stack.operatorInstalled) && (
              <div style={{ fontSize: 11.5, color: "var(--text2)", marginTop: 6, opacity: .85 }}>
                {[
                  `${data.stack.pciGpuNodes} node(s) with GPU hardware`,
                  `operator ${data.stack.operatorInstalled ? "installed" : "not installed"}`,
                  data.stack.clusterPolicyState ? `ClusterPolicy: ${data.stack.clusterPolicyState}` : null,
                  `${data.stack.gpuCapacity} allocatable GPU(s)`,
                ].filter(Boolean).join("  ·  ")}
              </div>
            )}
            {data.remediation?.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text2)", lineHeight: 1.6 }}>
                {data.remediation.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
            {data.docs && (
              <a href={data.docs} target="_blank" rel="noreferrer"
                 style={{ display: "inline-block", marginTop: 8, fontSize: 12, fontWeight: 600, color: "#3b82f6", textDecoration: "none" }}>
                NVIDIA GPU Operator install guide →
              </a>
            )}
          </div>
        </div>
      )}

      {!isLoading && data && data.available && s && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Telemetry banner — hardware is visible, live metrics are not. */}
          {data.telemetry === "unavailable" && (
            <div style={{
              padding: "10px 14px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
              background: "color-mix(in srgb, #3b82f6 10%, transparent)",
              border: "1px solid color-mix(in srgb, #3b82f6 32%, transparent)",
            }}>
              <strong style={{ color: "#3b82f6" }}>Inventory only — live GPU telemetry unavailable</strong>
              <div style={{ color: "var(--text2)", marginTop: 3 }}>{data.telemetryReason}</div>
              {data.telemetryRemediation?.length > 0 && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--text2)" }}>
                  {data.telemetryRemediation.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Summary strip */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "18px 26px", alignItems: "flex-start" }}>
            {/* A count, not a ratio — no meter. */}
            <Stat label="GPUs" value={s.totalGpus} sub={`${s.nodes} node${s.nodes === 1 ? "" : "s"}`} />

            {/* Four discrete things read better as pips than as a bar. */}
            <Stat label="Allocated" value={`${s.allocatedGpus}/${s.totalGpus}`} sub={`${s.unallocatedGpus} free`}>
              <Pips total={s.totalGpus} filled={s.allocatedGpus} />
            </Stat>

            {/* Utilisation is magnitude, not severity — high is GOOD for a GPU.
                Colouring it red at 90% would say "problem" about a fleet doing
                exactly what it was bought to do. The waste case is called out in
                the insights instead. */}
            {s.avgUtilPct != null && (
              <Stat label="Avg Util" value={`${s.avgUtilPct}%`} sub={`peak ${s.maxUtilPct}%`}>
                <Meter pct={s.avgUtilPct} tone="#3b82f6" />
              </Stat>
            )}

            {/* Every severity-coloured meter names its state in text as well.
                Amber and green sit within ΔE 6 for a protanope, so colour alone
                would not carry the difference. */}
            {s.memPct != null && (
              <Stat label="GPU Mem" value={`${s.memPct}%`}
                sub={[
                  s.memTotalGiB ? `${s.memUsedGiB} / ${s.memTotalGiB} GiB` : null,
                  s.memPct >= 95 ? "near limit" : s.memPct >= 85 ? "high" : null,
                ].filter(Boolean).join(" · ")}>
                <Meter pct={s.memPct} tone={s.memPct >= 95 ? "#ef4444" : s.memPct >= 85 ? "#f59e0b" : "#22c55e"} />
              </Stat>
            )}

            {/* Metered only when the cards report their own cap. No cap, no
                denominator, no meter — a spec-sheet TDP would be a guess. */}
            {(s.totalPowerKW || s.totalPowerW) && (
              <Stat label="Power" value={s.totalPowerKW ? `${s.totalPowerKW} kW` : `${s.totalPowerW} W`}
                sub={[
                  s.totalPowerLimitW ? `of ${Math.round(s.totalPowerLimitW / 100) / 10} kW cap` : null,
                  s.powerPct >= 90 ? "near cap" : null,
                ].filter(Boolean).join(" · ") || null}>
                <Meter pct={s.powerPct} tone={s.powerPct >= 90 ? "#f59e0b" : "#22c55e"} />
              </Stat>
            )}

            {/* Thermal headroom against the throttle point, not against 100°C. */}
            {s.maxTempC != null && (
              <Stat label="Max Temp" value={`${s.maxTempC}°C`} tone={tempColor(s.maxTempC)}
                sub={s.maxTempC >= 87 ? "throttling" : s.maxTempC >= 80 ? "hot" : "headroom to 80°C"}>
                <Meter pct={Math.round((s.maxTempC / 95) * 100)} tone={tempColor(s.maxTempC)} />
              </Stat>
            )}

            {s.health && s.health !== "unknown" && (
              <HealthBadge health={s.health} affected={s.unhealthyGpus} />
            )}
          </div>

          {/* Allocation bar — the single most important GPU fact, made visual.
              Every card is either working, reserved, or idle capital. */}
          {data.inventory?.totalGpus > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, opacity: .75, letterSpacing: .3 }}>FLEET ALLOCATION</span>
                <span style={{ fontSize: 11.5, color: "var(--text2)" }}>
                  {data.inventory.totalAllocated} allocated · {data.inventory.totalFree} free
                  {data.inventory.pendingGpus > 0 && ` · ${data.inventory.pendingGpus} requested and waiting`}
                </span>
              </div>
              <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden",
                background: "color-mix(in srgb, var(--text2) 15%, transparent)" }}>
                <div title={`${data.inventory.totalAllocated} allocated`}
                  style={{ width: `${(data.inventory.totalAllocated / data.inventory.totalGpus) * 100}%`, background: "#22c55e" }} />
                <div title={`${data.inventory.totalFree} free`}
                  style={{ width: `${(data.inventory.totalFree / data.inventory.totalGpus) * 100}%`,
                    background: "color-mix(in srgb, var(--text2) 22%, transparent)" }} />
              </div>
              {data.inventory.pendingCount > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: "#fbbf24" }}>
                  {data.inventory.pendingCount} job(s) queued for GPUs
                  {data.inventory.fragmentation?.largestFreeBlock != null &&
                    ` · largest free block on a single node: ${data.inventory.fragmentation.largestFreeBlock}`}
                </div>
              )}
            </div>
          )}

          {/* Insights — contention and waste, each with its evidence attached.
              These need no telemetry, which is the point: the view stays useful
              when monitoring is broken. */}
          {data.insights?.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              {data.insights.map((ins, i) => {
                const tone = ins.severity === "critical" ? "#ef4444" : ins.severity === "warning" ? "#f59e0b" : "#3b82f6";
                return (
                  <div key={i} style={{
                    padding: "10px 13px", borderRadius: 10,
                    background: `color-mix(in srgb, ${tone} 9%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)`,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: tone }}>{ins.title}</div>
                      <button
                        onClick={() => askAI(`${ins.title}. ${ins.detail} What should I do about this?`)}
                        style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, cursor: "pointer",
                          padding: "3px 9px", borderRadius: 7, border: `1px solid ${tone}`,
                          background: "transparent", color: tone }}>
                        Ask AI
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.5, marginTop: 3 }}>{ins.detail}</div>
                    {ins.evidence?.length > 0 && (
                      <ul style={{ margin: "5px 0 0", paddingLeft: 16, fontSize: 11,
                        color: "var(--text2)", opacity: .85, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                        {ins.evidence.map((e, j) => <li key={j}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Who holds the GPUs, and who is waiting for them */}
          {(data.inventory?.consumers?.length > 0 || data.inventory?.pending?.length > 0) && (
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              {data.inventory.consumers?.length > 0 && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "6px 11px", fontSize: 11, fontWeight: 700, opacity: .75,
                    borderBottom: "1px solid var(--border)", letterSpacing: .3 }}>
                    RUNNING ON GPUs <span style={{ opacity: .6 }}>({data.inventory.consumerCount})</span>
                  </div>
                  {data.inventory.consumers.slice(0, 6).map((c, i) => (
                    <div key={i} style={{ padding: "5px 11px", fontSize: 11.5, display: "flex",
                      justifyContent: "space-between", gap: 8, borderTop: i ? "1px solid var(--border)" : "none" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ opacity: .6 }}>{c.namespace}/</span>{c.pod}
                      </span>
                      <span style={{ flexShrink: 0, fontWeight: 700, color: "#22c55e" }}>{c.gpus} GPU</span>
                    </div>
                  ))}
                </div>
              )}
              {data.inventory.pending?.length > 0 && (
                <div style={{ border: "1px solid color-mix(in srgb, #f59e0b 35%, transparent)", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "6px 11px", fontSize: 11, fontWeight: 700, color: "#f59e0b",
                    borderBottom: "1px solid var(--border)", letterSpacing: .3 }}>
                    WAITING FOR GPUs <span style={{ opacity: .7 }}>({data.inventory.pendingCount})</span>
                  </div>
                  {data.inventory.pending.slice(0, 6).map((p, i) => (
                    <div key={i} style={{ padding: "5px 11px", fontSize: 11.5, borderTop: i ? "1px solid var(--border)" : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span style={{ opacity: .6 }}>{p.namespace}/</span>{p.pod}
                        </span>
                        <span style={{ flexShrink: 0, fontWeight: 700, color: "#fbbf24" }}>
                          {p.gpus} GPU · {p.waitingMinutes}m
                        </span>
                      </div>
                      {p.detail && <div style={{ fontSize: 10.5, opacity: .65, marginTop: 1 }}>{p.detail}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Hardware detail — model, memory, driver, MIG. From the API server,
              so it renders whether or not DCGM is reporting. */}
          {data.inventory?.nodes?.length > 0 && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "7px 12px", fontSize: 11.5, fontWeight: 700, opacity: .75,
                borderBottom: "1px solid var(--border)" }}>GPU hardware</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ textAlign: "left", opacity: .6 }}>
                      {["NODE", "MODEL", "GPUs", "ALLOCATED", "MEM/GPU", "DRIVER", "MIG"].map((h) => (
                        <th key={h} style={{ padding: "5px 10px", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.inventory.nodes.map((n) => (
                      <tr key={n.name} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>
                          {n.name}
                          {!n.ready && <span style={{ color: "#fca5a5", marginLeft: 6 }}>NotReady</span>}
                          {n.ready && !n.schedulable && <span style={{ color: "#fbbf24", marginLeft: 6 }}>cordoned</span>}
                        </td>
                        <td style={{ padding: "5px 10px" }}>{n.product}</td>
                        <td style={{ padding: "5px 10px" }}>{n.capacity}</td>
                        <td style={{ padding: "5px 10px" }}>
                          {n.allocatedGpus}<span style={{ opacity: .5 }}> / {n.allocatable}</span>
                        </td>
                        <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>
                          {n.memoryMiBPerGpu ? `${Math.round(n.memoryMiBPerGpu / 1024)} GiB` : "—"}
                        </td>
                        <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>{n.driverVersion || "—"}</td>
                        <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>
                          {n.migProfiles
                            ? Object.entries(n.migProfiles).map(([k, v]) => `${v}×${k}`).join(", ")
                            : n.migCapable ? (n.migStrategy || "capable") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.inventory.consumers?.length > 0 && (
                <div style={{ padding: "7px 12px", borderTop: "1px solid var(--border)", fontSize: 11.5, color: "var(--text2)" }}>
                  <strong style={{ opacity: .8 }}>Holding GPUs:</strong>{" "}
                  {data.inventory.consumers.slice(0, 6).map((c) => `${c.namespace}/${c.pod} (${c.gpus})`).join(" · ")}
                  {data.inventory.consumerCount > 6 && ` · +${data.inventory.consumerCount - 6} more`}
                </div>
              )}
            </div>
          )}

          {/* Idle-but-allocated cost-waste insight (the unique AI angle) */}
          {s.idleAllocatedGpus > 0 && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              padding: "10px 14px", borderRadius: 10,
              background: "color-mix(in srgb, #f59e0b 12%, transparent)",
              border: "1px solid color-mix(in srgb, #f59e0b 35%, transparent)",
            }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                <strong style={{ color: "#f59e0b" }}>{s.idleAllocatedGpus} allocated GPU{s.idleAllocatedGpus === 1 ? "" : "s"} sitting idle</strong>
                {" "}— reserved to workloads but effectively unused. GPUs are the fleet’s most expensive resource; reclaiming or MIG-slicing these frees capacity for queued jobs.
              </div>
              <button
                onClick={() => askAI("Which GPUs are allocated but idle, and how can I reclaim or right-size them?")}
                style={{
                  flexShrink: 0, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  padding: "6px 12px", borderRadius: 8, border: "1px solid #f59e0b",
                  background: "transparent", color: "#f59e0b",
                }}>
                Ask AI to reclaim
              </button>
            </div>
          )}

          {/* Error / health callout */}
          {(s.xidErrorGpus > 0 || s.eccErrorGpus > 0) && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: 10,
              background: "color-mix(in srgb, #ef4444 12%, transparent)",
              border: "1px solid color-mix(in srgb, #ef4444 35%, transparent)",
              fontSize: 12.5, color: "var(--text)",
            }}>
              <span style={{ fontWeight: 700, color: "#ef4444" }}>Hardware faults:</span>
              {s.xidErrorGpus > 0 && <span>{s.xidErrorGpus} GPU(s) reporting XID errors</span>}
              {s.xidErrorGpus > 0 && s.eccErrorGpus > 0 && <span style={{ color: "var(--text2)" }}>·</span>}
              {s.eccErrorGpus > 0 && <span>{s.eccErrorGpus} GPU(s) with uncorrectable ECC errors</span>}
              <button
                onClick={() => askAI("Investigate the GPU XID and ECC hardware errors in the fleet and recommend remediation.")}
                style={{
                  marginLeft: "auto", fontSize: 12, fontWeight: 600, cursor: "pointer",
                  padding: "6px 12px", borderRadius: 8, border: "1px solid #ef4444",
                  background: "transparent", color: "#ef4444",
                }}>
                Investigate
              </button>
            </div>
          )}

          {/* Utilization heatmap — one cell per physical GPU */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--text2)" }}>
                Per-GPU Utilization
              </span>
              <span style={{ fontSize: 11, color: "var(--text2)" }}>
                {gpus.length} device{gpus.length === 1 ? "" : "s"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: 8 }}>
              {gpus.map((g) => {
                const tone = utilColor(g.utilPct);
                const alloc = g.allocated;
                const idle = alloc && (g.utilPct == null || g.utilPct < 5);
                return (
                  <div key={g.id}
                    title={[
                      `${g.model}`,
                      `node ${g.node}${g.index != null ? ` · gpu ${g.index}` : ""}`,
                      `util ${g.utilPct == null ? "—" : g.utilPct + "%"}`,
                      g.memTotalMiB ? `mem ${g.memPct}% (${Math.round(g.memUsedMiB)}/${Math.round(g.memTotalMiB)} MiB)` : "",
                      g.tempC != null ? `temp ${g.tempC}°C` : "",
                      g.powerW != null ? `power ${Math.round(g.powerW)} W` : "",
                      g.pod ? `pod ${g.namespace}/${g.pod}` : "unallocated",
                      g.xidError ? `XID ${g.xidError}` : "",
                    ].filter(Boolean).join("\n")}
                    style={{
                      padding: "9px 10px", borderRadius: 9,
                      border: `1px solid ${g.status === "critical" ? "#ef4444" : "var(--border)"}`,
                      background: "var(--surface2, var(--card))",
                      position: "relative", overflow: "hidden",
                    }}>
                    {/* util fill bar along the bottom */}
                    <div style={{ position: "absolute", left: 0, bottom: 0, height: 3, width: `${Math.min(100, g.utilPct || 0)}%`, background: tone }} />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <span style={{ fontSize: 18, fontWeight: 800, color: tone }}>{g.utilPct == null ? "—" : `${g.utilPct}%`}</span>
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                        background: HEALTH_TONE[g.status] || "var(--text2)",
                      }} title={g.status} />
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--text2)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {g.model.replace(/^NVIDIA\s+/i, "")}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 10, color: "var(--text2)" }}>
                      {g.tempC != null && <span style={{ color: tempColor(g.tempC) }}>{g.tempC}°C</span>}
                      {g.memPct != null && <span>{g.memPct}% mem</span>}
                      {idle ? <span style={{ color: "#f59e0b", fontWeight: 600 }}>idle</span>
                        : !alloc && <span style={{ opacity: .7 }}>free</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per-node roll-up */}
          {Array.isArray(data.nodes) && data.nodes.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {data.nodes.map((n) => (
                <div key={n.name} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "5px 10px", borderRadius: 999, border: "1px solid var(--border)",
                  fontSize: 11.5,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: utilColor(n.avgUtil) }} />
                  <span style={{ fontWeight: 600, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
                  <span style={{ color: "var(--text2)" }}>{n.gpuCount}× · {n.avgUtil}%</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 10.5, color: "var(--text2)", marginTop: -4 }}>
            Source: DCGM exporter via Prometheus · {gpus.length} GPU device{gpus.length === 1 ? "" : "s"} across {s.nodes} node{s.nodes === 1 ? "" : "s"}
          </div>
        </div>
      )}
    </WidgetCard>
  );
}
