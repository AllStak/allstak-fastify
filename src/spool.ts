import { redactMap } from './redaction';

declare const module: unknown;

/**
 * Filesystem spool for un-sent telemetry envelopes (the Node/server analogue of
 * Sentry's offline cache / envelope store).
 *
 * When an event cannot be delivered (network outage, retries exhausted, or the
 * process is shutting down with events still buffered) the transport writes the
 * already-PII-scrubbed payload here, one JSON file per envelope. On the next SDK
 * init the transport drains the directory and replays each envelope through its
 * normal retry/backoff pipeline, removing the file only once the event is
 * accepted (2xx) or permanently undeliverable (4xx other than 429).
 *
 * The store is bounded by count, total bytes, and max age — when full the OLDEST
 * entries are dropped first so it never grows unbounded. Everything here is
 * fully fail-open: if the directory is not writable (read-only FS, serverless,
 * sandbox) every operation silently no-ops and the SDK keeps its in-memory
 * behavior.
 *
 * Session lifecycle calls (`/sessions/start`, `/sessions/end`) are intentionally
 * NOT spooled — a replayed stale session would skew durations — so the transport
 * filters them out before calling {@link FileSpool.persist}.
 */

/** A single persisted, already-scrubbed envelope. */
export interface SpoolEnvelope {
  /** Ingest path this envelope targets, e.g. `/ingest/v1/errors`. */
  path: string;
  /** Already-PII-scrubbed payload (never raw user data). */
  payload: Record<string, unknown>;
  /** Wall-clock ms the envelope was first persisted (for max-age eviction). */
  ts: number;
}

/** Subset of `node:fs` the spool needs; injectable for deterministic tests. */
export interface SpoolFs {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  unlinkSync(path: string): void;
  statSync(path: string): { size: number; mtimeMs: number };
}

