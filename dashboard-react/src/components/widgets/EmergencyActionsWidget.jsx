import { useActiveCluster } from "../../store/clusterStore";
import { useChatStore } from "../../store/chatStore";
import { useViewStore } from "../../store/viewStore";

/**
 * Emergency Actions — common remediation shortcuts. For safety, these do NOT
 * execute destructive operations directly; they seed the AI Chat (scoped to the
 * active cluster) with the remediation request, where guardrails + approval
 * flow apply. This keeps the audit trail and confirmation gates intact.
 */
const ACTIONS = [
  { icon: "🔄", label: "Restart failing workloads", prompt: "Restart all pods that are in CrashLoopBackOff or Failed state" },
  { icon: "🩺", label: "Diagnose cluster health", prompt: "Run a full cluster health diagnosis and summarize the top issues" },
  { icon: "📉", label: "Find resource pressure", prompt: "Which nodes are under memory or disk pressure right now?" },
  { icon: "🚨", label: "Triage active alerts", prompt: "Triage the current firing alerts and suggest remediation steps" },
  { icon: "🔍", label: "Investigate degraded operators", prompt: "Investigate any degraded cluster operators and explain the root cause" },
];

export function EmergencyActionsWidget() {
  const cluster = useActiveCluster();
  const setSeed = useChatStore((s) => s.setSeed);
  const setActiveView = useViewStore((s) => s.setActiveView);

  const run = (prompt) => {
    setSeed(cluster, prompt);
    setActiveView("chat");
  };

  return (
    <div className="widget-card span-all">
      <div className="widget-title">Emergency Actions — {cluster === "local" ? "Hub" : cluster}</div>
      <div className="widget-body">
        <div className="metric-label" style={{ marginBottom: 10 }}>
          One-click remediation via the AI assistant (guardrails &amp; approval apply).
        </div>
        <div className="action-grid">
          {ACTIONS.map((a) => (
            <button key={a.label} className="action-btn" onClick={() => run(a.prompt)}>
              <span className="action-icon">{a.icon}</span>
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
