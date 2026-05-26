import fp from 'fastify-plugin';
import { SDK_NAME, SDK_VERSION } from './version';
import { compileExtra, redactHeadersToString, redactMap } from './redaction';

export { SDK_NAME, SDK_VERSION } from './version';

const DEFAULT_HOST = 'https://api.allstak.sa';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CONCURRENT = 64;
const DEFAULT_MAX_BATCH = 50;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_RETRIES = 3;
/** Upper bound for any honored Retry-After delay. */
const MAX_RETRY_AFTER_MS = 300_000;

/**
 * Parse an HTTP `Retry-After` header into a delay in milliseconds.
 *
 * Supports the two RFC 7231 forms:
 *   - delta-seconds: a non-negative integer (e.g. "120" → 120000ms)
 *   - HTTP-date: an absolute date; the delta from `now` is returned (clamped ≥ 0)
 *
 * Returns 0 when the header is absent, empty, or unparseable so callers can
 * fall back to their computed backoff. The result is clamped to
 * MAX_RETRY_AFTER_MS (300000). Pure and side-effect free.
 */
export function parseRetryAfter(headerValue: string | null, now: number): number {
  if (headerValue == null) return 0;
  const raw = headerValue.trim();
  if (raw === '') return 0;

  let ms: number;
  if (/^\d+$/.test(raw)) {
    // delta-seconds: a bare non-negative integer.
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    ms = seconds * 1000;
  } else {
    // HTTP-date form.
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return 0;
    const delta = when - now;
    ms = delta > 0 ? delta : 0;
  }

  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

// Per-version Symbol so two different versions of @allstak/fastify in the same
// process do not silently hand each other the same "already registered" flag.
const REGISTERED_FLAG = Symbol.for(`@allstak/fastify@${SDK_VERSION}.registered`);

export interface AllStakFastifyConfig {
  apiKey?: string;
  dsn?: string;
  host?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  serviceName?: string;
  /** Extra attribute key patterns to redact. */
  redactKeys?: (string | RegExp)[];
  /** Capture inbound headers (redacted). Default false. */
  captureRequestHeaders?: boolean;
  /**
   * Fraction 0..1 of error events captured (onError), and the fallback trace
   * sampling rate when `tracesSampleRate` is not set. Default 1. Applied at
   * capture time, BEFORE beforeSend.
   */
  sampleRate?: number;
  /**
   * Fraction 0..1 of traces captured when this service is the trace origin
   * (no inbound sampled flag). Defaults to `sampleRate`. Drives the propagated
   * W3C `traceparent` sampled flag (`-01` kept / `-00` dropped) and gates
   * request + span emission. When an inbound `traceparent` carries a sampled
   * flag, the child inherits it and this rate is not consulted.
   */
  tracesSampleRate?: number;
  /** RNG seam for deterministic tests. Defaults to Math.random. Returns [0,1). */
  random?: () => number;
  /** Max events per HTTP request. Default 50. */
  maxBatchSize?: number;
  /** Max buffered events before drop-oldest. Default 1000. */
  maxQueueSize?: number;
  /** Flush interval in ms. Default 2000. Set <=0 to disable batching. */
  flushIntervalMs?: number;
  /** Per-request timeout. Default 3000. */
  timeoutMs?: number;
  /** Max retries for 408/429/5xx. Default 3. */
  maxRetries?: number;
  /** Max concurrent in-flight HTTP POSTs. Default 64. */
  maxConcurrent?: number;
  /**
   * Mutate or drop an event before send. Already-redacted payload. Return
   * `null` to drop. Errors in the hook are caught (fail-open).
   */
  beforeSend?: (event: AllStakOutboundEvent) => AllStakOutboundEvent | null | Promise<AllStakOutboundEvent | null>;
  /** Test injection. */
  fetch?: typeof fetch;
}

export interface AllStakOutboundEvent {
  path: '/ingest/v1/http-requests' | '/ingest/v1/errors' | '/ingest/v1/spans';
  payload: Record<string, unknown>;
}

interface FastifyRequestLike {
  method: string;
  url: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: string | number; email?: string };
  allstakStartedAt?: number;
  allstakTraceId?: string;
  allstakRequestId?: string;
  allstakSpanId?: string;
  allstakParentSpanId?: string;
  allstakSampled?: boolean;
}

interface FastifyReplyLike {
  statusCode: number;
  header?(name: string, value: string): void;
}

interface FastifyLike {
  addHook(name: 'onRequest' | 'onResponse' | 'onError', fn: (...args: any[]) => void): void;
}

function normalizeHost(host?: string): string {
  return (host || DEFAULT_HOST).replace(/\/$/, '');
}

function pathOnly(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url || '/';
}

