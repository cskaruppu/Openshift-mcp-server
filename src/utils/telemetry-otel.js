/**
 * OpenTelemetry Integration Layer.
 *
 * Provides standards-based distributed tracing and metrics export via OTLP.
 * When OTLP_ENDPOINT is not set, all functions are safe no-ops — zero
 * overhead on existing functionality.
 *
 * Integrates with enterprise observability stacks: Jaeger, Grafana Tempo,
 * Datadog, Dynatrace, New Relic, Splunk, and any OTLP-compatible backend.
 *
 * No external dependency required — uses built-in fetch for OTLP/HTTP export
 * when the full @opentelemetry/sdk is not installed.
 */

// ── Configuration ───────────────────────────────────────────────────────────

const OTLP_ENDPOINT = process.env.OTLP_ENDPOINT || "";
const OTLP_HEADERS = process.env.OTLP_HEADERS || "";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "tcs-agentic-ai";
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || "1.0.0";
const OTEL_ENABLED = Boolean(OTLP_ENDPOINT);

// ── Trace ID generation ─────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";

function generateTraceId() {
  return randomBytes(16).toString("hex");
}

function generateSpanId() {
  return randomBytes(8).toString("hex");
}

// ── In-memory span buffer ───────────────────────────────────────────────────

const _spanBuffer = [];
const FLUSH_INTERVAL_MS = 15_000;
const MAX_BUFFER_SIZE = 200;

let _flushTimer = null;

// ── Span tracking ───────────────────────────────────────────────────────────

/**
 * Start a new trace span. Returns a span context object.
 *
 * @param {string} name       — Span name (e.g. "chat.request", "tool.list_pods")
 * @param {object} [attrs]    — Key-value attributes
 * @param {object} [parent]   — Parent span context (for nesting)
 * @returns {{ traceId, spanId, name, startTime, attributes, end }}
 */
export function startSpan(name, attrs = {}, parent = null) {
  if (!OTEL_ENABLED) {
    return {
      traceId: "0",
      spanId: "0",
      name,
      startTime: Date.now(),
      attributes: attrs,
      end: () => {},
      setStatus: () => {},
      setAttribute: () => {},
    };
  }

  const traceId = parent?.traceId || generateTraceId();
  const spanId = generateSpanId();
  const startTime = Date.now();

  const span = {
    traceId,
    spanId,
    parentSpanId: parent?.spanId || "",
    name,
    startTime,
    attributes: { ...attrs },

    setAttribute(key, value) {
      span.attributes[key] = value;
    },

    setStatus(code, message) {
      span.attributes["otel.status_code"] = code;
      if (message) span.attributes["otel.status_message"] = message;
    },

    end() {
      span.endTime = Date.now();
      span.durationMs = span.endTime - span.startTime;
      _spanBuffer.push(span);

      if (_spanBuffer.length >= MAX_BUFFER_SIZE) {
        _flushSpans();
      }
    },
  };

  return span;
}

/**
 * Record a tool call as a span.
 *
 * @param {string} toolName
 * @param {object} params
 * @param {Function} fn — Async function to execute
 * @returns {Promise<*>} — Result of fn()
 */
