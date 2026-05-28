import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allstakFastify, FastifyTransport, FileSpool, type SpoolFs } from '../src/index';

type Hook = (...args: any[]) => void;

function makeApp() {
  const hooks: Record<string, Hook> = {};
  return {
    app: { addHook: (name: string, fn: Hook) => { hooks[name] = fn; } },
    hooks,
  };
}

/**
 * In-memory fake of the small `node:fs` surface the spool uses. Deterministic
 * and side-effect-free so cap/eviction/age tests don't touch the real disk.
 */
function memFs(opts: { failMkdir?: boolean; failWrite?: boolean } = {}): SpoolFs & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  let clock = 1;
  return {
    files,
    mkdirSync() {
      if (opts.failMkdir) throw new Error('EROFS: read-only file system');
    },
    writeFileSync(path: string, data: string) {
      if (opts.failWrite) throw new Error('ENOSPC: no space left on device');
      files.set(path, data);
    },
    readFileSync(path: string) {
      const v = files.get(path);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    readdirSync(dir: string) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    },
    unlinkSync(path: string) {
      files.delete(path);
    },
    statSync(path: string) {
      const v = files.get(path);
      return { size: v ? Buffer.byteLength(v) : 0, mtimeMs: clock++ };
    },
  };
}

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'allstak-spool-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Captures every outbound ingest call; configurable response. */
function captureFetch(respond: (call: { url: string; n: number }) => any = () => ({ ok: true, status: 202 })) {
  const calls: { url: string; body: any }[] = [];
  let n = 0;
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return respond({ url: String(url), n: n++ }) as any;
  });
  return { calls, spy };
}

describe('FileSpool — bounded persistent store', () => {
  it('persist + load round-trips an envelope', () => {
    const fs = memFs();
    const spool = new FileSpool({ dir: '/spool', fs, now: () => 1000 });
    spool.persist('/ingest/v1/errors', { message: 'boom' });
    const loaded = spool.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].envelope.path).toBe('/ingest/v1/errors');
    expect(loaded[0].envelope.payload).toMatchObject({ message: 'boom' });
    expect(loaded[0].envelope.ts).toBe(1000);
  });

  it('scrubs the payload BEFORE persisting — no secret hits the store', () => {
    const fs = memFs();
    const spool = new FileSpool({ dir: '/spool', fs });
    spool.persist('/ingest/v1/errors', {
      message: 'login failed',
      metadata: { password: 'hunter2', authorization: 'Bearer SECRET', userId: 'u1' },
    });
    // Inspect the raw bytes on disk: the secrets must not be present.
    const raw = [...fs.files.values()].join('\n');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('SECRET');
    expect(raw).toContain('[REDACTED]');
    expect(raw).toContain('u1'); // non-sensitive data preserved
    const env = spool.load()[0].envelope;
    expect((env.payload.metadata as any).password).toBe('[REDACTED]');
    expect((env.payload.metadata as any).authorization).toBe('[REDACTED]');
    expect((env.payload.metadata as any).userId).toBe('u1');
  });

  it('cap by count drops the OLDEST first', () => {
    let t = 1000;
    const fs = memFs();
    const spool = new FileSpool({ dir: '/spool', fs, maxEntries: 3, now: () => t++ });
    for (let i = 0; i < 6; i++) spool.persist('/ingest/v1/errors', { i });
    const kept = spool.load().map((e) => (e.envelope.payload as any).i);
    expect(kept).toHaveLength(3);
    // Oldest (0,1,2) evicted; newest (3,4,5) retained, oldest-first.
    expect(kept).toEqual([3, 4, 5]);
  });

  it('cap by bytes drops the OLDEST first', () => {
    let t = 1000;
    const fs = memFs();
    // Each envelope is well over 50 bytes; cap keeps only the newest few.
    const spool = new FileSpool({ dir: '/spool', fs, maxBytes: 220, now: () => t++ });
    for (let i = 0; i < 8; i++) spool.persist('/ingest/v1/errors', { i, pad: 'xxxxxxxxxxxxxxxx' });
    const total = [...fs.files.values()].reduce((a, v) => a + Buffer.byteLength(v), 0);
    expect(total).toBeLessThanOrEqual(220);
    const kept = spool.load().map((e) => (e.envelope.payload as any).i);
    // Whatever survives must be a contiguous newest-suffix (oldest evicted).
    expect(kept[kept.length - 1]).toBe(7);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
  });

  it('drops entries older than maxAgeMs on load', () => {
    const fs = memFs();
    let now = 0;
    const spool = new FileSpool({ dir: '/spool', fs, maxAgeMs: 1000, now: () => now });
    spool.persist('/ingest/v1/errors', { tag: 'stale' });
    now = 5000; // advance well past maxAge
    spool.persist('/ingest/v1/errors', { tag: 'fresh' });
    const loaded = spool.load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0].envelope.payload as any).tag).toBe('fresh');
  });

  it('remove() deletes the file idempotently', () => {
    const fs = memFs();
    const spool = new FileSpool({ dir: '/spool', fs });
    spool.persist('/ingest/v1/errors', { a: 1 });
    expect(spool.count()).toBe(1);
    const { remove } = spool.load()[0];
    remove();
    remove(); // idempotent
    expect(spool.count()).toBe(0);
  });

  it('degrades to a silent no-op when the dir is unwritable (read-only FS)', () => {
    const fs = memFs({ failMkdir: true });
    const spool = new FileSpool({ dir: '/spool', fs });
    expect(spool.isEnabled()).toBe(false);
    expect(() => spool.persist('/ingest/v1/errors', { a: 1 })).not.toThrow();
    expect(spool.load()).toEqual([]);
    expect(spool.count()).toBe(0);
    expect(fs.files.size).toBe(0);
  });

  it('a write failure mid-run never throws (disk full)', () => {
    const fs = memFs({ failWrite: true });
    const spool = new FileSpool({ dir: '/spool', fs });
    expect(spool.isEnabled()).toBe(true); // mkdir succeeded
    expect(() => spool.persist('/ingest/v1/errors', { a: 1 })).not.toThrow();
    expect(spool.count()).toBe(0);
  });

  it('drops unparseable files on load', () => {
    const fs = memFs();
    const spool = new FileSpool({ dir: '/spool', fs, now: () => 1 });
    spool.persist('/ingest/v1/errors', { ok: true });
    // Corrupt a file in place.
    const key = [...fs.files.keys()][0];
    fs.files.set(key, '{ not json');
    expect(spool.load()).toEqual([]);
    expect(spool.count()).toBe(0); // corrupt file was removed
  });

  it('works against a real filesystem dir', () => {
    const dir = freshDir();
    const spool = new FileSpool({ dir });
    expect(spool.isEnabled()).toBe(true);
    spool.persist('/ingest/v1/errors', { message: 'real', secret: 'topsecret' });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(dir, files[0]), 'utf8');
    expect(raw).not.toContain('topsecret');
    expect(JSON.parse(raw).payload.message).toBe('real');
  });
});

