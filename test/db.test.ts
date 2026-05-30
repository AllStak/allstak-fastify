import { describe, expect, it, vi } from 'vitest';
import {
  DbInstrumentation,
  normalizeQuery,
  hashQuery,
  detectQueryType,
  allstakFastify,
} from '../src/index';

type Hook = (...args: any[]) => void;

function makeApp() {
  const hooks: Record<string, Hook> = {};
  return {
    app: { addHook: (name: string, fn: Hook) => { hooks[name] = fn; } },
    hooks,
  };
}

/** Captures every enqueueDb event. */
function fakeTransport() {
  const events: { path: string; payload: any }[] = [];
  return {
    transport: {
      enqueueDb: (ev: any) => events.push(ev),
      enqueueRequest: () => {},
      enqueueSpan: () => {},
      enqueueLog: () => {},
      isDisabled: () => false,
    },
    events,
  };
}

// ── pure helpers ──────────────────────────────────────────────────────────────

describe('db — pure helpers', () => {
  it('normalizeQuery strips string + numeric literals and comments', () => {
    expect(normalizeQuery("SELECT * FROM users WHERE id = 42 AND name = 'bob' -- c"))
      .toBe('SELECT * FROM users WHERE id = ? AND name = ?');
  });
  it('normalizeQuery preserves quoted identifiers', () => {
    expect(normalizeQuery('SELECT "id" FROM "public"."Task"')).toBe('SELECT "id" FROM "public"."Task"');
  });
  it('hashQuery is stable + deterministic', () => {
    const a = hashQuery('SELECT ?');
    expect(a).toBe(hashQuery('SELECT ?'));
    expect(a).not.toBe(hashQuery('INSERT ?'));
  });
  it('detectQueryType reads the leading verb', () => {
    expect(detectQueryType('select 1')).toBe('SELECT');
    expect(detectQueryType('WITH x AS (..) SELECT')).toBe('OTHER');
  });
});

// ── pg ──────────────────────────────────────────────────────────────────────

describe('DbInstrumentation — pg', () => {
  it('captures a successful promise query with normalized SQL + trace ctx', async () => {
    const { transport, events } = fakeTransport();
    const calls: unknown[][] = [];
    const fakePg = {
      Client: {
        prototype: {
          query(this: { database?: string }, ...args: unknown[]) {
            calls.push(args);
            return Promise.resolve({ rowCount: 3 });
          },
        },
      },
    };
    const db = new DbInstrumentation({
      transport,
      moduleResolver: (id) => (id === 'pg' ? fakePg : null),
      getTraceContext: () => ({ traceId: 't1', spanId: 's1' }),
      service: 'svc',
      environment: 'test',
      now: () => 1000,
      flushIntervalMs: 0,
      batchSize: 1, // flush immediately
    });
    expect(db.install()).toBe(true);

    const client = Object.create(fakePg.Client.prototype) as { database?: string; query: Function };
    client.database = 'maindb';
    const res = await client.query("SELECT * FROM t WHERE id = 7 AND s = 'x'");
    expect(res).toEqual({ rowCount: 3 });
    // Original was still invoked.
    expect(calls).toHaveLength(1);

    expect(events).toHaveLength(1);
    const row = events[0].payload.queries[0];
    expect(events[0].path).toBe('/ingest/v1/db');
    expect(row.normalizedQuery).toBe('SELECT * FROM t WHERE id = ? AND s = ?');
    expect(row.queryType).toBe('SELECT');
    expect(row.status).toBe('success');
    expect(row.databaseType).toBe('postgresql');
    expect(row.databaseName).toBe('maindb');
    expect(row.rowsAffected).toBe(3);
    expect(row.traceId).toBe('t1');
    expect(row.spanId).toBe('s1');
    expect(row.service).toBe('svc');
    expect(row.environment).toBe('test');
  });

  it('captures a rejected promise query as status=error and rethrows', async () => {
    const { transport, events } = fakeTransport();
    const fakePg = {
      Client: {
        prototype: {
          query() { return Promise.reject(new Error('boom-db')); },
        },
      },
    };
    const db = new DbInstrumentation({
      transport,
      moduleResolver: (id) => (id === 'pg' ? fakePg : null),
      batchSize: 1,
    });
    db.install();
    const client = Object.create(fakePg.Client.prototype) as { query: Function };
    await expect(client.query('DELETE FROM t')).rejects.toThrow('boom-db');
    expect(events[0].payload.queries[0].status).toBe('error');
    expect(events[0].payload.queries[0].errorMessage).toBe('boom-db');
    expect(events[0].payload.queries[0].queryType).toBe('DELETE');
  });

  it('captures the callback signature', async () => {
    const { transport, events } = fakeTransport();
    const fakePg = {
      Client: {
        prototype: {
          query(this: unknown, _sql: string, cb: (e: Error | null, r?: any) => void) {
            cb(null, { rowCount: 5 });
            return undefined;
          },
        },
      },
    };
    const db = new DbInstrumentation({
      transport,
      moduleResolver: (id) => (id === 'pg' ? fakePg : null),
      batchSize: 1,
    });
    db.install();
    const client = Object.create(fakePg.Client.prototype) as { query: Function };
    await new Promise<void>((resolve) => {
      client.query('INSERT INTO t VALUES (1)', (_e: Error | null, r: any) => {
        expect(r.rowCount).toBe(5);
        resolve();
      });
    });
    expect(events[0].payload.queries[0].status).toBe('success');
    expect(events[0].payload.queries[0].rowsAffected).toBe(5);
    expect(events[0].payload.queries[0].queryType).toBe('INSERT');
  });

  it('fail-open: a capture error never breaks the host query (disabled transport)', async () => {
    const fakePg = {
      Client: { prototype: { query() { return Promise.resolve({ rowCount: 1 }); } } },
    };
    const events: any[] = [];
    const db = new DbInstrumentation({
      transport: { enqueueDb: (e: any) => events.push(e), isDisabled: () => true },
      moduleResolver: (id) => (id === 'pg' ? fakePg : null),
      batchSize: 1,
    });
    db.install();
    const client = Object.create(fakePg.Client.prototype) as { query: Function };
    await expect(client.query('SELECT 1')).resolves.toEqual({ rowCount: 1 });
    expect(events).toHaveLength(0); // disabled transport ⇒ nothing captured
  });

  it('is idempotent — a second install does not double-wrap', async () => {
    const { transport, events } = fakeTransport();
    const fakePg = {
      Client: { prototype: { query() { return Promise.resolve({ rowCount: 1 }); } } },
    };
    const mk = () =>
      new DbInstrumentation({
        transport,
        moduleResolver: (id) => (id === 'pg' ? fakePg : null),
        batchSize: 1,
      });
    mk().install();
    mk().install(); // second registration, same prototype
    const client = Object.create(fakePg.Client.prototype) as { query: Function };
    await client.query('SELECT 1');
    // Exactly one db row despite two installs.
    expect(events.flatMap((e) => e.payload.queries)).toHaveLength(1);
  });

  it('install() returns false when no driver resolves', () => {
    const { transport } = fakeTransport();
    const db = new DbInstrumentation({ transport, moduleResolver: () => null });
    expect(db.install()).toBe(false);
    expect(db.isInstalled()).toBe(true); // installed=true even with nothing patched
  });
});

