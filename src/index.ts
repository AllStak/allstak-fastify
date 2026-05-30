import fp from 'fastify-plugin';
import { SDK_NAME, SDK_VERSION } from './version';
import { compileExtra, redactHeadersToString, redactMap, scrubValuesDeep } from './redaction';
import { resolveRelease, type GitRunner } from './release';
import { SessionTracker } from './session';
import { FileSpool, nodeRequire, type FileSpoolOptions } from './spool';
import { OutboundInstrumentation, type OutboundInstrumentationOptions } from './outbound';
import { DbInstrumentation } from './db';
import { LogBridge, type PinoLikeLogger } from './logs';
import { installCrashHandlers, type CrashHandlerHandle } from './crash';
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
export { OutboundInstrumentation } from './outbound';
export type {
  OutboundInstrumentationOptions,
  OutboundTransportLike,
  OutboundTraceContext,
  DiagnosticsChannelModule,
} from './outbound';
export { DbInstrumentation, normalizeQuery, hashQuery, detectQueryType } from './db';
export type { DbInstrumentationOptions, DbTransportLike, DbQueryItem, DbTraceContext } from './db';
export { LogBridge, parsePinoArgs } from './logs';
export type { LogBridgeOptions, LogTransportLike, LogTraceContext, PinoLikeLogger, LogBridgeLevel } from './logs';
export { installCrashHandlers } from './crash';
export type { CrashHandlerHooks, CrashHandlerHandle, CrashProcessLike } from './crash';

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
  /**
   * Send personally-identifiable information (PII) that the SDK would otherwise
   * scrub out of free-text values. Default FALSE (privacy-by-default).
   *
   * When FALSE: email addresses and valid IPv4/IPv6 addresses found in event
   * messages, metadata/extra/context values, breadcrumbs, and captured HTTP
   * fields are replaced with `[REDACTED]`, and any auto-collected client IP is
   * dropped/masked. When TRUE: those value scrubbers are disabled (you have
   * opted into PII) and an auto-collected client IP is allowed through.
   *
   * High-risk financial/identity data (Luhn-valid credit-card numbers and
   * hyphenated US SSNs) is ALWAYS scrubbed regardless of this flag, as is the
   * existing key-name redaction (password/token/cookie/…). Explicitly-set user
   * data (via `setUser`) is never scrubbed by this flag.
   */
  sendDefaultPii?: boolean;
  /** Capture inbound headers (redacted). Default false. */
  captureRequestHeaders?: boolean;
  /**
   * Instrument OUTBOUND HTTP egress (the calls this service makes) via Node's
   * `diagnostics_channel` undici client channels — which back global `fetch`,
   * `undici.request`, and most modern HTTP clients. For each egress request the
   * SDK injects W3C `traceparent` + `baggage` (continuing the current inbound
   * request's trace context, reusing the same AsyncLocalStorage scope) so
   * downstream services join the distributed trace, and emits a client span +
   * an outbound `HttpRequestPayload` (`direction: 'outbound'`). The SDK's own
   * ingest host is always skipped. Default true; fully fail-open (a subscriber
   * error never breaks the host's outbound call). No-ops off a Node runtime or
   * when `diagnostics_channel` is unavailable.
   */
  captureOutboundHttp?: boolean;
  /**
   * diagnostics_channel module seam for deterministic outbound-instrumentation
   * tests. Defaults to the real `node:diagnostics_channel`.
   */
  diagnosticsChannel?: OutboundInstrumentationOptions['diagnosticsChannel'];
  /**
   * Auto-instrument the popular Node SQL drivers (`pg`, `mysql2`, and the
   * SQLite family) at plugin registration so database queries produce
   * `/ingest/v1/db` rows AUTOMATICALLY — normalized SQL, query type, duration,
   * status, rows-affected, plus the active request's trace/span ids. Drivers
   * are optional host peer deps: a missing driver simply turns that one
   * integration off. Fully fail-open (a capture error never breaks a query).
   * Default true; auto-skipped under a unit-test runtime unless explicitly
   * enabled or a `dbModuleResolver` is provided (which signals a test exercising
   * DB capture directly). No-ops off a Node runtime.
   */
  enableDbInstrumentation?: boolean;
  /**
   * Module resolver seam for deterministic DB-instrumentation tests. Given a
   * driver id (`pg`, `mysql2`, …) returns the (possibly fake) module or null.
   * Defaults to a defensive host-app require.
   */
  dbModuleResolver?: (id: string) => unknown | null;
  /**
   * Bridge Fastify's pino logger to AllStak: wrap the instance logger's level
   * methods so application + framework logs are shipped to `/ingest/v1/logs`
   * AUTOMATICALLY (your stdout logs are unchanged). ERROR/FATAL logs are
   * promoted with throwable extraction, and every log is stamped with the
   * active request's trace/span/request ids. Default true; auto-skipped under a
   * unit-test runtime unless explicitly enabled. Fully fail-open.
   */
  enableLogBridge?: boolean;
  /** Minimum log level forwarded to AllStak. Default 'info'. */
  logBridgeMinLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /**
   * Automatically record an `http` breadcrumb for every inbound request onto
   * the active request scope, so a subsequently captured error carries the
   * request as context with no per-call `addBreadcrumb`. Default true.
   */
  enableAutoBreadcrumbs?: boolean;
  /**
   * Install process-global `uncaughtException` / `unhandledRejection` handlers
   * (once per process, Symbol-guarded) so a fatal crash that escapes Fastify is
   * still captured at `fatal` level, marks the release-health session crashed,
   * and is flushed before the process exits per Node semantics. Default true;
   * auto-skipped under a unit-test runtime unless explicitly enabled. Fully
   * fail-open and preserves Node's default exit behavior.
   */
  enableCrashHandlers?: boolean;
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
   * restart and a network outage (offline persistent store). Session
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
    | '/ingest/v1/db'
    | '/ingest/v1/logs'
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
  /**
   * Fastify's pino logger instance (present on a real Fastify app). Typed as
   * `unknown` so this minimal structural type stays assignable from the real
   * `FastifyInstance` (whose `FastifyBaseLogger` lacks a string index
   * signature); narrowed to {@link PinoLikeLogger} at the install site.
   */
  log?: unknown;
}

