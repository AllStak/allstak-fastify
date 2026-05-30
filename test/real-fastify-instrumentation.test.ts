/**
 * Real-framework validation of the auto-instrumentation features against an
 * actual Fastify v4 instance: the pino log bridge, DB capture, and auto
 * breadcrumbs. Mirrors real-fastify.test.ts's harness (fastify.inject()).
 */
import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import allstakFastify from '../src/index';

function captureFetch() {
  const calls: { url: string; body: any }[] = [];
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 202 } as any;
  });
  vi.stubGlobal('fetch', spy);
  return { calls, spy };
}

const fakePg = {
  Client: {
    prototype: {
      query(this: { database?: string }) {
        return Promise.resolve({ rowCount: 1 });
      },
    },
  },
};

describe('@allstak/fastify auto-instrumentation against real Fastify v4', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('bridges the real pino logger to /ingest/v1/logs and stamps the request trace id', async () => {
    const { calls } = captureFetch();
    const app: FastifyInstance = Fastify({ logger: true });
    await app.register(allstakFastify, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      environment: 'test',
      release: 'fastify-inst@1.0.0',
      serviceName: 'fastify-inst',
      flushIntervalMs: 0,
      enableLogBridge: true,
      // keep the rest of the heavy auto features off for a focused test
      enableAutoSessionTracking: false,
      enableCrashHandlers: false,
      enableDbInstrumentation: false,
      captureOutboundHttp: false,
    });
    app.get('/log', async (req) => {
      req.log.error({ orderId: 7 }, 'order failed');
      return { ok: true };
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/log' });
      expect(res.statusCode).toBe(200);
      // Fastify auto-logs 'incoming request' / 'request completed' at info via
      // the same request child logger — proving the child wrap works — so we
      // locate the explicit error log we emitted.
      await vi.waitFor(() => {
        expect(
          calls.find((c) => c.url.endsWith('/ingest/v1/logs') && c.body.level === 'error'),
        ).toBeTruthy();
      }, { timeout: 1000 });
      const logCall = calls.find(
        (c) => c.url.endsWith('/ingest/v1/logs') && c.body.level === 'error',
      )!;
      expect(logCall.body.message).toBe('order failed');
      expect(logCall.body.metadata.orderId).toBe(7);
      // Trace id is stamped from the active request context (request-child logger).
      expect(logCall.body.traceId).toMatch(/^[0-9a-f]{32}$/);
      // The auto 'incoming request' info log was also bridged via the child.
      expect(
        calls.some((c) => c.url.endsWith('/ingest/v1/logs') && c.body.level === 'info'),
      ).toBe(true);
    } finally { await app.close(); }
  });

  it('produces /ingest/v1/db rows automatically from a query inside a handler', async () => {
    const { calls } = captureFetch();
    const app: FastifyInstance = Fastify({ logger: false });
    await app.register(allstakFastify, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      serviceName: 'fastify-db',
      dbModuleResolver: (id: string) => (id === 'pg' ? fakePg : null),
      enableAutoSessionTracking: false,
      enableCrashHandlers: false,
      enableLogBridge: false,
      captureOutboundHttp: false,
    });
    app.get('/db', async () => {
      const client = Object.create(fakePg.Client.prototype) as { query: Function };
      await client.query("SELECT * FROM orders WHERE id = 7");
      return { ok: true };
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/db' });
      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(calls.find((c) => c.url.endsWith('/ingest/v1/db'))).toBeTruthy();
      }, { timeout: 1000 });
      const dbCall = calls.find((c) => c.url.endsWith('/ingest/v1/db'))!;
      const row = dbCall.body.queries[0];
      expect(row.normalizedQuery).toBe('SELECT * FROM orders WHERE id = ?');
      expect(row.databaseType).toBe('postgresql');
      // The query ran inside a request ⇒ trace id propagated to the db row.
      expect(row.traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally { await app.close(); }
  });
});
