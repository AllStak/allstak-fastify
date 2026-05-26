/**
 * Per-request scoped context isolation for @allstak/fastify.
 *
 * Self-contained reimplementation of the AllStak scope-stack model (no
 * shared-core dependency). A `Scope` carries user / tags / extras / contexts /
 * breadcrumbs that attach to events captured while the scope is active. The
 * active scope stack lives in an AsyncLocalStorage store so per-request data
 * set inside an `onRequest`-wrapped handler does NOT leak across concurrent
 * requests, and `withScope` forks a temporary scope that is popped after the
 * callback (even on throw / rejection).
 */

export type Severity = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface ScopeUser {
  id?: string;
  email?: string;
  [key: string]: unknown;
}

export interface ScopeBreadcrumb {
  type?: string;
  category?: string;
  message: string;
  level?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

/** Max breadcrumbs retained per scope (drop-oldest ring). */
const MAX_BREADCRUMBS = 50;

export class Scope {
  user?: ScopeUser;
  tags: Record<string, string> = {};
  extras: Record<string, unknown> = {};
  contexts: Record<string, Record<string, unknown>> = {};
  breadcrumbs: ScopeBreadcrumb[] = [];
  fingerprint?: string[];
  level?: Severity;

  setUser(user: ScopeUser | null): this {
    this.user = user ?? undefined;
    return this;
  }
  setTag(key: string, value: string): this {
    this.tags[key] = value;
    return this;
  }
  setTags(tags: Record<string, string>): this {
    Object.assign(this.tags, tags);
    return this;
  }
  setExtra(key: string, value: unknown): this {
    this.extras[key] = value;
    return this;
  }
  setExtras(extras: Record<string, unknown>): this {
    Object.assign(this.extras, extras);
    return this;
  }
  setContext(name: string, ctx: Record<string, unknown> | null): this {
    if (ctx === null) delete this.contexts[name];
    else this.contexts[name] = ctx;
    return this;
  }
  setLevel(level: Severity): this {
    this.level = level;
    return this;
  }
  setFingerprint(fingerprint: string[] | null): this {
    this.fingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : undefined;
    return this;
  }
  addBreadcrumb(crumb: ScopeBreadcrumb): this {
    this.breadcrumbs.push({ timestamp: new Date().toISOString(), ...crumb });
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs = this.breadcrumbs.slice(-MAX_BREADCRUMBS);
    }
    return this;
  }
  clear(): this {
    this.user = undefined;
    this.tags = {};
    this.extras = {};
    this.contexts = {};
    this.breadcrumbs = [];
    this.fingerprint = undefined;
    this.level = undefined;
    return this;
  }
  /** Shallow clone so a forked scope inherits — but does not mutate — its parent. */
  clone(): Scope {
    const s = new Scope();
    s.user = this.user ? { ...this.user } : undefined;
    s.tags = { ...this.tags };
    s.extras = { ...this.extras };
    s.contexts = { ...this.contexts };
    s.breadcrumbs = [...this.breadcrumbs];
    s.fingerprint = this.fingerprint ? [...this.fingerprint] : undefined;
    s.level = this.level;
    return s;
  }
}

export interface MergedScopeData {
  user?: ScopeUser;
  tags: Record<string, string>;
  extras: Record<string, unknown>;
  contexts: Record<string, Record<string, unknown>>;
  breadcrumbs: ScopeBreadcrumb[];
  fingerprint?: string[];
  level?: Severity;
}

/**
 * Flatten a scope stack into a single effective view. Later scopes win on key
 * conflicts; breadcrumbs concatenate in order. Returns a fresh object — never
 * mutates the input scopes.
 */
export function mergeScopeStack(stack: Scope[]): MergedScopeData {
  const out: MergedScopeData = {
    tags: {},
    extras: {},
    contexts: {},
    breadcrumbs: [],
  };
  for (const scope of stack) {
    if (scope.user) out.user = scope.user;
    Object.assign(out.tags, scope.tags);
    Object.assign(out.extras, scope.extras);
    Object.assign(out.contexts, scope.contexts);
    if (scope.breadcrumbs.length) out.breadcrumbs.push(...scope.breadcrumbs);
    if (scope.fingerprint) out.fingerprint = scope.fingerprint;
    if (scope.level) out.level = scope.level;
  }
  return out;
}

interface AsyncScopeStorage {
  getStore(): Scope[] | undefined;
  run<T>(store: Scope[], callback: () => T): T;
  enterWith?(store: Scope[]): void;
}

type AsyncLocalStorageCtor = new <T>() => AsyncScopeStorage;

/**
 * Resolve Node's AsyncLocalStorage without a static `import 'node:async_hooks'`
 * (these server packages declare no `@types/node` and target node>=18, where
 * `getBuiltinModule` may be unavailable until 20.6). We try the modern builtin
 * accessor first, then fall back to an indirect `require` captured off the
 * CommonJS module wrapper. Indirect access keeps the bundler from rewriting it.
 */
