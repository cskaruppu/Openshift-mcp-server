import { useClusterQuery, REFRESH } from "../../hooks/useClusterQuery";
import { WidgetCard } from "../WidgetCard";

/** Namespaces widget. Reads /api/cluster/summary (namespaces block). */
export function NamespacesWidget() {
  const { data, isLoading, isError, error } = useClusterQuery("/api/cluster/summary", { refetchInterval: REFRESH.VITALS });

  const ns = data?.namespaces;
  const isOCP = data?.isOpenShift;

  return (
    <WidgetCard title="Namespaces">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className="metric">{ns ? ns.total : "--"}</div>
          <div className="metric-label">
            {ns ? `${ns.user} user ${isOCP ? "projects" : "namespaces"} · ${ns.system} system` : ""}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
