/**
 * Real-framework validation for @allstak/fastify.
 *
 * Boots an actual Fastify v4 instance via `fastify.inject()` and asserts the
 * SDK's externally-observable behavior end-to-end:
 *   - inbound traceparent is honored on the response
 *   - response carries x-allstak-trace-id / x-allstak-request-id / traceparent
 *   - successful responses produce an ingest /http-requests payload
 *   - thrown handler errors produce an ingest /errors payload AND the
 *     customer's 500 response is preserved
 *   - registering the plugin twice on the same app does not double-fire hooks
 *   - ingest outage (rejected fetch) does not break customer responses
 */
import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import allstakFastify, { allstakFastify as namedExport } from '../src/index';

interface IngestCall {
  url: string;
  body: any;
}

function captureFetch(): { calls: IngestCall[]; spy: ReturnType<typeof vi.fn> } {
  const calls: IngestCall[] = [];
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200 } as any;
  });
  vi.stubGlobal('fetch', spy);
  return { calls, spy };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // With fastify-plugin wrapping, app.register() hooks apply globally (no
  // encapsulated child context) — the standard Fastify registration pattern.
  await app.register(allstakFastify, {
    apiKey: 'ask_dev_test',
    host: 'https://api.allstak.sa',
    environment: 'test',
    release: 'fastify-validation@1.0.0',
    serviceName: 'fastify-validation',
    flushIntervalMs: 0, // synchronous dispatch in tests
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/boom', async () => { throw new Error('intentional boom'); });
  app.get('/echo', async (req) => ({ traceId: (req as any).allstakTraceId }));
  return app;
}

describe('@allstak/fastify against real Fastify v4', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('happy path: response carries correlation headers and emits ingest payload', async () => {
    const { calls } = captureFetch();
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-allstak-trace-id']).toMatch(/^[0-9a-f]{32}$/);
      expect(res.headers['x-allstak-request-id']).toBeTruthy();
      expect(String(res.headers.traceparent)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(String(res.headers['allstak-baggage'])).toContain(`allstak-trace_id=${res.headers['x-allstak-trace-id']}`);
      expect(String(res.headers.baggage)).toContain(`allstak-request_id=${res.headers['x-allstak-request-id']}`);

      // Wait for the fire-and-forget send() to land.
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 500 });
      const httpReq = calls.find((c) => c.url.endsWith('/ingest/v1/http-requests'));
      expect(httpReq, 'http-requests payload must be emitted').toBeTruthy();
      const row = httpReq!.body.requests[0];
      expect(row.path).toBe('/health');
      expect(row.method).toBe('GET');
      expect(row.statusCode).toBe(200);
      expect(row.traceId).toBe(res.headers['x-allstak-trace-id']);
      expect(row.requestId).toBe(res.headers['x-allstak-request-id']);
      expect(row.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(row.metadata.requestId).toBeUndefined();
      const spanReq = calls.find((c) => c.url.endsWith('/ingest/v1/spans'));
      expect(spanReq, 'span payload must be emitted').toBeTruthy();
      expect(spanReq!.body.spans[0]).toMatchObject({
        traceId: res.headers['x-allstak-trace-id'],
        operation: 'fastify.request',
        description: 'GET /health',
        status: 'ok',
      });
    } finally { await app.close(); }
  });

  it('honors inbound traceparent and propagates the same trace id back', async () => {
    captureFetch();
    const app = await buildApp();
    try {
      const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const res = await app.inject({
        method: 'GET',
        url: '/echo',
        headers: {
          traceparent: `00-${traceId}-bbbbbbbbbbbbbbbb-01`,
          'x-allstak-request-id': 'req-from-upstream',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-allstak-trace-id']).toBe(traceId);
      expect(res.headers['x-allstak-request-id']).toBe('req-from-upstream');
      expect(JSON.parse(res.body).traceId).toBe(traceId);
    } finally { await app.close(); }
  });

  it('thrown handler errors produce an ingest /errors payload and a 500 response', async () => {
    const { calls } = captureFetch();
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(500);
      await vi.waitFor(() => {
        const err = calls.find((c) => c.url.endsWith('/ingest/v1/errors'));
        expect(err, `expected /errors among: ${calls.map((c) => c.url).join(', ')}`).toBeTruthy();
      }, { timeout: 500 });
      const errCall = calls.find((c) => c.url.endsWith('/ingest/v1/errors'))!;
      expect(errCall.body.message).toBe('intentional boom');
      expect(errCall.body.metadata.httpPath).toBe('/boom');
      expect(errCall.body.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(errCall.body.requestId).toMatch(/^[0-9a-f]{32}$|^req-/);
      expect(errCall.body.spanId).toMatch(/^[0-9a-f]{16}$/);
    } finally { await app.close(); }
  });

  it('ingest outage does not break customer responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS failure')));
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    } finally { await app.close(); }
  });

  it('registering the plugin twice on the same instance is a no-op the second time', async () => {
    const { calls } = captureFetch();
    const app = Fastify({ logger: false });
    try {
      // Both registrations target the SAME underlying Fastify instance.
      // The plugin must be idempotent and not double-emit.
      // Use the named export to also verify backward-compat direct-call style.
      namedExport(app, { apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', flushIntervalMs: 0 });
      namedExport(app, { apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', flushIntervalMs: 0 });
      namedExport(app, { apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', flushIntervalMs: 0 });
      app.get('/x', async () => 'ok');

      const res = await app.inject({ method: 'GET', url: '/x' });
      expect(res.statusCode).toBe(200);
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 500 });
      const httpReqs = calls.filter((c) => c.url.endsWith('/ingest/v1/http-requests'));
      const spanReqs = calls.filter((c) => c.url.endsWith('/ingest/v1/spans'));
      expect(httpReqs).toHaveLength(1);
      expect(spanReqs).toHaveLength(1);
    } finally { await app.close(); }
  });
});
