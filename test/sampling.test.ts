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

function makeReply() {
  const headers: Record<string, string> = {};
  return {
    reply: {
      statusCode: 200,
      header: (n: string, v: string) => { headers[n.toLowerCase()] = v; },
    },
    headers,
  };
}

describe('@allstak/fastify — error sampleRate', () => {
  it('sampleRate 0 drops the error event (no send)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      sampleRate: 0,
      random: () => 0,
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('boom'), () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sampleRate 1 keeps the error event', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      sampleRate: 1,
      random: () => 0.999999,
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('boom'), () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/ingest/v1/errors');
  });

  it('sampling drops happen BEFORE beforeSend — beforeSend not called for dropped errors', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const beforeSend = vi.fn((event) => event);
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      sampleRate: 0,
      random: () => 0,
      flushIntervalMs: 0,
      beforeSend,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('boom'), () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(beforeSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('@allstak/fastify — error beforeSend', () => {
  it('mutates the error event before send', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      flushIntervalMs: 0,
      beforeSend: (event) => ({
        ...event,
        payload: { ...event.payload, message: 'rewritten' },
      }),
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('original'), () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe('rewritten');
  });

  it('drops the error when beforeSend returns null', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      flushIntervalMs: 0,
      beforeSend: () => null,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('drop me'), () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails open: a throwing beforeSend still sends the original error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      flushIntervalMs: 0,
      beforeSend: () => {
        throw new Error('callback blew up');
      },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('payload survives'), () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe('payload survives');
  });
});

describe('@allstak/fastify — tracesSampleRate drives traceparent flag', () => {
  it('origin trace: tracesSampleRate 0 propagates -00 and emits no request/span', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    const { reply, headers } = makeReply();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      tracesSampleRate: 0,
      random: () => 0,
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/r', headers: { host: 'h' } };
    hooks.onRequest(req, reply, () => {});
    hooks.onResponse(req, reply, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('origin trace: tracesSampleRate 1 propagates -01 and emits request + span', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    const { reply, headers } = makeReply();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      tracesSampleRate: 1,
      random: () => 0.999999,
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/r', headers: { host: 'h' } };
    hooks.onRequest(req, reply, () => {});
    hooks.onResponse(req, reply, () => {});
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('child trace inherits inbound sampled flag (-00) regardless of tracesSampleRate', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    const { reply, headers } = makeReply();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      tracesSampleRate: 1, // would sample IN if origin, but inbound flag wins
      random: () => 0,
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = {
      method: 'GET',
      url: '/r',
      headers: { host: 'h', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00` },
    };
    hooks.onRequest(req, reply, () => {});
    hooks.onResponse(req, reply, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(headers.traceparent).toMatch(/-00$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to sampleRate when tracesSampleRate is unset (legacy behavior)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const { app, hooks } = makeApp();
    const { reply, headers } = makeReply();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      sampleRate: 0,
      random: () => 0,
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const req = { method: 'GET', url: '/r', headers: { host: 'h' } };
    hooks.onRequest(req, reply, () => {});
    hooks.onResponse(req, reply, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(headers.traceparent).toMatch(/-00$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
