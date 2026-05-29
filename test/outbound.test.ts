/**
 * Outbound (egress) HTTP instrumentation tests for @allstak/fastify.
 *
 *   - pure helpers (origin parse / ingest-host skip / header presence / path)
 *   - the OutboundInstrumentation class driven by a FAKE diagnostics_channel:
 *       · injects W3C traceparent + baggage + correlation headers on create
 *       · continues the active request's trace context (ALS) as the parent span
 *       · emits an outbound http-request row + an http.client span on headers
 *       · marks the span errored on a transport error / 5xx
 *       · skips the SDK's own ingest host (no feedback loop)
 *       · never clobbers a traceparent a higher-level client already set
 *       · is fully fail-open
 *   - the Fastify plugin wires it up behind captureOutboundHttp and continues
 *     the inbound trace onto egress (verified through the plugin's onRequest).
 *   - a REAL end-to-end run: real Fastify + global fetch to a local server,
 *     asserting the downstream server actually receives the propagated headers.
 */
import http from 'node:http';
import realDc from 'node:diagnostics_channel';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OutboundInstrumentation,
  buildAllStakBaggage,
  buildTraceparent,
  hasHeader,
  isIngestHost,
  parseOrigin,
  pathWithoutQuery,
  type DiagnosticsChannelModule,
} from '../src/outbound';
import allstakFastify, { allstakFastify as namedExport } from '../src/index';

// ── A fake diagnostics_channel so we can drive create/headers/error inline ──

interface FakeUndiciRequest {
  origin: string;
  path: string;
  method: string;
  headers: unknown[];
  addHeader(name: string, value: string): void;
}

function fakeRequest(origin: string, path: string, method = 'GET', preset: unknown[] = []): FakeUndiciRequest {
  const headers = [...preset];
  return {
    origin,
    path,
    method,
    headers,
    addHeader(name: string, value: string) {
      headers.push(name, value);
    },
  };
}

class FakeDc implements DiagnosticsChannelModule {
  private subs = new Map<string, Set<(m: unknown) => void>>();
  subscribe(name: string, handler: (m: unknown) => void): void {
    if (!this.subs.has(name)) this.subs.set(name, new Set());
    this.subs.get(name)!.add(handler);
  }
  unsubscribe(name: string, handler: (m: unknown) => void): boolean {
    return this.subs.get(name)?.delete(handler) ?? false;
  }
  publish(name: string, message: unknown): void {
    for (const h of this.subs.get(name) ?? []) h(message);
  }
  count(name: string): number {
    return this.subs.get(name)?.size ?? 0;
  }
}

interface CapturedEv {
  path: string;
  payload: any;
}

function captureTransport() {
  const requests: CapturedEv[] = [];
  const spans: CapturedEv[] = [];
  return {
    requests,
    spans,
    transport: {
      enqueueRequest: (ev: CapturedEv) => requests.push(ev),
      enqueueSpan: (ev: CapturedEv) => spans.push(ev),
      isDisabled: () => false,
    },
  };
}

const TRACE = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), requestId: 'req-1', sampled: true };

function headerValueOf(req: FakeUndiciRequest, name: string): string | undefined {
  for (let i = 0; i < req.headers.length; i += 2) {
    if (String(req.headers[i]).toLowerCase() === name.toLowerCase()) return String(req.headers[i + 1]);
  }
  return undefined;
}

describe('outbound — pure helpers', () => {
  it('parseOrigin handles URL strings and objects', () => {
    expect(parseOrigin('http://svc.internal:8080')).toEqual({ host: 'svc.internal', port: '8080' });
    expect(parseOrigin('https://api.example.com')).toEqual({ host: 'api.example.com', port: '' });
    expect(parseOrigin({ origin: 'http://1.2.3.4:9000' })).toEqual({ host: '1.2.3.4', port: '9000' });
    expect(parseOrigin(undefined)).toEqual({ host: '', port: '' });
  });

  it('pathWithoutQuery strips the query', () => {
    expect(pathWithoutQuery('/v1/users?id=7')).toBe('/v1/users');
    expect(pathWithoutQuery('/v1/users')).toBe('/v1/users');
    expect(pathWithoutQuery(undefined)).toBe('/');
  });

  it('isIngestHost is host-only and case-insensitive', () => {
    expect(isIngestHost('api.allstak.sa', 'api.allstak.sa')).toBe(true);
    expect(isIngestHost('API.AllStak.SA', 'api.allstak.sa')).toBe(true);
    expect(isIngestHost('other.com', 'api.allstak.sa')).toBe(false);
    expect(isIngestHost('', 'api.allstak.sa')).toBe(false);
  });

  it('hasHeader scans flat arrays, raw strings and records', () => {
    expect(hasHeader(['traceparent', 'x', 'accept', 'y'], 'traceparent')).toBe(true);
    expect(hasHeader(['Accept', 'y'], 'traceparent')).toBe(false);
    expect(hasHeader('traceparent: 00-..\r\naccept: */*', 'traceparent')).toBe(true);
    expect(hasHeader({ Traceparent: 'x' }, 'traceparent')).toBe(true);
    expect(hasHeader(undefined, 'traceparent')).toBe(false);
  });

  it('buildTraceparent / buildAllStakBaggage produce W3C-shaped output', () => {
    expect(buildTraceparent('a'.repeat(32), 'b'.repeat(16), true)).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    expect(buildTraceparent('a'.repeat(32), 'b'.repeat(16), false)).toMatch(/-00$/);
    expect(buildAllStakBaggage('t', 'r', 's')).toBe('allstak-trace_id=t,allstak-request_id=r,allstak-span_id=s');
  });
});