export async function traceToolCall(toolName, params, fn) {
  const span = startSpan(`tool.${toolName}`, {
    "mcp.tool.name": toolName,
    "mcp.tool.params_keys": Object.keys(params || {}).join(","),
  });

  try {
    const result = await fn();
    span.setStatus("OK");
    return result;
  } catch (err) {
    span.setStatus("ERROR", err.message);
    span.setAttribute("error.type", err.constructor?.name || "Error");
    span.setAttribute("error.message", err.message);
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Record a chat request as a span.
 *
 * @param {string} userMessage
 * @param {object} parsed — NLU parse result
 * @param {Function} fn — Async function to execute
 * @returns {Promise<*>}
 */
export async function traceChatRequest(userMessage, parsed, fn) {
  const span = startSpan("chat.request", {
    "chat.intent": parsed?.intent || "unknown",
    "chat.resource": parsed?.resource || "none",
    "chat.scope": parsed?.scope || "none",
    "chat.confidence": parsed?.confidence || 0,
    "chat.message_length": userMessage?.length || 0,
  });

  try {
    const result = await fn();
    span.setStatus("OK");
    return result;
  } catch (err) {
    span.setStatus("ERROR", err.message);
    throw err;
  } finally {
    span.end();
  }
}

// ── Metrics ─────────────────────────────────────────────────────────────────

const _counters = new Map();
const _histograms = new Map();

/**
 * Increment a counter metric.
 * @param {string} name
 * @param {object} [labels]
 * @param {number} [value]
 */
export function incrCounter(name, labels = {}, value = 1) {
  const key = `${name}|${JSON.stringify(labels)}`;
  _counters.set(key, (_counters.get(key) || 0) + value);
}

/**
 * Record a histogram observation.
 * @param {string} name
 * @param {number} value
 * @param {object} [labels]
 */
export function recordHistogram(name, value, labels = {}) {
  const key = `${name}|${JSON.stringify(labels)}`;
  if (!_histograms.has(key)) {
    _histograms.set(key, { count: 0, sum: 0, min: Infinity, max: -Infinity });
  }
  const h = _histograms.get(key);
  h.count++;
  h.sum += value;
  h.min = Math.min(h.min, value);
  h.max = Math.max(h.max, value);
}

// ── OTLP/HTTP export ────────────────────────────────────────────────────────

function _buildHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };

  if (OTLP_HEADERS) {
    for (const pair of OTLP_HEADERS.split(",")) {
      const [k, ...vParts] = pair.split("=");
      if (k && vParts.length) {
        headers[k.trim()] = vParts.join("=").trim();
      }
    }
  }

  return headers;
}

function _spansToOtlp(spans) {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: SERVICE_NAME } },
          { key: "service.version", value: { stringValue: SERVICE_VERSION } },
          { key: "deployment.environment", value: { stringValue: process.env.NODE_ENV || "production" } },
        ],
      },
      scopeSpans: [{
        scope: { name: "tcs-agentic-ai", version: SERVICE_VERSION },
        spans: spans.map(s => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId || undefined,
          name: s.name,
          kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: String(s.startTime * 1_000_000),
          endTimeUnixNano: String((s.endTime || s.startTime) * 1_000_000),
          attributes: Object.entries(s.attributes || {}).map(([k, v]) => ({
            key: k,
            value: typeof v === "number" ? { intValue: String(Math.round(v)) } :
                   typeof v === "boolean" ? { boolValue: v } :
                   { stringValue: String(v) },
          })),
          status: s.attributes?.["otel.status_code"] === "ERROR"
            ? { code: 2, message: s.attributes["otel.status_message"] || "" }
            : { code: 1 },
        })),
      }],
    }],
  };
}

async function _flushSpans() {
  if (!OTEL_ENABLED || _spanBuffer.length === 0) return;

  const spans = _spanBuffer.splice(0, _spanBuffer.length);

  try {
    const endpoint = OTLP_ENDPOINT.replace(/\/$/, "");
    const url = `${endpoint}/v1/traces`;

    await fetch(url, {
      method: "POST",
      headers: _buildHeaders(),
      body: JSON.stringify(_spansToOtlp(spans)),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[otel] failed to export ${spans.length} spans: ${err.message}`);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Initialize OpenTelemetry. Safe to call even when OTLP_ENDPOINT is not set.
 */
export function initTelemetry() {
  if (!OTEL_ENABLED) {
    console.log("[otel] OTLP_ENDPOINT not set — telemetry disabled (no overhead)");
    return;
  }

  console.log(`[otel] exporting traces to ${OTLP_ENDPOINT} as '${SERVICE_NAME}'`);

  _flushTimer = setInterval(() => {
    _flushSpans().catch(() => {});
  }, FLUSH_INTERVAL_MS);

  if (_flushTimer.unref) _flushTimer.unref();
}

/**
 * Flush remaining spans and shut down.
 */
export async function shutdownTelemetry() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  await _flushSpans();
}

/**
 * Check if OpenTelemetry is enabled.
 * @returns {boolean}
 */
export function isOtelEnabled() {
  return OTEL_ENABLED;
}

/**
 * Get telemetry status for dashboard / healthz.
 * @returns {object}
 */
export function getTelemetryStatus() {
  return {
    enabled: OTEL_ENABLED,
    endpoint: OTEL_ENABLED ? OTLP_ENDPOINT : null,
    serviceName: SERVICE_NAME,
    serviceVersion: SERVICE_VERSION,
    pendingSpans: _spanBuffer.length,
    counters: _counters.size,
    histograms: _histograms.size,
  };
}
