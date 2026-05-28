import { describe, expect, it, vi } from 'vitest';
import { allstakFastify } from '../src/index';
import { SessionTracker } from '../src/session';

type Hook = (...args: any[]) => void;

function makeApp() {
  const hooks: Record<string, Hook> = {};
  return {
    app: { addHook: (name: string, fn: Hook) => { hooks[name] = fn; } },
    hooks,
  };
}

/** Captures every outbound ingest call. */
function captureFetch() {
  const calls: { url: string; body: any }[] = [];
  const spy = vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 202 } as any;
  });
  return { calls, spy };
}

describe('SessionTracker — class lifecycle + status model', () => {
  it('start() emits the documented /sessions/start payload shape', () => {
    const sent: { path: string; payload: Record<string, unknown> }[] = [];
    const transport = { sendNow: (ev: any) => sent.push(ev), isDisabled: () => false };
    const tracker = new SessionTracker(transport, {
      release: 'app@1.2.3',
      environment: 'production',
      userId: 'u-42',
      platform: 'node-linux',
      sessionId: 'sess-1',
      now: () => 1000,
    });
    tracker.start();

    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/ingest/v1/sessions/start');
    expect(sent[0].payload).toMatchObject({
      sessionId: 'sess-1',
      release: 'app@1.2.3',
      environment: 'production',
      userId: 'u-42',
      sdkName: '@allstak/fastify',
      platform: 'node-linux',
    });
    expect(typeof sent[0].payload.sdkVersion).toBe('string');
  });

  it('start() is idempotent — a second call does not re-POST', () => {
    const sent: any[] = [];
    const transport = { sendNow: (ev: any) => sent.push(ev), isDisabled: () => false };
    const tracker = new SessionTracker(transport, { release: 'r', sessionId: 's', now: () => 0 });
    tracker.start();
    tracker.start();
    expect(sent).toHaveLength(1);
  });

  it('status transitions ok -> errored -> crashed and end() carries the final status', () => {
    const sent: { path: string; payload: any }[] = [];
    let clock = 1000;
    const transport = { sendNow: (ev: any) => sent.push(ev), isDisabled: () => false };
    const tracker = new SessionTracker(transport, {
      release: 'r',
      sessionId: 'sess-x',
      now: () => clock,
    });

    tracker.start();
    expect(tracker.getStatus()).toBe('ok');

    tracker.recordError();
    expect(tracker.getStatus()).toBe('errored');

    tracker.recordCrash();
    expect(tracker.getStatus()).toBe('crashed');

    clock = 1500;
    tracker.end();

    const endCall = sent.find((c) => c.path === '/ingest/v1/sessions/end')!;
    expect(endCall).toBeTruthy();
    expect(endCall.payload).toEqual({
      sessionId: 'sess-x',
      durationMs: 500,
      status: 'crashed',
    });
  });

  it('ok -> errored end() reports errored (no crash)', () => {
    const sent: { path: string; payload: any }[] = [];
    const transport = { sendNow: (ev: any) => sent.push(ev), isDisabled: () => false };
    const tracker = new SessionTracker(transport, { release: 'r', sessionId: 's', now: () => 0 });
    tracker.start();
    tracker.recordError();
    tracker.end();
    const endCall = sent.find((c) => c.path === '/ingest/v1/sessions/end')!;
    expect(endCall.payload.status).toBe('errored');
  });

  it('recordError() never downgrades an already-crashed session', () => {
    const transport = { sendNow: () => {}, isDisabled: () => false };
    const tracker = new SessionTracker(transport, { release: 'r', sessionId: 's', now: () => 0 });
    tracker.start();
    tracker.recordCrash();
    tracker.recordError();
    expect(tracker.getStatus()).toBe('crashed');
  });

  it('end() is idempotent — only one /sessions/end POST', () => {
    const sent: any[] = [];
    const transport = { sendNow: (ev: any) => sent.push(ev), isDisabled: () => false };
    const tracker = new SessionTracker(transport, { release: 'r', sessionId: 's', now: () => 0 });
    tracker.start();
    tracker.end();
    tracker.end();
    expect(sent.filter((c) => c.path === '/ingest/v1/sessions/end')).toHaveLength(1);
  });

  it('a disabled transport (no api key) records status but emits no I/O — fail-open', () => {
    const sent: any[] = [];
    const transport = { sendNow: (ev: any) => sent.push(ev), isDisabled: () => true };
    const tracker = new SessionTracker(transport, { release: 'r', sessionId: 's', now: () => 0 });
    tracker.start();
    tracker.recordError();
    tracker.end();
    expect(sent).toHaveLength(0);
    expect(tracker.getStatus()).toBe('errored');
  });

  it('a throwing transport never propagates out of start()/end()', () => {
    const transport = {
      sendNow: () => { throw new Error('network down'); },
      isDisabled: () => false,
    };
    const tracker = new SessionTracker(transport, { release: 'r', sessionId: 's', now: () => 0 });
    expect(() => tracker.start()).not.toThrow();
    expect(() => tracker.end()).not.toThrow();
  });
});

