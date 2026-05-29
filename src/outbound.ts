/**
 * Outbound (egress) HTTP instrumentation for @allstak/fastify.
 *
 * The inbound hooks SET a W3C `traceparent` / `baggage` on the *reply* but
 * never propagate them onto the outbound calls the service itself makes — so a
 * downstream service receiving a fetch/undici request from this app had no way
 * to continue the trace. This module closes that gap.
 *
 * It subscribes to Node's `diagnostics_channel` undici client channels
 * (`undici:request:create` / `:headers` / `:error` — used by global `fetch`,
 * `undici.request`, and most modern HTTP clients) and, for every egress
 * request:
 *
 *   1. injects W3C `traceparent` + `baggage` (and the AllStak correlation
 *      headers) continuing the CURRENT request's trace context, read from the
 *      ALS trace store the `onRequest` hook bound — so the child span/trace id
 *      flows downstream;
 *   2. emits a client span and an outbound `HttpRequestPayload`
 *      (`direction: 'outbound'`) through the SDK's existing transport.
 *
 * The SDK's own ingest host is skipped (no self-instrumentation feedback loop).
 * Everything is gated behind a config flag (default on) and fully fail-open:
 * a thrown subscriber must never break the host's outbound request. dist/ is
 * gitignored; this is source-only.
 */

import { SDK_NAME, SDK_VERSION } from './version';

/** Minimal transport seam — satisfied by the plugin's FastifyTransport. */
export interface OutboundTransportLike {
  enqueueRequest(ev: { path: string; payload: Record<string, unknown> }): void;
  enqueueSpan(ev: { path: string; payload: Record<string, unknown> }): void;
  isDisabled?(): boolean;
}

/** Active-request trace context the instrumentation continues on egress. */
export interface OutboundTraceContext {
  traceId: string;
  spanId: string;
  requestId: string;
  sampled: boolean;
}

export interface OutboundInstrumentationOptions {
  transport: OutboundTransportLike;
  /** Reads the active request's trace context (ALS-backed). */
  getTraceContext: () => OutboundTraceContext | undefined;
  /** Host (no scheme/port) of the SDK ingest endpoint — never instrumented. */
  ingestHost: string;
  environment?: string;
  release: string;
  serviceName?: string;
  /** Random 16-hex span id generator. Seam for deterministic tests. */
  spanIdGen?: () => string;
  /** Clock seam for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * diagnostics_channel module seam for tests. When omitted, the real
   * `node:diagnostics_channel` is loaded lazily (Node only). When the module is
   * unavailable the instrumentation silently degrades to a no-op.
   */
  diagnosticsChannel?: DiagnosticsChannelModule;
}

/** The subset of `node:diagnostics_channel` we depend on. */
export interface DiagnosticsChannelModule {
  subscribe(name: string, handler: (message: unknown) => void): void;
  unsubscribe?(name: string, handler: (message: unknown) => void): boolean | void;
}

/** Shape of the undici request object carried on the diagnostics messages. */
interface UndiciRequest {
  origin?: string | { origin?: string };
  path?: string;
  method?: string;
  /** Flat [name, value, name, value, …] header list (undici representation). */
  headers?: unknown;
  addHeader?(name: string, value: string): unknown;
}

interface UndiciCreateMessage {
  request?: UndiciRequest;
}
interface UndiciHeadersMessage {
  request?: UndiciRequest;
  response?: { statusCode?: number };
}
interface UndiciErrorMessage {
  request?: UndiciRequest;
  error?: unknown;
}

const CH_CREATE = 'undici:request:create';
const CH_HEADERS = 'undici:request:headers';
const CH_ERROR = 'undici:request:error';

/** Generate a random 16-hex span id (8 bytes). */
function randomSpanId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const data = new Uint8Array(8);
    c.getRandomValues(data);
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');
}

/** Build a W3C traceparent for an outbound child span. Pure. */
export function buildTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

/** AllStak baggage entries for an outbound child span. Pure. */
export function buildAllStakBaggage(traceId: string, requestId: string, spanId: string): string {
  return [
    `allstak-trace_id=${traceId}`,
    `allstak-request_id=${requestId}`,
    `allstak-span_id=${spanId}`,
  ].join(',');
}

/**
 * Extract `{ host, port }` from an undici request `origin` (URL string or
 * object) — host has no scheme. Returns `host` '' when unparseable. Pure.
 */
export function parseOrigin(origin: UndiciRequest['origin']): { host: string; port: string } {
  const raw = typeof origin === 'string' ? origin : origin?.origin ?? '';
  if (!raw) return { host: '', port: '' };
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: u.port };
  } catch {
    // Fall back to a naive scheme strip for non-URL origins.
    const stripped = raw.replace(/^[a-z]+:\/\//i, '');
    const hostPort = stripped.split('/')[0] ?? '';
    const [host, port = ''] = hostPort.split(':');
    return { host: host ?? '', port };
  }
}