describe('@allstak/fastify — offline/persistent queue integration', () => {
  it('persists an error on a network outage (retries exhausted), then drains it on the next init', async () => {
    const dir = freshDir();
    // First boot: the network is DOWN — every POST rejects.
    const down = captureFetch();
    down.spy.mockRejectedValue(new Error('ECONNREFUSED'));
    const t1 = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: down.spy as unknown as typeof fetch,
    });
    expect(t1.isOfflineQueueEnabled()).toBe(true);
    t1.sendNow({ path: '/ingest/v1/errors', payload: { message: 'offline-boom' } });
    await vi.waitFor(() => expect(t1.stats().persisted).toBe(1));
    expect(readdirSync(dir)).toHaveLength(1);

    // Second boot: the network is back UP. Drain replays the persisted error.
    const up = captureFetch();
    const t2 = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      flushIntervalMs: 0,
      fetch: up.spy as unknown as typeof fetch,
    });
    await t2.drainSpool();
    const replay = up.calls.find((c) => c.url.endsWith('/ingest/v1/errors'));
    expect(replay).toBeTruthy();
    expect(replay!.body.message).toBe('offline-boom');
    // Accepted ⇒ the file is removed from the store.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('scrubs before persisting — no secret reaches disk via the transport', async () => {
    const dir = freshDir();
    const down = captureFetch();
    down.spy.mockRejectedValue(new Error('offline'));
    const t = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: down.spy as unknown as typeof fetch,
    });
    t.sendNow({
      path: '/ingest/v1/errors',
      payload: { message: 'm', metadata: { password: 'hunter2', token: 'abc123' } },
    });
    await vi.waitFor(() => expect(t.stats().persisted).toBe(1));
    const files = readdirSync(dir);
    const raw = readFileSync(join(dir, files[0]), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('abc123');
    expect(raw).toContain('[REDACTED]');
  });

  it('does NOT persist session lifecycle calls on failure', async () => {
    const dir = freshDir();
    const down = captureFetch();
    down.spy.mockRejectedValue(new Error('offline'));
    const t = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: down.spy as unknown as typeof fetch,
    });
    t.sendNow({ path: '/ingest/v1/sessions/start', payload: { sessionId: 's1' } });
    t.sendNow({ path: '/ingest/v1/sessions/end', payload: { sessionId: 's1', status: 'ok' } });
    await vi.waitFor(() => expect(down.spy.mock.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.stats().persisted).toBe(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('does NOT replay a 4xx-other-than-429 (permanently undeliverable) — removed from store', async () => {
    const dir = freshDir();
    const down = captureFetch();
    down.spy.mockRejectedValue(new Error('offline'));
    const t1 = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: down.spy as unknown as typeof fetch,
    });
    t1.sendNow({ path: '/ingest/v1/errors', payload: { message: 'bad' } });
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1));

    // On replay the server returns 400 — bad data, drop it (don't loop forever).
    const reject400 = captureFetch(() => ({ ok: false, status: 400 }));
    const t2 = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: reject400.spy as unknown as typeof fetch,
    });
    await t2.drainSpool();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('keeps a persisted event on a transient (5xx) replay failure for the next drain', async () => {
    const dir = freshDir();
    const down = captureFetch();
    down.spy.mockRejectedValue(new Error('offline'));
    const t1 = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: down.spy as unknown as typeof fetch,
    });
    t1.sendNow({ path: '/ingest/v1/errors', payload: { message: 'still-down' } });
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1));

    // Still down on replay (503) — must NOT be removed.
    const reject503 = captureFetch(() => ({ ok: false, status: 503, headers: { get: () => null } }));
    const t2 = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: reject503.spy as unknown as typeof fetch,
    });
    await t2.drainSpool();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('opt-out: enableOfflineQueue=false disables persistence entirely', async () => {
    const dir = freshDir();
    const down = captureFetch();
    down.spy.mockRejectedValue(new Error('offline'));
    const t = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: false,
      offlineQueueDir: dir,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: down.spy as unknown as typeof fetch,
    });
    expect(t.isOfflineQueueEnabled()).toBe(false);
    t.sendNow({ path: '/ingest/v1/errors', payload: { message: 'lost' } });
    await vi.waitFor(() => expect(down.spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(t.stats().persisted).toBe(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('defaults to disabled under the unit-test runtime when the flag is unset', () => {
    const t = new FastifyTransport({ apiKey: 'ask_dev_test', flushIntervalMs: 0 });
    expect(t.isOfflineQueueEnabled()).toBe(false);
  });

  it('graceful no-op when the spool dir is unwritable (injected fs)', async () => {
    const fs = memFs({ failMkdir: true });
    const down = captureFetch();
    down.spy.mockRejectedValue(new Error('offline'));
    const t = new FastifyTransport({
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true,
      offlineQueueDir: '/read-only',
      offlineQueueFs: fs,
      maxRetries: 0,
      flushIntervalMs: 0,
      fetch: down.spy as unknown as typeof fetch,
    });
    expect(t.isOfflineQueueEnabled()).toBe(false);
    expect(() => t.sendNow({ path: '/ingest/v1/errors', payload: { x: 1 } })).not.toThrow();
    await vi.waitFor(() => expect(down.spy).toHaveBeenCalled());
    expect(fs.files.size).toBe(0);
    expect(t.stats().persisted).toBe(0);
  });

  it('plugin wires an onReady drain when the offline queue is enabled', async () => {
    const dir = freshDir();
    // Seed a previous run's persisted error directly.
    const seed = new FileSpool({ dir });
    seed.persist('/ingest/v1/errors', { message: 'from-last-run' });
    expect(readdirSync(dir)).toHaveLength(1);

    const up = captureFetch();
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      enableOfflineQueue: true, // explicit opt-in under the test runtime
      offlineQueueDir: dir,
      flushIntervalMs: 0,
      fetch: up.spy as unknown as typeof fetch,
    });
    expect(typeof hooks.onReady).toBe('function');
    hooks.onReady(() => {});
    await vi.waitFor(() => expect(up.calls.some((c) => c.url.endsWith('/ingest/v1/errors'))).toBe(true));
    const replay = up.calls.find((c) => c.url.endsWith('/ingest/v1/errors'))!;
    expect(replay.body.message).toBe('from-last-run');
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(0));
  });
});
