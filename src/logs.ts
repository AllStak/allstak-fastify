/**
 * Logs bridge for @allstak/fastify.
 *
 * Fastify logs through pino. This bridge auto-attaches to the running Fastify
 * instance's logger so application + framework logs are shipped to
 * `/ingest/v1/logs` AUTOMATICALLY — no per-call code. It wraps the logger's
 * level methods (`fatal`/`error`/`warn`/`info`/`debug`/`trace`) in place: the
 * original pino method still runs (your stdout logs are unchanged), and a
 * fail-open side-channel forwards the level + message (+ a redacted object
 * payload) to AllStak.
 *
 * Behavior:
 *   - ERROR / FATAL logs are promoted: when the first argument is an `Error`
 *     (the pino `log.error(err, msg)` convention) its name/message/stack are
 *     captured as `throwable` fields so the dashboard can correlate the log
 *     with the error.
 *   - Each shipped log is stamped with the active inbound request's
 *     trace/span/request ids (ALS-backed) so logs join the distributed trace.
 *   - Wrapping is idempotent (a Symbol guard on the logger object) so a second
 *     registration does not double-wrap, and `child()` loggers inherit the wrap
 *     because pino children delegate level methods through the parent binding —
 *     and any freshly-created child is wrapped on first use via the prototype
 *     chain marker.
 *
 * Fully fail-open: a throw inside the side-channel never breaks the host log
 * call. Defaults ON; toggle with `enableLogBridge: false`.
 */

import { scrubValuesDeep } from './redaction';
import { SDK_NAME, SDK_VERSION } from './version';

export type LogBridgeLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** The pino level methods we wrap, in severity order. */
const LEVEL_METHODS: LogBridgeLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

/** Levels promoted with throwable extraction (errors/fatals). */
const PROMOTED = new Set<LogBridgeLevel>(['error', 'fatal']);

/** Minimal transport seam — satisfied by the plugin's FastifyTransport. */
export interface LogTransportLike {
  enqueueLog(ev: { path: string; payload: Record<string, unknown> }): void;
  isDisabled?(): boolean;
}

/** Active-request trace context the bridge stamps onto each log row. */
export interface LogTraceContext {
  traceId?: string;
  spanId?: string;
  requestId?: string;
}

/** Minimal shape of a pino-like logger. */
export interface PinoLikeLogger {
  fatal?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  trace?: (...args: unknown[]) => void;
  [k: string]: unknown;
}

export interface LogBridgeOptions {
  transport: LogTransportLike;
  /** Reads the active request's trace context (ALS-backed). */
  getTraceContext?: () => LogTraceContext | undefined;
  service?: string;
  environment?: string;
  release?: string;
  /** Extra value-scrubbing toggle (mirrors the plugin's sendDefaultPii). */
  sendDefaultPii?: boolean;
  /**
   * Minimum level shipped to AllStak. Logs below this are passed through to the
   * underlying logger untouched but not forwarded. Default 'info'.
   */
  minLevel?: LogBridgeLevel;
}

const INGEST_PATH = '/ingest/v1/logs';
const WRAP_FLAG = Symbol.for('@allstak/fastify.logBridge.wrapped');

/** Numeric severity for minLevel gating (higher = more severe). */
const SEVERITY: Record<LogBridgeLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * In-place logger wrapper. One instance per plugin registration. Wrapping a
 * logger object is idempotent across instances via the WRAP_FLAG symbol.
 */
export class LogBridge {
  private readonly opts: LogBridgeOptions;
  private readonly minSeverity: number;
  private wrapped: PinoLikeLogger | null = null;
  /** Originals captured so uninstall can restore the logger. */
  private originals: Partial<Record<LogBridgeLevel, unknown>> = {};
  /** Original `child` method captured for restoration. */
  private originalChild: unknown;
  private installed = false;

  constructor(opts: LogBridgeOptions) {
    this.opts = opts;
    this.minSeverity = SEVERITY[opts.minLevel ?? 'info'];
  }

  isInstalled(): boolean {
    return this.installed;
  }

