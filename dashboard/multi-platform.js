/**
 * Multi-Platform Dashboard Enhancements
 *
 * Loaded by the dashboard to add platform awareness:
 *   - Platform badge in the header
 *   - Platform-specific welcome categories
 *   - Skill availability indicators
 *   - Adaptive command suggestions (oc vs kubectl)
 *
 * This file is ADDITIVE — it does not modify index.html.
 * It reads from a /api/platform-info endpoint.
 */

(function () {
  "use strict";

  let _platformInfo = null;

  const PLATFORM_BADGES = {
    openshift: { label: "OpenShift", color: "#ee0000", icon: "⬢" },
    rosa:      { label: "ROSA",      color: "#ff6600", icon: "⬢" },
    aro:       { label: "ARO",       color: "#0078d4", icon: "⬢" },
    eks:       { label: "EKS",       color: "#ff9900", icon: "☁" },
    aks:       { label: "AKS",       color: "#0089d6", icon: "☁" },
    gke:       { label: "GKE",       color: "#4285f4", icon: "☁" },
    k8s:       { label: "Kubernetes", color: "#326ce5", icon: "☸" },
  };

  const PLATFORM_CATEGORIES = {
    eks: [
      {
        title: "AWS / EKS",
        icon: "☁",
        gradient: "linear-gradient(135deg,#ff9900,#ff6600)",
        buttons: [
          { label: "ALB Ingress status", query: "Show ALB ingress status" },
          { label: "IRSA bindings", query: "Show IRSA bindings" },
          { label: "Karpenter node pools", query: "Show Karpenter status" },
          { label: "EKS managed add-ons", query: "Show EKS add-on health" },
          { label: "ECR images", query: "Show ECR image analysis" },
          { label: "EKS node groups", query: "Show EKS node groups" },
        ],
      },
    ],
    aks: [
      {
        title: "Azure / AKS",
        icon: "☁",
        gradient: "linear-gradient(135deg,#0089d6,#00bcf2)",
        buttons: [
          { label: "AGIC Ingress status", query: "Show AGIC ingress status" },
          { label: "Azure Workload Identity", query: "Show Azure workload identity" },
          { label: "AKS node pools", query: "Show AKS node pools" },
          { label: "ACR images", query: "Show ACR image analysis" },
          { label: "Azure Arc extensions", query: "Show AKS extensions" },
          { label: "AKS network config", query: "Show AKS network configuration" },
        ],
      },
    ],
    gke: [
      {
        title: "GCP / GKE",
        icon: "☁",
        gradient: "linear-gradient(135deg,#4285f4,#34a853)",
        buttons: [
          { label: "GKE NEG Ingress", query: "Show GKE ingress status" },
          { label: "GKE Workload Identity", query: "Show GKE workload identity" },
          { label: "GKE node pools", query: "Show GKE node pools" },
          { label: "Artifact Registry images", query: "Show GAR image analysis" },
          { label: "Binary Authorization", query: "Show binary authorization status" },
          { label: "Autopilot status", query: "Show GKE autopilot status" },
        ],
      },
    ],
    k8s: [
      {
        title: "Kubernetes",
        icon: "☸",
        gradient: "linear-gradient(135deg,#326ce5,#1a73e8)",
        buttons: [
          { label: "Cluster version", query: "Show Kubernetes version" },
          { label: "Ingress controller", query: "Show ingress controller" },
          { label: "cert-manager status", query: "Show cert-manager status" },
          { label: "Cluster autoscaler", query: "Show cluster autoscaler" },
          { label: "CSI drivers", query: "Show storage provisioners" },
        ],
      },
    ],
  };

  async function fetchPlatformInfo() {
    try {
      const resp = await fetch("/api/platform-info");
      if (resp.ok) {
        _platformInfo = await resp.json();
        return _platformInfo;
      }
    } catch {
      // Platform endpoint not available — platform layer not initialized
    }
    return null;
  }

  function renderPlatformBadge() {
    if (!_platformInfo) return;
    const badge = PLATFORM_BADGES[_platformInfo.platform] || PLATFORM_BADGES.k8s;

    const el = document.createElement("span");
    el.className = "platform-badge";
    el.innerHTML = `${badge.icon} ${badge.label}`;
    el.style.cssText = `
      display:inline-flex;align-items:center;gap:4px;
      background:${badge.color};color:#fff;
      font-size:11px;font-weight:600;
      padding:3px 10px;border-radius:12px;
      margin-left:10px;letter-spacing:0.5px;
      vertical-align:middle;
    `;

    const subtitle = document.querySelector(".header-subtitle");
    if (subtitle && !document.querySelector(".platform-badge")) {
      subtitle.parentNode.insertBefore(el, subtitle.nextSibling);
    }
  }

  function renderPlatformCategories() {
    if (!_platformInfo) return;
    const platform = _platformInfo.platform;
    const categories = PLATFORM_CATEGORIES[platform];
    if (!categories) return;

    const welcomeGrid = document.querySelector(".welcome-categories");
    if (!welcomeGrid) return;

    // Check if already added
    if (document.querySelector(".wcat-platform-added")) return;

    categories.forEach(cat => {
      const div = document.createElement("div");
      div.className = "wcat wcat-platform-added";
      div.onclick = function () { this.classList.toggle("open"); };

      let buttonsHtml = "";
      cat.buttons.forEach(btn => {
        buttonsHtml += `<button onclick="sendFullChat('${btn.query}')">${btn.label}</button>`;
      });

      div.innerHTML = `
        <div class="wcat-head">
          <span class="wcat-icon" style="background:${cat.gradient}">${cat.icon}</span>
          <span class="wcat-title">${cat.title}</span>
          <span class="wcat-arrow">&#x25B8;</span>
        </div>
        <div class="wcat-body">${buttonsHtml}</div>
      `;

      welcomeGrid.appendChild(div);
    });
  }

  function renderSkillCount() {
    if (!_platformInfo || !_platformInfo.skillCount) return;
    const tip = document.querySelector(".welcome-tip");
    if (tip && !tip.dataset.skillCountAdded) {
      tip.dataset.skillCountAdded = "true";
      const span = document.createElement("span");
      span.style.cssText = "margin-left:8px;opacity:0.7;font-size:11px";
      span.textContent = `| ${_platformInfo.skillCount} skills available for ${PLATFORM_BADGES[_platformInfo.platform]?.label || "your cluster"}`;
      tip.appendChild(span);
    }
  }

  async function init() {
    const info = await fetchPlatformInfo();
    if (info) {
      renderPlatformBadge();
      renderPlatformCategories();
      renderSkillCount();
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // Small delay to let the main dashboard render first
    setTimeout(init, 500);
  }

  // Expose for manual refresh
  window._multiPlatform = { fetchPlatformInfo, init, getPlatformInfo: () => _platformInfo };
})();
