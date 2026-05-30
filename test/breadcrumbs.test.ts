import { describe, expect, it, vi } from 'vitest';
import { allstakFastify } from '../src/index';

type Hook = (...args: any[]) => void;

function makeApp() {
  const hooks: Record<string, Hook> = {};
  return {
    app: { addHook: (name: string, fn: Hook) => { hooks[name] = fn; } },
    hooks,
  };
}

function captureFetch() {
  const calls: { url: string; body: any }[] = [];
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 202 } as any;
  });
  return { calls, spy };
}

describe('@allstak/fastify — auto http breadcrumbs', () => {
  it('records an http breadcrumb per request, attached to a captured error', async () => {
    const { calls, spy } = captureFetch();
    const { app, hooks } = makeApp();
    const reply = { statusCode: 500, header: () => {} };
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      fetch: spy as unknown as typeof fetch,
    });
    const request = {
      method: 'GET',
      url: '/orders/42?secret=1',
      headers: { host: 'api.example.test' },
    };
    hooks.onRequest(request, reply, () => {});
    // Error in the same request async context picks up the breadcrumb.
    hooks.onError(request, reply, new Error('handler exploded'), () => {});

    await vi.waitFor(() => {
      expect(calls.find((c) => c.url.endsWith('/ingest/v1/errors'))).toBeTruthy();
    });
    const errCall = calls.find((c) => c.url.endsWith('/ingest/v1/errors'))!;
    const crumbs = errCall.body.breadcrumbs;
    expect(Array.isArray(crumbs)).toBe(true);
    const httpCrumb = crumbs.find((b: any) => b.type === 'http');
    expect(httpCrumb).toBeTruthy();
    expect(httpCrumb.category).toBe('http.server');
    expect(httpCrumb.message).toBe('GET /orders/42');
    expect(httpCrumb.data.method).toBe('GET');
    expect(httpCrumb.data.path).toBe('/orders/42');
  });

  it('does not record a breadcrumb when enableAutoBreadcrumbs is false', async () => {
    const { calls, spy } = captureFetch();
    const { app, hooks } = makeApp();
    const reply = { statusCode: 500, header: () => {} };
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      fetch: spy as unknown as typeof fetch,
      enableAutoBreadcrumbs: false,
    });
    const request = { method: 'POST', url: '/x', headers: { host: 'h' } };
    hooks.onRequest(request, reply, () => {});
    hooks.onError(request, reply, new Error('boom'), () => {});

    await vi.waitFor(() => {
      expect(calls.find((c) => c.url.endsWith('/ingest/v1/errors'))).toBeTruthy();
    });
    const errCall = calls.find((c) => c.url.endsWith('/ingest/v1/errors'))!;
    const crumbs = errCall.body.breadcrumbs;
    const httpCrumb = (crumbs ?? []).find((b: any) => b.type === 'http');
    expect(httpCrumb).toBeUndefined();
  });
});
