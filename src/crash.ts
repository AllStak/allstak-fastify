/**
 * Process-global crash handlers for @allstak/fastify.
 *
 * Fastify's `onError` hook only sees errors thrown inside a request lifecycle.
 * A truly fatal error — an `uncaughtException` from a timer/stream callback, or
 * an `unhandledRejection` — escapes Fastify entirely and would otherwise crash
 * the process with no telemetry. This module installs process-global
 * `uncaughtException` / `unhandledRejection` listeners ONCE per process
 * (guarded by a Symbol on `process`) so such a crash is:
 *
 *   1. captured at `fatal` level through the SDK's normal capture path;
 *   2. recorded on the release-health session as a crash; and
 *   3. flushed synchronously (best-effort, within a short budget) before the
 *      process exits — so the crash report actually leaves the box.
 *
 * Node semantics are preserved. For `uncaughtException` with no OTHER user
 * listener, Node's default is to print the error and exit non-zero; we replicate
 * that (after flushing) so we never silently swallow a fatal crash. When the
 * application has registered its own `uncaughtException` listener we defer to it
 * and do NOT force-exit. `unhandledRejection` does not exit by default, so we
 * only capture + flush and leave the process running.
 *
 * Fully fail-open: a throw inside the handler must never make the crash worse.
 */

/** Symbol guard so handlers install exactly once per process. */
const INSTALLED_FLAG = Symbol.for('@allstak/fastify.crashHandlers.installed');

/** Seam-friendly view of the process object the handlers need. */
export interface CrashProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  listeners?(event: string): unknown[];
  listenerCount?(event: string): number;
  exit?(code?: number): void;
  exitCode?: number;
}

export interface CrashHandlerHooks {
  /**
   * Capture the fatal error through the SDK. Should route to captureException
   * at `fatal` level (which also marks the session crashed) and is expected to
   * be synchronous-enqueue (the actual network send is awaited via flush).
   */
  captureFatal: (error: unknown) => void;
  /** Best-effort synchronous flush; resolves when the queue is drained/timed out. */
  flush: () => Promise<void>;
}

/** Handle returned by {@link installCrashHandlers} so a test can tear down. */
export interface CrashHandlerHandle {
  /** True when THIS call installed the handlers (false if already installed). */
  installed: boolean;
  /** Remove the listeners and clear the process guard. Idempotent. */
  uninstall(): void;
}

const NOOP_HANDLE: CrashHandlerHandle = { installed: false, uninstall() {} };

/** Max ms to wait for the synchronous crash flush before exiting. */
const FLUSH_BUDGET_MS = 2000;

/**
 * Install the process-global crash handlers. Idempotent per process via a
 * Symbol guard. `proc` defaults to the real `process` (seam for tests). Returns
 * a handle whose `uninstall()` removes the listeners and clears the guard.
 */
export function installCrashHandlers(
  hooks: CrashHandlerHooks,
  proc?: CrashProcessLike,
): CrashHandlerHandle {
  const p =
    proc ??
    ((globalThis as { process?: CrashProcessLike }).process as CrashProcessLike | undefined);
  if (!p || typeof p.on !== 'function') return NOOP_HANDLE;

  const tagged = p as CrashProcessLike & { [INSTALLED_FLAG]?: boolean };
  if (tagged[INSTALLED_FLAG]) return NOOP_HANDLE;

  const onUncaught = (...args: unknown[]): void => {
    const error = args[0];
    let shouldExit = false;
    try {
      hooks.captureFatal(error);
      // Replicate Node's default-exit behavior only when WE are the sole
      // uncaughtException listener (besides our own). If the app registered its
      // own handler, defer to it and do not force-exit.
      shouldExit = !appHasOwnUncaughtListener(p, onUncaught);
    } catch {
      shouldExit = false;
    }
    void flushThenMaybeExit(hooks, p, shouldExit, error);
  };

  const onUnhandled = (...args: unknown[]): void => {
    try {
      // The rejection reason is the first arg; the promise is the second.
      hooks.captureFatal(args[0]);
    } catch {
      /* fail-open */
    }
    // unhandledRejection does not exit by default — capture + flush, keep running.
    void hooks.flush().catch(() => {});
  };

  try {
    p.on('uncaughtException', onUncaught);
    p.on('unhandledRejection', onUnhandled);
    Object.defineProperty(p, INSTALLED_FLAG, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    return NOOP_HANDLE;
  }

  return {
    installed: true,
    uninstall(): void {
      try {
        p.removeListener?.('uncaughtException', onUncaught);
        p.removeListener?.('unhandledRejection', onUnhandled);
        try {
          delete tagged[INSTALLED_FLAG];
        } catch {
          /* ignore */
        }
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Whether the application registered its OWN uncaughtException listener (one
 * other than ours). When true we must not force-exit — Node will run the app's
 * handler and the app owns the exit decision.
 */
function appHasOwnUncaughtListener(p: CrashProcessLike, ours: (...a: unknown[]) => void): boolean {
  try {
    const list = p.listeners?.('uncaughtException') ?? [];
    for (const l of list) {
      if (l !== ours) return true;
    }
    return false;
  } catch {
    // If we can't introspect, be conservative and do NOT force-exit (avoid
    // killing a process the app might have wanted to keep alive).
    return true;
  }
}

/**
 * Flush within a bounded budget, then exit non-zero if we replicated Node's
 * default-crash behavior. The exit is deferred until the flush settles (or the
 * budget elapses) so the crash report has a chance to leave the process.
 */
async function flushThenMaybeExit(
  hooks: CrashHandlerHooks,
  p: CrashProcessLike,
  shouldExit: boolean,
  _error: unknown,
): Promise<void> {
  try {
    await Promise.race([
      hooks.flush(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, FLUSH_BUDGET_MS);
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    /* fail-open */
  }
  if (shouldExit) {
    try {
      // Match Node's default fatal-exit code.
      p.exitCode = 1;
      p.exit?.(1);
    } catch {
      /* best-effort */
    }
  }
}