// ── better-sqlite3 ────────────────────────────────────────────────────────────

describe('DbInstrumentation — better-sqlite3', () => {
  it('captures prepared-statement run() with rows from changes', () => {
    const { transport, events } = fakeTransport();
    const stmt = { run: (..._a: unknown[]) => ({ changes: 2 }) };
    const fakeBetter = {
      prototype: {
        name: 'app.db',
        prepare(_sql: string) { return { ...stmt }; },
        exec(_sql: string) { return undefined; },
      },
    };
    const db = new DbInstrumentation({
      transport,
      moduleResolver: (id) => (id === 'better-sqlite3' ? fakeBetter : null),
      batchSize: 1,
    });
    db.install();
    const conn = Object.create(fakeBetter.prototype) as { prepare: Function };
    const prepared = conn.prepare('INSERT INTO t VALUES (?)') as { run: Function };
    const r = prepared.run(1) as { changes: number };
    expect(r.changes).toBe(2);
    expect(events[0].payload.queries[0]).toMatchObject({
      databaseType: 'sqlite',
      status: 'success',
      rowsAffected: 2,
      queryType: 'INSERT',
    });
  });
});

// ── plugin integration ────────────────────────────────────────────────────────

describe('@allstak/fastify plugin — DB auto-instrumentation', () => {
  it('wires DB capture on register when dbModuleResolver is provided (test opt-in)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const { app, hooks } = makeApp();
    const fakePg = {
      Client: { prototype: { query() { return Promise.resolve({ rowCount: 1 }); } } },
    };
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
      dbModuleResolver: (id) => (id === 'pg' ? fakePg : null),
    });
    // onReady triggers the auto-instrument path's lifecycle hooks (already
    // installed at register). Exercise a query.
    const client = Object.create(fakePg.Client.prototype) as { query: Function };
    await client.query('SELECT 1');
    // Force a flush via onClose teardown.
    await new Promise<void>((resolve) => hooks.onClose?.({}, () => resolve()));
    await vi.waitFor(() => {
      const dbCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/ingest/v1/db'));
      expect(dbCall, 'db ingest call expected').toBeTruthy();
    });
    const dbCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/ingest/v1/db'))!;
    const body = JSON.parse((dbCall[1] as any).body);
    expect(body.queries[0].normalizedQuery).toBe('SELECT ?');
  });
});