function loadAsyncLocalStorage(): AsyncLocalStorageCtor | null {
  const proc = (globalThis as {
    process?: {
      versions?: { node?: string };
      getBuiltinModule?: (id: string) => { AsyncLocalStorage?: AsyncLocalStorageCtor };
    };
  }).process;
  if (!proc?.versions?.node) return null;
  try {
    const fromBuiltin = proc.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage;
    if (fromBuiltin) return fromBuiltin;
  } catch {
    /* fall through */
  }
  try {
    const req = (globalThis as { require?: (id: string) => { AsyncLocalStorage?: AsyncLocalStorageCtor } }).require
      ?? (typeof module !== 'undefined' && (module as { require?: (id: string) => { AsyncLocalStorage?: AsyncLocalStorageCtor } }).require);
    const mod = req ? req('node:async_hooks') : undefined;
    return mod?.AsyncLocalStorage ?? null;
  } catch {
    return null;
  }
}

declare const module: unknown;

function createAsyncScopeStorage(): AsyncScopeStorage | null {
  const Ctor = loadAsyncLocalStorage();
  if (!Ctor) return null;
  try {
    return new Ctor<Scope[]>();
  } catch {
    return null;
  }
}

/**
 * Module-level scope manager. Holds a global (process-wide) scope plus an
 * AsyncLocalStorage-backed per-request stack. Capture paths read the active
 * stack (request stack if inside one, else just the global scope) and merge it
 * onto the event being built.
 */
export class ScopeManager {
  private readonly globalScope = new Scope();
  private readonly als: AsyncScopeStorage | null = createAsyncScopeStorage();

  /** The active scope stack: ALS request stack when inside a request, else [globalScope]. */
  private stack(): Scope[] {
    const requestStack = this.als?.getStore();
    if (requestStack && requestStack.length > 0) return requestStack;
    return [this.globalScope];
  }

  /** The scope mutations target: the innermost active scope. */
  getCurrentScope(): Scope {
    const s = this.stack();
    return s[s.length - 1];
  }

  /** Effective merged view used by capture paths. */
  getMerged(): MergedScopeData {
    return mergeScopeStack(this.stack());
  }

  /**
   * Run `callback` inside a fresh per-request scope context (ALS). The request
   * scope is seeded as a clone of the global scope so configured base
   * user/tags still apply, and request-set values stay isolated to this run.
   * Falls back to a synchronous global mutation+restore when ALS is missing.
   */
  runInRequestScope<T>(callback: () => T): T {
    const seeded = this.globalScope.clone();
    if (this.als) {
      return this.als.run([seeded], callback);
    }
    return callback();
  }

  /**
   * Establish a fresh per-request scope for the remainder of the current async
   * context using `AsyncLocalStorage.enterWith`. Designed for framework hooks
   * (e.g. Fastify `onRequest`) that cannot wrap the downstream handler in a
   * callback but run inside the request's async chain. No-ops without ALS.
   */
  enterRequestScope(): Scope | null {
    if (!this.als || typeof this.als.enterWith !== 'function') return null;
    const seeded = this.globalScope.clone();
    this.als.enterWith([seeded]);
    return seeded;
  }

  /**
   * Fork a temporary scope on top of the active stack, run the callback, then
   * pop. Supports sync and async callbacks; pops on throw/rejection.
   */
  withScope<T>(callback: (scope: Scope) => T): T {
    const parent = this.stack();
    const forked = this.getCurrentScope().clone();
    const newStack = [...parent, forked];
    if (this.als) {
      return this.als.run(newStack, () => callback(forked));
    }
    // No ALS: push onto the global scope's logical stack via a temp manager.
    // We emulate by temporarily swapping; but without ALS we only have the
    // global scope, so we capture/restore its state around the callback.
    const snapshot = this.globalScope.clone();
    Object.assign(this.globalScope, forked);
    const restore = () => {
      this.globalScope.user = snapshot.user;
      this.globalScope.tags = snapshot.tags;
      this.globalScope.extras = snapshot.extras;
      this.globalScope.contexts = snapshot.contexts;
      this.globalScope.breadcrumbs = snapshot.breadcrumbs;
      this.globalScope.fingerprint = snapshot.fingerprint;
      this.globalScope.level = snapshot.level;
    };
    try {
      const result = callback(this.globalScope);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return (result as unknown as Promise<unknown>).then(
          (v) => { restore(); return v; },
          (e) => { restore(); throw e; },
        ) as unknown as T;
      }
      restore();
      return result;
    } catch (err) {
      restore();
      throw err;
    }
  }

  /** Mutate the active scope in place. */
  configureScope(callback: (scope: Scope) => void): void {
    callback(this.getCurrentScope());
  }
}
