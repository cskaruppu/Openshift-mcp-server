/**
 * Component Toggle System.
 *
 * Allows operators to selectively enable/disable tool categories at startup
 * via the ENABLED_COMPONENTS environment variable. When not set, ALL
 * components are enabled (preserving current behavior).
 *
 * Example:
 *   ENABLED_COMPONENTS=core,security,observability,itsm
 *
 * This is a pure additive gate — it wraps existing tool registration calls
 * with an isEnabled() check. No existing tool module is modified.
 */

// ── Component definitions ───────────────────────────────────────────────────

const COMPONENT_CATALOG = {
  // Core cluster operations — always recommended
  core: {
    label: "Core Cluster Operations",
    tools: [
      "registerClusterTools",
      "registerNodeTools",
      "registerPodTools",
      "registerNamespaceTools",
      "registerWorkloadTools",
      "registerGenericTools",
      "registerDashboardTools",
    ],
  },

  // Observability & diagnostics
  observability: {
    label: "Observability & Diagnostics",
    tools: [
      "registerDiagnosticTools",
      "registerMetricsTopTools",
      "registerPrometheusTools",
      "registerMustGatherTools",
      "registerTimelineTools",
      "registerOperatorDiagTools",
      "registerBenchmarkTools",
    ],
  },

  // Security & compliance
  security: {
    label: "Security & Compliance",
    tools: [
      "registerSecurityTools",
      "registerComplianceTools",
      "registerSCCAdvisorTools",
      "registerPolicyGenTools",
    ],
  },

  // Networking
  networking: {
    label: "Networking & Service Mesh",
    tools: [
      "registerNetworkTools",
      "registerOSSMTools",
    ],
  },

  // ITSM & automation
  itsm: {
    label: "ITSM & Automation",
    tools: [
      "registerServiceNowTools",
      "registerAnsibleTools",
      "registerNotificationTools",
    ],
  },

  // Lifecycle & deployment
  lifecycle: {
    label: "Lifecycle & Deployment",
    tools: [
      "registerHelmTools",
      "registerTektonTools",
      "registerGitOpsTools",
      "registerVeleroTools",
      "registerProvisioningTools",
    ],
  },

  // Upgrade management
  upgrade: {
    label: "Upgrade Management",
    tools: [
      "registerUpgradeAdvisorTools",
      "registerPreflightTools",
    ],
  },

  // Advanced platform
  advanced: {
    label: "Advanced Platform",
    tools: [
      "registerACMTools",
      "registerKubeVirtTools",
      "registerEmergencyTools",
      "registerDriftTools",
      "registerImpactTools",
      "registerRecommendationTools",
    ],
  },
};

// ── State ───────────────────────────────────────────────────────────────────

let _enabledComponents = null; // null = all enabled
let _initialized = false;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the component toggle system.
 * Reads ENABLED_COMPONENTS env var. If not set, all components are enabled.
 */
export function initComponents() {
  const envVal = process.env.ENABLED_COMPONENTS;

  if (!envVal || envVal.trim() === "" || envVal.trim().toLowerCase() === "all") {
    _enabledComponents = null; // all enabled
    _initialized = true;
    return;
  }

  _enabledComponents = new Set(
    envVal.split(",").map(c => c.trim().toLowerCase()).filter(Boolean)
  );
  _initialized = true;

  const known = Object.keys(COMPONENT_CATALOG);
  const enabled = known.filter(k => _enabledComponents.has(k));
  const unknown = [..._enabledComponents].filter(k => !known.includes(k));

  console.log(`[components] enabled: ${enabled.join(", ") || "(none)"}`);
  if (unknown.length) {
    console.warn(`[components] unknown components ignored: ${unknown.join(", ")}`);
  }
}

/**
 * Check if a specific component category is enabled.
 *
 * @param {string} componentName — e.g. "core", "security", "itsm"
 * @returns {boolean}
 */
export function isComponentEnabled(componentName) {
  if (!_initialized) initComponents();
  if (_enabledComponents === null) return true; // all enabled
  return _enabledComponents.has(componentName.toLowerCase());
}

/**
 * Check if a specific tool registration function should run.
 * Looks up which component owns the tool and checks if that component is enabled.
 *
 * @param {string} registerFnName — e.g. "registerSecurityTools"
 * @returns {boolean}
 */
export function isToolRegistrationEnabled(registerFnName) {
  if (!_initialized) initComponents();
  if (_enabledComponents === null) return true;

  for (const [component, def] of Object.entries(COMPONENT_CATALOG)) {
    if (def.tools.includes(registerFnName)) {
      return _enabledComponents.has(component);
    }
  }

  // Tool not in any component — enable by default (multi-cluster, etc.)
  return true;
}

/**
 * Get the full component catalog for dashboard display / API exposure.
 * @returns {object} { componentName: { label, tools[], enabled } }
 */
export function getComponentCatalog() {
  if (!_initialized) initComponents();

  const result = {};
  for (const [name, def] of Object.entries(COMPONENT_CATALOG)) {
    result[name] = {
      ...def,
      enabled: _enabledComponents === null || _enabledComponents.has(name),
    };
  }
  return result;
}

/**
 * Get a summary string for startup logging.
 * @returns {string}
 */
export function getComponentSummary() {
  if (!_initialized) initComponents();

  if (_enabledComponents === null) {
    return `all ${Object.keys(COMPONENT_CATALOG).length} components enabled`;
  }

  const total = Object.keys(COMPONENT_CATALOG).length;
  const enabled = Object.keys(COMPONENT_CATALOG).filter(k => _enabledComponents.has(k)).length;
  return `${enabled}/${total} components enabled`;
}
