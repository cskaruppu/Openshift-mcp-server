import { useClusterQuery } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

const gradeColor = (g) =>
  g === "A" ? "#22c55e" : g === "B" ? "#84cc16" : g === "C" ? "#f59e0b" : g === "D" ? "#f97316" : g === "F" ? "#ef4444" : "#888";

/**
 * Generic scorecard widget for dashboard score endpoints.
 * Reused for CIS/Security, GitOps, DR, Resource Optimization, Image Vulns —
 * each is just a different endpoint + field mapping, all cluster-scoped.
 *
 * @param {string} title
 * @param {string} path - API endpoint
 * @param {(d:any)=>{value:string,grade?:string,label:string,unavailable?:boolean}} map
 */
export function ScoreWidget({ title, path, map }) {
  const { data, isLoading, isError, error } = useClusterQuery(path);

  let view = null;
  if (data) {
    if (data.available === false || data.installed === false || data.unavailable) {
      view = { value: "N/A", label: data.message || "Not installed on this cluster", unavailable: true };
    } else {
      view = map(data);
    }
  }

  return (
    <WidgetCard title={title}>
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && view && (
        <>
          <div className="metric" style={{ color: view.unavailable ? "#888" : gradeColor(view.grade) }}>
            {view.value}
            {view.grade && !view.unavailable ? <span style={{ fontSize: 18, marginLeft: 8 }}>({view.grade})</span> : null}
          </div>
          <div className="metric-label">{view.label}</div>
        </>
      )}
    </WidgetCard>
  );
}
