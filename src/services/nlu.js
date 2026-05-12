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
  deployment:        ["deployment", "deployments", "deploy", "deployments.apps", "replica", "replicas"],
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

  // ---- Tier 1: OpenShift-native resources ----
  buildconfig:       ["buildconfig", "buildconfigs", "bc"],
  build:             ["build", "builds"],
  imagestream:       ["imagestream", "imagestreams"],
  imagestreamtag:    ["imagestreamtag", "imagestreamtags", "istag", "istags"],
  deploymentconfig:  ["deploymentconfig", "deploymentconfigs", "dc"],
  scc:               ["scc", "sccs", "securitycontextconstraint", "securitycontextconstraints"],
  subscription:      ["subscription", "subscriptions", "subs"],
  installplan:       ["installplan", "installplans", "ip"],
  operatorgroup:     ["operatorgroup", "operatorgroups", "og"],
  clusterserviceversion: ["clusterserviceversion", "clusterserviceversions", "csv", "csvs"],
  machineconfig:     ["machineconfig", "machineconfigs", "mc"],
  machineconfigpool: ["machineconfigpool", "machineconfigpools", "mcp"],
  machinehealthcheck: ["machinehealthcheck", "machinehealthchecks", "mhc"],

  // ---- Tier 1: RBAC ----
  role:                ["role", "roles"],
  rolebinding:         ["rolebinding", "rolebindings"],
  clusterrole:         ["clusterrole", "clusterroles"],
  clusterrolebinding:  ["clusterrolebinding", "clusterrolebindings"],
  user:                ["user", "users"],
  group:               ["group", "groups"],
  identity:            ["identity", "identities"],

  // ---- Tier 1: Quota / governance ----
  resourcequota:       ["resourcequota", "resourcequotas", "quota", "quotas"],
  clusterresourcequota: ["clusterresourcequota", "clusterresourcequotas", "crq"],
  limitrange:          ["limitrange", "limitranges", "limits"],
  poddisruptionbudget: ["poddisruptionbudget", "poddisruptionbudgets", "pdb", "pdbs"],

  // ---- Tier 1: CRDs / certificates ----
  customresourcedefinition: ["customresourcedefinition", "customresourcedefinitions", "crd", "crds"],
  certificatesigningrequest: ["certificatesigningrequest", "certificatesigningrequests", "csr", "csrs"],
  priorityclass:       ["priorityclass", "priorityclasses", "pc"],

  // ---- Tier 2: Storage / certs lifecycle ----
  volumesnapshot:      ["volumesnapshot", "volumesnapshots", "vs"],
  volumesnapshotclass: ["volumesnapshotclass", "volumesnapshotclasses", "vsc"],
  csidriver:           ["csidriver", "csidrivers"],

  // ---- Tier 3: Service mesh / networking ----
  virtualservice:      ["virtualservice", "virtualservices", "vsvc"],
  destinationrule:     ["destinationrule", "destinationrules", "dr-rule"],
  gateway:             ["gateway", "gateways", "gw"],
  egressip:            ["egressip", "egressips"],
  egressnetworkpolicy: ["egressnetworkpolicy", "egressnetworkpolicies", "egressnp"],
  networkattachmentdefinition: ["networkattachmentdefinition", "networkattachmentdefinitions", "nad", "net-attach-def"],

  // ---- Tier 3: OAuth / identity ----
  oauthclient:         ["oauthclient", "oauthclients"],
  oauth:               ["oauth"],

  // ---- Tier 3: Etcd / control plane ----
  etcd:                ["etcd"],

  // ---- Sprint B: Compliance & Security Operators ----
  compliancesuite:     ["compliancesuite", "compliancesuites"],
  compliancescan:      ["compliancescan", "compliancescans"],
  complianceprofile:   ["complianceprofile", "complianceprofiles", "profilebundle", "profilebundles"],
  complianceresult:    ["complianceresult", "complianceresults", "compliancecheckresult", "compliancecheckresults"],
  fileintegrity:       ["fileintegrity", "fileintegrities"],
  fileintegritynodestatus: ["fileintegritynodestatus", "fileintegritynodestatuses"],
  // Cert-Manager
  certificate:         ["certificate", "certificates", "cert", "certs"],
  certificaterequest:  ["certificaterequest", "certificaterequests"],
  issuer:              ["issuer", "issuers"],
  clusterissuer:       ["clusterissuer", "clusterissuers"],
  // External Secrets / Vault / SealedSecrets
  externalsecret:      ["externalsecret", "externalsecrets", "es-secret"],
  secretstore:         ["secretstore", "secretstores"],
  clustersecretstore:  ["clustersecretstore", "clustersecretstores"],
  sealedsecret:        ["sealedsecret", "sealedsecrets"],
  vaultauth:           ["vaultauth", "vaultauths"],
  vaultstaticsecret:   ["vaultstaticsecret", "vaultstaticsecrets"],
  // Policy engines
  constrainttemplate:  ["constrainttemplate", "constrainttemplates"],
  constraint:          ["constraint", "constraints"],
  policyreport:        ["policyreport", "policyreports"],
  clusterpolicyreport: ["clusterpolicyreport", "clusterpolicyreports"],
  kyvernopolicy:       ["kyvernopolicy", "kyvernopolicies", "clusterpolicy", "clusterpolicies"],

  // ---- Sprint B: Observability Operators ----
  prometheusrule:      ["prometheusrule", "prometheusrules", "alertrule", "alertrules"],
  servicemonitor:      ["servicemonitor", "servicemonitors"],
  podmonitor:          ["podmonitor", "podmonitors"],
  alertmanagerconfig:  ["alertmanagerconfig", "alertmanagerconfigs"],
  prometheus:          ["prometheus"],
  alertmanager:        ["alertmanager"],
  thanosruler:         ["thanosruler", "thanosrulers"],
  // Logging
  clusterlogforwarder: ["clusterlogforwarder", "clusterlogforwarders", "logforwarder"],
  clusterlogging:      ["clusterlogging", "clusterloggings"],
  lokistack:           ["lokistack", "lokistacks"],
  // Tracing
  jaeger:              ["jaeger", "jaegers"],
  tempo:               ["tempo", "tempos", "tempostack", "tempostacks"],
  // Grafana
  grafana:             ["grafana"],
  grafanadashboard:    ["grafanadashboard", "grafanadashboards"],
  grafanadatasource:   ["grafanadatasource", "grafanadatasources"],

  // ---- Sprint B: Storage — ODF / Ceph / Velero ----
  cephcluster:         ["cephcluster", "cephclusters"],
  cephblockpool:       ["cephblockpool", "cephblockpools"],
  cephfilesystem:      ["cephfilesystem", "cephfilesystems"],
  cephobjectstore:     ["cephobjectstore", "cephobjectstores"],
  noobaa:              ["noobaa", "noobaas", "objectbucket", "objectbuckets"],
  storagecluster:      ["storagecluster", "storageclusters"],
  // Velero
  backup:              ["backup", "backups"],
  restore:             ["restore", "restores"],
  schedule:            ["schedule", "schedules"],
  backupstoragelocation: ["backupstoragelocation", "backupstoragelocations", "bsl"],
  volumesnapshotlocation: ["volumesnapshotlocation", "volumesnapshotlocations", "vsl"],
  podvolumebackup:     ["podvolumebackup", "podvolumebackups"],

  // ---- Sprint B: Multi-Cluster — ACM / Hive / HyperShift ----
  managedcluster:      ["managedcluster", "managedclusters"],
  managedclusteraddon: ["managedclusteraddon", "managedclusteraddons"],
  policy:              ["policy", "policies"],
  placementrule:       ["placementrule", "placementrules"],
  placement:           ["placement", "placements"],
  manifestwork:        ["manifestwork", "manifestworks"],
  gitopscluster:       ["gitopscluster", "gitopsclusters"],
  // Hive
  clusterdeployment:   ["clusterdeployment", "clusterdeployments"],
  clusterpool:         ["clusterpool", "clusterpools"],
  clusterclaim:        ["clusterclaim", "clusterclaims"],
  clusterimageset:     ["clusterimageset", "clusterimagesets"],
  // HyperShift
  hostedcluster:       ["hostedcluster", "hostedclusters"],
  nodepool:            ["nodepool", "nodepools"],
  // Submariner
  submariner:          ["submariner", "submariners"],

  // ---- Sprint B: Bare-Metal & Edge ----
  baremetalhost:       ["baremetalhost", "baremetalhosts", "bmh"],
  hostfirmwaresettings:["hostfirmwaresettings"],
  infraenv:            ["infraenv", "infraenvs"],
  agent:               ["agent", "agents"],
  agentclusterinstall: ["agentclusterinstall", "agentclusterinstalls"],

  // ---- Sprint B: Performance / Tuning ----
  performanceprofile:  ["performanceprofile", "performanceprofiles", "perfprofile"],
  tuned:               ["tuned", "tuneds", "tunedprofile"],
  nodefeature:         ["nodefeature", "nodefeatures"],
  nodefeaturediscovery:["nodefeaturediscovery", "nodefeaturediscoveries", "nfd"],

  // ---- Sprint B: OpenShift AI (RHODS) ----
  datasciencecluster:  ["datasciencecluster", "datascienceclusters", "dsc"],
  notebook:            ["notebook", "notebooks"],
  workbench:           ["workbench", "workbenches"],
  inferenceservice:    ["inferenceservice", "inferenceservices", "isvc"],
  servingruntime:      ["servingruntime", "servingruntimes"],
  modelregistry:       ["modelregistry", "modelregistries"],

  // ---- Sprint B: Networking — SR-IOV / MetalLB / DNS / NetObserv ----
  sriovnetwork:        ["sriovnetwork", "sriovnetworks"],
  sriovnetworknodepolicy: ["sriovnetworknodepolicy", "sriovnetworknodepolicies"],
  bgppeer:             ["bgppeer", "bgppeers"],
  ipaddresspool:       ["ipaddresspool", "ipaddresspools"],
  l2advertisement:     ["l2advertisement", "l2advertisements"],
  bgpadvertisement:    ["bgpadvertisement", "bgpadvertisements"],
  adminnetworkpolicy:  ["adminnetworkpolicy", "adminnetworkpolicies", "anp"],
  baselineadminnetworkpolicy: ["baselineadminnetworkpolicy", "baselineadminnetworkpolicies", "banp"],
  flowcollector:       ["flowcollector", "flowcollectors"],
  dnsoperator:         ["dnsoperator", "dnsoperators"],
  ingresscontroller:   ["ingresscontroller", "ingresscontrollers", "router"],

  // ---- Sprint B: Tekton Advanced ----
  eventlistener:       ["eventlistener", "eventlisteners"],
  triggerbinding:      ["triggerbinding", "triggerbindings"],
  triggertemplate:     ["triggertemplate", "triggertemplates"],
  trigger:             ["trigger", "triggers"],
  pipelineresource:    ["pipelineresource", "pipelineresources"],

  // ---- Sprint B: Admission & API Governance ----
  mutatingwebhookconfiguration:  ["mutatingwebhookconfiguration", "mutatingwebhookconfigurations", "mwc"],
  validatingwebhookconfiguration:["validatingwebhookconfiguration", "validatingwebhookconfigurations", "vwc"],
  apiservice:          ["apiservice", "apiservices"],
  apirequestcount:     ["apirequestcount", "apirequestcounts"],
  flowschema:          ["flowschema", "flowschemas"],
  prioritylevelconfiguration: ["prioritylevelconfiguration", "prioritylevelconfigurations"],

  // ---- Sprint B: ArgoCD / GitOps ----
  application:         ["application", "applications", "argoapp", "argoapps"],
  appproject:          ["appproject", "appprojects"],
  applicationset:      ["applicationset", "applicationsets", "appset"],

  // ---- Sprint B: OpenShift Templates / Catalog ----
  template:            ["template", "templates"],
  catalogsource:       ["catalogsource", "catalogsources"],
  packagemanifest:     ["packagemanifest", "packagemanifests"],
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
  // ---- Tier 1: node lifecycle ----
  drain:    { intent: "drain",   weight: 92 },
  cordon:   { intent: "cordon",  weight: 92 },
  uncordon: { intent: "uncordon", weight: 92 },
  taint:    { intent: "taint",   weight: 88 },
  untaint:  { intent: "untaint", weight: 88 },
  label:    { intent: "label",   weight: 70 },
  annotate: { intent: "annotate", weight: 70 },
  evict:    { intent: "evict",   weight: 85 },
  // ---- Tier 1: rollout / rollback ----
  rollback: { intent: "rollback", weight: 92 },
  rollout:  { intent: "rollout",  weight: 80 },
  revert:   { intent: "rollback", weight: 88 },
  undo:     { intent: "rollback", weight: 85 },
  pause:    { intent: "rollout",  weight: 75 },
  resume:   { intent: "rollout",  weight: 75 },
  // ---- Tier 1: RBAC inquiry ----
  who:      { intent: "rbac",     weight: 60 },
  permissions: { intent: "rbac",  weight: 75 },
  access:   { intent: "rbac",     weight: 55 },
  // ---- Tier 1: approval (CSR / installplan) ----
  approve:  { intent: "approve",  weight: 88 },
  reject:   { intent: "delete",   weight: 80 },
  sign:     { intent: "approve",  weight: 80 },
  // ---- Tier 2: export / dump ----
  export:   { intent: "export",   weight: 85 },
  dump:     { intent: "export",   weight: 80 },
  yaml:     { intent: "export",   weight: 30 },
  // ---- Tier 2: compare ----
  compare:  { intent: "compare",  weight: 80 },
  diff:     { intent: "compare",  weight: 80 },
  // ---- Tier 2: snapshot ----
  snapshot: { intent: "snapshot", weight: 80 },
  // ---- Tier 2: resize / expand ----
  resize:   { intent: "resize",   weight: 85 },
  expand:   { intent: "resize",   weight: 75 },
  grow:     { intent: "resize",   weight: 60 },
  // ---- Tier 2: find / search ----
  find:     { intent: "list",     weight: 30 },
  search:   { intent: "list",     weight: 30 },
  filter:   { intent: "list",     weight: 25 },
  // ---- Sprint C: bulk operations ----
  bulk:     { intent: "bulk",     weight: 80 },
  cleanup:  { intent: "bulk",     weight: 75 },
  // ---- Sprint C: change timeline / forecast / kb ----
  changes:  { intent: "changes",  weight: 70 },
  changed:  { intent: "changes",  weight: 55 },
  history:  { intent: "changes",  weight: 60 },
  timeline: { intent: "changes",  weight: 70 },
  forecast: { intent: "forecast", weight: 85 },
  predict:  { intent: "forecast", weight: 80 },
  project:  { intent: "forecast", weight: 55 },
  trend:    { intent: "forecast", weight: 70 },
  trends:   { intent: "forecast", weight: 70 },
  kb:       { intent: "kb",       weight: 80 },
  knowledge:{ intent: "kb",       weight: 70 },
  runbook:  { intent: "kb",       weight: 75 },
  // ---- Sprint C: self-service provisioning ----
  provision:{ intent: "provision", weight: 85 },
  onboard:  { intent: "provision", weight: 75 },
  setup:    { intent: "provision", weight: 55 },
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
  "terminating", "containercreating", "imagepullbackoff", "crashloopbackoff",
  "oomkilled", "evicted", "init", "stuck", "state", "phase",
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
  // Tier 1-3 new verbs
  "drain", "cordon", "uncordon", "taint", "untaint", "label", "annotate", "evict",
  "rollback", "rollout", "revert", "undo", "pause", "resume",
  "who", "permissions", "access", "approve", "reject", "sign",
  "export", "dump", "yaml", "compare", "diff", "snapshot", "resize", "expand", "grow",
  "find", "search", "filter",
  // Common English adjectives/adverbs that appear in follow-up queries and must
  // never be treated as Kubernetes resource names.
  "detailed", "brief", "full", "complete", "quick", "more", "less", "latest",
  "previous", "recent", "current", "next", "last", "first", "new", "old",
  "specific", "particular", "exact", "same", "other", "another", "above",
  "below", "existing", "available", "overall", "total", "entire", "whole",
  "continue", "continued", "also", "still", "just", "only", "even",
  "check", "give", "tell", "want", "need", "like", "know", "think",
  "look", "looking", "try", "trying", "going", "work", "working",
  "correct", "proper", "good", "bad", "better", "best", "worse", "worst",
  "history", "timeline", "changelog", "overview", "audit", "report",
  "everything", "anything", "something", "nothing",
  "resource", "resources", "limits", "requests", "probes", "upgrades",
  "clients", "servers", "providers", "rules", "policies",
  // Time-related words that appear in advanced filter queries
  "hour", "hours", "minute", "minutes", "second", "seconds",
  "day", "days", "week", "weeks", "month", "months", "ago",
  // Verb forms and operational words
  "logged", "login", "logins", "taints", "labels", "annotations",
  "configured", "installed", "enabled", "disabled", "active",
  "admin", "admins", "administrator",
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
  [/\boauth\s+clients?\b/gi, "oauthclient"],
  [/\bcluster\s+roles?\s*bindings?\b/gi, "clusterrolebinding"],
  [/\bcluster\s+roles?\b/gi, "clusterrole"],
  [/\brole\s*bindings?\b/gi, "rolebinding"],
  [/\bservice\s+accounts?\b/gi, "serviceaccount"],
  [/\bstorage\s+class(?:es)?\b/gi, "storageclass"],
  [/\bnetwork\s+polic(?:y|ies)\b/gi, "networkpolicy"],
  [/\bbuild\s+configs?\b/gi, "buildconfig"],
  [/\bimage\s+streams?\b/gi, "imagestream"],
  [/\bdeployment\s+configs?\b/gi, "deploymentconfig"],
  [/\bconfig\s+maps?\b/gi, "configmap"],
  [/\bstateful\s+sets?\b/gi, "statefulset"],
  [/\bdaemon\s+sets?\b/gi, "daemonset"],
  [/\breplica\s+sets?\b/gi, "replicaset"],
  [/\bcron\s+jobs?\b/gi, "cronjob"],
  [/\bcluster\s+operators?\b/gi, "clusteroperator"],
  [/\bresource\s+quotas?\b/gi, "resourcequota"],
  [/\blimit\s+ranges?\b/gi, "limitrange"],
  [/\bpod\s+disruption\s+budgets?\b/gi, "poddisruptionbudget"],
  [/\bmachine\s+configs?\b/gi, "machineconfig"],
  [/\bmachine\s+config\s+pools?\b/gi, "machineconfigpool"],
  [/\bmachine\s+health\s+checks?\b/gi, "machinehealthcheck"],
  [/\binstall\s+plans?\b/gi, "installplan"],
  [/\boperator\s+groups?\b/gi, "operatorgroup"],
  [/\bingress\s+controllers?\b/gi, "ingresscontroller"],
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
  } else if (/\b(history|timeline|changelog)\b/.test(lower)) {
    intent = intent || "list";
    scope = "history";
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
    // For describe/get/delete/restart without explicit resource: inherit
    // from memory if available; otherwise default to pod (most common).
    if (!resource && (intent === "describe" || intent === "get" || intent === "delete" || intent === "restart")) {
      resource = memory.resource || "pod";
    }
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
  // Strategy: try forward search after the resource word (most common shape
  // "describe pod NAME"), then backward search before the resource word
  // (handles "NAME pod logs" or "NAME describe"), then a global fallback.
  let name = null;
  const isCandidateName = (t, idx) => {
    if (NS_KEYWORDS.has(t)) return false;
    if (t === "-n" || t === "--namespace" || t === "--ns") return false;
    if (idx > 0 && (tokens[idx - 1] === "-n" || tokens[idx - 1] === "--namespace" || tokens[idx - 1] === "--ns")) return false;
    if (t === namespace) return false;
    if (t === "--") return false;
    if (isNoise(t)) return false;
    if (!isDnsLabel(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (idx === resourceTokenIdx) return false;
    if (idx === intentTokenIdx) return false;
    return true;
  };

  // 6a. Forward search after resource word (or after intent verb if no resource).
  if (resource) {
    const startIdx = resourceTokenIdx >= 0 ? resourceTokenIdx + 1 :
                     intentTokenIdx >= 0   ? intentTokenIdx   + 1 : 0;
    for (let i = startIdx; i < tokens.length; i++) {
      if (tokens[i] === "--") break;
      if (NS_KEYWORDS.has(tokens[i]) || tokens[i] === "-n" || tokens[i] === "--namespace" || tokens[i] === "--ns") { i++; continue; }
      if (isCandidateName(tokens[i], i)) { name = tokens[i]; break; }
    }
  }

  // 6b. Backward search before resource word — handles "NAME pod logs" or
  //     "NAME describe" where the user puts the resource name first.
  if (!name && (resourceTokenIdx > 0 || (intentTokenIdx > 0 && resource))) {
    const stopIdx = resourceTokenIdx > 0 ? resourceTokenIdx : intentTokenIdx;
    for (let i = stopIdx - 1; i >= 0; i--) {
      if (isCandidateName(tokens[i], i)) { name = tokens[i]; break; }
    }
  }

  // 6c. Global fallback — if there's an intent but still no name, look
  //     anywhere in the message for a non-noise DNS-label that resembles
  //     a workload name (has a hyphen, suggesting deployment-hash-suffix).
  if (!name && intent) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!isCandidateName(t, i)) continue;
      // Prefer hyphenated names — they look like real K8s resource names.
      if (t.includes("-") || t.length > 4) { name = t; break; }
    }
  }

  // 6d. Pronoun resolution: "delete it", "show its logs"
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
  // Only activate for generic intents (list/get/null). Specific intents like
  // "rbac", "rollout", "drain", etc. have their own handlers and must NOT be
  // hijacked just because the message contains the word "cluster".
  const SPECIFIC_INTENTS = new Set([
    "rbac", "rollout", "rollback", "drain", "cordon", "uncordon",
    "taint", "untaint", "approve", "compare", "export", "snapshot",
    "resize", "bulk", "changes", "forecast", "kb", "provision",
    "logs", "top", "exec", "delete", "create", "update", "start", "stop",
    "label", "annotate", "evict", "run",
  ]);
  if (!resource && !SPECIFIC_INTENTS.has(intent) &&
      (scope === "health" || /\b(cluster|overview|status)\b/.test(lower))) {
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
  // ChatGPT/Claude-style continuity: when the user follows up without
  // re-specifying namespace/resource, inherit from the last turn.

  // Carry namespace forward if we have ANY actionable context (name or
  // intent+resource) but no explicit namespace and no "all namespaces" flag.
  if (!namespace && !allNs && memory.namespace) {
    if (name || (intent && resource && intent !== "list")) {
      namespace = memory.namespace;
    }
  }

  // Inherit resource from memory if we have a name but no resource type.
  // Guard: don't inherit if the current intent implies a different resource
  // domain (e.g. intent=rollout shouldn't inherit resource=clusterversion).
  const INTENT_RESOURCE_COMPAT = {
    rollout: new Set(["deployment", "deploymentconfig", "statefulset", "daemonset"]),
    rollback: new Set(["deployment", "deploymentconfig"]),
    cordon: new Set(["node"]),
    uncordon: new Set(["node"]),
    drain: new Set(["node"]),
    taint: new Set(["node"]),
    untaint: new Set(["node"]),
  };
  if (name && !resource && memory.resource) {
    const compat = INTENT_RESOURCE_COMPAT[intent];
    if (!compat || compat.has(memory.resource)) {
      resource = memory.resource;
    }
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

  // Pillar 1: Extract constraints (maintenance window, change freeze, urgency)
  const constraints = extractConstraints(lower);
  // Pillar 1: Detect persona signals (security/dev/manager language patterns)
  const personaHint = detectPersona(lower);
  // Pillar 1: Detect goal intent (multi-step goals like "migrate", "audit", "prepare for")
  const goalHint = detectGoal(lower);
  // Tier 2: Advanced filters — time-based, superlative, status, output format
  const advFilters = extractAdvancedFilters(lower);

  return makeResult({
    intent, resource, name, namespace, filter, allNs, scope, options,
    confidence, raw, constraints, personaHint, goalHint, advFilters,
  });
}

// ---------------------------------------------------------------------------
// Tier 2: Advanced filters — time-based, superlative, output format, status
//
// Captures phrases like:
//   "pods pending for more than 1 hour"  → timeFilter: { op: ">", durationMs }
//   "which pod uses the most CPU"        → superlative: { op: "max", metric: "cpu" }
//   "pods stuck in Terminating"          → statusFilter: "Terminating"
//   "export deployments to yaml"         → outputFormat: "yaml"
//   "find pods without limits"           → missingFeature: "limits"
// ---------------------------------------------------------------------------
function extractAdvancedFilters(lower) {
  const f = {};

  // --- Time-based filtering ---
  // "for more than 1 hour", "older than 30 minutes", "in the last 5m"
  const durationRe = /\b(?:for\s+(?:more|longer)\s+than|older\s+than|>\s*|over\s+|past\s+|last\s+|since\s+|within\s+)\s*(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)\b/;
  const dm = lower.match(durationRe);
  if (dm) {
    const n = parseInt(dm[1], 10);
    const unit = dm[2];
    const ms = toMs(n, unit);
    if (ms != null) {
      const isPast = /\b(last|past|within|since)\b/.test(dm[0]);
      f.timeFilter = { op: isPast ? "withinLastMs" : "olderThanMs", ms, raw: dm[0] };
    }
  }
  // "in the last 5 minutes" / "recently"
  if (!f.timeFilter && /\b(recent(ly)?|just\s+now|moments?\s+ago)\b/.test(lower)) {
    f.timeFilter = { op: "withinLastMs", ms: 15 * 60_000, raw: "recently" };
  }
  // Restart filter ("restarted recently", "restarted in last 30 min")
  if (/\brestart(ed|ing|s)?\b/.test(lower)) {
    f.restartFilter = true;
    if (!f.timeFilter && /\blast\b|\bpast\b|\bwithin\b/.test(lower)) {
      f.timeFilter = { op: "withinLastMs", ms: 60 * 60_000, raw: "last hour" };
    }
  }

  // --- Superlative queries: "which pod uses the most CPU" / "largest PVC" / "oldest pod" ---
  if (/\b(most|highest|top|biggest|largest|maximum|max)\b/.test(lower)) {
    let metric = null;
    if (/\bcpu\b/.test(lower)) metric = "cpu";
    else if (/\b(memory|mem|ram)\b/.test(lower)) metric = "memory";
    else if (/\b(storage|disk|size|capacity)\b/.test(lower)) metric = "storage";
    else if (/\b(restart(s|ed)?)\b/.test(lower)) metric = "restarts";
    else if (/\b(age|old|oldest)\b/.test(lower)) metric = "age";
    // Infer metric from resource context when not stated explicitly
    else if (/\b(pvc|persistentvolumeclaim|persistentvolume|pv)\b/.test(lower)) metric = "storage";
    else if (/\b(biggest|largest)\b/.test(lower)) metric = "size";
    if (metric) f.superlative = { op: "max", metric };
  }
  if (/\b(least|lowest|smallest|minimum|min)\b/.test(lower)) {
    let metric = null;
    if (/\bcpu\b/.test(lower)) metric = "cpu";
    else if (/\b(memory|mem|ram)\b/.test(lower)) metric = "memory";
    else if (/\b(age|young|youngest|newest)\b/.test(lower)) metric = "age";
    else if (/\b(pvc|persistentvolumeclaim|pv)\b/.test(lower)) metric = "storage";
    if (metric) f.superlative = { op: "min", metric };
  }
  // "oldest X" / "newest X" — age superlative
  if (/\b(oldest)\b/.test(lower)) f.superlative = { op: "max", metric: "age" };
  if (/\b(newest|youngest|most\s+recent)\b/.test(lower) && !f.superlative) f.superlative = { op: "min", metric: "age" };

  // --- Status filters that aren't in the basic FILTERS table ---
  if (/\b(terminating|stuck\s+(?:in\s+)?terminat)/i.test(lower)) f.statusFilter = "Terminating";
  else if (/\bcontainercreating\b/i.test(lower)) f.statusFilter = "ContainerCreating";
  else if (/\binit(?:\s+|:)|\binit[- ]?error\b/.test(lower)) f.statusFilter = "Init";
  else if (/\bcompleted\b/.test(lower) && /\bpod/.test(lower)) f.statusFilter = "Completed";
  else if (/\bunknown\s+state\b|\bphase\s+unknown\b/.test(lower)) f.statusFilter = "Unknown";

  // --- Zero-replica / scale-to-zero filter ---
  if (/\b(?:no|zero|0)\s+replicas?\b|\bscaled?\s+to\s+0\b|\bscale[- ]to[- ]zero\b/.test(lower)) {
    f.zeroReplicas = true;
  }

  // --- Missing-feature filters ("without limits", "no PDB", "missing requests") ---
  if (/\b(?:without|no|missing|lacking)\s+(?:cpu\s+)?(?:resource\s+)?limits?\b/.test(lower)) f.missingFeature = "limits";
  else if (/\b(?:without|no|missing)\s+(?:resource\s+)?requests?\b/.test(lower)) f.missingFeature = "requests";
  else if (/\b(?:without|no|missing)\s+(?:liveness|readiness|startup)\s+probe?\b/.test(lower)) f.missingFeature = "probes";
  else if (/\b(?:without|no|missing)\s+pdb\b|\bno\s+poddisruption/i.test(lower)) f.missingFeature = "pdb";
  else if (/\b(?:without|no|missing)\s+networkpolic/i.test(lower)) f.missingFeature = "networkpolicy";
  else if (/\b(?:without|no|missing)\s+(?:owner|owner\s*ref)/i.test(lower)) f.missingFeature = "ownerRef";

  // --- Output format ---
  if (/\b(?:as|in|to|export\s+to)\s+yaml\b|\.yaml\b/.test(lower)) f.outputFormat = "yaml";
  else if (/\b(?:as|in|to|export\s+to)\s+json\b|\.json\b/.test(lower)) f.outputFormat = "json";
  else if (/\b(?:as|in|to|export\s+to)\s+csv\b|\.csv\b/.test(lower)) f.outputFormat = "csv";
  else if (/\b(?:as|in|to|export\s+to)\s+(?:table|markdown|md)\b/.test(lower)) f.outputFormat = "table";

  // --- Image tag concerns ---
  if (/\blatest\s+tag\b|:latest\b/.test(lower)) f.imageTagConcern = "latest";

  // --- Cross-namespace compare ---
  const compareMatch = lower.match(/\b(?:compare|diff)\s+(?:namespace\s+)?(\S+)\s+(?:and|vs|with|to|against)\s+(?:namespace\s+)?(\S+)\b/);
  if (compareMatch) {
    f.compare = { a: compareMatch[1].replace(/[^a-z0-9-_]/g, ""), b: compareMatch[2].replace(/[^a-z0-9-_]/g, "") };
  }

  return Object.keys(f).length > 0 ? f : null;
}

function toMs(n, unit) {
  const u = unit.toLowerCase();
  if (/^s|sec/.test(u)) return n * 1000;
  if (/^m($|in)/.test(u)) return n * 60_000;
  if (/^h/.test(u)) return n * 3_600_000;
  if (/^d/.test(u)) return n * 86_400_000;
  if (/^w/.test(u)) return n * 7 * 86_400_000;
  return null;
}

// ---------------------------------------------------------------------------
// Pillar 1: Constraint extraction (maintenance windows, change freeze, urgency)
// ---------------------------------------------------------------------------
function extractConstraints(lower) {
  const c = {};

  // Urgency
  if (/\b(urgent|asap|now|immediately|critical|emergency|p0|p1)\b/.test(lower)) {
    c.urgency = "critical";
  } else if (/\b(soon|today|priority|important)\b/.test(lower)) {
    c.urgency = "high";
  } else if (/\b(no rush|whenever|low priority|when possible)\b/.test(lower)) {
    c.urgency = "low";
  }

  // Maintenance / change window
  const mwMatch = lower.match(/\b(?:during|in|within|after|before)\s+(?:the\s+)?(?:maintenance|change|deployment)\s+(?:window|slot)\b/);
  if (mwMatch) c.maintenanceWindow = true;
  if (/\b(?:maintenance|change|deploy(?:ment)?)\s+window\b/.test(lower)) c.maintenanceWindow = true;

  // Change freeze
  if (/\b(?:change|deploy(?:ment)?|code)\s+freeze\b|\bdo not deploy\b|\bdnd\b/.test(lower)) {
    c.changeFreeze = true;
  }

  // Production vs non-prod
  if (/\b(?:production|prod|live)\b/.test(lower)) c.environment = "production";
  else if (/\b(?:staging|stage|preprod|uat)\b/.test(lower)) c.environment = "staging";
  else if (/\b(?:dev(?:elopment)?|test|qa|sandbox)\b/.test(lower)) c.environment = "development";

  // Approval / review constraints
  if (/\b(?:requires?|needs?|with)\s+approval\b|\bcab\s+approved\b|\bafter\s+review\b/.test(lower)) {
    c.requiresApproval = true;
  }

  // Dry-run preference
  if (/\bdry[\s-]?run\b|\bsimulate\b|\bpreview\b|\bwhat[- ]if\b/.test(lower)) {
    c.preferDryRun = true;
  }

  // Time-of-day constraint
  const todMatch = lower.match(/\b(after|before|at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|hours?|hrs)?\b/);
  if (todMatch) c.timeConstraint = todMatch[0];

  return Object.keys(c).length > 0 ? c : null;
}

// ---------------------------------------------------------------------------
// Pillar 1: Persona detection from language patterns
// ---------------------------------------------------------------------------
function detectPersona(lower) {
  // Security persona: talks about CVEs, RBAC, compliance, audit, policies
  if (/\b(cve|vulnerab|exploit|security audit|cis benchmark|nist|hipaa|pci|soc2|rbac|policy|policies|complian|threat)\b/.test(lower)) {
    return "security";
  }
  // Developer persona: talks about deployments, code, builds, environment vars
  if (/\b(my app|deploy(?:ed)?|build|pipeline|env(?:ironment)? var|configmap|secret value|image tag|dockerfile|helm|chart)\b/.test(lower)) {
    return "developer";
  }
  // Manager persona: asks about costs, summaries, headcount, reports
  if (/\b(cost|spend|budget|monthly|quarterly|report|summary|executive|how many people|headcount|sla|slo)\b/.test(lower)) {
    return "manager";
  }
  // SRE / Platform default: ops/health/performance/scaling/incidents
  if (/\b(sre|incident|p0|p1|p2|capacity|scale|throughput|latency|sli|slo|toil|postmortem|root cause)\b/.test(lower)) {
    return "sre";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pillar 1: Goal-oriented intent detection (for the planner in Pillar 4)
// ---------------------------------------------------------------------------
function detectGoal(lower) {
  if (/\b(migrate|migration|move|relocate)\b/.test(lower)) return "migration";
  if (/\b(prepare|ready|harden|production[- ]ize)\b/.test(lower)) return "prepare_production";
  if (/\b(audit|review|inventory|stocktake)\b/.test(lower)) return "audit";
  if (/\b(troubleshoot|debug|investigate|root cause|why\s+is)\b/.test(lower)) return "troubleshoot";
  if (/\b(optimize|right[- ]size|reduce|cleanup|clean up)\b/.test(lower)) return "optimize";
  if (/\b(upgrade|update|patch)\b/.test(lower)) return "upgrade";
  if (/\b(backup|restore|disaster recovery|dr\s+test)\b/.test(lower)) return "backup_restore";
  if (/\b(scale|grow|expand|capacity\s+plan)\b/.test(lower)) return "scale";
  return null;
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
    constraints: partial.constraints || null,
    personaHint: partial.personaHint || null,
    goalHint: partial.goalHint || null,
    advFilters: partial.advFilters || null,
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
