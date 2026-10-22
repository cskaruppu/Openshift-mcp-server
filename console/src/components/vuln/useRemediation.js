import { useState, useCallback } from "react";
import { showToast } from "../../store/toastStore";
import { clusterUrl } from "./vulnModel";

// AI Fix → Dry Run → Apply & Raise CR, per image. The server makes every
// decision that matters (role, KEV status, registry check, which container);
// this only carries the operator's clicks to it and keeps each image's state.

const deploymentHint = (img) =>
  (img.workload?.name) ||
  (img.runtime?.pods?.[0]?.owner?.kind === "ReplicaSet" ? img.runtime.pods[0].owner.name.replace(/-[a-f0-9]{6,10}$/, "") : "") ||
  ((img.pods && img.pods[0]?.pod) ? img.pods[0].pod.replace(/-[a-f0-9]+(-[a-z0-9]+)?$/, "") : "");

export function useRemediation(cluster) {
  const [aiFix, setAiFix] = useState({});       // { [imageKey]: { loading, data, error } }
  const [remediate, setRemediate] = useState({}); // { [imageKey]: { phase, dryRun, result, error } }

  const handleAiFix = useCallback(async (img) => {
    const key = img.fullImage || img.image;
    setAiFix((p) => ({ ...p, [key]: { loading: true } }));
    try {
      const res = await fetch(clusterUrl("/api/ai/image-remediation", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: key, namespace: img.namespace, deployment: deploymentHint(img),
          vulnerabilities: img.vulnerabilities || [],
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Remediation failed");
      setAiFix((p) => ({ ...p, [key]: { loading: false, data } }));
    } catch (err) {
      setAiFix((p) => ({ ...p, [key]: { loading: false, error: err.message } }));
      showToast("AI fix failed: " + err.message, "err");
    }
  }, [cluster]);

  const runRemediation = useCallback(async (img, dryRun, confirmUnverifiedImage = false) => {
    const key = img.fullImage || img.image;
    const newImage = aiFix[key]?.data?.recommendedImage;
    if (!newImage || /[<>]/.test(newImage)) {
      showToast("Run AI Fix first to get a concrete target image", "err");
      return;
    }
    setRemediate((p) => ({ ...p, [key]: { ...(p[key] || {}), phase: dryRun ? "dry-running" : "applying", dryRun } }));
    try {
      const res = await fetch(clusterUrl("/api/security/remediate-image", cluster), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: key, namespace: img.namespace, deployment: deploymentHint(img),
          container: img.runtime?.pods?.[0]?.container || (img.pods && img.pods[0]?.container),
          newImage, dryRun, confirmUnverifiedImage,
          cveIds: (img.vulnerabilities || []).map((v) => v.id).filter(Boolean),
          before: { critical: img.critical || 0, high: img.high || 0, medium: img.medium || 0, low: img.low || 0, total: img.total || 0 },
        }),
      });
      const data = await res.json();
      if (data.needsConfirmation && !dryRun && !confirmUnverifiedImage) {
        setRemediate((p) => ({ ...p, [key]: { ...(p[key] || {}), phase: "dry-done", dryRun: true } }));
        if (window.confirm(`${data.error}\n\nApply ${newImage} anyway?`)) return runRemediation(img, false, true);
        return;
      }
      if (!res.ok || data.success === false) throw new Error(data.error || "Remediation failed");
      setRemediate((p) => ({ ...p, [key]: { phase: dryRun ? "dry-done" : "applied", dryRun, result: data } }));
      showToast(dryRun ? "Dry run complete" : `Applied${data.changeRequest?.number ? " · " + data.changeRequest.number : ""}`, "ok");
    } catch (err) {
      setRemediate((p) => ({ ...p, [key]: { ...(p[key] || {}), phase: "failed", dryRun, error: err.message } }));
      showToast("Remediation failed: " + err.message, "err");
    }
  }, [cluster, aiFix]);

  return { aiFix, remediate, handleAiFix, runRemediation };
}
