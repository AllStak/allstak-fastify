import fp from 'fastify-plugin';
import { SDK_NAME, SDK_VERSION } from './version';
import { compileExtra, redactHeadersToString, redactMap } from './redaction';
import { resolveRelease, type GitRunner } from './release';
import { SessionTracker } from './session';
import { FileSpool, nodeRequire, type FileSpoolOptions } from './spool';
import {
  Scope,
  ScopeManager,
  type ScopeUser,
  type ScopeBreadcrumb,
  type Severity,
  type MergedScopeData,
} from './scope';

export { SDK_NAME, SDK_VERSION } from './version';
export { Scope } from './scope';
export type { ScopeUser, ScopeBreadcrumb, Severity, MergedScopeData } from './scope';
export {
  resolveRelease,
  resolveGitRelease,
  detectReleaseFromEnv,
  isNodeRuntime,
  defaultGitRunner,
  RELEASE_ENV_VARS,
  _resetReleaseCache,
  type ResolveReleaseOptions,
} from './release';
export type { GitRunner } from './release';
export { SessionTracker } from './session';
export type { SessionStatus } from './session';
export { FileSpool } from './spool';
export type { SpoolEnvelope, SpoolFs, FileSpoolOptions } from './spool';

const DEFAULT_HOST = 'https://api.allstak.sa';
/** Default spool directory under the OS tmp dir; resolved lazily, Node-only. */
const DEFAULT_SPOOL_SUBDIR = 'allstak-fastify-spool';
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
const runtimeReleaseRegistrations = new Set<string>();

export interface AllStakFastifyConfig {
  apiKey?: string;
  dsn?: string;
  host?: string;
  endpoint?: string;
  environment?: string;
  release?: string;
  serviceName?: string;
  /**
   * Auto-detect the release when `release` is not set: env vars
   * (ALLSTAK_RELEASE, RAILWAY_GIT_COMMIT_SHA, RENDER_GIT_COMMIT, …), then local
   * git at init (`git describe`/short SHA, Node runtime only, cached one-shot),
   * then the SDK version so release is never empty. Default true. Set false to
   * gate off the git lookup and version fallback (explicit/env still apply).
   */
  autoDetectRelease?: boolean;
  /**
   * Register the resolved release with AllStak from the server runtime at
   * plugin registration, without requiring a CI/CD hook. Default true.
   */
  autoRegisterRelease?: boolean;
  /**
   * Open one release-health session per process: POST `/sessions/start` on the
   * Fastify `onReady` hook and POST `/sessions/end` on `onClose` with the final
   * status (ok / errored / crashed) and total duration. Sessions are never
   * sampled and the network calls are fully fail-open. Default true; set false
   * to opt out. Automatically skipped under a unit-test runtime (NODE_ENV=test
   * or VITEST=true), like release auto-registration.
   */
  enableAutoSessionTracking?: boolean;
  /** Git runner seam for deterministic tests; defaults to a guarded spawnSync. */
  gitRunner?: GitRunner;
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
  /**
   * Persist un-sent (already PII-scrubbed) telemetry to a filesystem spool when
   * delivery fails — network outage, retries exhausted, or shutdown with events
   * still buffered — and replay it on the next init so events survive a process
   * restart and a network outage (Sentry offline-store parity). Session
   * lifecycle calls (`/sessions/start`, `/sessions/end`) are never spooled.
   *
   * Default true on Node runtimes, but automatically skipped under a unit-test
   * runtime (NODE_ENV=test / VITEST=true) unless explicitly set true. Degrades
   * to in-memory silently when the spool dir is not writable (read-only FS,
   * serverless, edge with no `node:fs`). Set false to disable entirely.
   */
  enableOfflineQueue?: boolean;
  /** Spool directory. Default `<os.tmpdir()>/allstak-fastify-spool`. */
  offlineQueueDir?: string;
  /** Max spooled envelopes (drop-oldest). Default 200. */
  offlineQueueMaxEntries?: number;
  /** Max spooled bytes (drop-oldest). Default ~5 MiB. */
  offlineQueueMaxBytes?: number;
  /** Max spooled-envelope age in ms before drop-on-load. Default 48h. */
  offlineQueueMaxAgeMs?: number;
  /** fs seam for deterministic spool tests. */
  offlineQueueFs?: FileSpoolOptions['fs'];
  /** Clock seam for deterministic spool tests. Defaults to Date.now. */
  offlineQueueNow?: () => number;
  /** Test injection. */
  fetch?: typeof fetch;
}

