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

function Stat({ label, value, sub, tone }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 92 }}>
      <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.05, color: tone || "var(--text)" }}>{value}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text2)", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</span>
      {sub && <span style={{ fontSize: 11, color: "var(--text2)" }}>{sub}</span>}
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
            background: "color-mix(in srgb, var(--text2) 12%, transparent)", color: "var(--text2)",
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10v4M11 10v4M15 10v4" /><path d="M3 9h-1M3 15h-1M22 9h-1M22 15h-1" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
              {data.reason === "gpu-nodes-without-metrics" ? "GPUs detected — metrics pending"
                : data.reason === "metrics-unreachable" ? "GPU status unknown — metrics backend unreachable"
                : data.reason === "cluster-unreachable" ? "Cluster unreachable"
                : "No GPU metrics on this cluster"}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text2)", lineHeight: 1.55, maxWidth: 620 }}>
              {data.message}
            </div>
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
            <Stat label="GPUs" value={s.totalGpus} sub={`${s.nodes} node${s.nodes === 1 ? "" : "s"}`} />
            {s.avgUtilPct != null && <Stat label="Avg Util" value={`${s.avgUtilPct}%`} sub={`peak ${s.maxUtilPct}%`} tone={utilColor(s.avgUtilPct)} />}
            <Stat label="Allocated" value={`${s.allocatedGpus}/${s.totalGpus}`} sub={`${s.unallocatedGpus} free`} />
            {s.memPct != null && <Stat label="GPU Mem" value={`${s.memPct}%`} sub={s.memTotalGiB ? `${s.memUsedGiB} / ${s.memTotalGiB} GiB` : null} />}
            {(s.totalPowerKW || s.totalPowerW) && <Stat label="Power" value={s.totalPowerKW ? `${s.totalPowerKW} kW` : `${s.totalPowerW} W`} />}
            {s.maxTempC != null && <Stat label="Max Temp" value={`${s.maxTempC}°C`} tone={tempColor(s.maxTempC)} />}
            {s.health && s.health !== "unknown" && (
              <Stat
                label="Health"
                value={s.health === "healthy" ? "OK" : s.health === "warning" ? "Warn" : "Crit"}
                tone={HEALTH_TONE[s.health]}
                sub={s.unhealthyGpus > 0 ? `${s.unhealthyGpus} affected` : "all nominal"}
              />
            )}
          </div>

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
                        <td style={{ padding: "5px 10px" }}>{n.migCapable ? (n.migStrategy || "capable") : "—"}</td>
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
