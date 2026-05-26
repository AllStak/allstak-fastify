/**
 * Manual capture + scope API tests for @allstak/fastify.
 *
 * Verifies the additive parity surface:
 *   - captureException / captureMessage route through the plugin transport
 *     (existing redaction + beforeSend + sampling pipeline), no real network
 *   - setUser / setTag / setContext attach to subsequently captured events
 *   - withScope forks a temporary scope that is popped afterwards
 *   - concurrent ALS request scopes do not leak user/tags across requests
 *   - auto-capture (onError hook) includes scope-set user/tags
 */
import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import allstakFastify, {
  captureException,
  captureMessage,
  setUser,
  setTag,
  setTags,
  setContext,
  setExtra,
  addBreadcrumb,
  withScope,
  configureScope,
} from '../src/index';

interface IngestCall {
  url: string;
  body: any;
}

function captureFetch(): { calls: IngestCall[] } {
  const calls: IngestCall[] = [];
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200 } as any;
  });
  vi.stubGlobal('fetch', spy);
  return { calls };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(allstakFastify, {
    apiKey: 'ask_dev_test',
    host: 'https://api.allstak.sa',
    environment: 'test',
    serviceName: 'scope-test',
    flushIntervalMs: 0,
  });
  return app;
}

function errorCalls(calls: IngestCall[]): IngestCall[] {
  return calls.filter((c) => c.url.endsWith('/ingest/v1/errors'));
}

