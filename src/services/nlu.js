/**
 * Natural-Language Understanding for the OpenShift MCP chat.
 *
 * Goal: convert any user message into a single structured command:
 *
 *   {
 *     intent:      'list' | 'get' | 'delete' | 'logs' | 'top' | 'exec'
 *                  | 'run'  | 'create' | 'update' | 'start' | 'stop'
 *                  | 'upgrade' | 'help' | 'unknown',
 *     resource:    'pod' | 'deployment' | 'service' | ... | null,
 *     name:        string | null,
 *     namespace:   string | null,
 *     filter:      'CrashLoopBackOff' | 'ImagePullBackOff' | ... | null,
 *     allNs:       boolean,
 *     options:     { command?, image?, replicas?, follow?, tail? },
 *     scope:       'count' | 'list' | 'detail' | 'health' | null,
 *     confidence:  number 0..1,
 *     raw:         string
 *   }
 *
 * Designed to be deterministic, fast, and easy to extend with tests.
 * NO regex spaghetti — we tokenize once and walk the tokens.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// Resource type aliases → canonical name. Keep this sorted by canonical.
export const RESOURCE_ALIASES = {
  // canonical: [aliases]
  pod:               ["pod", "pods", "po"],
  deployment:        ["deployment", "deployments", "deploy", "deployments.apps"],
  service:           ["service", "services", "svc"],
  configmap:         ["configmap", "configmaps", "cm"],
  secret:            ["secret", "secrets"],
  serviceaccount:    ["serviceaccount", "serviceaccounts", "sa"],
  event:             ["event", "events", "ev"],
  statefulset:       ["statefulset", "statefulsets", "sts"],
  daemonset:         ["daemonset", "daemonsets", "ds"],
  replicaset:        ["replicaset", "replicasets", "rs"],
  job:               ["job", "jobs"],
  cronjob:           ["cronjob", "cronjobs", "cj"],
  pvc:               ["pvc", "pvcs", "persistentvolumeclaim", "persistentvolumeclaims"],
  pv:                ["pv", "pvs", "persistentvolume", "persistentvolumes"],
  ingress:           ["ingress", "ingresses", "ing"],
  route:             ["route", "routes"],
  node:              ["node", "nodes", "no"],
  namespace:         ["namespace", "namespaces", "ns"],
  project:           ["project", "projects"],
  clusteroperator:   ["clusteroperator", "clusteroperators", "co"],
  storageclass:      ["storageclass", "storageclasses", "sc"],
  networkpolicy:     ["networkpolicy", "networkpolicies", "netpol"],
  hpa:               ["hpa", "horizontalpodautoscaler", "horizontalpodautoscalers"],
  virtualmachine:    ["virtualmachine", "virtualmachines", "vm", "vms"],
  virtualmachineinstance: ["virtualmachineinstance", "virtualmachineinstances", "vmi", "vmis"],
  pipeline:          ["pipeline", "pipelines"],
  pipelinerun:       ["pipelinerun", "pipelineruns"],
  task:              ["task", "tasks"],
  taskrun:           ["taskrun", "taskruns"],
  helmrelease:       ["helmrelease", "helmreleases", "helm"],
  clusterversion:    ["clusterversion", "clusterversions"],
  machine:           ["machine", "machines"],
  machineset:        ["machineset", "machinesets"],
};

// Build a flat token → canonical map for O(1) lookup.
const ALIAS_TO_CANONICAL = (() => {
  const map = {};
  for (const [canon, aliases] of Object.entries(RESOURCE_ALIASES)) {
    for (const a of aliases) map[a] = canon;
  }
  return map;
})();

// Verbs (tokens that signal an intent) with a priority weight. Higher
// priority wins when multiple verbs appear in one message — so "show logs
// for X" picks `logs` over `show` (list).
const VERB_TABLE = {
  // specific actions — high priority
  logs: { intent: "logs",   weight: 90 },
  log:  { intent: "logs",   weight: 90 },
  tail: { intent: "logs",   weight: 80 },
  top:  { intent: "top",    weight: 90 },
  metrics:     { intent: "top", weight: 85 },
  usage:       { intent: "top", weight: 70 },
  consumption: { intent: "top", weight: 70 },
  exec:    { intent: "exec", weight: 95 },
  execute: { intent: "exec", weight: 90 },
  shell:   { intent: "exec", weight: 80 },
  sh:      { intent: "exec", weight: 70 },
  bash:    { intent: "exec", weight: 70 },
  delete: { intent: "delete", weight: 95 },
  remove: { intent: "delete", weight: 90 },
  rm:     { intent: "delete", weight: 90 },
  kill:   { intent: "delete", weight: 90 },
  destroy:{ intent: "delete", weight: 85 },
  drop:   { intent: "delete", weight: 70 },
  terminate: { intent: "delete", weight: 85 },
  purge:  { intent: "delete", weight: 85 },
  scale:  { intent: "update", weight: 90 },
  restart:{ intent: "update", weight: 90 },
  patch:  { intent: "update", weight: 80 },
  edit:   { intent: "update", weight: 80 },
  modify: { intent: "update", weight: 75 },
  change: { intent: "update", weight: 70 },
  update: { intent: "update", weight: 75 },
  set:    { intent: "update", weight: 60 },
  run:    { intent: "run",    weight: 75 },
  launch: { intent: "run",    weight: 75 },
  spawn:  { intent: "run",    weight: 75 },
  create: { intent: "create", weight: 70 },
  apply:  { intent: "create", weight: 70 },
  add:    { intent: "create", weight: 50 },
  make:   { intent: "create", weight: 50 },
  new:    { intent: "create", weight: 50 },
  describe: { intent: "get", weight: 80 },
  inspect:  { intent: "get", weight: 80 },
  details:  { intent: "get", weight: 60 },
  detail:   { intent: "get", weight: 60 },
  info:     { intent: "get", weight: 50 },
  explain:  { intent: "get", weight: 60 },
  about:    { intent: "get", weight: 40 },
  // generic list — low priority so a co-occurring specific verb wins
  list:      { intent: "list", weight: 30 },
  show:      { intent: "list", weight: 25 },
  display:   { intent: "list", weight: 25 },
  view:      { intent: "list", weight: 25 },
  see:       { intent: "list", weight: 20 },
  enumerate: { intent: "list", weight: 30 },
  fetch:     { intent: "list", weight: 30 },
  ls:        { intent: "list", weight: 30 },
  count:     { intent: "list", weight: 35 },
  how:       { intent: "list", weight: 15 },
  many:      { intent: "list", weight: 15 },
  which:     { intent: "list", weight: 15 },
  what:      { intent: "list", weight: 10 },
  get:       { intent: "get",  weight: 30 },
  // help
  help: { intent: "help", weight: 100 },
  commands: { intent: "help", weight: 80 },
  start:    { intent: "start",   weight: 85 },
  stop:     { intent: "stop",    weight: 85 },
  upgrade:  { intent: "upgrade", weight: 85 },
  migrate:  { intent: "update",  weight: 80 },
  // diagnostic — high priority so they win over implicit "list" fallback
  // and bypass handleListCommand/handleDirectCommand → route to LLM
  why:          { intent: "diagnose", weight: 70 },
  troubleshoot: { intent: "diagnose", weight: 75 },
  diagnose:     { intent: "diagnose", weight: 80 },
  investigate:  { intent: "diagnose", weight: 75 },
  analyze:      { intent: "diagnose", weight: 70 },
  analyse:      { intent: "diagnose", weight: 70 },
  debug:        { intent: "diagnose", weight: 70 },
  root:         { intent: "diagnose", weight: 50 },
  cause:        { intent: "diagnose", weight: 50 },
  reason:       { intent: "diagnose", weight: 55 },
};

// Backwards-compatible flat lookup for callers that just want the intent.
const VERB_TO_INTENT = (() => {
  const m = {};
  for (const [k, v] of Object.entries(VERB_TABLE)) m[k] = v.intent;
  return m;
})();

// Words that should be ignored when looking for "names". These are common
// English fillers + words used by the prompt structure itself.
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "for", "to", "from", "in", "on", "into", "at", "by", "with", "about",
  "and", "or", "but", "if", "then", "than", "so", "as",
  "i", "me", "my", "we", "us", "you", "your", "they", "them", "it", "its",
  "this", "that", "these", "those",
  "do", "does", "did", "have", "has", "had", "can", "could", "would", "should",
  "may", "might", "must", "will", "shall", "please", "thanks", "thank",
  "now", "currently", "today", "right", "actually",
  "all", "any", "each", "every", "none", "some", "few", "lots", "many",
  "running", "pending", "completed", "failed", "succeeded", "ready",
  "status", "state", "phase", "summary", "detail", "details", "info",
  "version", "image", "images", "containers", "container",
  "cluster", "openshift", "ocp", "kubernetes", "k8s",
  "messages", "message", "respond", "response",
  // verbs already covered by VERB_TO_INTENT but also valid stop-words for
  // name extraction
  "list", "show", "get", "display", "view", "see", "fetch", "ls",
  "count", "how", "many", "which", "what", "describe", "inspect", "explain",
  "about", "delete", "remove", "kill", "destroy", "drop", "purge", "terminate",
  "logs", "log", "tail", "top", "metrics", "usage", "exec", "execute",
  "shell", "run", "launch", "create", "apply", "make", "update", "patch",
  "edit", "modify", "change", "set", "scale", "restart", "help", "info",
  "start", "stop", "upgrade", "migrate",
  "use", "using", "via", "with", "without",
  "why", "troubleshoot", "diagnose", "investigate", "analyze", "analyse",
  "debug", "root", "cause", "reason",
]);

// Filter keywords (issue type). Order matters: most specific first.
const FILTERS = [
  { re: /\bcrash[\s-]*loop[\s-]*back[\s-]*off|\bcrashloop|\bcrash[\s-]*back|\bcrashlook|\bcras[\s-]*loop\b/, value: "CrashLoopBackOff" },
  { re: /\bimage[\s-]*pull[\s-]*back[\s-]*off|\bimagepull|\bimage[\s-]*pull[\s-]*err|\berrimagepull/, value: "ImagePullBackOff" },
  { re: /\bcreate[\s-]*container[\s-]*config[\s-]*err|\bcontainer[\s-]*config[\s-]*err/, value: "CreateContainerConfigError" },
  { re: /\boom[\s-]*killed?|\boutofmemory|\bout[\s-]*of[\s-]*memory/, value: "OOMKilled" },
  { re: /\bevicted/, value: "Evicted" },
  { re: /\bpending\b/, value: "Pending" },
  { re: /\bfailed\b|\bfailing\b|\berror(s)?\b|\bissue(s)?\b|\bproblem(s)?\b|\bbroken/, value: "Failed" },
];

// Namespace marker keywords (treated specially when followed by a word).
const NS_KEYWORDS = new Set(["namespace", "ns", "project", "projects"]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a message into lowercase tokens, preserving useful punctuation
 * (-n flag) and dropping the rest. Returns an array of tokens with their
 * positions so we can resolve "X after the verb" patterns.
 */
