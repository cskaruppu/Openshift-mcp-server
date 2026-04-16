/**
 * Prometheus-compatible metrics exporter for the MCP assistant itself.
 *
 * Zero external dependency — we write a tiny text-exposition implementation
 * that `prom-client` would otherwise provide. Mounted at GET /metrics.
 */

const counters = new Map();
const histograms = new Map();

function key(name, labels) {
  if (!labels) return name;
  const pairs = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(",");
  return `${name}{${pairs}}`;
}

export function incCounter(name, labels = null, value = 1) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) || 0) + value);
}

export function observeHistogram(name, labels, value) {
  const k = key(name, labels);
  if (!histograms.has(k)) {
    histograms.set(k, { count: 0, sum: 0, buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120], counts: [] });
  }
  const h = histograms.get(k);
  h.count++;
  h.sum += value;
  if (h.counts.length === 0) h.counts = Array(h.buckets.length).fill(0);
  for (let i = 0; i < h.buckets.length; i++) {
    if (value <= h.buckets[i]) h.counts[i]++;
  }
}

export function renderMetrics() {
  const lines = [];
  lines.push("# HELP mcp_chat_requests_total Total number of /api/chat requests");
  lines.push("# TYPE mcp_chat_requests_total counter");
  lines.push("# HELP mcp_llm_calls_total Total LLM calls by provider");
  lines.push("# TYPE mcp_llm_calls_total counter");
  lines.push("# HELP mcp_actions_total Pending/approved/executed actions");
  lines.push("# TYPE mcp_actions_total counter");
  lines.push("# HELP mcp_tool_calls_total Agent-loop tool calls");
  lines.push("# TYPE mcp_tool_calls_total counter");
  for (const [k, v] of counters) {
    lines.push(`${k} ${v}`);
  }
  lines.push("# HELP mcp_chat_latency_seconds Chat handler latency");
  lines.push("# TYPE mcp_chat_latency_seconds histogram");
  for (const [k, h] of histograms) {
    const base = k.includes("{") ? k.slice(0, -1) : k; // strip closing "}"
    for (let i = 0; i < h.buckets.length; i++) {
      const brace = k.includes("{") ? "," : "{";
      lines.push(`${base}_bucket${brace}le="${h.buckets[i]}"} ${h.counts[i] || 0}`);
    }
    lines.push(`${base.replace(/\{.*/, "") || base}_sum${k.includes("{") ? k.slice(k.indexOf("{")) : ""} ${h.sum}`);
    lines.push(`${base.replace(/\{.*/, "") || base}_count${k.includes("{") ? k.slice(k.indexOf("{")) : ""} ${h.count}`);
  }
  return lines.join("\n") + "\n";
}

export function handleMetricsRequest(res) {
  const body = renderMetrics();
  res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
  res.end(body);
}
