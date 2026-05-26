/**
 * Release auto-detection for @allstak/fastify.
 *
 * Resolves the "release" identifier attached to every event, highest priority
 * first:
 *
 *   1. Explicit `release` passed in config — always wins.
 *   2. Environment variables — `ALLSTAK_RELEASE` first, then common platform
 *      deploy vars (Railway, Render, generic `GIT_COMMIT`/`GIT_SHA`, Heroku
 *      `SOURCE_VERSION`).
 *   3. Local git at init (Node runtime only): `git describe --tags --always
 *      --dirty`, falling back to `git rev-parse --short HEAD` (+ `-dirty` when
 *      the tree is dirty). Run ONCE, cached, fully guarded — any missing git /
 *      non-repo / spawn error yields no release. Gated behind
 *      `autoDetectRelease` (default true).
 *   4. The package version, so a release is never empty. Also gated behind
 *      `autoDetectRelease`.
 *
 * `node:child_process` is never statically imported — it is resolved lazily
 * through a guarded optional require so the module stays safe to bundle on any
 * runtime and the require only fires on a real Node process.
 */

/** A runner that executes a git command and returns its trimmed stdout, or
 *  null when git is unavailable / errored. Seam for deterministic tests. */
export type GitRunner = (args: string[]) => string | null;

export interface ResolveReleaseOptions {
  /** Explicit release from config — wins over everything when non-empty. */
  explicit?: string;
  /** Enable git + version fallback (steps 3 & 4). Default true. */
  autoDetectRelease?: boolean;
  /** Env source. Defaults to `process.env`. Seam for tests. */
  env?: Record<string, string | undefined>;
  /** Git runner seam. Defaults to a guarded spawnSync runner. Tests inject. */
  gitRunner?: GitRunner;
  /** Package version fallback (step 4). Empty when omitted. */
  version?: string;
}

/**
 * Ordered list of environment variables checked for a release identifier.
 * `ALLSTAK_RELEASE` is the explicit override; the rest are platform deploy
 * vars commonly available to a Node server.
 */
export const RELEASE_ENV_VARS = [
  'ALLSTAK_RELEASE',
  'RAILWAY_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'GIT_COMMIT',
  'GIT_SHA',
  'SOURCE_VERSION',
] as const;

/** Read the first non-empty release env var. Pure over the supplied `env`. */
export function detectReleaseFromEnv(
  env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
): string | undefined {
  for (const key of RELEASE_ENV_VARS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  return undefined;
}

/**
 * Build a release string from the output of a git runner. Pure and testable.
 *
 * Prefers `git describe --tags --always --dirty`. When that yields nothing,
 * falls back to `git rev-parse --short HEAD` and appends `-dirty` if `git
 * status --porcelain` reports a dirty tree. Returns undefined when git is
 * unavailable or produced no usable output.
 */
export function resolveGitRelease(runner: GitRunner): string | undefined {
  let describe: string | null = null;
  try {
    describe = runner(['describe', '--tags', '--always', '--dirty']);
  } catch {
    describe = null;
  }
  if (describe && describe.trim() !== '') return describe.trim();

  let sha: string | null = null;
  try {
    sha = runner(['rev-parse', '--short', 'HEAD']);
  } catch {
    sha = null;
  }
  if (!sha || sha.trim() === '') return undefined;
  let dirty = '';
  try {
    const status = runner(['status', '--porcelain']);
    if (status && status.trim() !== '') dirty = '-dirty';
  } catch {
    /* status unavailable — treat as clean */
  }
  return `${sha.trim()}${dirty}`;
}

/** True only on a Node.js runtime (where child_process + fs exist). */
export function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!proc?.versions?.node;
}

interface SpawnSyncResult {
  status: number | null;
  // `encoding: 'utf8'` makes stdout a string; we keep a structural fallback so
  // this module needs no `@types/node` (the fastify package ships none).
  stdout?: string | { toString(encoding?: string): string };
}
interface ChildProcessModule {
  spawnSync?: (cmd: string, args: string[], opts: Record<string, unknown>) => SpawnSyncResult;
}

declare const module: unknown;

/**
 * Resolve `node:child_process` WITHOUT a static import. Try
 * `process.getBuiltinModule` first, then an indirect require off the CommonJS
 * wrapper. Returns null on any failure (incl. non-Node runtimes).
 */
function loadChildProcess(): ChildProcessModule | null {
  if (!isNodeRuntime()) return null;
  const proc = (globalThis as {
    process?: { getBuiltinModule?: (id: string) => ChildProcessModule };
  }).process;
  try {
    const fromBuiltin = proc?.getBuiltinModule?.('node:child_process');
    if (fromBuiltin?.spawnSync) return fromBuiltin;
  } catch {
    /* fall through */
  }
  try {
    const req =
      (globalThis as { require?: (id: string) => ChildProcessModule }).require ??
      (typeof module !== 'undefined' && (module as { require?: (id: string) => ChildProcessModule }).require);
    const mod = req ? req('node:child_process') : undefined;
    return mod?.spawnSync ? mod : null;
  } catch {
    return null;
  }
}

/**
 * Default git runner: a guarded `spawnSync('git', …)` with a short timeout.
 * Returns null when not on Node, when child_process can't be loaded, when git
 * is missing, or on any non-zero exit / error. Never throws.
 */
export function defaultGitRunner(args: string[]): string | null {
  const cp = loadChildProcess();
  if (!cp?.spawnSync) return null;
  try {
    const result = cp.spawnSync('git', args, {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (!result || result.status !== 0) return null;
    const out = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8');
    return out ? out.trim() : null;
  } catch {
    return null;
  }
}

let cachedGitRelease: string | undefined;
let gitResolutionAttempted = false;

/** @internal — reset the one-shot git cache (tests only). */
export function _resetReleaseCache(): void {
  cachedGitRelease = undefined;
  gitResolutionAttempted = false;
}

/**
 * Resolve the effective release per the documented priority order. The git
 * lookup (step 3) runs at most once per process and is cached. Never throws.
 */
export function resolveRelease(options: ResolveReleaseOptions = {}): string {
  // 1. Explicit config wins.
  const explicit = options.explicit;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();

  // 2. Environment variables.
  const fromEnv = detectReleaseFromEnv(options.env);
  if (fromEnv) return fromEnv;

  const autoDetect = options.autoDetectRelease !== false;
  if (!autoDetect) return '';

  // 3. Local git (Node runtime only), cached one-shot.
  const runner = options.gitRunner ?? defaultGitRunner;
  if (options.gitRunner || isNodeRuntime()) {
    if (!gitResolutionAttempted) {
      gitResolutionAttempted = true;
      try {
        cachedGitRelease = resolveGitRelease(runner);
      } catch {
        cachedGitRelease = undefined;
      }
    }
    if (cachedGitRelease) return cachedGitRelease;
  }

  // 4. Package version fallback so release is never empty.
  return options.version ?? '';
}