function requestHost(request: FastifyRequestLike): string {
  const header = request.headers.host;
  return typeof header === 'string' ? header : request.hostname || 'unknown';
}

function headerValue(headers: FastifyRequestLike['headers'], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function randomHex(bytes: number): string {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const data = new Uint8Array(bytes);
    c.getRandomValues(data);
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

function parseTraceparent(value: string): {
  traceId?: string;
  parentSpanId?: string;
  sampled?: boolean;
} {
  const parts = value.split('-');
  if (parts.length < 4) return {};
  const flags = parts[3];
  // trace-flags is a 2-hex-digit field; bit 0 is the "sampled" flag.
  const sampled = /^[0-9a-fA-F]{2}$/.test(flags ?? '')
    ? (parseInt(flags, 16) & 0x01) === 0x01
    : undefined;
  return {
    traceId: parts[1]?.length === 32 ? parts[1] : undefined,
    parentSpanId: parts[2]?.length === 16 ? parts[2] : undefined,
    sampled,
  };
}

function traceparent(traceId: string, spanId: string, sampled: boolean): string {
  const t = traceId.length === 32 ? traceId : randomHex(16);
  const s = spanId.length === 16 ? spanId : randomHex(8);
  return `00-${t}-${s}-${sampled ? '01' : '00'}`;
}

function allstakBaggage(traceId: string, requestId: string, spanId: string): string {
  return [
    `allstak-trace_id=${traceId}`,
    `allstak-request_id=${requestId}`,
    `allstak-span_id=${spanId}`,
  ].join(',');
}

function mergeBaggage(existing: string, traceId: string, requestId: string, spanId: string): string {
  const preserved = existing
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.toLowerCase().startsWith('allstak-'));
  return [...preserved, ...allstakBaggage(traceId, requestId, spanId).split(',')].join(',');
}

interface QueuedEvent {
  ev: AllStakOutboundEvent;
}

/**
 * Per-plugin-instance transport. Batches /http-requests; sends /errors
 * single-shot (errors are usually low-volume and you want fast visibility).
 */
class FastifyTransport {
  private readonly host: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly beforeSend?: AllStakFastifyConfig['beforeSend'];

  private requestQueue: QueuedEvent[] = [];
  private spanQueue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private dropped = 0;
  private shuttingDown = false;

  constructor(cfg: AllStakFastifyConfig) {
    this.host = normalizeHost(cfg.host || cfg.endpoint);
    this.apiKey = cfg.apiKey || cfg.dsn || '';
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrent = cfg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxBatchSize = cfg.maxBatchSize ?? DEFAULT_MAX_BATCH;
    this.maxQueueSize = cfg.maxQueueSize ?? DEFAULT_MAX_QUEUE;
    this.flushIntervalMs = cfg.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = (cfg.fetch || globalThis.fetch) as typeof fetch;
    this.beforeSend = cfg.beforeSend;
  }

  stats(): { inFlight: number; dropped: number; queued: number } {
    return { inFlight: this.inFlight, dropped: this.dropped, queued: this.requestQueue.length + this.spanQueue.length };
  }

  async forceFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.drainRequests();
    await this.drainSpans();
  }

  async shutdown(timeoutMs = 1500): Promise<void> {
    this.shuttingDown = true;
    await this.forceFlush();
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Batched. Used for /http-requests where volume is high. */
  enqueueRequest(ev: AllStakOutboundEvent): void {
    if (!this.apiKey || this.shuttingDown) return;
    if (this.requestQueue.length >= this.maxQueueSize) {
      this.requestQueue.shift();
      this.dropped++;
    }
    this.requestQueue.push({ ev });
    if (this.flushIntervalMs <= 0 || this.requestQueue.length >= this.maxBatchSize) {
      void this.drainRequests();
    } else {
      this.scheduleFlush();
    }
  }

  /** Batched. Used for /spans where every request can emit a server span. */
  enqueueSpan(ev: AllStakOutboundEvent): void {
    if (!this.apiKey || this.shuttingDown) return;
    if (this.spanQueue.length >= this.maxQueueSize) {
      this.spanQueue.shift();
      this.dropped++;
    }
    this.spanQueue.push({ ev });
    if (this.flushIntervalMs <= 0 || this.spanQueue.length >= this.maxBatchSize) {
      void this.drainSpans();
    } else {
      this.scheduleFlush();
    }
  }

  /** Single-shot. Used for /errors. */
  sendNow(ev: AllStakOutboundEvent): void {
    if (!this.apiKey || this.shuttingDown) return;
    void this.dispatch(ev);
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void Promise.all([this.drainRequests(), this.drainSpans()]);
    }, this.flushIntervalMs);
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private async drainRequests(): Promise<void> {
    while (this.requestQueue.length > 0) {
      const batch = this.requestQueue.splice(0, this.maxBatchSize);
      // Merge per-event payloads into one /http-requests POST.
      const merged: Record<string, unknown>[] = [];
      for (const { ev } of batch) {
        const rows = (ev.payload as { requests?: unknown[] }).requests;
        if (Array.isArray(rows)) merged.push(...(rows as Record<string, unknown>[]));
      }
      const mergedEv: AllStakOutboundEvent = {
        path: '/ingest/v1/http-requests',
        payload: { requests: merged },
      };
      await this.dispatch(mergedEv);
    }
  }

  private async drainSpans(): Promise<void> {
    while (this.spanQueue.length > 0) {
      const batch = this.spanQueue.splice(0, this.maxBatchSize);
      const merged: Record<string, unknown>[] = [];
      for (const { ev } of batch) {
        const rows = (ev.payload as { spans?: unknown[] }).spans;
        if (Array.isArray(rows)) merged.push(...(rows as Record<string, unknown>[]));
      }
      const mergedEv: AllStakOutboundEvent = {
        path: '/ingest/v1/spans',
        payload: { spans: merged },
      };
      await this.dispatch(mergedEv);
    }
  }

  private async dispatch(ev: AllStakOutboundEvent): Promise<void> {
    let outbound: AllStakOutboundEvent | null = ev;
    if (this.beforeSend) {
      try {
        outbound = (await this.beforeSend(ev)) ?? null;
      } catch {
        outbound = ev;
      }
    }
    if (!outbound) return;
    if (this.inFlight >= this.maxConcurrent) {
      this.dropped++;
      return;
    }
    this.inFlight++;
    try {
      await this.sendWithRetry(outbound);
    } catch {
      // fail-open
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async sendWithRetry(ev: AllStakOutboundEvent): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.sendOnce(ev);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxRetries) break;
        if (!isRetryable(err)) break;
        // Honor a server-provided Retry-After on 429/503 when present;
        // otherwise fall back to exponential backoff with jitter.
        const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs ?? 0;
        let wait: number;
        if (retryAfterMs > 0) {
          wait = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
        } else {
          const base = Math.min(8000, 500 * 2 ** attempt);
          const jitter = Math.floor(Math.random() * (base / 4));
          wait = base + jitter;
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async sendOnce(ev: AllStakOutboundEvent): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Defense-in-depth wire scrub. Module-level redactMap already
      // scrubs metadata at construction; this chokepoint covers any
      // top-level sensitive key that bypasses that path. Pure, fail-open.
      let body: string;
      try {
        const scrubbed = redactMap(ev.payload as Record<string, unknown>) ?? ev.payload;
        body = JSON.stringify(scrubbed);
      } catch {
        body = JSON.stringify(ev.payload);
      }
      const resp = await this.fetchImpl(`${this.host}${ev.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.apiKey,
          'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
        },
        body,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const err = new Error(`AllStak fastify ingest HTTP ${resp.status}`);
        (err as Error & { status?: number }).status = resp.status;
        if (resp.status === 429 || resp.status === 503) {
          const headerValue = resp.headers?.get?.('Retry-After') ?? null;
          (err as Error & { retryAfterMs?: number }).retryAfterMs = parseRetryAfter(
            headerValue,
            Date.now(),
          );
        }
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') {
      if (status === 408 || status === 429) return true;
      if (status >= 500 && status < 600) return true;
      return false;
    }
  }
  return true;
}

export function allstakFastify(
  fastify: FastifyLike,
  config: AllStakFastifyConfig,
  done?: (err?: Error) => void,
): void {
  const tagged = fastify as FastifyLike & { [REGISTERED_FLAG]?: FastifyTransport };
  if (tagged[REGISTERED_FLAG]) {
    done?.();
    return;
  }
  const transport = new FastifyTransport(config);
  tagged[REGISTERED_FLAG] = transport;

  const extraRedact = compileExtra(config.redactKeys);
  const sampleRate = typeof config.sampleRate === 'number' ? clamp01(config.sampleRate) : 1;
  // Trace sampling falls back to sampleRate when tracesSampleRate is unset,
  // preserving the historical behavior where sampleRate gated request/span
  // capture.
  const tracesSampleRate =
    typeof config.tracesSampleRate === 'number' ? clamp01(config.tracesSampleRate) : sampleRate;
  const random = config.random || Math.random;

  fastify.addHook('onRequest', (request: FastifyRequestLike, reply: FastifyReplyLike, doneHook: (err?: Error) => void) => {
    request.allstakStartedAt = Date.now();
    const parsed = parseTraceparent(headerValue(request.headers, 'traceparent'));
    const traceId = headerValue(request.headers, 'x-allstak-trace-id') || parsed.traceId || randomHex(16);
    const requestId =
      headerValue(request.headers, 'x-allstak-request-id') ||
      headerValue(request.headers, 'x-request-id') ||
      traceId;
    const spanId = randomHex(8);
    // Trace sampling: inherit an inbound sampled flag (child follows root);
    // otherwise this service is the trace origin, so decide via
    // tracesSampleRate and drive the propagated traceparent flag.
    const sampled = parsed.sampled ?? (tracesSampleRate >= 1 ? true : random() < tracesSampleRate);
    request.allstakTraceId = traceId;
    request.allstakRequestId = requestId;
    request.allstakSpanId = spanId;
    request.allstakSampled = sampled;
    request.allstakParentSpanId =
      headerValue(request.headers, 'x-allstak-parent-span-id') || parsed.parentSpanId;
    reply.header?.('traceparent', traceparent(traceId, spanId, sampled));
    reply.header?.('baggage', mergeBaggage(headerValue(request.headers, 'baggage'), traceId, requestId, spanId));
    reply.header?.('allstak-baggage', allstakBaggage(traceId, requestId, spanId));
    reply.header?.('x-allstak-trace-id', traceId);
    reply.header?.('x-allstak-request-id', requestId);
    doneHook();
  });

  fastify.addHook('onResponse', (request: FastifyRequestLike, reply: FastifyReplyLike, doneHook: (err?: Error) => void) => {
    // Trace-not-sampled: skip request + span emission. Decision was made at
    // onRequest time so the propagated traceparent already carries the flag.
    if (request.allstakSampled === false) {
      doneHook();
      return;
    }
    const startedAt = request.allstakStartedAt || Date.now();
    const userId = request.user?.id == null ? undefined : String(request.user.id);
    const durationMs = Math.max(0, Date.now() - startedAt);
    const path = pathOnly(request.url);
    const method = request.method.toUpperCase();
    const statusCode = reply.statusCode;
    const traceId = request.allstakTraceId || '';
    const spanId = request.allstakSpanId || '';
    const payload: Record<string, unknown> = {
      requests: [
        {
          direction: 'inbound',
          method,
          host: requestHost(request),
          path,
          statusCode,
          durationMs,
          timestamp: new Date(startedAt).toISOString(),
          traceId,
          spanId,
          parentSpanId: request.allstakParentSpanId || '',
          requestId: request.allstakRequestId || '',
          environment: config.environment || '',
          release: config.release || '',
          service: config.serviceName || '',
          userId,
          requestHeaders: config.captureRequestHeaders
            ? redactHeadersToString(request.headers, extraRedact)
            : '',
          metadata: redactMap(
            {
              'sdk.name': SDK_NAME,
              'sdk.version': SDK_VERSION,
            },
            extraRedact,
          ),
        },
      ],
    };
    transport.enqueueRequest({ path: '/ingest/v1/http-requests', payload });
    transport.enqueueSpan({
      path: '/ingest/v1/spans',
      payload: {
        spans: [
          {
            traceId,
            spanId,
            parentSpanId: request.allstakParentSpanId || '',
            operation: 'fastify.request',
            description: `${method} ${path}`,
            status: statusCode >= 500 ? 'error' : 'ok',
            durationMs,
            startTimeMillis: startedAt,
            endTimeMillis: startedAt + durationMs,
            service: config.serviceName || '',
            environment: config.environment || '',
            release: config.release || '',
            tags: {
              component: 'fastify',
              method,
              statusCode: String(statusCode),
            },
            data: JSON.stringify({ host: requestHost(request), path }),
          },
        ],
      },
    });
    doneHook();
  });

  fastify.addHook('onError', (request: FastifyRequestLike, _reply: FastifyReplyLike, error: Error, doneHook: (err?: Error) => void) => {
    // Error sampling: deterministic random drop at capture time, applied
    // BEFORE beforeSend (which runs in the transport). Dropped errors never
    // reach beforeSend.
    if (sampleRate < 1 && random() >= sampleRate) {
      doneHook();
      return;
    }
    const payload: Record<string, unknown> = {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: error.stack ? error.stack.split('\n') : [],
      level: 'error',
      environment: config.environment || '',
      release: config.release || '',
      traceId: request.allstakTraceId || '',
      spanId: request.allstakSpanId || '',
      parentSpanId: request.allstakParentSpanId || '',
      requestId: request.allstakRequestId || '',
      metadata: redactMap(
        {
          'sdk.name': SDK_NAME,
          'sdk.version': SDK_VERSION,
          service: config.serviceName || '',
          httpMethod: request.method,
          httpPath: pathOnly(request.url),
        },
        extraRedact,
      ),
    };
    transport.sendNow({ path: '/ingest/v1/errors', payload });
    doneHook();
  });

  done?.();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export { FastifyTransport };

export default fp(allstakFastify, {
  fastify: '>=4.0.0',
  name: '@allstak/fastify',
});