export interface AllStakOutboundEvent {
  path:
    | '/ingest/v1/http-requests'
    | '/ingest/v1/errors'
    | '/ingest/v1/spans'
    | '/ingest/v1/releases'
    | '/ingest/v1/sessions/start'
    | '/ingest/v1/sessions/end';
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
  addHook(
    name: 'onRequest' | 'onResponse' | 'onError' | 'onReady' | 'onClose',
    fn: (...args: any[]) => void,
  ): void;
}

function normalizeHost(host?: string): string {
  return (host || DEFAULT_HOST).replace(/\/$/, '');
}

/**
 * Resolve the effective release for a config: explicit `release` > env vars >
 * local git at init > SDK version. The git lookup is cached one-shot inside
 * resolveRelease.
 */
function releaseOf(config: AllStakFastifyConfig): string {
  return resolveRelease({
    explicit: config.release,
    autoDetectRelease: config.autoDetectRelease,
    gitRunner: config.gitRunner,
    version: SDK_VERSION,
  });
}

function registerRuntimeRelease(config: AllStakFastifyConfig, transport: FastifyTransport, release: string): void {
  if (!shouldAutoRegisterRelease(config.autoRegisterRelease) || !release) return;
  const host = normalizeHost(config.host || config.endpoint);
  const apiKey = config.apiKey || config.dsn || '';
  if (!apiKey) return;
  const environment = config.environment || 'production';
  const key = `${host}|${apiKey}|${environment}|${release}`;
  if (runtimeReleaseRegistrations.has(key)) return;
  runtimeReleaseRegistrations.add(key);
  transport.sendNow({
    path: '/ingest/v1/releases',
    payload: {
      version: release,
      environment,
      author: `${SDK_NAME}/${SDK_VERSION}`,
      message: 'Registered automatically by AllStak Fastify SDK at runtime',
    },
  });
}

function shouldAutoRegisterRelease(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.NODE_ENV !== 'test' && env?.VITEST !== 'true';
  } catch {
    return true;
  }
}