describe('outbound — OutboundInstrumentation with a fake diagnostics channel', () => {
  it('injects propagation headers continuing the active trace, child span under the server span', () => {
    const dc = new FakeDc();
    const { requests, spans, transport } = captureTransport();
    const inst = new OutboundInstrumentation({
      transport,
      getTraceContext: () => TRACE,
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      serviceName: 'svc',
      environment: 'test',
      diagnosticsChannel: dc,
      spanIdGen: () => 'c'.repeat(16),
      now: () => 1_700_000_000_000,
    });
    inst.install();
    expect(inst.isInstalled()).toBe(true);

    const req = fakeRequest('http://downstream.svc:8080', '/api/widgets?q=1', 'POST');
    dc.publish('undici:request:create', { request: req });

    // (1) headers injected, continuing the inbound trace
    expect(headerValueOf(req, 'traceparent')).toBe(`00-${'a'.repeat(32)}-${'c'.repeat(16)}-01`);
    expect(headerValueOf(req, 'baggage')).toBe(`allstak-trace_id=${'a'.repeat(32)},allstak-request_id=req-1,allstak-span_id=${'c'.repeat(16)}`);
    expect(headerValueOf(req, 'x-allstak-trace-id')).toBe('a'.repeat(32));
    expect(headerValueOf(req, 'x-allstak-request-id')).toBe('req-1');

    // (2) completing the request emits the outbound row + client span
    dc.publish('undici:request:headers', { request: req, response: { statusCode: 201 } });
    expect(requests).toHaveLength(1);
    expect(spans).toHaveLength(1);
    const row = requests[0].payload.requests[0];
    expect(row).toMatchObject({
      direction: 'outbound',
      method: 'POST',
      host: 'downstream.svc',
      path: '/api/widgets',
      statusCode: 201,
      traceId: 'a'.repeat(32),
      spanId: 'c'.repeat(16),
      parentSpanId: 'b'.repeat(16), // the server span is the parent
      requestId: 'req-1',
      service: 'svc',
      environment: 'test',
      release: 'svc@1',
    });
    const span = spans[0].payload.spans[0];
    expect(span).toMatchObject({
      traceId: 'a'.repeat(32),
      spanId: 'c'.repeat(16),
      parentSpanId: 'b'.repeat(16),
      operation: 'http.client',
      description: 'POST downstream.svc/api/widgets',
      status: 'ok',
    });
    expect(span.tags).toMatchObject({ component: 'undici', method: 'POST', statusCode: '201' });
  });

  it('marks a 5xx response and a transport error as errored spans', () => {
    const dc = new FakeDc();
    const { requests, spans, transport } = captureTransport();
    const inst = new OutboundInstrumentation({
      transport,
      getTraceContext: () => TRACE,
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      diagnosticsChannel: dc,
      spanIdGen: () => 'c'.repeat(16),
    });
    inst.install();

    const r1 = fakeRequest('http://d', '/a');
    dc.publish('undici:request:create', { request: r1 });
    dc.publish('undici:request:headers', { request: r1, response: { statusCode: 503 } });

    const r2 = fakeRequest('http://d', '/b');
    dc.publish('undici:request:create', { request: r2 });
    dc.publish('undici:request:error', { request: r2, error: new Error('ECONNREFUSED') });

    expect(spans.map((s) => s.payload.spans[0].status)).toEqual(['error', 'error']);
    expect(requests.map((r) => r.payload.requests[0].statusCode)).toEqual([503, 0]);
  });

  it('skips the SDK ingest host (no telemetry feedback loop)', () => {
    const dc = new FakeDc();
    const { requests, spans, transport } = captureTransport();
    const inst = new OutboundInstrumentation({
      transport,
      getTraceContext: () => TRACE,
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      diagnosticsChannel: dc,
    });
    inst.install();

    const req = fakeRequest('https://api.allstak.sa', '/ingest/v1/http-requests', 'POST');
    dc.publish('undici:request:create', { request: req });
    // No propagation headers injected and no span buffered.
    expect(headerValueOf(req, 'traceparent')).toBeUndefined();
    dc.publish('undici:request:headers', { request: req, response: { statusCode: 200 } });
    expect(requests).toHaveLength(0);
    expect(spans).toHaveLength(0);
  });

  it('never clobbers a traceparent a higher-level client already set', () => {
    const dc = new FakeDc();
    const { transport } = captureTransport();
    const inst = new OutboundInstrumentation({
      transport,
      getTraceContext: () => TRACE,
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      diagnosticsChannel: dc,
      spanIdGen: () => 'c'.repeat(16),
    });
    inst.install();
    const req = fakeRequest('http://d', '/a', 'GET', ['traceparent', 'pre-existing']);
    dc.publish('undici:request:create', { request: req });
    expect(headerValueOf(req, 'traceparent')).toBe('pre-existing');
  });

  it('originates a trace when there is no active request context but still propagates', () => {
    const dc = new FakeDc();
    const { requests, transport } = captureTransport();
    const inst = new OutboundInstrumentation({
      transport,
      getTraceContext: () => undefined,
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      diagnosticsChannel: dc,
      spanIdGen: () => 'c'.repeat(16),
    });
    inst.install();
    const req = fakeRequest('http://d', '/a');
    dc.publish('undici:request:create', { request: req });
    const tp = headerValueOf(req, 'traceparent')!;
    expect(tp).toMatch(/^00-[0-9a-f]{32}-cccccccccccccccc-01$/);
    dc.publish('undici:request:headers', { request: req, response: { statusCode: 200 } });
    expect(requests[0].payload.requests[0].parentSpanId).toBe(''); // root: no parent
  });

  it('does not emit telemetry for an unsampled trace but still propagates the flag', () => {
    const dc = new FakeDc();
    const { requests, spans, transport } = captureTransport();
    const inst = new OutboundInstrumentation({
      transport,
      getTraceContext: () => ({ ...TRACE, sampled: false }),
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      diagnosticsChannel: dc,
      spanIdGen: () => 'c'.repeat(16),
    });
    inst.install();
    const req = fakeRequest('http://d', '/a');
    dc.publish('undici:request:create', { request: req });
    expect(headerValueOf(req, 'traceparent')).toMatch(/-00$/);
    dc.publish('undici:request:headers', { request: req, response: { statusCode: 200 } });
    expect(requests).toHaveLength(0);
    expect(spans).toHaveLength(0);
  });

  it('is fail-open: a thrown subscriber side effect never escapes', () => {
    const dc = new FakeDc();
    const inst = new OutboundInstrumentation({
      transport: {
        enqueueRequest: () => { throw new Error('transport boom'); },
        enqueueSpan: () => { throw new Error('transport boom'); },
      },
      getTraceContext: () => TRACE,
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      diagnosticsChannel: dc,
    });
    inst.install();
    const req = fakeRequest('http://d', '/a');
    expect(() => dc.publish('undici:request:create', { request: req })).not.toThrow();
    expect(() => dc.publish('undici:request:headers', { request: req, response: { statusCode: 200 } })).not.toThrow();
  });

  it('uninstall unsubscribes and is idempotent', () => {
    const dc = new FakeDc();
    const { transport } = captureTransport();
    const inst = new OutboundInstrumentation({
      transport,
      getTraceContext: () => TRACE,
      ingestHost: 'api.allstak.sa',
      release: 'svc@1',
      diagnosticsChannel: dc,
    });
    inst.install();
    expect(dc.count('undici:request:create')).toBe(1);
    inst.uninstall();
    inst.uninstall();
    expect(dc.count('undici:request:create')).toBe(0);
    expect(inst.isInstalled()).toBe(false);
  });
});

