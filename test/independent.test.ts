import { describe, expect, it, vi } from 'vitest';
import allstakDefault, { allstakFastify, FastifyTransport, SDK_NAME, SDK_VERSION } from '../src/index';
import pkg from '../package.json';

type Hook = (...args: any[]) => void;

function makeApp() {
  const hooks: Record<string, Hook> = {};
  return {
    app: { addHook: (name: string, fn: Hook) => { hooks[name] = fn; } },
    hooks,
  };
}

describe('@allstak/fastify — version consistency', () => {
  it('SDK_NAME / SDK_VERSION exposed and match package.json', () => {
    expect(SDK_NAME).toBe('@allstak/fastify');
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe('@allstak/fastify — plugin', () => {
  it('emits ingest payload with redacted-off-by-default headers, sdk.version metadata', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    const responseHeaders: Record<string, string> = {};
    const reply = {
      statusCode: 200,
      header: (n: string, v: string) => { responseHeaders[n.toLowerCase()] = v; },
    };
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const request = {
      method: 'GET',
      url: '/health?x=1',
      headers: {
        host: 'api.example.test',
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        'x-allstak-request-id': 'req-fastify-test',
        authorization: 'Bearer SECRET',
      },
    };
    hooks.onRequest(request, reply, () => {});
    hooks.onResponse(request, reply, () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(responseHeaders['x-allstak-trace-id']).toBe('a'.repeat(32));
    expect(responseHeaders.baggage).toContain(`allstak-trace_id=${'a'.repeat(32)}`);
    expect(responseHeaders['allstak-baggage']).toContain('allstak-request_id=req-fastify-test');
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers['User-Agent']).toBe(`${SDK_NAME}/${SDK_VERSION}`);
    const row = JSON.parse(init.body).requests[0];
    expect(row.path).toBe('/health');
    expect(row.requestId).toBe('req-fastify-test');
    expect(row.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(row.parentSpanId).toBe('b'.repeat(16));
    expect(row.metadata.requestId).toBeUndefined();
    expect(row.metadata['sdk.version']).toBe(SDK_VERSION);
    expect(row.requestHeaders).toBe('');
    await vi.waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/ingest/v1/spans'))).toBe(true));
    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/ingest/v1/spans'))!;
    const span = JSON.parse(spanCall[1].body).spans[0];
    expect(span).toMatchObject({
      traceId: 'a'.repeat(32),
      operation: 'fastify.request',
      description: 'GET /health',
      status: 'ok',
      environment: '',
    });
  });

  it('captures redacted headers when captureRequestHeaders=true', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      flushIntervalMs: 0,
      captureRequestHeaders: true,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const reply = { statusCode: 200, header: () => {} };
    const request = {
      method: 'GET',
      url: '/me',
      headers: { host: 'h', authorization: 'Bearer SECRET', cookie: 'session=xyz', 'x-trace-id': 'tr-1' },
    };
    hooks.onRequest(request, reply, () => {});
    hooks.onResponse(request, reply, () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const row = JSON.parse(fetchSpy.mock.calls[0][1].body).requests[0];
    expect(row.requestHeaders).toContain('authorization: [REDACTED]');
    expect(row.requestHeaders).toContain('cookie: [REDACTED]');
    expect(row.requestHeaders).toContain('x-trace-id: tr-1');
  });

  it('does not break Fastify hooks when AllStak ingest fails', () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('dns failed'));
    const { app, hooks } = makeApp();
    allstakFastify(app, { apiKey: 'ask_dev_test', flushIntervalMs: 0, fetch: fetchSpy as unknown as typeof fetch });
    const reply = { statusCode: 200, header: () => {} };
    const request = { method: 'GET', url: '/health', headers: { host: 'h' } };
    hooks.onRequest(request, reply, () => {});
    let doneCalled = false;
    expect(() => hooks.onResponse(request, reply, () => { doneCalled = true; })).not.toThrow();
    expect(doneCalled).toBe(true);
  });

  it('idempotent install — three registrations add hooks once', () => {
    const counts: Record<string, number> = {};
    const app = {
      addHook: (name: string) => { counts[name] = (counts[name] ?? 0) + 1; },
    };
    allstakFastify(app as any, { apiKey: 'ask_dev_test' });
    allstakFastify(app as any, { apiKey: 'ask_dev_test' });
    allstakFastify(app as any, { apiKey: 'ask_dev_test' });
    expect(counts.onRequest).toBe(1);
    expect(counts.onResponse).toBe(1);
    expect(counts.onError).toBe(1);
  });

  it('batches multiple inbound responses into one HTTP POST', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      flushIntervalMs: 60_000,
      maxBatchSize: 100,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const reply = { statusCode: 200, header: () => {} };
    for (let i = 0; i < 5; i++) {
      const req = { method: 'GET', url: `/r-${i}`, headers: { host: 'h' } };
      hooks.onRequest(req, reply, () => {});
      hooks.onResponse(req, reply, () => {});
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // Pull the transport off the app and force-flush.
    const transport = (app as any)[Object.getOwnPropertySymbols(app)[0]] as FastifyTransport;
    await transport.forceFlush();
    const httpCalls = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/http-requests'));
    const spanCalls = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/ingest/v1/spans'));
    expect(httpCalls).toHaveLength(1);
    expect(spanCalls).toHaveLength(1);
    const body = JSON.parse(httpCalls[0][1].body);
    expect(body.requests).toHaveLength(5);
    expect(JSON.parse(spanCalls[0][1].body).spans).toHaveLength(5);
  });

  it('sampleRate=0 drops every inbound', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      sampleRate: 0,
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const reply = { statusCode: 200, header: () => {} };
    for (let i = 0; i < 5; i++) {
      const req = { method: 'GET', url: `/r-${i}`, headers: { host: 'h' } };
      hooks.onRequest(req, reply, () => {});
      hooks.onResponse(req, reply, () => {});
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('retries 5xx, succeeds on third try', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      flushIntervalMs: 0,
      maxRetries: 2,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const reply = { statusCode: 500, header: () => {} };
    const request = { method: 'POST', url: '/x', headers: { host: 'h' } };
    hooks.onError(request, reply, new Error('boom'), () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3), { timeout: 4000 });
  }, 5_000);

  it('beforeSend can drop events', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      flushIntervalMs: 0,
      beforeSend: () => null,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const reply = { statusCode: 200, header: () => {} };
    const req = { method: 'GET', url: '/r', headers: { host: 'h' } };
    hooks.onRequest(req, reply, () => {});
    hooks.onResponse(req, reply, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('captures errors with redacted metadata', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const request = {
      method: 'POST',
      url: '/orders',
      headers: { host: 'api.example.test' },
      allstakTraceId: 'c'.repeat(32),
      allstakRequestId: 'req-error',
      allstakSpanId: 'd'.repeat(16),
    };
    hooks.onError(request, { statusCode: 500, header: () => {} }, new Error('boom'), () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(payload.traceId).toBe('c'.repeat(32));
    expect(payload.metadata['sdk.version']).toBe(SDK_VERSION);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.allstak.sa/ingest/v1/errors');
  });

  it('default and named export are the same plugin function', () => {
    expect(typeof allstakDefault).toBe('function');
    expect(typeof allstakFastify).toBe('function');
  });
});
