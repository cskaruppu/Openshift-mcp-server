import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../../api/client";
import { WidgetCard } from "../WidgetCard";

/**
 * Ansible Automation Platform status. This reflects platform-wide integration
 * configuration (fleet-level), so it uses a plain useQuery — not cluster-scoped.
 */
export function AnsibleWidget() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/integrations"],
    queryFn: ({ signal }) => apiGet("/api/integrations", { signal }),
    staleTime: 60_000,
  });

  const cfg = data?.config || {};
  // Defensive: find an ansible/aap config block under common key names.
  const aap = cfg.ansible || cfg.aap || cfg.ansibleTower || cfg.automationPlatform || {};
  const configured = !!(aap.url || aap.host || aap.baseUrl || aap.enabled);

  return (
    <WidgetCard title="Ansible Automation Platform">
      {isLoading && <div className="metric muted">Loading…</div>}
      {isError && <div className="metric err">{String(error.message)}</div>}
      {!isLoading && !isError && (
        <>
          <div className={`metric ${configured ? "ok" : "muted"}`}>
            {configured ? "Connected" : "Not configured"}
          </div>
          <div className="metric-label">
            {configured
              ? `Endpoint: ${aap.url || aap.host || aap.baseUrl || "configured"}`
              : "Configure AAP under Integrations to enable playbook automation"}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
