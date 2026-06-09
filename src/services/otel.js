/**
 * Lightweight OpenTelemetry-compatible tracing.
 *
 * Stores spans in a fixed-size ring buffer (last 100) and exposes stats via
 * an HTTP handler. If OTEL_EXPORTER_OTLP_ENDPOINT is set (or passed via
 * initTracing), spans are also POSTed to the OTLP endpoint in batches on a
 * best-effort, non-blocking basis.
 *
 * Zero external dependencies — the OTLP export uses plain fetch / http.
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const RING_SIZE = 100;
const _ring = new Array(RING_SIZE);
let _ringIdx = 0;
let _totalSpans = 0;
let _errorCount = 0;
let _durationSum = 0;

let _endpoint = null;
let _serviceName = "agentic-ai-server";
let _samplingRate = 1.0;

/** Buffer of completed spans waiting to be exported. */
const _exportBuffer = [];
const EXPORT_BATCH_SIZE = 20;
const EXPORT_INTERVAL_MS = 5000;
let _exportTimer = null;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function hexId(bytes) {
  return randomBytes(bytes).toString("hex");
}

function traceId() {
  return hexId(16); // 32 hex chars
}

function spanId() {
  return hexId(8); // 16 hex chars
}

// ---------------------------------------------------------------------------
// OTLP export (best-effort, non-blocking)
// ---------------------------------------------------------------------------

function scheduleExport() {
  if (_exportTimer) return;
  _exportTimer = setTimeout(() => {
    _exportTimer = null;
    flushExport();
  }, EXPORT_INTERVAL_MS);
  // Don't prevent process exit
  if (_exportTimer.unref) _exportTimer.unref();
}

async function flushExport() {
  if (!_endpoint || _exportBuffer.length === 0) return;

  const batch = _exportBuffer.splice(0, EXPORT_BATCH_SIZE);
  if (batch.length === 0) return;

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: _serviceName } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "agentic-ai-server" },
            spans: batch.map(spanToOtlp),
          },
        ],
      },
    ],
  };

  try {
    const url = _endpoint.replace(/\/+$/, "") + "/v1/traces";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[otel] OTLP export failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`[otel] OTLP export error: ${err.message}`);
  }

  // If more spans are queued, schedule another flush
  if (_exportBuffer.length > 0) {
    scheduleExport();
  }
}

function spanToOtlp(span) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    startTimeUnixNano: String(span.startTime * 1_000_000),
    endTimeUnixNano: String((span.endTime || span.startTime) * 1_000_000),
    status: span.status === "error"
      ? { code: 2, message: span.statusMessage || "error" }
      : { code: 1 },
    attributes: Object.entries(span.attributes || {}).map(([k, v]) => ({
      key: k,
      value: typeof v === "number"
        ? { intValue: String(v) }
        : { stringValue: String(v) },
    })),
  };
}

// ---------------------------------------------------------------------------
// Ring buffer helpers
// ---------------------------------------------------------------------------

function pushToRing(span) {
  _ring[_ringIdx % RING_SIZE] = span;
  _ringIdx++;
}

