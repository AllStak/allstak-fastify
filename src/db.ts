/**
 * Database (DB) auto-instrumentation for @allstak/fastify.
 *
 * Self-contained reimplementation of the AllStak driver-level DB
 * instrumentation (no shared-core dependency, matching scope.ts / spool.ts /
 * outbound.ts in this package). On plugin registration it monkey-patches the
 * popular Node SQL drivers — `pg`, `mysql2`, and the SQLite family
 * (`better-sqlite3` / `sqlite3` / `node:sqlite`) — at require time, so that the
 * developer gets `/ingest/v1/db` rows produced AUTOMATICALLY with zero per-call
 * code. Each captured query carries the normalized SQL, a stable hash, the
 * query type, duration, status, optional rows-affected, and the active inbound
 * request's trace/span ids so DB time joins the distributed trace.
 *
 * Drivers are optional peer deps of the HOST app, not of this SDK, so each
 * driver is resolved defensively from the host's `node_modules` and a missing
 * driver simply turns that one integration off. Everything is fully fail-open:
 * an exception inside the capture path must never break the host's query chain.
 *
 * The wire shape (`{ queries: [DbQueryItem, …] }` POSTed to `/ingest/v1/db`)
 * matches the existing AllStak DB ingest contract used by the other SDKs.
 */

/** Minimal transport seam — satisfied by the plugin's FastifyTransport. */
export interface DbTransportLike {
  enqueueDb(ev: { path: string; payload: Record<string, unknown> }): void;
  isDisabled?(): boolean;
}

/** Active-request trace context the DB capture stamps onto each query row. */
export interface DbTraceContext {
  traceId?: string;
  spanId?: string;
}

/** A single captured DB query row (camelCase wire shape for `/ingest/v1/db`). */
export interface DbQueryItem {
  normalizedQuery: string;
  queryHash: string;
  /** SELECT, INSERT, UPDATE, DELETE, BEGIN, COMMIT, ROLLBACK, OTHER. */
  queryType: string;
  durationMs: number;
  timestampMillis: number;
  /** success | error. */
  status: string;
  errorMessage?: string;
  databaseName?: string;
  /** postgresql | mysql | sqlite. */
  databaseType?: string;
  service?: string;
  environment?: string;
  traceId?: string;
  spanId?: string;
  rowsAffected?: number;
}

export interface DbInstrumentationOptions {
  transport: DbTransportLike;
  /** Reads the active request's trace context (ALS-backed). */
  getTraceContext?: () => DbTraceContext | undefined;
  service?: string;
  environment?: string;
  /** Clock seam for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Module resolver seam for deterministic tests. Given a module id (`pg`,
   * `mysql2`, …) returns the (possibly fake) module or null. Defaults to a
   * defensive host-app require.
   */
  moduleResolver?: (id: string) => unknown | null;
  /** Flush interval in ms for the internal batch. Default 5000. */
  flushIntervalMs?: number;
  /** Flush when this many rows accumulate. Default 20. */
  batchSize?: number;
}

const INGEST_PATH = '/ingest/v1/db';
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 20;

/** ORM-ownership marker so an ORM-level wrapper can suppress the driver row. */
const DEDUPE_SYMBOL = Symbol.for('allstak.db.ownedByOrm');