export interface FileSpoolOptions {
  /** Absolute spool directory. */
  dir: string;
  /** Max envelopes retained. Default 200. */
  maxEntries?: number;
  /** Max total bytes retained. Default 5 MiB. */
  maxBytes?: number;
  /** Max envelope age in ms before it is dropped on load. Default 48h. */
  maxAgeMs?: number;
  /** fs seam (defaults to a lazily-required `node:fs`). */
  fs?: SpoolFs;
  /** Clock seam for tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Filename pattern for spool files: `<ts>-<rand>.json` so a lexical sort is age order. */
const FILE_RE = /^\d+-[0-9a-z]+\.json$/i;

/**
 * Resolve a builtin-module loader for the optional `node:fs` / `node:os` lookups
 * WITHOUT a static import, so esbuild never bundles the node core modules and
 * browser/edge bundles without a filesystem just yield null.
 *
 * Mirrors the release-detection module's loader: try `process.getBuiltinModule`
 * first (Node ≥18.20/20/22), then an indirect require off `globalThis`/the
 * CommonJS wrapper (which also works under Vitest). Any failure (no Node
 * runtime, pure-ESM browser) returns null and the spool degrades to a no-op.
 */
export function nodeRequire(): ((id: string) => unknown) | null {
  const proc = (globalThis as {
    process?: { versions?: { node?: string }; getBuiltinModule?: (id: string) => unknown };
  }).process;
  if (!proc?.versions?.node) return null;
  if (typeof proc.getBuiltinModule === 'function') {
    const get = proc.getBuiltinModule.bind(proc);
    try {
      // Probe that it actually resolves a core module before trusting it.
      if (get('node:fs')) return get;
    } catch {
      /* fall through to require */
    }
  }
  try {
    const req =
      (globalThis as { require?: (id: string) => unknown }).require ??
      (typeof module !== 'undefined' ? (module as { require?: (id: string) => unknown }).require : undefined);
    return typeof req === 'function' ? req : null;
  } catch {
    return null;
  }
}

/**
 * Lazily resolve `node:fs`. Returns null on any runtime without a filesystem
 * (browsers, some edge runtimes) so the spool degrades to a silent no-op.
 */
function loadNodeFs(): SpoolFs | null {
  try {
    const req = nodeRequire();
    if (!req) return null;
    const fs = req('node:fs');
    if (fs && typeof (fs as SpoolFs).writeFileSync === 'function') return fs as SpoolFs;
    return null;
  } catch {
    return null;
  }
}

/** Join two path segments without pulling in `node:path`. */
function joinPath(dir: string, file: string): string {
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`;
}

/**
 * Filesystem-backed spool. Construct once per transport. If the directory can
 * not be created the instance is permanently disabled and every method no-ops.
 */
export class FileSpool {
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly fs: SpoolFs | null;
  private readonly now: () => number;
  private seq = 0;
  private disabled = false;

  constructor(opts: FileSpoolOptions) {
    this.dir = opts.dir;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = opts.now ?? Date.now;
    this.fs = opts.fs ?? loadNodeFs();
    if (!this.fs) {
      this.disabled = true;
      return;
    }
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      // Read-only FS / permission denied / serverless: degrade to in-memory.
      this.disabled = true;
    }
  }

  /** Whether the spool is usable. False ⇒ every method is a silent no-op. */
  isEnabled(): boolean {
    return !this.disabled;
  }

  /**
   * Persist an already-scrubbed envelope. Runs the payload through the SDK PII
   * sanitizer once more (defense-in-depth — never write secrets to disk) and
   * enforces the count/byte caps by dropping the OLDEST files first. Fully
   * fail-open: any error leaves the in-memory pipeline untouched.
   */
  persist(path: string, payload: Record<string, unknown>): void {
    if (this.disabled || !this.fs) return;
    try {
      // Defense-in-depth scrub: callers already scrub, but the on-disk store is
      // a security boundary, so we never persist unredacted data.
      const scrubbed = (redactMap(payload) ?? payload) as Record<string, unknown>;
      const envelope: SpoolEnvelope = { path, payload: scrubbed, ts: this.now() };
      const body = JSON.stringify(envelope);
      const name = `${this.now()}-${(this.seq++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}.json`;
      this.fs.writeFileSync(joinPath(this.dir, name), body);
      this.enforceCaps();
    } catch {
      // Disk full / permission revoked mid-run: silently drop.
    }
  }

  /**
   * Load all valid envelopes oldest-first, dropping (and deleting) any that are
   * unparseable or older than maxAgeMs. Returns each envelope alongside an
   * idempotent `remove()` callback so the caller deletes a file only after the
   * replay is accepted or permanently undeliverable.
   */
  load(): Array<{ envelope: SpoolEnvelope; remove: () => void }> {
    if (this.disabled || !this.fs) return [];
    let files: string[];
    try {
      files = this.listSorted();
    } catch {
      return [];
    }
    const cutoff = this.now() - this.maxAgeMs;
    const out: Array<{ envelope: SpoolEnvelope; remove: () => void }> = [];
    for (const file of files) {
      const full = joinPath(this.dir, file);
      let env: SpoolEnvelope | null = null;
      try {
        env = JSON.parse(this.fs.readFileSync(full, 'utf8')) as SpoolEnvelope;
      } catch {
        this.safeUnlink(full);
        continue;
      }
      if (!env || typeof env.path !== 'string' || typeof env.ts !== 'number' || env.ts < cutoff) {
        this.safeUnlink(full);
        continue;
      }
      out.push({ envelope: env, remove: () => this.safeUnlink(full) });
    }
    return out;
  }

  /** Number of spool files currently on disk (for tests / introspection). */
  count(): number {
    if (this.disabled || !this.fs) return 0;
    try {
      return this.listSorted().length;
    } catch {
      return 0;
    }
  }

  /** Spool files sorted oldest-first (filename is `<ts>-…` so lexical == age). */
  private listSorted(): string[] {
    if (!this.fs) return [];
    return this.fs
      .readdirSync(this.dir)
      .filter((f) => FILE_RE.test(f))
      .sort();
  }

  /** Drop oldest files until both the count and byte caps are satisfied. */
  private enforceCaps(): void {
    if (!this.fs) return;
    let files: string[];
    try {
      files = this.listSorted();
    } catch {
      return;
    }
    // Count cap: oldest first.
    while (files.length > this.maxEntries) {
      const victim = files.shift();
      if (victim) this.safeUnlink(joinPath(this.dir, victim));
    }
    // Byte cap: sum sizes, evict oldest until under the limit.
    let total = 0;
    const sized = files.map((f) => {
      let size = 0;
      try {
        size = this.fs!.statSync(joinPath(this.dir, f)).size;
      } catch {
        size = 0;
      }
      total += size;
      return { f, size };
    });
    let i = 0;
    while (total > this.maxBytes && i < sized.length) {
      this.safeUnlink(joinPath(this.dir, sized[i].f));
      total -= sized[i].size;
      i++;
    }
  }

  private safeUnlink(full: string): void {
    if (!this.fs) return;
    try {
      this.fs.unlinkSync(full);
    } catch {
      // Already gone / locked: ignore.
    }
  }
}
