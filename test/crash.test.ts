import { describe, expect, it, vi } from 'vitest';
import { installCrashHandlers, type CrashProcessLike } from '../src/index';

/** A fake process that records listeners and exit calls (no real listeners). */
function fakeProcess() {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  let exitCode: number | undefined;
  const calls: { exit?: number } = {};
  const proc: CrashProcessLike = {
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return proc;
    },
    removeListener(event, listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      return proc;
    },
    listeners(event) {
      return listeners[event] ?? [];
    },
    listenerCount(event) {
      return (listeners[event] ?? []).length;
    },
    exit(code) {
      calls.exit = code;
    },
    get exitCode() {
      return exitCode;
    },
    set exitCode(c: number | undefined) {
      exitCode = c;
    },
  };
  return { proc, listeners, calls, get exitCode() { return exitCode; } };
}

describe('installCrashHandlers', () => {
  it('captures an uncaughtException at fatal level, flushes, and exits when sole listener', async () => {
    const { proc, listeners, calls } = fakeProcess();
    const captured: unknown[] = [];
    let flushed = 0;
    const handle = installCrashHandlers(
      {
        captureFatal: (e) => captured.push(e),
        flush: async () => { flushed++; },
      },
      proc,
    );
    expect(handle.installed).toBe(true);
    expect(listeners.uncaughtException).toHaveLength(1);
    expect(listeners.unhandledRejection).toHaveLength(1);

    const err = new Error('fatal boom');
    listeners.uncaughtException[0](err);
    // capture is synchronous; flush + exit happen on the microtask chain.
    expect(captured).toEqual([err]);
    await vi.waitFor(() => expect(calls.exit).toBe(1));
    expect(flushed).toBe(1);
  });

  it('does NOT force-exit when the app has its own uncaughtException listener', async () => {
    const { proc, listeners, calls } = fakeProcess();
    // Simulate an app-owned listener registered BEFORE ours.
    proc.on('uncaughtException', () => {});
    const captured: unknown[] = [];
    installCrashHandlers(
      { captureFatal: (e) => captured.push(e), flush: async () => {} },
      proc,
    );
    const err = new Error('app handles this');
    // Our listener is the 2nd registered.
    listeners.uncaughtException[1](err);
    expect(captured).toEqual([err]);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.exit).toBeUndefined();
  });

  it('captures unhandledRejection but never exits', async () => {
    const { proc, listeners, calls } = fakeProcess();
    const captured: unknown[] = [];
    let flushed = 0;
    installCrashHandlers(
      { captureFatal: (e) => captured.push(e), flush: async () => { flushed++; } },
      proc,
    );
    const reason = new Error('rejected');
    listeners.unhandledRejection[0](reason, Promise.resolve());
    expect(captured).toEqual([reason]);
    await vi.waitFor(() => expect(flushed).toBe(1));
    expect(calls.exit).toBeUndefined();
  });

  it('is idempotent per process — a second install is a no-op', () => {
    const { proc, listeners } = fakeProcess();
    const h1 = installCrashHandlers({ captureFatal: () => {}, flush: async () => {} }, proc);
    const h2 = installCrashHandlers({ captureFatal: () => {}, flush: async () => {} }, proc);
    expect(h1.installed).toBe(true);
    expect(h2.installed).toBe(false);
    expect(listeners.uncaughtException).toHaveLength(1);
    h1.uninstall();
    // After uninstall a fresh install works again.
    const h3 = installCrashHandlers({ captureFatal: () => {}, flush: async () => {} }, proc);
    expect(h3.installed).toBe(true);
  });

  it('uninstall removes the listeners', () => {
    const { proc, listeners } = fakeProcess();
    const handle = installCrashHandlers({ captureFatal: () => {}, flush: async () => {} }, proc);
    handle.uninstall();
    expect(listeners.uncaughtException).toHaveLength(0);
    expect(listeners.unhandledRejection).toHaveLength(0);
  });

  it('a throw inside captureFatal does not prevent flushing / never rethrows', async () => {
    const { proc, listeners } = fakeProcess();
    let flushed = 0;
    installCrashHandlers(
      { captureFatal: () => { throw new Error('capture failed'); }, flush: async () => { flushed++; } },
      proc,
    );
    expect(() => listeners.uncaughtException[0](new Error('x'))).not.toThrow();
    await vi.waitFor(() => expect(flushed).toBe(1));
  });

  it('no-ops gracefully on a process without .on', () => {
    const handle = installCrashHandlers(
      { captureFatal: () => {}, flush: async () => {} },
      {} as CrashProcessLike,
    );
    expect(handle.installed).toBe(false);
  });
});