describe('outbound — Fastify plugin wiring', () => {
  it('captureOutboundHttp=false does not subscribe', () => {
    const dc = new FakeDc();
    const app = { addHook: () => {} };
    allstakFastify(app as any, {
      apiKey: 'ask_dev_test',
      captureOutboundHttp: false,
      diagnosticsChannel: dc as any,
      enableOfflineQueue: false,
      enableAutoSessionTracking: false,
    });
    expect(dc.count('undici:request:create')).toBe(0);
  });

  it('continues the inbound request trace onto egress through the plugin', async () => {
    const dc = new FakeDc();
    const sent: CapturedEv[] = [];
    const fetchSpy = vi.fn(async (url: string, init: any) => {
      sent.push({ path: String(url), payload: JSON.parse(init.body) });
      return { ok: true, status: 200 } as any;
    });
    const hooks: Record<string, (...a: any[]) => void> = {};
    const app = { addHook: (n: string, fn: (...a: any[]) => void) => { hooks[n] = fn; } };
    allstakFastify(app as any, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      serviceName: 'svc',
      flushIntervalMs: 0,
      captureOutboundHttp: true,
      diagnosticsChannel: dc as any,
      fetch: fetchSpy as unknown as typeof fetch,
      enableOfflineQueue: false,
      enableAutoSessionTracking: false,
    });

    const reply = { statusCode: 200, header: () => {} };
    const request = {
      method: 'GET',
      url: '/work',
      headers: {
        host: 'h',
        traceparent: `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01`,
        'x-allstak-request-id': 'req-up',
      },
    };
    // onRequest binds the ALS trace context; the egress publish runs inside it.
    hooks.onRequest(request, reply, () => {
      const eg = fakeRequest('http://downstream', '/call');
      dc.publish('undici:request:create', { request: eg });
      // egress headers continue the inbound trace id + the server span as parent
      expect(headerValueOf(eg, 'x-allstak-trace-id')).toBe('e'.repeat(32));
      const tp = headerValueOf(eg, 'traceparent')!;
      expect(tp.startsWith(`00-${'e'.repeat(32)}-`)).toBe(true);
      expect(tp.endsWith('-01')).toBe(true);
      expect(headerValueOf(eg, 'x-allstak-request-id')).toBe('req-up');
      dc.publish('undici:request:headers', { request: eg, response: { statusCode: 200 } });
    });

    await vi.waitFor(() => {
      const out = sent.find((c) => c.path.endsWith('/ingest/v1/http-requests'));
      expect(out?.payload.requests.some((r: any) => r.direction === 'outbound')).toBe(true);
    });
    const outRow = sent
      .flatMap((c) => (c.path.endsWith('/ingest/v1/http-requests') ? c.payload.requests : []))
      .find((r: any) => r.direction === 'outbound');
    expect(outRow.traceId).toBe('e'.repeat(32));
    expect(outRow.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(outRow.host).toBe('downstream');
  });
});