describe('@allstak/fastify — release-health session wiring', () => {
  it('onReady opens a session, onClose ends it with errored after a handler error', async () => {
    const { calls, spy } = captureFetch();
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      environment: 'production',
      release: 'svc@9.9.9',
      enableAutoSessionTracking: true, // explicit opt-in under the test runtime
      flushIntervalMs: 0,
      fetch: spy as unknown as typeof fetch,
    });

    expect(typeof hooks.onReady).toBe('function');
    expect(typeof hooks.onClose).toBe('function');

    // Server becomes ready -> /sessions/start.
    hooks.onReady(() => {});
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/sessions/start'))).toBe(true));
    const startCall = calls.find((c) => c.url.endsWith('/sessions/start'))!;
    expect(startCall.body).toMatchObject({
      release: 'svc@9.9.9',
      environment: 'production',
      sdkName: '@allstak/fastify',
    });
    expect(typeof startCall.body.sessionId).toBe('string');
    const sessionId = startCall.body.sessionId;

    // A handled request error bumps the session to errored AND carries the id.
    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('boom'), () => {});
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/ingest/v1/errors'))).toBe(true));
    const errCall = calls.find((c) => c.url.endsWith('/ingest/v1/errors'))!;
    expect(errCall.body.sessionId).toBe(sessionId);

    // Graceful shutdown -> /sessions/end with the final errored status.
    hooks.onClose({}, () => {});
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/sessions/end'))).toBe(true));
    const endCall = calls.find((c) => c.url.endsWith('/sessions/end'))!;
    expect(endCall.body.sessionId).toBe(sessionId);
    expect(endCall.body.status).toBe('errored');
    expect(typeof endCall.body.durationMs).toBe('number');
  });

  it('enableAutoSessionTracking:false opts out — no onReady/onClose hooks, no session traffic', async () => {
    const { calls, spy } = captureFetch();
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      release: 'svc@1.0.0',
      enableAutoSessionTracking: false,
      flushIntervalMs: 0,
      fetch: spy as unknown as typeof fetch,
    });

    expect(hooks.onReady).toBeUndefined();
    expect(hooks.onClose).toBeUndefined();

    const req = { method: 'GET', url: '/boom', headers: { host: 'h' } };
    hooks.onError(req, {}, new Error('boom'), () => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.some((c) => c.url.includes('/sessions/'))).toBe(false);
    // The error event still flows, just without a sessionId.
    const errCall = calls.find((c) => c.url.endsWith('/ingest/v1/errors'));
    expect(errCall).toBeTruthy();
    expect(errCall!.body.sessionId).toBeUndefined();
  });

  it('defaults to skipped under the unit-test runtime when the flag is unset', () => {
    const { app, hooks } = makeApp();
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      release: 'svc@1.0.0',
      flushIntervalMs: 0,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    // VITEST=true at runtime, so no session hooks are registered by default.
    expect(hooks.onReady).toBeUndefined();
    expect(hooks.onClose).toBeUndefined();
  });
});