function recentTraces(n = 20) {
  const results = [];
  const total = Math.min(_totalSpans, RING_SIZE);
  const start = _ringIdx - total;
  // Walk backwards from most recent
  for (let i = _ringIdx - 1; i >= start && results.length < n; i--) {
    const s = _ring[((i % RING_SIZE) + RING_SIZE) % RING_SIZE];
    if (s) results.push(s);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize tracing. If an OTLP endpoint is configured, spans will be
 * exported there in batches.
 *
 * @param {object} opts
 * @param {string} [opts.endpoint]      OTLP HTTP endpoint (e.g. http://localhost:4318).
 *                                      Falls back to OTEL_EXPORTER_OTLP_ENDPOINT env var.
 * @param {string} [opts.serviceName]   Logical service name. Default: agentic-ai-server.
 * @param {number} [opts.samplingRate]  Fraction of spans to keep (0..1). Default: 1.0.
 */
export function initTracing(opts = {}) {
  _endpoint = opts.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;
  _serviceName = opts.serviceName || _serviceName;
  _samplingRate = typeof opts.samplingRate === "number"
    ? Math.max(0, Math.min(1, opts.samplingRate))
    : 1.0;

  if (_endpoint) {
    console.log(`[otel] tracing enabled — exporting to ${_endpoint}`);
  } else {
    console.log("[otel] tracing enabled — in-memory only (no OTLP endpoint)");
  }
}

/**
 * Start a new trace span. If sampling drops this span, returns a no-op span
 * whose end() is a no-op.
 *
 * @param {string}  name        Human-readable span name (e.g. "tool:list_pods").
 * @param {object}  [attributes]  Arbitrary key/value metadata.
 * @returns {{ traceId: string, spanId: string, name: string, startTime: number, attributes: object, end: function }}
 */
export function startSpan(name, attributes = {}) {
  // Sampling decision
  if (_samplingRate < 1.0 && Math.random() > _samplingRate) {
    return _noopSpan(name);
  }

  const span = {
    traceId: traceId(),
    spanId: spanId(),
    name,
    startTime: Date.now(),
    endTime: null,
    durationMs: null,
    attributes: { ...attributes },
    status: "ok",
    statusMessage: null,
    _ended: false,

    /** End this span, optionally setting a status. */
    end(status) {
      if (span._ended) return;
      span._ended = true;
      endSpan(span, status);
    },
  };

  return span;
}

/**
 * End a span, record its duration, and push it into the ring buffer.
 *
 * @param {object} span   The span object returned by startSpan().
 * @param {string} [status]  "ok" or "error". Default: "ok".
 */
export function endSpan(span, status) {
  if (!span || span._noop) return;
  if (span._ended && span.endTime) return; // already finalized

  span.endTime = Date.now();
  span.durationMs = span.endTime - span.startTime;
  span._ended = true;

  if (status === "error") {
    span.status = "error";
    _errorCount++;
  } else if (status && status !== "ok") {
    span.status = status;
    span.statusMessage = String(status);
  }

  _totalSpans++;
  _durationSum += span.durationMs;
  pushToRing(span);

  // Queue for OTLP export
  if (_endpoint) {
    _exportBuffer.push(span);
    scheduleExport();
  }
}

/**
 * Convenience wrapper: run an async or sync function within a span.
 * The span is automatically ended when the function completes or throws.
 *
 * @param {string}   name         Span name.
 * @param {object}   attributes   Span attributes.
 * @param {function} fn           The function to execute. Receives the span as its argument.
 * @returns {Promise<*>}          The return value of fn.
 */
export async function withSpan(name, attributes, fn) {
  // Allow (name, fn) shorthand without attributes
  if (typeof attributes === "function" && fn === undefined) {
    fn = attributes;
    attributes = {};
  }

  const span = startSpan(name, attributes);
  try {
    const result = await fn(span);
    span.end("ok");
    return result;
  } catch (err) {
    span.status = "error";
    span.statusMessage = err.message;
    span.end("error");
    throw err;
  }
}

/**
 * Return aggregated trace statistics from the in-memory ring buffer.
 *
 * @returns {{ totalSpans: number, avgDurationMs: number, errorCount: number, recentTraces: Array }}
 */
export function getTraceStats() {
  const recent = recentTraces(20);
  return {
    totalSpans: _totalSpans,
    avgDurationMs: _totalSpans > 0 ? Math.round(_durationSum / _totalSpans) : 0,
    errorCount: _errorCount,
    recentTraces: recent.map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      name: s.name,
      durationMs: s.durationMs,
      status: s.status,
      attributes: s.attributes,
      startTime: new Date(s.startTime).toISOString(),
    })),
  };
}

/**
 * HTTP handler for GET /stats — returns JSON trace statistics.
 *
 * @param {import("node:http").ServerResponse} res
 */
export function handleStatsRequest(res) {
  const stats = getTraceStats();
  const body = JSON.stringify(stats, null, 2);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// No-op span (for when sampling drops a trace)
// ---------------------------------------------------------------------------

function _noopSpan(name) {
  return {
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    name,
    startTime: Date.now(),
    endTime: null,
    durationMs: null,
    attributes: {},
    status: "ok",
    statusMessage: null,
    _ended: true,
    _noop: true,
    end() {},
  };
}