  /**
   * Wrap the given logger's level methods in place. Idempotent + fail-open.
   * Also wraps `child()` so per-request child loggers (Fastify creates one per
   * request via `app.log.child()`, surfaced as `req.log`) inherit the bridge —
   * which is how `req.log.error(...)` is forwarded with the request trace id.
   * Returns true when this call performed the wrap.
   */
  install(logger: PinoLikeLogger | undefined | null): boolean {
    if (this.installed) return false;
    if (!logger || typeof logger !== 'object') return false;
    try {
      const tagged = logger as PinoLikeLogger & { [WRAP_FLAG]?: boolean };
      if (tagged[WRAP_FLAG]) {
        // Already wrapped by another registration; treat as installed so the
        // onClose teardown is a no-op for us (the first owner restores it).
        this.installed = true;
        this.wrapped = logger;
        return false;
      }
      // Capture the root originals so uninstall can restore them.
      for (const level of LEVEL_METHODS) {
        const original = logger[level];
        if (typeof original === 'function') this.originals[level] = original;
      }
      this.originalChild = (logger as { child?: unknown }).child;
      this.wrapLevels(logger);
      this.wrapChild(logger);
      Object.defineProperty(logger, WRAP_FLAG, {
        value: true,
        enumerable: false,
        configurable: true,
      });
      this.wrapped = logger;
      this.installed = true;
      return true;
    } catch {
      // Wrapping failed: leave the logger untouched, fail-open.
      return false;
    }
  }

  /** Wrap each level method on `logger` in place (forward + pass-through). */
  private wrapLevels(logger: PinoLikeLogger): void {
    const bridge = this;
    for (const level of LEVEL_METHODS) {
      const original = logger[level];
      if (typeof original !== 'function') continue;
      logger[level] = function patchedLevel(this: unknown, ...args: unknown[]): void {
        // Run the original logger FIRST so behavior (and ordering) is preserved
        // even if forwarding throws.
        try {
          (original as Function).apply(this, args);
        } finally {
          bridge.forward(level, args);
        }
      };
    }
  }

  /**
   * Wrap `logger.child()` so every child logger it produces (e.g. Fastify's
   * per-request logger) is itself level-wrapped + child-wrapped on creation.
   * Children are tagged with WRAP_FLAG so a child that is re-derived is not
   * double-wrapped. Fail-open.
   */
  private wrapChild(logger: PinoLikeLogger): void {
    const origChild = (logger as { child?: (...a: unknown[]) => unknown }).child;
    if (typeof origChild !== 'function') return;
    const bridge = this;
    (logger as { child: (...a: unknown[]) => unknown }).child = function patchedChild(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const child = (origChild as Function).apply(this, args) as PinoLikeLogger & {
        [WRAP_FLAG]?: boolean;
      };
      try {
        // pino children prototype-inherit from their parent, so a plain
        // `child[WRAP_FLAG]` would read the PARENT's flag through the chain and
        // wrongly skip wrapping. Check for an OWN flag only — each child must be
        // wrapped (its level methods are fresh own properties) and its own
        // `child()` re-patched so grandchildren inherit the bridge too.
        const ownFlag = Object.prototype.hasOwnProperty.call(child, WRAP_FLAG);
        if (child && typeof child === 'object' && !ownFlag) {
          bridge.wrapLevels(child);
          bridge.wrapChild(child);
          Object.defineProperty(child, WRAP_FLAG, {
            value: true,
            enumerable: false,
            configurable: true,
          });
        }
      } catch {
        // never break child logger creation
      }
      return child;
    };
  }

  /** Restore the original level methods. Idempotent + fail-open. */
  uninstall(): void {
    if (!this.installed || !this.wrapped) {
      this.installed = false;
      return;
    }
    try {
      const logger = this.wrapped as PinoLikeLogger & {
        [WRAP_FLAG]?: boolean;
        child?: unknown;
      };
      for (const level of LEVEL_METHODS) {
        const original = this.originals[level];
        if (typeof original === 'function') logger[level] = original as (...a: unknown[]) => void;
      }
      if (typeof this.originalChild === 'function') logger.child = this.originalChild;
      try {
        delete logger[WRAP_FLAG];
      } catch {
        /* ignore */
      }
    } catch {
      /* best-effort */
    }
    this.originals = {};
    this.originalChild = undefined;
    this.wrapped = null;
    this.installed = false;
  }