export function tokenize(message) {
  if (!message) return [];
  // Replace common punctuation with spaces, but keep '-' and '.' inside names.
  const cleaned = String(message)
    .toLowerCase()
    .replace(/[?!,;:'"`()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  return cleaned.split(" ").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const DNS_LABEL_RE = /^[a-z0-9][-a-z0-9.]*[a-z0-9]?$/;

function isDnsLabel(token) {
  if (!token) return false;
  if (token.length > 253) return false;
  return DNS_LABEL_RE.test(token);
}

function isResourceWord(token) {
  return Object.prototype.hasOwnProperty.call(ALIAS_TO_CANONICAL, token);
}

function isVerb(token) {
  return Object.prototype.hasOwnProperty.call(VERB_TO_INTENT, token);
}

function isNoise(token) {
  return STOP_WORDS.has(token) || isVerb(token) || isResourceWord(token) ||
         NS_KEYWORDS.has(token);
}

// ---------------------------------------------------------------------------
// Compound term normalization — merge multi-word resource types into single
// tokens before the tokenizer splits them (e.g. "virtual machine" → "virtualmachine").
// ---------------------------------------------------------------------------
const COMPOUND_TERMS = [
  [/\bvirtual\s+machine\s+instances?\b/gi, "virtualmachineinstance"],
  [/\bvirtual\s+machines?\b/gi, "virtualmachine"],
  [/\bpipeline\s+runs?\b/gi, "pipelinerun"],
  [/\btask\s+runs?\b/gi, "taskrun"],
  [/\bhelm\s+releases?\b/gi, "helmrelease"],
  [/\bcluster\s+versions?\b/gi, "clusterversion"],
  [/\bmachine\s+sets?\b/gi, "machineset"],
];

function normalizeCompounds(text) {
  let result = text;
  for (const [re, replacement] of COMPOUND_TERMS) {
    result = result.replace(re, replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

/**
 * Parse a natural-language message into a structured command.
 *
 * @param {string} message
 * @param {{namespace?: string, resource?: string, name?: string}} [memory]
 *        Optional conversation memory used to resolve pronouns ("its logs",
 *        "delete it", "now in production").
 */
export function parse(message, memory = {}) {
  const raw = String(message || "");
  const normalized = normalizeCompounds(raw);
  const tokens = tokenize(normalized);
  const lower = normalized.toLowerCase();

  if (tokens.length === 0) {
    return makeResult({ intent: "unknown", raw, confidence: 0 });
  }

  // ---- 1. Intent detection (highest-priority verb wins) ----
  let intent = null;
  let intentWeight = -1;
  let intentTokenIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const v = VERB_TABLE[tokens[i]];
    if (v && v.weight > intentWeight) {
      intent = v.intent;
      intentWeight = v.weight;
      intentTokenIdx = i;
    }
  }

  // "how many" / "count" → list with scope=count
  let scope = null;
  if (/\b(how\s+many|how\s+much|count|number\s+of|total)\b/.test(lower)) {
    intent = intent || "list";
    scope = "count";
  } else if (/\b(list|show|display|view|enumerate)\b/.test(lower)) {
    intent = intent || "list";
    scope = "list";
  } else if (/\b(describe|inspect|details?|info|explain|tell\s+me\s+about)\b/.test(lower)) {
    intent = intent || "get";
    scope = "detail";
  } else if (/\b(health|healthy|alive|ok|up|down|broken)\b/.test(lower)) {
    intent = intent || "list";
    scope = "health";
  }

  // ---- 2. Resource type ----
  // Skip aliases that are also namespace markers ("namespace", "project")
  // when they're clearly being used as a marker (i.e. have a DNS-label
  // neighbor). Otherwise we'd capture "kasten-io project pods" as
  // resource=project instead of resource=pod.
  let resource = null;
  let resourceTokenIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const canon = ALIAS_TO_CANONICAL[t];
    if (!canon) continue;

    // If this token is also a namespace-marker word AND surrounded by a
    // valid DNS label, skip it — it's being used as a marker, not a
    // resource type. EXCEPT when the intent is mutating (delete/create) —
    // "delete namespace X" means resource=namespace, name=X.
    if (NS_KEYWORDS.has(t)) {
      const isMutating = intent === "delete" || intent === "create" || intent === "update";
      if (!isMutating) {
        const prev = tokens[i - 1];
        const next = tokens[i + 1];
        const prevLooksLikeNs = prev && isDnsLabel(prev) && !isNoise(prev);
        const nextLooksLikeNs = next && isDnsLabel(next) && !isNoise(next);
        if (prevLooksLikeNs || nextLooksLikeNs) continue;
      }
    }

    resource = canon;
    resourceTokenIdx = i;
    break;
  }
  // Pronoun resolution from memory.
  if (!resource && memory.resource &&
      /\b(it|its|that|this|same|same\s+one)\b/.test(lower)) {
    resource = memory.resource;
  }

  // Default resource for some intents.
  if (!resource) {
    if (intent === "logs" || intent === "top" || intent === "exec") resource = "pod";
    if (intent === "upgrade" && /\b(cluster|openshift|ocp)\b/.test(lower)) resource = "clusterversion";
  }

  // ---- 3. Namespace extraction ----
  let namespace = null;

  // 3a. Highest precedence: "-n X" or "--namespace X"
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "-n" || tokens[i] === "--namespace" || tokens[i] === "--ns") {
      const next = tokens[i + 1];
      if (isDnsLabel(next) && !isNoise(next)) { namespace = next; break; }
    }
  }

  // 3b. "namespace X" / "ns X" / "project X"
  // Skip if the NS_KEYWORD token was already consumed as the resource type
  // (e.g. "delete namespace X" — resource=namespace, name=X, NOT namespace=X).
  if (!namespace) {
    for (let i = 0; i < tokens.length - 1; i++) {
      if (NS_KEYWORDS.has(tokens[i])) {
        if (i === resourceTokenIdx) continue;
        const next = tokens[i + 1];
        if (isDnsLabel(next) && !isNoise(next)) { namespace = next; break; }
      }
    }
  }

  // 3c. "X namespace" / "X ns" / "X project"
  if (!namespace) {
    for (let i = 1; i < tokens.length; i++) {
      if (NS_KEYWORDS.has(tokens[i])) {
        if (i === resourceTokenIdx) continue;
        const prev = tokens[i - 1];
        if (isDnsLabel(prev) && !isNoise(prev)) { namespace = prev; break; }
      }
    }
  }

  // 3d. Prepositional fallback: "in X" / "under X" / "from X" / "on X"
  // Only accept the next token if it isn't noise / a resource word / a verb.
  if (!namespace) {
    const PREPS = new Set(["in", "under", "from", "on", "within", "inside"]);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (PREPS.has(tokens[i])) {
        let j = i + 1;
        // Skip "the"
        if (tokens[j] === "the") j++;
        // Skip "namespace" / "project" — handled above already
        if (NS_KEYWORDS.has(tokens[j])) j++;
        const cand = tokens[j];
        if (cand && isDnsLabel(cand) && !isNoise(cand)) {
          namespace = cand;
          break;
        }
      }
    }
  }

  // 3e. Pronoun resolution from memory.
  if (!namespace && memory.namespace &&
      /\b(it|its|same|same\s+(namespace|ns|project)|there)\b/.test(lower)) {
    namespace = memory.namespace;
  }

  // ---- 4. allNs flag ----
  const allNs = /\ball\s+(namespaces?|projects?|ns)\b|\beverywhere\b/.test(lower);

  // ---- 5. Filter (issue type) ----
  let filter = null;
  for (const f of FILTERS) {
    if (f.re.test(lower)) { filter = f.value; break; }
  }

  // ---- 6. Resource name extraction ----
  // Strategy: search for the first non-noise DNS-label token that comes
  // AFTER the resource word — or, if the resource was inferred (no
  // explicit token), after the verb. Skip namespace markers and the
  // namespace value itself.
  let name = null;
  if (resource) {
    const startIdx = resourceTokenIdx >= 0 ? resourceTokenIdx + 1 :
                     intentTokenIdx >= 0   ? intentTokenIdx   + 1 : 0;
    for (let i = startIdx; i < tokens.length; i++) {
      const t = tokens[i];
      // Skip namespace marker triplets ("namespace foo" / "-n foo").
      if (NS_KEYWORDS.has(t)) { i++; continue; }
      if (t === "-n" || t === "--namespace" || t === "--ns") { i++; continue; }
      if (t === namespace) continue;
      if (t === "--") break; // exec command separator
      if (isNoise(t)) continue;
      if (!isDnsLabel(t)) continue;
      // Skip pure numbers (e.g. replica counts).
      if (/^\d+$/.test(t)) continue;
      name = t;
      break;
    }
  }
  // Pronoun resolution: "delete it", "show its logs"
  if (!name && memory.name &&
      /\b(it|its|that\s+one|the\s+same|same\s+pod)\b/.test(lower)) {
    name = memory.name;
  }

  // ---- 7. Options ----
  const options = {};
  // tail=N
  const tailMatch = lower.match(/\btail\s*(?:=|\s)\s*(\d+)\b/) ||
                    lower.match(/\blast\s+(\d+)\s+lines?\b/);
  if (tailMatch) options.tail = parseInt(tailMatch[1], 10);
  if (/\bfollow\b|--follow|\b-f\b/.test(lower)) options.follow = true;
  // image=...
  const imgMatch = lower.match(/\bimage[:\s=]+([a-z0-9][-a-z0-9./:_]*)/);
  if (imgMatch) options.image = imgMatch[1];
  // replicas=N
  const repMatch = lower.match(/\b(?:replicas?|to)\s*(?:=|\s)\s*(\d+)\b/);
  if (repMatch) options.replicas = parseInt(repMatch[1], 10);
  // exec command — text after "run"/"exec"/"--"
  const cmdMatch = lower.match(/(?:command|cmd)\s*[:=]\s*"([^"]+)"/) ||
                   lower.match(/--\s+(.+)$/);
  if (cmdMatch) options.command = cmdMatch[1].trim();

  // ---- 8. Disambiguation: if a resource is missing but the question is
  // clearly about pods (filter set, "issues", etc), default to pod.
  if (!resource && (filter || /\bissues?\b|\bproblems?\b|\berrors?\b/.test(lower))) {
    resource = "pod";
    intent = intent || "list";
  }

  // ---- 9. Special: bare cluster health questions ----
  if (!resource && (scope === "health" || /\b(cluster|overview|status)\b/.test(lower))) {
    intent = intent || "list";
    return makeResult({
      intent, resource: "cluster", scope: "health", raw, confidence: 0.7,
    });
  }

  // ---- 10. Help ----
  if (intent === "help" || /^(help|what\s+can\s+you\s+do|commands?)$/i.test(raw.trim())) {
    return makeResult({ intent: "help", raw, confidence: 1 });
  }

  // ---- 11. Final fallback ----
  if (!intent && resource) intent = "list";
  if (!intent) {
    return makeResult({ intent: "unknown", raw, confidence: 0 });
  }

  // ---- 12. Implicit context carryover from memory ----
  // If we found a resource name but no namespace, inherit from memory.
  // This handles "show logs for pod-xyz" after "show pods in sock-shop".
  if (name && !namespace && !allNs && memory.namespace) {
    namespace = memory.namespace;
  }
  // If we have an intent + name but no resource, inherit resource from memory.
  if (name && !resource && memory.resource) {
    resource = memory.resource;
  }
  // If we have a namespace-targeted intent but no name, and the same namespace
  // is in memory, inherit the last resource name.
  if (!name && namespace && memory.name && memory.namespace === namespace && intent && intent !== "list") {
    name = memory.name;
    if (!resource && memory.resource) resource = memory.resource;
  }

  // ---- 13. Confidence scoring ----
  let confidence = 0.4;
  if (intent) confidence += 0.2;
  if (resource) confidence += 0.2;
  if (namespace) confidence += 0.1;
  if (name) confidence += 0.1;
  if (filter) confidence += 0.1;
  if (confidence > 1) confidence = 1;

  return makeResult({
    intent, resource, name, namespace, filter, allNs, scope, options,
    confidence, raw,
  });
}

function makeResult(partial) {
  return {
    intent: partial.intent || "unknown",
    resource: partial.resource || null,
    name: partial.name || null,
    namespace: partial.namespace || null,
    filter: partial.filter || null,
    allNs: Boolean(partial.allNs),
    scope: partial.scope || null,
    options: partial.options || {},
    confidence: typeof partial.confidence === "number" ? partial.confidence : 0,
    raw: partial.raw || "",
  };
}

// ---------------------------------------------------------------------------
// Pretty-print a parsed command (for debugging / "what did you understand?")
// ---------------------------------------------------------------------------
export function describeParse(p) {
  const bits = [];
  bits.push(`intent=${p.intent}`);
  if (p.resource) bits.push(`resource=${p.resource}`);
  if (p.name) bits.push(`name=${p.name}`);
  if (p.namespace) bits.push(`namespace=${p.namespace}`);
  if (p.filter) bits.push(`filter=${p.filter}`);
  if (p.allNs) bits.push(`allNs=true`);
  if (p.scope) bits.push(`scope=${p.scope}`);
  for (const [k, v] of Object.entries(p.options || {})) bits.push(`${k}=${v}`);
  bits.push(`confidence=${p.confidence.toFixed(2)}`);
  return bits.join(" ");
}