describe('outbound — real Fastify + real fetch end-to-end', () => {
  let downstream: http.Server;
  let downstreamUrl = '';
  let received: Record<string, string | string[] | undefined> = {};

  beforeEach(async () => {
    received = {};
    downstream = http.createServer((req, res) => {
      received = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => downstream.listen(0, '127.0.0.1', resolve));
    const addr = downstream.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    downstreamUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => downstream.close(() => resolve()));
  });

  it('real global fetch from a handler carries the propagated traceparent downstream', async () => {
    // Use the REAL node:diagnostics_channel here. Stub fetch ONLY for the
    // SDK's ingest delivery so we do not hit the network for telemetry, while
    // the handler's outbound call uses real global fetch (real undici).
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.fn(async (url: any, init: any) => {
      if (String(url).startsWith('https://api.allstak.sa')) {
        return { ok: true, status: 200, headers: { get: () => null } } as any;
      }
      return realFetch(url, init);
    });

    const app = Fastify({ logger: false });
    let propagated: string | undefined;
    try {
      await app.register(namedExport as any, {
        apiKey: 'ask_dev_test',
        host: 'https://api.allstak.sa',
        serviceName: 'e2e',
        flushIntervalMs: 0,
        captureOutboundHttp: true, // explicit opt-in under the test runtime
        fetch: fetchSpy as unknown as typeof fetch,
        enableOfflineQueue: false,
        enableAutoSessionTracking: false,
      });
      app.get('/proxy', async () => {
        const r = await realFetch(`${downstreamUrl}/edge`);
        await r.text();
        propagated = received.traceparent as string | undefined;
        return { done: true };
      });

      const res = await app.inject({
        method: 'GET',
        url: '/proxy',
        headers: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
      });
      expect(res.statusCode).toBe(200);
      // The downstream server received a W3C traceparent continuing our trace.
      expect(propagated).toBeTruthy();
      expect(String(propagated)).toMatch(new RegExp(`^00-${'a'.repeat(32)}-[0-9a-f]{16}-01$`));
      expect(received['x-allstak-trace-id']).toBe('a'.repeat(32));
    } finally {
      await app.close();
    }
  });
});

// Defensive: real diagnostics_channel exists in this runtime (sanity for the
// e2e test above). If it ever doesn't, the plugin degrades to a no-op.
describe('outbound — runtime diagnostics_channel availability', () => {
  it('node:diagnostics_channel is available', () => {
    expect(typeof realDc.subscribe).toBe('function');
  });
});