  /**
   * Forward one log call to AllStak. pino call shapes handled:
   *   log.info('msg')
   *   log.info('msg %s', arg)            (printf — message taken as-is)
   *   log.info({ a: 1 }, 'msg')          (merge object + message)
   *   log.error(err)                     (Error → throwable + message)
   *   log.error(err, 'msg')              (Error → throwable, explicit message)
   * Fully fail-open.
   */
  private forward(level: LogBridgeLevel, args: unknown[]): void {
    try {
      if (SEVERITY[level] < this.minSeverity) return;
      if (this.opts.transport.isDisabled?.()) return;
      if (args.length === 0) return;

      const { message, mergeObject, error } = parsePinoArgs(args);
      const trace = this.opts.getTraceContext?.() ?? {};

      const metadata: Record<string, unknown> = {
        'sdk.name': SDK_NAME,
        'sdk.version': SDK_VERSION,
      };
      if (mergeObject) {
        for (const [k, v] of Object.entries(mergeObject)) {
          // Skip pino-internal/structural keys that duplicate routing fields.
          if (k === 'level' || k === 'time' || k === 'pid' || k === 'hostname') continue;
          metadata[k] = v;
        }
      }

      const payload: Record<string, unknown> = {
        level: toIngestLevel(level),
        message: message || (error ? error.message : ''),
        service: this.opts.service || '',
        environment: this.opts.environment || '',
        release: this.opts.release || '',
        traceId: trace.traceId,
        spanId: trace.spanId,
        requestId: trace.requestId,
        metadata,
      };

      // ERROR/FATAL promotion: fold the throwable into the metadata bag (a
      // documented free-form field on the logs ingest contract) so the
      // dashboard can correlate the log with the underlying error without
      // inventing a new wire field.
      if (PROMOTED.has(level) && error) {
        metadata['error.type'] = error.name || 'Error';
        metadata['error.message'] = error.message;
        if (error.stack) metadata['error.stackTrace'] = error.stack.split('\n');
      }

      // Value-scrub the whole payload (CC/SSN always; email/IP unless PII opt-in).
      const scrubbed = scrubValuesDeep(payload, this.opts.sendDefaultPii === true);
      this.opts.transport.enqueueLog({ path: INGEST_PATH, payload: scrubbed });
    } catch {
      // never break the host's log call
    }
  }
}

/** Map a pino level to the AllStak logs ingest level vocabulary. */
function toIngestLevel(level: LogBridgeLevel): string {
  if (level === 'warn') return 'warn';
  if (level === 'trace') return 'debug';
  return level;
}

interface ParsedPinoArgs {
  message: string;
  mergeObject?: Record<string, unknown>;
  error?: Error;
}

/**
 * Parse a pino-style argument list into a normalized message / merge object /
 * error. Pure and fail-open (returns a best-effort shape on any oddity).
 */
export function parsePinoArgs(args: unknown[]): ParsedPinoArgs {
  if (args.length === 0) return { message: '' };
  const first = args[0];

  // log.error(err) / log.error(err, 'msg')
  if (first instanceof Error) {
    const explicit = typeof args[1] === 'string' ? (args[1] as string) : '';
    return { message: explicit || first.message, error: first };
  }

  // log.info({ ... }, 'msg', ...interp) — pino merge-object form. The object
  // may itself carry an `err`/`error` Error per the pino convention.
  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>;
    const message = typeof args[1] === 'string' ? (args[1] as string) : '';
    const maybeErr = obj.err ?? obj.error;
    const error = maybeErr instanceof Error ? maybeErr : undefined;
    return { message, mergeObject: obj, error };
  }

  // log.info('msg', ...interp) — printf form; we keep the format string as the
  // message (interpolation is best-effort skipped to avoid format injection).
  if (typeof first === 'string') {
    return { message: first };
  }

  return { message: String(first) };
}