/** Path without the query string. Pure. */
export function pathWithoutQuery(path: string | undefined): string {
  if (!path) return '/';
  const i = path.indexOf('?');
  return i >= 0 ? path.slice(0, i) : path;
}

/**
 * Whether the egress request targets the SDK's own ingest host and must NOT be
 * instrumented (prevents a telemetry feedback loop). Compared host-only,
 * case-insensitively. Pure.
 */
export function isIngestHost(targetHost: string, ingestHost: string): boolean {
  if (!targetHost || !ingestHost) return false;
  return targetHost.toLowerCase() === ingestHost.toLowerCase();
}

/**
 * Whether the undici request already carries a header (case-insensitive) in its
 * flat [name, value, …] header list, a raw header string, or a record. Used to
 * avoid clobbering a traceparent a higher-level client already set. Pure.
 */
export function hasHeader(headers: unknown, name: string): boolean {
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === lower) return true;
    }
    return false;
  }
  if (typeof headers === 'string') {
    // Raw header block: match a header line start, case-insensitively.
    return new RegExp(`(^|\\r\\n)${escapeRegExp(lower)}:`, 'i').test(headers);
  }
  if (headers && typeof headers === 'object') {
    for (const k of Object.keys(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === lower) return true;
    }
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Per-request span bookkeeping kept between create→headers/error. */
interface PendingSpan {
  traceId: string;
  parentSpanId: string;
  requestId: string;
  spanId: string;
  method: string;
  host: string;
  port: string;
  path: string;
  startedAt: number;
  startHr: number;
}

/**
 * Subscribes to the undici diagnostics channels and instruments egress HTTP.
 * One instance per plugin registration. Idempotent install/uninstall.
 */
export class OutboundInstrumentation {
  private readonly opts: OutboundInstrumentationOptions;
  private readonly spanIdGen: () => string;
  private readonly now: () => number;
  private readonly pending = new WeakMap<object, PendingSpan>();
  private dc: DiagnosticsChannelModule | null = null;
  private installed = false;

  private readonly onCreate = (message: unknown) => this.handleCreate(message as UndiciCreateMessage);
  private readonly onHeaders = (message: unknown) => this.handleHeaders(message as UndiciHeadersMessage);
  private readonly onError = (message: unknown) => this.handleError(message as UndiciErrorMessage);

  constructor(opts: OutboundInstrumentationOptions) {
    this.opts = opts;
    this.spanIdGen = opts.spanIdGen ?? randomSpanId;
    this.now = opts.now ?? Date.now;
  }

  /** True once subscribed to the channels (i.e. diagnostics_channel resolved). */
  isInstalled(): boolean {
    return this.installed;
  }

  /**
   * Subscribe to the undici channels. Fail-open: a missing
   * `node:diagnostics_channel` (non-Node runtime, or stripped build) degrades
   * to a no-op. Idempotent.
   */
  install(): void {
    if (this.installed) return;
    const dc = this.opts.diagnosticsChannel ?? loadDiagnosticsChannel();
    if (!dc) return;
    try {
      dc.subscribe(CH_CREATE, this.onCreate);
      dc.subscribe(CH_HEADERS, this.onHeaders);
      dc.subscribe(CH_ERROR, this.onError);
      this.dc = dc;
      this.installed = true;
    } catch {
      // Subscription failed: leave uninstalled, fail-open.
      this.dc = null;
    }
  }

  /** Unsubscribe from the channels. Idempotent + fail-open. */
  uninstall(): void {
    if (!this.installed || !this.dc) return;
    try {
      this.dc.unsubscribe?.(CH_CREATE, this.onCreate);
      this.dc.unsubscribe?.(CH_HEADERS, this.onHeaders);
      this.dc.unsubscribe?.(CH_ERROR, this.onError);
    } catch {
      // best-effort
    }
    this.installed = false;
    this.dc = null;
  }

  /** create: inject propagation headers + start a client span. Fail-open. */
  private handleCreate(message: UndiciCreateMessage): void {
    try {
      const req = message?.request;
      if (!req) return;
      const { host, port } = parseOrigin(req.origin);
      // Skip our own ingest egress to avoid a telemetry feedback loop.
      if (isIngestHost(host, this.opts.ingestHost)) return;

      const trace = this.opts.getTraceContext();
      // No active request context ⇒ this egress is not part of an inbound trace
      // we own. We still want downstream continuity, so originate a trace.
      const traceId = trace?.traceId ?? randomTraceId();
      const parentSpanId = trace?.spanId ?? '';
      const requestId = trace?.requestId ?? traceId;
      const sampled = trace?.sampled ?? true;
      const spanId = this.spanIdGen();

      // (1) Inject W3C + AllStak correlation headers, never clobbering an
      // existing traceparent a higher-level client already set.
      if (typeof req.addHeader === 'function') {
        if (!hasHeader(req.headers, 'traceparent')) {
          req.addHeader('traceparent', buildTraceparent(traceId, spanId, sampled));
        }
        if (!hasHeader(req.headers, 'baggage')) {
          req.addHeader('baggage', buildAllStakBaggage(traceId, requestId, spanId));
        }
        if (!hasHeader(req.headers, 'x-allstak-trace-id')) {
          req.addHeader('x-allstak-trace-id', traceId);
        }
        if (!hasHeader(req.headers, 'x-allstak-request-id')) {
          req.addHeader('x-allstak-request-id', requestId);
        }
      }

      // Sampled-out: still propagate (above) but emit no telemetry.
      if (!sampled) return;

      this.pending.set(req as object, {
        traceId,
        parentSpanId,
        requestId,
        spanId,
        method: (req.method || 'GET').toUpperCase(),
        host,
        port,
        path: pathWithoutQuery(req.path),
        startedAt: this.now(),
        startHr: hrNow(),
      });
    } catch {
      // never break the host's outbound request
    }
  }

  /** headers: the response arrived ⇒ finish the span with the status code. */
  private handleHeaders(message: UndiciHeadersMessage): void {
    try {
      const req = message?.request;
      if (!req) return;
      const pending = this.pending.get(req as object);
      if (!pending) return;
      this.pending.delete(req as object);
      const statusCode = message?.response?.statusCode ?? 0;
      this.emit(pending, statusCode, statusCode >= 500 ? 'error' : 'ok');
    } catch {
      // fail-open
    }
  }

  /** error: the egress failed before a response ⇒ finish the span as errored. */
  private handleError(message: UndiciErrorMessage): void {
    try {
      const req = message?.request;
      if (!req) return;
      const pending = this.pending.get(req as object);
      if (!pending) return;
      this.pending.delete(req as object);
      this.emit(pending, 0, 'error');
    } catch {
      // fail-open
    }
  }

  /** Emit the outbound http-request row + client span through the transport. */
  private emit(p: PendingSpan, statusCode: number, status: 'ok' | 'error'): void {
    const transport = this.opts.transport;
    if (transport.isDisabled?.()) return;
    const durationMs = Math.max(0, Math.round(hrNow() - p.startHr));
    const env = this.opts.environment || '';
    const service = this.opts.serviceName || '';
    const release = this.opts.release;

    transport.enqueueRequest({
      path: '/ingest/v1/http-requests',
      payload: {
        requests: [
          {
            direction: 'outbound',
            method: p.method,
            host: p.host || 'unknown',
            path: p.path,
            statusCode,
            durationMs,
            timestamp: new Date(p.startedAt).toISOString(),
            traceId: p.traceId,
            spanId: p.spanId,
            parentSpanId: p.parentSpanId,
            requestId: p.requestId,
            environment: env,
            release,
            service,
            requestHeaders: '',
            metadata: {
              'sdk.name': SDK_NAME,
              'sdk.version': SDK_VERSION,
            },
          },
        ],
      },
    });

    transport.enqueueSpan({
      path: '/ingest/v1/spans',
      payload: {
        spans: [
          {
            traceId: p.traceId,
            spanId: p.spanId,
            parentSpanId: p.parentSpanId,
            operation: 'http.client',
            description: `${p.method} ${p.host}${p.path}`,
            status,
            durationMs,
            startTimeMillis: p.startedAt,
            endTimeMillis: p.startedAt + durationMs,
            service,
            environment: env,
            release,
            tags: {
              component: 'undici',
              method: p.method,
              statusCode: String(statusCode),
              'http.host': p.host,
            },
            data: JSON.stringify({ host: p.host, port: p.port, path: p.path }),
          },
        ],
      },
    });
  }
}

/** Random 32-hex trace id (16 bytes) for egress that has no inbound trace. */
function randomTraceId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const data = new Uint8Array(16);
    c.getRandomValues(data);
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');
}