function isOwnedByOrm(target: unknown): boolean {
  try {
    if (target && typeof target === 'object') {
      return (target as Record<symbol, boolean>)[DEDUPE_SYMBOL] === true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Normalize a SQL statement for dedup + safe storage: strip comments and
 * string literals, mask numeric literals, collapse whitespace. Mirrors the
 * canonical AllStak normalizer. Quoted identifiers ("schema"."Table") are NOT
 * masked. Pure and fail-open.
 */
export function normalizeQuery(sql: string): string {
  if (!sql) return '';
  try {
    return sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* block comments */
      .replace(/--[^\n]*/g, ' ') // -- line comments
      .replace(/'(?:''|[^'])*'/g, '?') // single-quoted literals
      .replace(/\$[a-zA-Z0-9_]*\$[\s\S]*?\$[a-zA-Z0-9_]*\$/g, '?') // dollar-quoted
      .replace(/\b\d+(?:\.\d+)?\b/g, '?') // numeric literals
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return sql;
  }
}

/** Stable 32-bit-ish string hash of a normalized query. Pure. */
export function hashQuery(normalized: string): string {
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + c;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Detect the leading SQL verb. Pure. */
export function detectQueryType(sql: string): string {
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase();
  if (!first) return 'OTHER';
  if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'BEGIN', 'COMMIT', 'ROLLBACK'].includes(first)) {
    return first;
  }
  return 'OTHER';
}

/**
 * Defensive host-app module resolver. The SDK is installed under the host's
 * `node_modules/@allstak/fastify`, but the DB drivers are peer deps of the HOST
 * app, so a plain require would resolve relative to the SDK and fail. Walk the
 * host project's resolution bases first, then fall back to a plain require.
 * Returns null when the driver is not installed (expected; that integration
 * stays off). Fully fail-open.
 */
function defaultModuleResolver(id: string): unknown | null {
  const req = resolveRequire();
  if (!req) return null;
  const bases: string[] = [];
  try {
    const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
    if (cwd) bases.push(cwd);
  } catch {
    /* ignore */
  }
  try {
    const mainPaths = (req as { main?: { paths?: string[] } }).main?.paths;
    if (Array.isArray(mainPaths)) bases.push(...mainPaths);
  } catch {
    /* ignore */
  }
  for (const base of bases) {
    try {
      const resolved = (req as { resolve?: (id: string, opts: { paths: string[] }) => string }).resolve?.(
        id,
        { paths: [base] },
      );
      if (resolved) return req(resolved);
    } catch {
      /* try next base */
    }
  }
  try {
    return req(id);
  } catch {
    return null;
  }
}

/** Resolve a CommonJS `require` without a static import (bundler-safe). */
function resolveRequire(): ((id: string) => unknown) | null {
  try {
    const req =
      (globalThis as { require?: (id: string) => unknown }).require ??
      (typeof module !== 'undefined'
        ? (module as { require?: (id: string) => unknown }).require
        : undefined);
    return typeof req === 'function' ? req : null;
  } catch {
    return null;
  }
}

declare const module: unknown;

/**
 * Driver-level SQL instrumentation. One instance per plugin registration.
 * Idempotent install (per process per driver, guarded by a module-level flag
 * keyed on the resolved driver object so re-registration does not double-wrap).
 */
export class DbInstrumentation {
  private readonly opts: DbInstrumentationOptions;
  private readonly now: () => number;
  private readonly resolve: (id: string) => unknown | null;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private queue: DbQueryItem[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private installed = false;
  /** Drivers patched by THIS instance (so uninstall can stop the timer). */
  private patchedAny = false;

  constructor(opts: DbInstrumentationOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.resolve = opts.moduleResolver ?? defaultModuleResolver;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    // flushIntervalMs <= 0 disables batching: each captured query flushes
    // immediately (mirrors the transport's `flushIntervalMs: 0` test mode).
    this.batchSize = this.flushIntervalMs <= 0 ? 1 : opts.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** True once at least one driver was patched. */
  isInstalled(): boolean {
    return this.installed;
  }

  /**
   * Patch every resolvable driver. Fail-open: a missing driver / a throw inside
   * one patcher never stops the others and never breaks registration. Returns
   * true when at least one driver was instrumented.
   */
  install(): boolean {
    if (this.installed) return this.patchedAny;
    let any = false;
    any = this.safePatch(() => this.patchPg()) || any;
    any = this.safePatch(() => this.patchMysql2()) || any;
    any = this.safePatch(() => this.patchSqlite()) || any;
    this.patchedAny = any;
    this.installed = true;
    // Only arm the interval timer when batching is enabled; with
    // flushIntervalMs <= 0 every capture flushes synchronously.
    if (any && this.flushIntervalMs > 0) this.startFlushTimer();
    return any;
  }

  /** Stop the flush timer and emit anything still queued. Idempotent. */
  uninstall(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    // Monkey-patches are intentionally left in place: unwrapping a shared
    // driver prototype mid-process is riskier than leaving a fail-open,
    // disabled-transport wrapper (which no-ops once the transport reports
    // disabled). install() is guarded so re-registration never double-wraps.
    this.installed = false;
  }

  private safePatch(fn: () => boolean): boolean {
    try {
      return fn();
    } catch {
      return false;
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    const t = this.flushTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  /** Record one query row; batches and flushes on size/interval. Fail-open. */
  private capture(
    item: Omit<DbQueryItem, 'service' | 'environment' | 'traceId' | 'spanId'>,
  ): void {
    try {
      if (this.opts.transport.isDisabled?.()) return;
      const trace = this.opts.getTraceContext?.() ?? {};
      this.queue.push({
        ...item,
        service: this.opts.service,
        environment: this.opts.environment,
        traceId: trace.traceId,
        spanId: trace.spanId,
      });
      if (this.queue.length >= this.batchSize) this.flush();
    } catch {
      /* never break the host's query chain */
    }
  }

  /** Drain the batch into one `/ingest/v1/db` POST through the transport. */
  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      this.opts.transport.enqueueDb({ path: INGEST_PATH, payload: { queries: batch } });
    } catch {
      /* fail-open */
    }
  }

  // ── pg ────────────────────────────────────────────────────────────────────

  private patchPg(): boolean {
    const pg = this.resolve('pg') as
      | { Client?: { prototype?: { query?: (...args: unknown[]) => unknown } } }
      | null;
    const proto = pg?.Client?.prototype;
    if (!proto || typeof proto.query !== 'function') return false;
    if (markPatched(proto, 'query')) return true; // already patched this process

    const self = this;
    const originalQuery = proto.query;
    proto.query = function patchedPgQuery(this: unknown, ...args: unknown[]): unknown {
      if (isOwnedByOrm(this)) return originalQuery.apply(this, args);
      const startTime = self.now();
      const firstArg = args[0];
      const queryText =
        typeof firstArg === 'string' ? firstArg : (firstArg as { text?: string })?.text ?? '';
      const normalized = normalizeQuery(queryText);
      const databaseName = (this as { database?: string }).database ?? '';
      const record = (status: 'success' | 'error', err?: Error, rowsAffected = -1): void => {
        self.capture({
          normalizedQuery: normalized,
          queryHash: hashQuery(normalized),
          queryType: detectQueryType(queryText),
          durationMs: self.now() - startTime,
          timestampMillis: startTime,
          status,
          errorMessage: err?.message?.slice(0, 500),
          databaseName,
          databaseType: 'postgresql',
          rowsAffected,
        });
      };

      // Callback signature: client.query(text, [values,] cb) → returns undefined.
      let cbIndex = -1;
      for (let i = args.length - 1; i >= 0; i--) {
        if (typeof args[i] === 'function') {
          cbIndex = i;
          break;
        }
      }
      const submittable =
        firstArg && typeof firstArg === 'object'
          ? (firstArg as { callback?: (err: Error | null, res?: { rowCount?: number }) => void })
          : null;

      if (cbIndex >= 0) {
        const originalCb = args[cbIndex] as (err: Error | null, res?: { rowCount?: number }) => void;
        args[cbIndex] = function wrappedCb(this: unknown, err: Error | null, res?: { rowCount?: number }) {
          record(err ? 'error' : 'success', err ?? undefined, res?.rowCount ?? -1);
          return originalCb.call(this, err, res as never);
        };
        try {
          return originalQuery.apply(this, args);
        } catch (err) {
          record('error', err as Error);
          throw err;
        }
      } else if (submittable?.callback && typeof submittable.callback === 'function') {
        const originalCb = submittable.callback;
        submittable.callback = function wrappedCb(this: unknown, err: Error | null, res?: { rowCount?: number }) {
          record(err ? 'error' : 'success', err ?? undefined, res?.rowCount ?? -1);
          return originalCb.call(this, err, res as never);
        };
        try {
          return originalQuery.apply(this, args);
        } catch (err) {
          record('error', err as Error);
          throw err;
        }
      }

      // Promise signature.
      try {
        const result = originalQuery.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<{ rowCount?: number }>).then(
            (res) => {
              record('success', undefined, res?.rowCount ?? -1);
              return res;
            },
            (err: Error) => {
              record('error', err);
              throw err;
            },
          );
        }
        const maybeEmitter = result as { on?: (ev: string, cb: unknown) => unknown };
        if (maybeEmitter && typeof maybeEmitter.on === 'function') {
          maybeEmitter.on('end', () => record('success'));
          maybeEmitter.on('error', (err: Error) => record('error', err));
        }
        return result;
      } catch (err) {
        record('error', err as Error);
        throw err;
      }
    };
    return true;
  }

  // ── mysql2 ──────────────────────────────────────────────────────────────────

  private patchMysql2(): boolean {
    const mysql2 = this.resolve('mysql2') as
      | { Connection?: { prototype?: Record<string, unknown> } }
      | null;
    const proto = mysql2?.Connection?.prototype;
    if (!proto) return false;

    const self = this;
    const getSql = (args: unknown[]): string => {
      const first = args[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') {
        const o = first as { sql?: string };
        if (typeof o.sql === 'string') return o.sql;
      }
      return '';
    };

    let wrappedAny = false;
    const wrapProtoMethod = (methodName: string): void => {
      const original = proto[methodName];
      if (typeof original !== 'function') return;
      if (markPatched(proto, methodName)) {
        wrappedAny = true;
        return;
      }
      proto[methodName] = function wrapped(this: unknown, ...args: unknown[]): unknown {
        if (isOwnedByOrm(this)) return (original as Function).apply(this, args);
        const startTime = self.now();
        const sql = getSql(args);
        const normalized = normalizeQuery(sql);
        const databaseName = (this as { config?: { database?: string } }).config?.database ?? '';
        const record = (status: 'success' | 'error', err?: Error, rowsAffected = -1): void => {
          self.capture({
            normalizedQuery: normalized,
            queryHash: hashQuery(normalized),
            queryType: detectQueryType(sql),
            durationMs: self.now() - startTime,
            timestampMillis: startTime,
            status,
            errorMessage: err?.message?.slice(0, 500),
            databaseName,
            databaseType: 'mysql',
            rowsAffected,
          });
        };

        const wrapOriginalCb = (
          orig: (err: Error | null, results?: unknown, fields?: unknown) => void,
        ) =>
          function wrappedCb(this: unknown, err: Error | null, results?: unknown, fields?: unknown) {
            const rows =
              (results as { affectedRows?: number; length?: number })?.affectedRows ??
              (results as { length?: number })?.length ??
              -1;
            record(err ? 'error' : 'success', err ?? undefined, rows);
            return orig.call(this, err, results, fields);
          };

        let cbIndex = -1;
        for (let i = args.length - 1; i >= 0; i--) {
          if (typeof args[i] === 'function') {
            cbIndex = i;
            break;
          }
        }
        if (cbIndex >= 0) {
          args[cbIndex] = wrapOriginalCb(
            args[cbIndex] as (err: Error | null, results?: unknown, fields?: unknown) => void,
          );
          try {
            return (original as Function).apply(this, args);
          } catch (err) {
            record('error', err as Error);
            throw err;
          }
        }
        const first = args[0] as
          | { onResult?: (err: Error | null, rows?: unknown, fields?: unknown) => void }
          | undefined;
        if (first && typeof first.onResult === 'function') {
          first.onResult = wrapOriginalCb(first.onResult);
          try {
            return (original as Function).apply(this, args);
          } catch (err) {
            record('error', err as Error);
            throw err;
          }
        }
        try {
          const result = (original as Function).apply(this, args);
          record('success');
          return result;
        } catch (err) {
          record('error', err as Error);
          throw err;
        }
      };
      wrappedAny = true;
    };

    wrapProtoMethod('query');
    wrapProtoMethod('execute');
    return wrappedAny;
  }

  // ── sqlite (better-sqlite3 / sqlite3 / node:sqlite) ───────────────────────────

  private patchSqlite(): boolean {
    let any = false;
    any = this.safePatch(() => this.patchBetterSqlite3()) || any;
    any = this.safePatch(() => this.patchSqlite3()) || any;
    any = this.safePatch(() => this.patchNodeSqlite()) || any;
    return any;
  }

  private recordSqlite(
    startTime: number,
    sql: string,
    databaseName: string,
    status: 'success' | 'error',
    err?: Error,
    rowsAffected = -1,
  ): void {
    const normalized = normalizeQuery(sql);
    this.capture({
      normalizedQuery: normalized,
      queryHash: hashQuery(normalized),
      queryType: detectQueryType(sql),
      durationMs: this.now() - startTime,
      timestampMillis: startTime,
      status,
      errorMessage: err?.message?.slice(0, 500),
      databaseName,
      databaseType: 'sqlite',
      rowsAffected,
    });
  }

  private patchBetterSqlite3(): boolean {
    const mod = this.resolve('better-sqlite3') as
      | {
          prototype?: {
            prepare?: (sql: string) => { source?: string };
            exec?: (sql: string) => unknown;
          };
        }
      | null;
    const proto = mod?.prototype;
    if (!proto) return false;
    if (markPatched(proto, '__allstak_sqlite')) return true;
    const self = this;
    const origPrepare = proto.prepare;
    const origExec = proto.exec;

    if (typeof origPrepare === 'function') {
      proto.prepare = function (this: { name?: string }, sql: string) {
        if (isOwnedByOrm(this)) return origPrepare.call(this, sql);
        const databaseName = this.name ?? '';
        let stmt: Record<string, unknown> & { source?: string };
        try {
          stmt = origPrepare.call(this, sql) as Record<string, unknown> & { source?: string };
        } catch (err) {
          self.recordSqlite(self.now(), sql, databaseName, 'error', err as Error);
          throw err;
        }
        for (const method of ['run', 'get', 'all', 'iterate'] as const) {
          const original = stmt[method];
          if (typeof original === 'function') {
            stmt[method] = function (this: unknown, ...args: unknown[]) {
              const startTime = self.now();
              try {
                const result = (original as Function).apply(this, args);
                const rows =
                  (result as { changes?: number })?.changes ??
                  (Array.isArray(result) ? result.length : -1);
                self.recordSqlite(startTime, sql, databaseName, 'success', undefined, rows);
                return result;
              } catch (err) {
                self.recordSqlite(startTime, sql, databaseName, 'error', err as Error);
                throw err;
              }
            };
          }
        }
        return stmt;
      };
    }
    if (typeof origExec === 'function') {
      proto.exec = function (this: { name?: string }, sql: string) {
        if (isOwnedByOrm(this)) return origExec.call(this, sql);
        const startTime = self.now();
        const databaseName = this.name ?? '';
        try {
          const result = origExec.call(this, sql);
          self.recordSqlite(startTime, sql, databaseName, 'success');
          return result;
        } catch (err) {
          self.recordSqlite(startTime, sql, databaseName, 'error', err as Error);
          throw err;
        }
      };
    }
    return true;
  }

  private patchSqlite3(): boolean {
    const mod = this.resolve('sqlite3') as { Database?: { prototype?: Record<string, unknown> } } | null;
    const proto = mod?.Database?.prototype;
    if (!proto) return false;
    if (markPatched(proto, '__allstak_sqlite3')) return true;
    const self = this;
    for (const method of ['run', 'get', 'all', 'each', 'exec']) {
      const original = proto[method];
      if (typeof original !== 'function') continue;
      proto[method] = function (this: { filename?: string }, ...args: unknown[]) {
        if (isOwnedByOrm(this)) return (original as Function).apply(this, args);
        const startTime = self.now();
        const sql = typeof args[0] === 'string' ? (args[0] as string) : '';
        const databaseName = this.filename ?? '';
        const cbIndex = args.findIndex((a) => typeof a === 'function');
        if (cbIndex >= 0) {
          const cb = args[cbIndex] as Function;
          args[cbIndex] = function (this: unknown, err: Error | null, ...rest: unknown[]) {
            const rows = (this as { changes?: number })?.changes ?? -1;
            self.recordSqlite(startTime, sql, databaseName, err ? 'error' : 'success', err ?? undefined, rows);
            return cb.apply(this, [err, ...rest]);
          };
        } else {
          self.recordSqlite(startTime, sql, databaseName, 'success');
        }
        try {
          return (original as Function).apply(this, args);
        } catch (err) {
          self.recordSqlite(startTime, sql, databaseName, 'error', err as Error);
          throw err;
        }
      };
    }
    return true;
  }

  private patchNodeSqlite(): boolean {
    const proc = (globalThis as { process?: { emitWarning?: Function } }).process;
    const origEmit = proc?.emitWarning;
    if (proc && typeof origEmit === 'function') {
      proc.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
        if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) return;
        return (origEmit as Function).call(proc, warning, ...rest);
      } as typeof proc.emitWarning;
    }
    const mod = this.resolve('node:sqlite') as
      | { DatabaseSync?: { prototype?: Record<string, unknown> } }
      | null;
    if (proc && typeof origEmit === 'function') proc.emitWarning = origEmit as typeof proc.emitWarning;
    const dbProto = mod?.DatabaseSync?.prototype;
    if (!dbProto) return false;
    if (markPatched(dbProto, '__allstak_node_sqlite')) return true;
    const self = this;

    const origPrepare = dbProto.prepare;
    if (typeof origPrepare === 'function') {
      dbProto.prepare = function (this: { location?: string }, sql: string) {
        const stmt = (origPrepare as Function).call(this, sql) as Record<string, unknown>;
        const databaseName = this.location ?? '';
        for (const method of ['run', 'get', 'all'] as const) {
          const original = stmt[method];
          if (typeof original === 'function') {
            stmt[method] = function (this: unknown, ...args: unknown[]) {
              const startTime = self.now();
              try {
                const result = (original as Function).apply(this, args);
                const rows =
                  (result as { changes?: number })?.changes ??
                  (Array.isArray(result) ? result.length : -1);
                self.recordSqlite(startTime, sql, databaseName, 'success', undefined, rows);
                return result;
              } catch (err) {
                self.recordSqlite(startTime, sql, databaseName, 'error', err as Error);
                throw err;
              }
            };
          }
        }
        return stmt;
      };
    }
    const origExec = dbProto.exec;
    if (typeof origExec === 'function') {
      dbProto.exec = function (this: { location?: string }, sql: string) {
        const startTime = self.now();
        const databaseName = this.location ?? '';
        try {
          const result = (origExec as Function).call(this, sql);
          self.recordSqlite(startTime, sql, databaseName, 'success');
          return result;
        } catch (err) {
          self.recordSqlite(startTime, sql, databaseName, 'error', err as Error);
          throw err;
        }
      };
    }
    return true;
  }
}

/**
 * Mark a prototype method as patched by AllStak so a second plugin registration
 * (or a second driver-prototype resolution) never double-wraps. Returns true
 * when it was ALREADY patched (caller should treat it as success and skip).
 */
function markPatched(target: object, method: string): boolean {
  const flag = Symbol.for(`allstak.db.patched.${method}`);
  try {
    if ((target as Record<symbol, boolean>)[flag]) return true;
    Object.defineProperty(target, flag, { value: true, enumerable: false, configurable: true });
  } catch {
    /* non-extensible target: best effort, allow patch to proceed */
  }
  return false;
}