/** True when running under a unit-test runtime (mirrors the Java SDK guard). */
function isLikelyTestRuntime(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.NODE_ENV === 'test' || env?.VITEST === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether to open a release-health session for this registration. Opt-out via
 * `enableAutoSessionTracking: false`; auto-skipped under a unit-test runtime so
 * tests don't hit `/ingest/v1/sessions/start` unless they pass an explicit
 * `enableAutoSessionTracking: true`.
 */
function shouldAutoSessionTrack(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  return !isLikelyTestRuntime();
}

/**
 * Whether to persist un-sent telemetry to the filesystem spool. Opt-out via
 * `enableOfflineQueue: false`; auto-skipped under a unit-test runtime so tests
 * don't write spool files unless they pass an explicit `enableOfflineQueue: true`
 * (mirrors the session-tracking / release-registration guards).
 */
function shouldEnableOfflineQueue(value: boolean | undefined): boolean {
  if (value === false) return false;
  if (value === true) return true;
  // Only meaningful on a Node runtime; in-memory degrade handles the rest.
  if (!detectPlatform()) return false;
  return !isLikelyTestRuntime();
}

/**
 * Ingest paths excluded from the persistent spool. Session lifecycle calls are
 * best-effort live-only — a replayed stale `/sessions/start`/`/sessions/end`
 * after a restart would skew release-health durations.
 */
const NON_PERSISTABLE_PATHS = new Set<AllStakOutboundEvent['path']>([
  '/ingest/v1/sessions/start',
  '/ingest/v1/sessions/end',
]);

/** Resolve the default spool dir under the OS tmp dir (Node only). */
function defaultSpoolDir(): string | null {
  try {
    const req = nodeRequire();
    if (!req) return null;
    const os = req('node:os') as { tmpdir?: () => string };
    const tmp = os.tmpdir?.();
    if (!tmp) return null;
    return tmp.endsWith('/') ? `${tmp}${DEFAULT_SPOOL_SUBDIR}` : `${tmp}/${DEFAULT_SPOOL_SUBDIR}`;
  } catch {
    return null;
  }
}

/** Host platform string for the session payload (e.g. "node-darwin"). */
function detectPlatform(): string | undefined {
  const proc = (globalThis as {
    process?: { platform?: string; versions?: { node?: string } };
  }).process;
  if (!proc?.versions?.node) return undefined;
  return proc.platform ? `node-${proc.platform}` : 'node';
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
  private readonly spool: FileSpool | null;

  private requestQueue: QueuedEvent[] = [];
  private spanQueue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private dropped = 0;
  private persisted = 0;
  private shuttingDown = false;
  private draining = false;

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
    // Offline/persistent spool: only constructed when enabled AND a dir resolves.
    // FileSpool itself fails open (no-op) if the dir is not writable.
    if (this.apiKey && shouldEnableOfflineQueue(cfg.enableOfflineQueue)) {
      const dir = cfg.offlineQueueDir ?? defaultSpoolDir();
      this.spool = dir
        ? new FileSpool({
            dir,
            maxEntries: cfg.offlineQueueMaxEntries,
            maxBytes: cfg.offlineQueueMaxBytes,
            maxAgeMs: cfg.offlineQueueMaxAgeMs,
            fs: cfg.offlineQueueFs,
            now: cfg.offlineQueueNow,
          })
        : null;
    } else {
      this.spool = null;
    }
  }

  stats(): { inFlight: number; dropped: number; queued: number; persisted: number } {
    return {
      inFlight: this.inFlight,
      dropped: this.dropped,
      queued: this.requestQueue.length + this.spanQueue.length,
      persisted: this.persisted,
    };
  }

  /** Whether the persistent offline spool is active and writable. */
  isOfflineQueueEnabled(): boolean {
    return !!this.spool && this.spool.isEnabled();
  }

  /** No API key ⇒ the transport cannot emit anything. */
  isDisabled(): boolean {
    return !this.apiKey;
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
    // Any events still buffered after the flush window (network was down the
    // whole time) are persisted so they survive the process exit. Failed
    // dispatches were already persisted via the catch in dispatch().
    this.persistRemaining();
  }

  /** Persist whatever is still queued in-memory to the offline spool. */
  private persistRemaining(): void {
    if (!this.spool || !this.spool.isEnabled()) return;
    const remaining = [...this.requestQueue.splice(0), ...this.spanQueue.splice(0)];
    for (const { ev } of remaining) this.persistEnvelope(ev);
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
      // Saturated in-flight window: persist rather than silently drop so the
      // event survives to the next drain. Falls through to drop if no spool.
      if (!this.persistEnvelope(outbound)) this.dropped++;
      return;
    }
    this.inFlight++;
    try {
      await this.sendWithRetry(outbound);
    } catch (err) {
      // Permanent failure after retries (network outage, 5xx/429 exhausted, or
      // timeout). Persist the already-scrubbed payload to the offline spool so
      // it replays on the next init. A 4xx other than 429 is permanently bad
      // data — never persist it (it would replay forever). Fully fail-open.
      if (isPersistableFailure(err)) this.persistEnvelope(outbound);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  /**
   * Write an envelope's already-scrubbed payload to the offline spool. Session
   * lifecycle calls are never persisted (a replayed stale session skews
   * durations). Returns true when it was persisted. Fully fail-open.
   */
  private persistEnvelope(ev: AllStakOutboundEvent): boolean {
    if (!this.spool || !this.spool.isEnabled()) return false;
    if (NON_PERSISTABLE_PATHS.has(ev.path)) return false;
    try {
      this.spool.persist(ev.path, this.scrubPayload(ev.payload as Record<string, unknown>));
      this.persisted++;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replay persisted envelopes through the normal send pipeline. Loaded
   * oldest-first; each file is deleted only after the event is accepted (2xx)
   * or permanently undeliverable (4xx other than 429). Transient failures keep
   * the file for the next drain. Async + fail-open; never blocks init.
   */
  async drainSpool(): Promise<void> {
    if (!this.apiKey || this.shuttingDown) return;
    if (!this.spool || !this.spool.isEnabled() || this.draining) return;
    this.draining = true;
    try {
      const entries = this.spool.load();
      for (const { envelope, remove } of entries) {
        if (this.shuttingDown) break;
        try {
          await this.sendWithRetry({
            path: envelope.path as AllStakOutboundEvent['path'],
            payload: envelope.payload,
          });
          remove(); // accepted (2xx)
        } catch (err) {
          if (!isPersistableFailure(err)) {
            remove(); // permanently undeliverable (4xx other than 429)
          }
          // else: transient — keep for the next drain.
        }
      }
    } catch {
      // Spool unreadable: fail-open, keep in-memory behavior.
    } finally {
      this.draining = false;
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

  /**
   * Defense-in-depth wire scrub. Module-level redactMap already scrubs metadata
   * at construction; this chokepoint covers any top-level sensitive key that
   * bypasses that path. Returns the already-scrubbed payload object. Pure and
   * fail-open. Shared by {@link sendOnce} (wire body) and the offline spool so
   * the persisted form is byte-identical to what would have been sent.
   */
  scrubPayload(payload: Record<string, unknown>): Record<string, unknown> {
    try {
      const scrubbed = (redactMap(payload) ?? payload) as Record<string, unknown>;
      // The SDK's release-health `sessionId` is an opaque id the SDK itself
      // generates (not a user credential), and the backend REQUIRES it to
      // correlate errors/sessions. The defense-in-depth scrub matches the
      // generic `session_id` denylist pattern, so restore the SDK value.
      const original = payload as { sessionId?: unknown };
      if (typeof original.sessionId === 'string') {
        scrubbed.sessionId = original.sessionId;
      }
      return scrubbed;
    } catch {
      return payload;
    }
  }

  private async sendOnce(ev: AllStakOutboundEvent): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let body: string;
      try {
        body = JSON.stringify(this.scrubPayload(ev.payload as Record<string, unknown>));
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

/**
 * Whether a failed send should be persisted to the offline spool for later
 * replay (transient: network error / timeout / 5xx / 429 / 408 retries
 * exhausted) versus permanently dropped (a 4xx other than 429/408 is bad data
 * the server will keep rejecting). Mirrors {@link isRetryable}: anything worth
 * retrying live is worth persisting across a restart/outage.
 */
function isPersistableFailure(err: unknown): boolean {
  return isRetryable(err);
}

// ───────────────────────────────────────────────────────────────────────────
// Module-level manual capture + scope API
//
// The Fastify plugin's transport/config are local to allstakFastify(). To let
// application code call captureException / setUser / withScope from anywhere,
// we record the most-recently-registered plugin instance's transport + config
// at module scope. Manual captures route through the SAME transport (and thus
// its existing redaction, retry, batching, and beforeSend pipeline), and merge
// the active scope (user/tags/extras/contexts/breadcrumbs) onto the event.
// ───────────────────────────────────────────────────────────────────────────

/** Process-wide scope manager (ALS-backed request isolation + global scope). */
const scopeManager = new ScopeManager();

interface ActiveCaptureContext {
  transport: FastifyTransport;
  config: AllStakFastifyConfig;
  extraRedact: RegExp[];
  sampleRate: number;
  random: () => number;
  /** Release resolved once at registration (explicit > env > git > version). */
  release: string;
  /** Release-health session for this registration, or null when disabled. */
  session: SessionTracker | null;
}

let activeContext: ActiveCaptureContext | null = null;

/**
 * Apply the active scope's user/tags/extras/contexts/breadcrumbs/level onto an
 * error or http-request payload. Mutates and returns `payload`. Used by both
 * the auto-capture hooks and manual captureException/captureMessage so a single
 * code path attaches scope data.
 */
function applyScopeToErrorPayload(
  payload: Record<string, unknown>,
  extraRedact: RegExp[],
  merged: MergedScopeData,
): Record<string, unknown> {
  const baseMeta = (payload.metadata as Record<string, unknown> | undefined) ?? {};
  const meta: Record<string, unknown> = { ...baseMeta };
  if (merged.user?.id != null) meta.userId = String(merged.user.id);
  if (merged.user?.email != null) meta.userEmail = merged.user.email;
  for (const [k, v] of Object.entries(merged.tags)) meta[`tag.${k}`] = v;
  for (const [k, v] of Object.entries(merged.extras)) meta[`extra.${k}`] = v;
  for (const [name, ctx] of Object.entries(merged.contexts)) meta[`context.${name}`] = ctx;
  payload.metadata = redactMap(meta, extraRedact);
  if (merged.level) payload.level = merged.level;
  if (merged.fingerprint) payload.fingerprint = merged.fingerprint;
  if (merged.breadcrumbs.length) payload.breadcrumbs = merged.breadcrumbs;
  if (merged.user?.id != null && payload.userId === undefined) {
    payload.userId = String(merged.user.id);
  }
  return payload;
}

/** Flatten merged scope tags/extras/contexts into metadata keys (no redaction). */
function scopeMetadata(merged: MergedScopeData): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (merged.user?.id != null) meta.userId = String(merged.user.id);
  if (merged.user?.email != null) meta.userEmail = merged.user.email;
  for (const [k, v] of Object.entries(merged.tags)) meta[`tag.${k}`] = v;
  for (const [k, v] of Object.entries(merged.extras)) meta[`extra.${k}`] = v;
  for (const [name, ctx] of Object.entries(merged.contexts)) meta[`context.${name}`] = ctx;
  return meta;
}

function buildErrorPayload(
  error: Error,
  ctx: ActiveCaptureContext,
  level: Severity,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    exceptionClass: error.name || 'Error',
    message: error.message,
    stackTrace: error.stack ? error.stack.split('\n') : [],
    level,
    environment: ctx.config.environment || '',
    release: ctx.release,
    metadata: {
      'sdk.name': SDK_NAME,
      'sdk.version': SDK_VERSION,
      service: ctx.config.serviceName || '',
      ...(extra ?? {}),
    },
  };
  // Carry the release-health session id so the backend's error consumer can
  // mark the session errored / crashed.
  if (ctx.session) payload.sessionId = ctx.session.sessionId;
  return applyScopeToErrorPayload(payload, ctx.extraRedact, scopeManager.getMerged());
}

/**
 * Capture an exception on demand through the active plugin transport. Honors
 * the same sampleRate / beforeSend / redaction pipeline as auto-capture and
 * merges the current scope. No-op if the plugin was never registered.
 */
export function captureException(error: unknown, hint?: { extra?: Record<string, unknown>; level?: Severity }): void {
  const ctx = activeContext;
  if (!ctx) return;
  const level = hint?.level ?? 'error';
  // Status transition is independent of sampling: a fatal manually-captured
  // exception crashes the session even if the event itself is sampled out.
  if (level === 'fatal') ctx.session?.recordCrash();
  else ctx.session?.recordError();
  if (ctx.sampleRate < 1 && ctx.random() >= ctx.sampleRate) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const payload = buildErrorPayload(err, ctx, level, hint?.extra);
  ctx.transport.sendNow({ path: '/ingest/v1/errors', payload });
}

/**
 * Capture a freeform message on demand through the active plugin transport.
 * Routed to the errors stream.
 */
export function captureMessage(message: string, level: Severity = 'info'): void {
  const ctx = activeContext;
  if (!ctx) return;
  if (ctx.sampleRate < 1 && ctx.random() >= ctx.sampleRate) return;
  const payload: Record<string, unknown> = {
    exceptionClass: 'Message',
    message,
    stackTrace: [],
    level,
    environment: ctx.config.environment || '',
    release: ctx.release,
    metadata: {
      'sdk.name': SDK_NAME,
      'sdk.version': SDK_VERSION,
      service: ctx.config.serviceName || '',
    },
  };
  if (ctx.session) payload.sessionId = ctx.session.sessionId;
  applyScopeToErrorPayload(payload, ctx.extraRedact, scopeManager.getMerged());
  ctx.transport.sendNow({ path: '/ingest/v1/errors', payload });
}

/** Set the user on the active (request or global) scope. */
export function setUser(user: ScopeUser | null): void {
  scopeManager.getCurrentScope().setUser(user);
}
/** Set a single tag on the active scope. */
export function setTag(key: string, value: string): void {
  scopeManager.getCurrentScope().setTag(key, value);
}
/** Merge tags onto the active scope. */
export function setTags(tags: Record<string, string>): void {
  scopeManager.getCurrentScope().setTags(tags);
}
/** Set a single extra value on the active scope. */
export function setExtra(key: string, value: unknown): void {
  scopeManager.getCurrentScope().setExtra(key, value);
}
/** Merge extras onto the active scope. */
export function setExtras(extras: Record<string, unknown>): void {
  scopeManager.getCurrentScope().setExtras(extras);
}
/** Attach (or remove, with `null`) a named context bag on the active scope. */
export function setContext(name: string, ctx: Record<string, unknown> | null): void {
  scopeManager.getCurrentScope().setContext(name, ctx);
}
/** Add a breadcrumb to the active scope; attached to subsequently captured events. */
export function addBreadcrumb(crumb: ScopeBreadcrumb): void {
  scopeManager.getCurrentScope().addBreadcrumb(crumb);
}
/** Run `callback` with a forked scope that is popped afterwards (sync or async). */
export function withScope<T>(callback: (scope: Scope) => T): T {
  return scopeManager.withScope(callback);
}
/** Mutate the active scope in place. */
export function configureScope(callback: (scope: Scope) => void): void {
  scopeManager.configureScope(callback);
}
/** @internal — exposed for tests; returns the merged active scope view. */
export function _getMergedScope(): MergedScopeData {
  return scopeManager.getMerged();
}

/** @internal */
export function _resetRuntimeReleaseRegistrationForTest(): void {
  runtimeReleaseRegistrations.clear();
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
  // Resolve the release once at registration: explicit > env > local git
  // (Node runtime, cached one-shot) > SDK version. Reused by every emitted
  // event for this plugin instance.
  const release = releaseOf(config);
  registerRuntimeRelease(config, transport, release);

  // Release-health: one session per process. Created here (no I/O yet); the
  // /sessions/start POST fires on the Fastify onReady hook and /sessions/end on
  // onClose. Skipped when disabled or under a unit-test runtime. Sessions are
  // never sampled and every call is fully fail-open.
  const session: SessionTracker | null = shouldAutoSessionTrack(config.enableAutoSessionTracking)
    ? new SessionTracker(transport, {
        release,
        environment: config.environment,
        platform: detectPlatform(),
      })
    : null;

  // Register this plugin instance as the active capture context so module-level
  // captureException/captureMessage route through this transport + pipeline.
  activeContext = { transport, config, extraRedact, sampleRate, random, release, session };

  fastify.addHook('onRequest', (request: FastifyRequestLike, reply: FastifyReplyLike, doneHook: (err?: Error) => void) => {
    // Establish a fresh, request-isolated scope for the remainder of this
    // request's async context so user/tags set in a handler don't leak across
    // concurrent requests. enterWith binds the ALS store for the continuation.
    scopeManager.enterRequestScope();
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
    const merged = scopeManager.getMerged();
    // Scope-set user takes precedence over a framework-populated request.user.
    const scopeUserId = merged.user?.id == null ? undefined : String(merged.user.id);
    const userId = scopeUserId ?? (request.user?.id == null ? undefined : String(request.user.id));
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
          release,
          service: config.serviceName || '',
          userId,
          requestHeaders: config.captureRequestHeaders
            ? redactHeadersToString(request.headers, extraRedact)
            : '',
          metadata: redactMap(
            {
              'sdk.name': SDK_NAME,
              'sdk.version': SDK_VERSION,
              ...scopeMetadata(merged),
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
            release,
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
    // A request-handler error is a HANDLED error for release-health: it bumps
    // the session to "errored" but keeps it running. Recorded before sampling
    // so a sampled-out error still affects crash-free rate.
    session?.recordError();
    // Error sampling: deterministic random drop at capture time, applied
    // BEFORE beforeSend (which runs in the transport). Dropped errors never
    // reach beforeSend.
    if (sampleRate < 1 && random() >= sampleRate) {
      doneHook();
      return;
    }
    const merged = scopeManager.getMerged();
    const payload: Record<string, unknown> = {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: error.stack ? error.stack.split('\n') : [],
      level: 'error',
      environment: config.environment || '',
      release,
      traceId: request.allstakTraceId || '',
      spanId: request.allstakSpanId || '',
      parentSpanId: request.allstakParentSpanId || '',
      requestId: request.allstakRequestId || '',
      metadata: {
        'sdk.name': SDK_NAME,
        'sdk.version': SDK_VERSION,
        service: config.serviceName || '',
        httpMethod: request.method,
        httpPath: pathOnly(request.url),
      },
    };
    // Carry the release-health session id so the backend's error consumer can
    // mark the session errored / crashed. Only set when a session is active.
    if (session) payload.sessionId = session.sessionId;
    // Merge the active request scope (user/tags/extras/contexts/breadcrumbs)
    // and apply redaction.
    applyScopeToErrorPayload(payload, extraRedact, merged);
    transport.sendNow({ path: '/ingest/v1/errors', payload });
    doneHook();
  });

  // A single onReady/onClose pair drives BOTH release-health sessions and the
  // offline spool (the test harness keys hooks by name, so one registration of
  // each keeps that and real Fastify happy). Registered when either feature is
  // active.
  const offlineQueueOn = transport.isOfflineQueueEnabled();
  if (session || offlineQueueOn) {
    fastify.addHook('onReady', (doneHook: (err?: Error) => void) => {
      // Open the release-health session once the server is ready to accept
      // traffic. Fire-and-forget; never blocks startup.
      if (session) {
        try {
          session.start();
        } catch {
          // Session tracking is fully fail-open.
        }
      }
      // Replay any telemetry persisted by a previous run (restart/outage
      // recovery). Async + fail-open; never blocks startup or the hook.
      if (offlineQueueOn) {
        void transport.drainSpool();
      }
      doneHook();
    });
    fastify.addHook('onClose', (_instance: unknown, doneHook: (err?: Error) => void) => {
      // Close the session on graceful shutdown with the accumulated status and
      // total duration, then flush + persist any still-buffered telemetry so it
      // survives the process exit. Best-effort; must not block or throw.
      if (session) {
        try {
          session.end();
        } catch {
          // Best-effort.
        }
      }
      if (offlineQueueOn) {
        void transport.shutdown();
      }
      doneHook();
    });
  }

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