/** Monotonic-ish millisecond clock; falls back to Date.now without perf. */
function hrNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

/**
 * Resolve `node:diagnostics_channel` without a static import (these packages
 * declare no `@types/node`). Mirrors the loader strategy in scope.ts: try the
 * modern builtin accessor, then an indirect require. Returns null off-Node or
 * when the module is unavailable.
 */
function loadDiagnosticsChannel(): DiagnosticsChannelModule | null {
  const proc = (globalThis as {
    process?: {
      versions?: { node?: string };
      getBuiltinModule?: (id: string) => DiagnosticsChannelModule | undefined;
    };
  }).process;
  if (!proc?.versions?.node) return null;
  try {
    const fromBuiltin = proc.getBuiltinModule?.('node:diagnostics_channel');
    if (fromBuiltin && typeof fromBuiltin.subscribe === 'function') return fromBuiltin;
  } catch {
    /* fall through */
  }
  try {
    const req =
      (globalThis as { require?: (id: string) => DiagnosticsChannelModule }).require ??
      (typeof module !== 'undefined' &&
        (module as { require?: (id: string) => DiagnosticsChannelModule }).require);
    const mod = req ? req('node:diagnostics_channel') : undefined;
    return mod && typeof mod.subscribe === 'function' ? mod : null;
  } catch {
    return null;
  }
}

declare const module: unknown;