function normalizeHost(host?: string): string {
  return (host || DEFAULT_HOST).replace(/\/$/, '');
}

/** Hostname (no scheme/port) of the ingest endpoint; used to skip self-egress. */
function ingestHostname(host?: string): string {
  const normalized = normalizeHost(host);
  try {
    return new URL(normalized).hostname;
  } catch {
    return normalized.replace(/^[a-z]+:\/\//i, '').split('/')[0]?.split(':')[0] ?? '';
  }
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
 * Whether to install outbound HTTP egress instrumentation. Defaults ON. Like
 * the session-tracking / offline-queue gates it auto-skips under a unit-test
 * runtime unless explicitly enabled — but a test that injects a fake
 * `diagnosticsChannel` is treating outbound as the system under test, so that
 * counts as an explicit opt-in. Only meaningful on a Node runtime; the
 * instrumentation itself no-ops where diagnostics_channel is unavailable.
 */
function shouldCaptureOutbound(config: AllStakFastifyConfig): boolean {
  if (config.captureOutboundHttp === false) return false;
  if (!detectPlatform()) return false;
  if (config.captureOutboundHttp === true) return true;
  // A fake diagnostics channel means a test is exercising outbound directly.
  if (config.diagnosticsChannel) return true;
  return !isLikelyTestRuntime();
}

/**
 * Whether to auto-instrument SQL drivers. Defaults ON. Auto-skips under a
 * unit-test runtime unless explicitly enabled — but a test that injects a fake
 * `dbModuleResolver` is treating DB capture as the system under test, so that
 * counts as an explicit opt-in. Only meaningful on a Node runtime.
 */
function shouldInstrumentDb(config: AllStakFastifyConfig): boolean {
  if (config.enableDbInstrumentation === false) return false;
  if (!detectPlatform()) return false;
  if (config.enableDbInstrumentation === true) return true;
  if (config.dbModuleResolver) return true;
  return !isLikelyTestRuntime();
}

/**
 * Whether to attach the pino log bridge. Defaults ON. Auto-skips under a
 * unit-test runtime unless explicitly enabled (a wrapped global logger could
 * otherwise leak across tests). Only meaningful on a Node runtime.
 */
function shouldBridgeLogs(config: AllStakFastifyConfig): boolean {
  if (config.enableLogBridge === false) return false;
  if (!detectPlatform()) return false;
  if (config.enableLogBridge === true) return true;
  return !isLikelyTestRuntime();
}

/** Whether to record an auto http breadcrumb per request. Defaults ON. */
function shouldAutoBreadcrumb(value: boolean | undefined): boolean {
  return value !== false;
}

/**
 * Whether to install the process-global crash handlers. Defaults ON. Auto-skips
 * under a unit-test runtime unless explicitly enabled (a process-global
 * listener installed during a test would persist across the whole suite). Only
 * meaningful on a Node runtime.
 */
function shouldInstallCrashHandlers(config: AllStakFastifyConfig): boolean {
  if (config.enableCrashHandlers === false) return false;
  if (!detectPlatform()) return false;
  if (config.enableCrashHandlers === true) return true;
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
  private readonly sendDefaultPii: boolean;
  private readonly spool: FileSpool | null;

  private requestQueue: QueuedEvent[] = [];
  private spanQueue: QueuedEvent[] = [];
  private dbQueue: QueuedEvent[] = [];
  private logQueue: QueuedEvent[] = [];
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
    // sendDefaultPii defaults FALSE (privacy-by-default): value-pattern email/IP
    // scrubbing is ON unless the user explicitly opts into PII.
    this.sendDefaultPii = cfg.sendDefaultPii === true;
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
      queued:
        this.requestQueue.length +
        this.spanQueue.length +
        this.dbQueue.length +
        this.logQueue.length,
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
    await this.drainDb();
    await this.drainLogs();
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
    const remaining = [
      ...this.requestQueue.splice(0),
      ...this.spanQueue.splice(0),
      ...this.dbQueue.splice(0),
      ...this.logQueue.splice(0),
    ];
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

  /** Batched. Used for /db where every query emits a row. */
  enqueueDb(ev: AllStakOutboundEvent): void {
    if (!this.apiKey || this.shuttingDown) return;
    if (this.dbQueue.length >= this.maxQueueSize) {
      this.dbQueue.shift();
      this.dropped++;
    }
    this.dbQueue.push({ ev });
    if (this.flushIntervalMs <= 0 || this.dbQueue.length >= this.maxBatchSize) {
      void this.drainDb();
    } else {
      this.scheduleFlush();
    }
  }

  /** Batched. Used for /logs forwarded from the pino bridge. */
  enqueueLog(ev: AllStakOutboundEvent): void {
    if (!this.apiKey || this.shuttingDown) return;
    if (this.logQueue.length >= this.maxQueueSize) {
      this.logQueue.shift();
      this.dropped++;
    }
    this.logQueue.push({ ev });
    if (this.flushIntervalMs <= 0 || this.logQueue.length >= this.maxBatchSize) {
      void this.drainLogs();
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
      void Promise.all([
        this.drainRequests(),
        this.drainSpans(),
        this.drainDb(),
        this.drainLogs(),
      ]);
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

  private async drainDb(): Promise<void> {
    while (this.dbQueue.length > 0) {
      const batch = this.dbQueue.splice(0, this.maxBatchSize);
      // Merge per-event `queries` arrays into one /db POST.
      const merged: Record<string, unknown>[] = [];
      for (const { ev } of batch) {
        const rows = (ev.payload as { queries?: unknown[] }).queries;
        if (Array.isArray(rows)) merged.push(...(rows as Record<string, unknown>[]));
      }
      if (merged.length === 0) continue;
      await this.dispatch({ path: '/ingest/v1/db', payload: { queries: merged } });
    }
  }

  private async drainLogs(): Promise<void> {
    // Logs ship one LogIngestPayload per POST (single-record contract), so we
    // dispatch each queued log event individually rather than merging.
    while (this.logQueue.length > 0) {
      const { ev } = this.logQueue.shift()!;
      await this.dispatch(ev);
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
      // Layer 1: key-name redaction (password/token/cookie/…) replaces values
      // whose KEY looks sensitive. Layer 2: value-pattern PII scrubbing scans
      // free-text string values (CC/SSN always; email/IP unless sendDefaultPii).
      // Both fail open independently — see redaction.ts.
      const keyRedacted = (redactMap(payload) ?? payload) as Record<string, unknown>;
      const scrubbed = scrubValuesDeep(keyRedacted, this.sendDefaultPii);
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

  // Outbound HTTP egress instrumentation: inject W3C traceparent/baggage onto
  // the calls this service makes (continuing the inbound request's trace via
  // the ALS trace context bound in onRequest) and emit client spans + outbound
  // http-request rows. Skips the SDK's own ingest host. Fully fail-open; no-ops
  // off Node / where diagnostics_channel is unavailable.
  const outbound: OutboundInstrumentation | null = shouldCaptureOutbound(config)
    ? new OutboundInstrumentation({
        transport,
        getTraceContext: () => scopeManager.getTraceContext(),
        ingestHost: ingestHostname(config.host || config.endpoint),
        environment: config.environment,
        release,
        serviceName: config.serviceName,
        diagnosticsChannel: config.diagnosticsChannel,
      })
    : null;
  if (outbound) {
    try {
      outbound.install();
    } catch {
      // Instrumentation install is fully fail-open.
    }
  }

  // DB auto-instrumentation: monkey-patch pg / mysql2 / sqlite at registration
  // so queries produce /ingest/v1/db rows AUTOMATICALLY, stamped with the
  // active request's trace/span ids. Drivers are optional host peer deps; a
  // missing driver turns that one integration off. Fully fail-open.
  const db: DbInstrumentation | null = shouldInstrumentDb(config)
    ? new DbInstrumentation({
        transport,
        getTraceContext: () => {
          const t = scopeManager.getTraceContext();
          return t ? { traceId: t.traceId, spanId: t.spanId } : undefined;
        },
        service: config.serviceName,
        environment: config.environment,
        moduleResolver: config.dbModuleResolver,
        // Inherit the transport's batching mode: flushIntervalMs <= 0 (test
        // mode) makes each captured query flush immediately.
        flushIntervalMs: config.flushIntervalMs,
      })
    : null;
  if (db) {
    try {
      db.install();
    } catch {
      // Instrumentation install is fully fail-open.
    }
  }

  // Logs bridge: wrap Fastify's pino logger so application + framework logs are
  // shipped to /ingest/v1/logs AUTOMATICALLY (stdout logs unchanged), with
  // ERROR/FATAL throwable promotion and trace/request id stamping. Installed on
  // onReady so we wrap the FINAL configured logger. Fully fail-open.
  const logBridge: LogBridge | null = shouldBridgeLogs(config)
    ? new LogBridge({
        transport,
        getTraceContext: () => {
          const t = scopeManager.getTraceContext();
          return t
            ? { traceId: t.traceId, spanId: t.spanId, requestId: t.requestId }
            : undefined;
        },
        service: config.serviceName,
        environment: config.environment,
        release,
        sendDefaultPii: config.sendDefaultPii === true,
        minLevel: config.logBridgeMinLevel,
      })
    : null;

  // Process-global crash handlers: capture uncaughtException / unhandledRejection
  // at fatal level, mark the session crashed, flush, then preserve Node's exit
  // semantics. Installed once per process (Symbol-guarded inside the module).
  const crashHandle: CrashHandlerHandle | null = shouldInstallCrashHandlers(config)
    ? installCrashHandlers({
        captureFatal: (error: unknown) => {
          // Routes through the active capture context: records the crash on the
          // session and emits an /errors event at fatal level.
          captureException(error, { level: 'fatal' });
        },
        flush: () => transport.forceFlush(),
      })
    : null;

  const autoBreadcrumb = shouldAutoBreadcrumb(config.enableAutoBreadcrumbs);

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
    // Bind this request's trace context to ALS so outbound egress captured
    // out-of-band (diagnostics_channel) can continue the SAME trace. The server
    // span id becomes the parent of every outbound client span.
    scopeManager.enterTraceContext({ traceId, spanId, requestId, sampled });
    // Auto http breadcrumb: record the inbound request on the active request
    // scope so a subsequently captured error (onError or manual
    // captureException) carries it as context with no per-call addBreadcrumb.
    if (autoBreadcrumb) {
      try {
        scopeManager.getCurrentScope().addBreadcrumb({
          type: 'http',
          category: 'http.server',
          message: `${request.method.toUpperCase()} ${pathOnly(request.url)}`,
          level: 'info',
          data: {
            method: request.method.toUpperCase(),
            path: pathOnly(request.url),
            host: requestHost(request),
            requestId,
          },
        });
      } catch {
        // Breadcrumb recording is fully fail-open.
      }
    }
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

  // A single onReady/onClose pair drives release-health sessions, the offline
  // spool, the log bridge, DB instrumentation teardown, and the crash handlers
  // (the test harness keys hooks by name, so one registration of each keeps
  // that and real Fastify happy). Registered when any feature is active.
  const offlineQueueOn = transport.isOfflineQueueEnabled();
  if (session || offlineQueueOn || outbound || db || logBridge || crashHandle) {
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
      // Attach the log bridge to the FINAL configured Fastify logger now that
      // the app is fully built (custom logger / level config is settled).
      if (logBridge) {
        try {
          logBridge.install(fastify.log as PinoLikeLogger | undefined);
        } catch {
          // Log bridge install is fully fail-open.
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
      // Flush DB rows still batched and stop the flush timer.
      if (db) {
        try {
          db.uninstall();
        } catch {
          // Best-effort.
        }
      }
      // Restore the original logger so a closed instance stops forwarding.
      if (logBridge) {
        try {
          logBridge.uninstall();
        } catch {
          // Best-effort.
        }
      }
      // Remove the process-global crash listeners so a closed plugin instance
      // (matters most for tests opening/closing many apps) stops handling.
      if (crashHandle) {
        try {
          crashHandle.uninstall();
        } catch {
          // Best-effort.
        }
      }
      if (offlineQueueOn) {
        void transport.shutdown();
      }
      // Stop instrumenting egress once the server is closing so a closed plugin
      // instance does not keep emitting from leftover diagnostics-channel
      // subscriptions (matters most for tests that open/close many apps).
      if (outbound) {
        try {
          outbound.uninstall();
        } catch {
          // Best-effort.
        }
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