describe('@allstak/fastify manual capture + scope', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('captureException routes through the plugin transport', async () => {
    const { calls } = captureFetch();
    const app = await buildApp();
    try {
      captureException(new Error('manual boom'));
      await vi.waitFor(() => expect(errorCalls(calls).length).toBeGreaterThan(0));
      const err = errorCalls(calls)[0].body;
      expect(err.message).toBe('manual boom');
      expect(err.exceptionClass).toBe('Error');
      expect(err.metadata['sdk.name']).toBeTruthy();
    } finally { await app.close(); }
  });

  it('captureMessage sends a message event', async () => {
    const { calls } = captureFetch();
    const app = await buildApp();
    try {
      captureMessage('hello world', 'warning');
      await vi.waitFor(() => expect(errorCalls(calls).length).toBeGreaterThan(0));
      const ev = errorCalls(calls)[0].body;
      expect(ev.message).toBe('hello world');
      expect(ev.level).toBe('warning');
      expect(ev.exceptionClass).toBe('Message');
    } finally { await app.close(); }
  });

  it('setUser / setTag / setContext attach to captured events', async () => {
    const { calls } = captureFetch();
    const app = await buildApp();
    try {
      setUser({ id: 'u-42', email: 'a@b.co' });
      setTag('feature', 'checkout');
      setTags({ region: 'eu' });
      setExtra('orderId', 'o-9');
      setContext('app', { build: '1.2.3' });
      captureException(new Error('with scope'));
      await vi.waitFor(() => expect(errorCalls(calls).length).toBeGreaterThan(0));
      const meta = errorCalls(calls)[0].body.metadata;
      expect(meta.userId).toBe('u-42');
      expect(meta.userEmail).toBe('a@b.co');
      expect(meta['tag.feature']).toBe('checkout');
      expect(meta['tag.region']).toBe('eu');
      expect(meta['extra.orderId']).toBe('o-9');
      expect(meta['context.app']).toEqual({ build: '1.2.3' });
    } finally {
      // reset global scope state for later tests
      configureScope((s) => s.clear());
      await app.close();
    }
  });

  it('addBreadcrumb attaches breadcrumbs to captured events', async () => {
    const { calls } = captureFetch();
    const app = await buildApp();
    try {
      addBreadcrumb({ type: 'custom', message: 'step-1' });
      captureException(new Error('crumbs'));
      await vi.waitFor(() => expect(errorCalls(calls).length).toBeGreaterThan(0));
      const crumbs = errorCalls(calls)[0].body.breadcrumbs;
      expect(Array.isArray(crumbs)).toBe(true);
      expect(crumbs.some((c: any) => c.message === 'step-1')).toBe(true);
    } finally {
      configureScope((s) => s.clear());
      await app.close();
    }
  });

  it('withScope forks a temporary scope that is popped afterwards', async () => {
    const { calls } = captureFetch();
    const app = await buildApp();
    try {
      withScope((scope) => {
        scope.setTag('temp', 'yes');
        captureException(new Error('inside'));
      });
      captureException(new Error('outside'));
      await vi.waitFor(() => expect(errorCalls(calls).length).toBe(2));
      const inside = errorCalls(calls).find((c) => c.body.message === 'inside')!.body;
      const outside = errorCalls(calls).find((c) => c.body.message === 'outside')!.body;
      expect(inside.metadata['tag.temp']).toBe('yes');
      expect(outside.metadata['tag.temp']).toBeUndefined();
    } finally { await app.close(); }
  });

  it('concurrent request scopes do not leak user/tags (ALS isolation)', async () => {
    const { calls } = captureFetch();
    const app = Fastify({ logger: false });
    await app.register(allstakFastify, {
      apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', flushIntervalMs: 0,
    });
    // Two handlers that set distinct users with an interleaving await, then
    // throw so the onError auto-capture emits with the request-scoped user.
    app.get('/a', async () => {
      setUser({ id: 'user-A' });
      setTag('which', 'A');
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('boom-A');
    });
    app.get('/b', async () => {
      setUser({ id: 'user-B' });
      setTag('which', 'B');
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('boom-B');
    });
    try {
      const [ra, rb] = await Promise.all([
        app.inject({ method: 'GET', url: '/a' }),
        app.inject({ method: 'GET', url: '/b' }),
      ]);
      expect(ra.statusCode).toBe(500);
      expect(rb.statusCode).toBe(500);
      await vi.waitFor(() => expect(errorCalls(calls).length).toBe(2));
      const a = errorCalls(calls).find((c) => c.body.message === 'boom-A')!.body;
      const b = errorCalls(calls).find((c) => c.body.message === 'boom-B')!.body;
      expect(a.metadata.userId).toBe('user-A');
      expect(a.metadata['tag.which']).toBe('A');
      expect(b.metadata.userId).toBe('user-B');
      expect(b.metadata['tag.which']).toBe('B');
    } finally { await app.close(); }
  });

  it('auto-capture (onError) includes scope-set user/tags', async () => {
    const { calls } = captureFetch();
    const app = Fastify({ logger: false });
    await app.register(allstakFastify, {
      apiKey: 'ask_dev_test', host: 'https://api.allstak.sa', flushIntervalMs: 0,
    });
    app.get('/boom', async () => {
      setUser({ id: 'handler-user' });
      setTag('route', 'boom');
      throw new Error('handler error');
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(500);
      await vi.waitFor(() => expect(errorCalls(calls).length).toBe(1));
      const meta = errorCalls(calls)[0].body.metadata;
      expect(meta.userId).toBe('handler-user');
      expect(meta['tag.route']).toBe('boom');
      expect(errorCalls(calls)[0].body.message).toBe('handler error');
    } finally { await app.close(); }
  });

  it('beforeSend still runs on manual captures (pipeline preserved)', async () => {
    const calls: IngestCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as any;
    }));
    const app = Fastify({ logger: false });
    await app.register(allstakFastify, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      beforeSend: (ev) => {
        (ev.payload as any).tagged = true;
        return ev;
      },
    });
    try {
      captureException(new Error('pipe'));
      await vi.waitFor(() => expect(errorCalls(calls).length).toBeGreaterThan(0));
      expect(errorCalls(calls)[0].body.tagged).toBe(true);
    } finally { await app.close(); }
  });
});
