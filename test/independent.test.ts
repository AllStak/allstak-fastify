import { describe, expect, it, vi } from 'vitest';
import { allstakFastify } from '../src/index';

describe('@allstak/fastify standalone package', () => {
  it('has no runtime dependency on another AllStak SDK and emits ingest payloads', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const hooks: Record<string, Function> = {};
    const app = {
      addHook: (name: string, fn: Function) => { hooks[name] = fn; },
      setErrorHandler: vi.fn(),
    };

    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      host: 'https://api.dev.allstak.sa',
      environment: 'development',
      release: 'tier1-test',
      serviceName: 'fastify-test',
    });

    hooks.onRequest({ method: 'GET', url: '/health?x=1', headers: { host: 'api.example.test' } }, {}, () => {});
    hooks.onResponse({ method: 'GET', url: '/health?x=1', headers: { host: 'api.example.test' }, allstakStartedAt: Date.now() }, { statusCode: 200 }, () => {});

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.dev.allstak.sa/ingest/v1/http-requests');
    expect(fetchSpy.mock.calls[0][1].headers['X-AllStak-Key']).toBe('ask_dev_test');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).requests[0].path).toBe('/health');
  });
});
