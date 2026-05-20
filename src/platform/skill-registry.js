/**
 * Agentic Skill Registry
 *
 * Central registry for platform-specific and shared skills.
 * Skills are categorized, tagged with platform compatibility,
 * and discoverable at runtime. The orchestrator uses this
 * registry to determine which agent handles a given intent.
 *
 * Skill structure:
 * {
 *   id:          "pod-health",
 *   name:        "Pod Health Check",
 *   category:    "cluster-health",
 *   platforms:   ["*"] or ["openshift","eks","aks"],
 *   intents:     ["pod_issues","pod_summary","cluster_health"],
 *   keywords:    ["pod","crash","oom","restart"],
 *   priority:    10,       // higher = preferred when multiple match
 *   handler:     async (ctx) => { ... },
 *   description: "Analyzes pod health across the cluster",
 * }
 */

const _skills = new Map();
const _categoryIndex = new Map();
const _intentIndex = new Map();
const _platformIndex = new Map();

const SKILL_CATEGORIES = {
  CLUSTER_HEALTH: "cluster-health",
  WORKLOADS: "workloads",
  SECURITY: "security",
  NETWORKING: "networking",
  STORAGE: "storage",
  OBSERVABILITY: "observability",
  SCALING: "scaling",
  UPGRADE: "upgrade",
  GOVERNANCE: "governance",
  INCIDENT: "incident",
  SUPPLY_CHAIN: "supply-chain",
  IDENTITY: "identity",
  BACKUP: "backup",
  MULTI_CLUSTER: "multi-cluster",
  PLATFORM_SPECIFIC: "platform-specific",
};

function registerSkill(skill) {
  if (!skill.id || !skill.handler) {
    throw new Error(`Skill must have 'id' and 'handler': ${JSON.stringify(skill)}`);
  }

  const entry = {
    id: skill.id,
    name: skill.name || skill.id,
    category: skill.category || "general",
    platforms: skill.platforms || ["*"],
    intents: skill.intents || [],
    keywords: skill.keywords || [],
    priority: skill.priority || 0,
    handler: skill.handler,
    description: skill.description || "",
    provider: skill.provider || "shared",
  };

  _skills.set(entry.id, entry);

  // Index by category
  if (!_categoryIndex.has(entry.category)) _categoryIndex.set(entry.category, []);
  _categoryIndex.get(entry.category).push(entry.id);

  // Index by intent
  for (const intent of entry.intents) {
    if (!_intentIndex.has(intent)) _intentIndex.set(intent, []);
    _intentIndex.get(intent).push(entry.id);
  }

  // Index by platform
  for (const platform of entry.platforms) {
    if (!_platformIndex.has(platform)) _platformIndex.set(platform, []);
    _platformIndex.get(platform).push(entry.id);
  }

  return entry;
}

function registerSkills(skills) {
  return skills.map(s => registerSkill(s));
}

function getSkill(id) {
  return _skills.get(id) || null;
}

function findSkillsByIntent(intent, platform) {
  const ids = _intentIndex.get(intent) || [];
  return ids
    .map(id => _skills.get(id))
    .filter(s => s && (s.platforms.includes("*") || s.platforms.includes(platform)))
    .sort((a, b) => b.priority - a.priority);
}

function findSkillsByCategory(category, platform) {
  const ids = _categoryIndex.get(category) || [];
  return ids
    .map(id => _skills.get(id))
    .filter(s => s && (s.platforms.includes("*") || s.platforms.includes(platform)))
    .sort((a, b) => b.priority - a.priority);
}

function findSkillsByPlatform(platform) {
  const universalIds = _platformIndex.get("*") || [];
  const platformIds = _platformIndex.get(platform) || [];
  const allIds = [...new Set([...universalIds, ...platformIds])];
  return allIds.map(id => _skills.get(id)).filter(Boolean);
}

function findSkillsByKeyword(keyword, platform) {
  const lower = keyword.toLowerCase();
  return [..._skills.values()]
    .filter(s => {
      if (!s.platforms.includes("*") && !s.platforms.includes(platform)) return false;
      return s.keywords.some(k => k.includes(lower) || lower.includes(k));
    })
    .sort((a, b) => b.priority - a.priority);
}

function findBestSkill(intent, platform) {
  const skills = findSkillsByIntent(intent, platform);
  return skills.length > 0 ? skills[0] : null;
}

function getAllSkills() {
  return [..._skills.values()];
}

function getSkillCount() {
  return _skills.size;
}

function getCategories() {
  return [..._categoryIndex.keys()];
}

function getSkillManifest(platform) {
  const skills = findSkillsByPlatform(platform);
  const manifest = {};
  for (const skill of skills) {
    if (!manifest[skill.category]) manifest[skill.category] = [];
    manifest[skill.category].push({
      id: skill.id,
      name: skill.name,
      intents: skill.intents,
      provider: skill.provider,
    });
  }
  return manifest;
}

function clearRegistry() {
  _skills.clear();
  _categoryIndex.clear();
  _intentIndex.clear();
  _platformIndex.clear();
}

export {
  SKILL_CATEGORIES,
  registerSkill,
  registerSkills,
  getSkill,
  findSkillsByIntent,
  findSkillsByCategory,
  findSkillsByPlatform,
  findSkillsByKeyword,
  findBestSkill,
  getAllSkills,
  getSkillCount,
  getCategories,
  getSkillManifest,
  clearRegistry,
};
