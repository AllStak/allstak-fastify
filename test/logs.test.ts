import { describe, expect, it, vi } from 'vitest';
import { LogBridge, parsePinoArgs, allstakFastify, SDK_NAME } from '../src/index';

type Hook = (...args: any[]) => void;

function makeApp(log?: any) {
  const hooks: Record<string, Hook> = {};
  return {
    app: { addHook: (name: string, fn: Hook) => { hooks[name] = fn; }, log },
    hooks,
  };
}

function fakeLogTransport() {
  const events: { path: string; payload: any }[] = [];
  return {
    transport: { enqueueLog: (ev: any) => events.push(ev), isDisabled: () => false },
    events,
  };
}

/** A minimal pino-like logger that records calls so we can prove pass-through. */
function fakeLogger() {
  const seen: { level: string; args: unknown[] }[] = [];
  const mk = (level: string) => (...args: unknown[]) => seen.push({ level, args });
  return {
    logger: {
      fatal: mk('fatal'),
      error: mk('error'),
      warn: mk('warn'),
      info: mk('info'),
      debug: mk('debug'),
      trace: mk('trace'),
    } as Record<string, (...a: unknown[]) => void>,
    seen,
  };
}

// ── parsePinoArgs ─────────────────────────────────────────────────────────────

describe('logs — parsePinoArgs', () => {
  it('string message', () => {
    expect(parsePinoArgs(['hello'])).toEqual({ message: 'hello' });
  });
  it('error first arg', () => {
    const e = new Error('bad');
    expect(parsePinoArgs([e])).toMatchObject({ message: 'bad', error: e });
  });
  it('error + explicit message', () => {
    const e = new Error('bad');
    expect(parsePinoArgs([e, 'while saving'])).toMatchObject({ message: 'while saving', error: e });
  });
  it('merge object + message + embedded err', () => {
    const e = new Error('oops');
    const r = parsePinoArgs([{ userId: 'u1', err: e }, 'failed']);
    expect(r.message).toBe('failed');
    expect(r.mergeObject).toMatchObject({ userId: 'u1' });
    expect(r.error).toBe(e);
  });
});

// ── LogBridge ─────────────────────────────────────────────────────────────────

describe('LogBridge', () => {
  it('forwards info logs to /ingest/v1/logs while preserving the original call', () => {
    const { transport, events } = fakeLogTransport();
    const { logger, seen } = fakeLogger();
    const bridge = new LogBridge({
      transport,
      service: 'svc',
      environment: 'test',
      release: 'r@1',
      getTraceContext: () => ({ traceId: 't', spanId: 's', requestId: 'rq' }),
    });
    expect(bridge.install(logger)).toBe(true);

    logger.info('hello world');
    // Original pino call still fired.
    expect(seen).toEqual([{ level: 'info', args: ['hello world'] }]);
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe('/ingest/v1/logs');
    expect(events[0].payload).toMatchObject({
      level: 'info',
      message: 'hello world',
      service: 'svc',
      environment: 'test',
      release: 'r@1',
      traceId: 't',
      spanId: 's',
      requestId: 'rq',
    });
    expect(events[0].payload.metadata['sdk.name']).toBe(SDK_NAME);
  });

  it('promotes error logs with throwable extraction into metadata', () => {
    const { transport, events } = fakeLogTransport();
    const { logger } = fakeLogger();
    new LogBridge({ transport }).install(logger);
    const err = new Error('db down');
    logger.error(err, 'query failed');
    const p = events[0].payload;
    expect(p.level).toBe('error');
    expect(p.message).toBe('query failed');
    expect(p.metadata['error.type']).toBe('Error');
    expect(p.metadata['error.message']).toBe('db down');
    expect(Array.isArray(p.metadata['error.stackTrace'])).toBe(true);
  });

  it('maps warn→warn and trace→debug', () => {
    const { transport, events } = fakeLogTransport();
    const { logger } = fakeLogger();
    new LogBridge({ transport, minLevel: 'trace' }).install(logger);
    logger.warn('careful');
    logger.trace('verbose');
    expect(events.map((e) => e.payload.level)).toEqual(['warn', 'debug']);
  });

  it('respects minLevel — below-threshold logs are not forwarded', () => {
    const { transport, events } = fakeLogTransport();
    const { logger, seen } = fakeLogger();
    new LogBridge({ transport, minLevel: 'warn' }).install(logger);
    logger.info('skipme');
    logger.warn('keepme');
    // info still passed through to the underlying logger.
    expect(seen.map((s) => s.level)).toEqual(['info', 'warn']);
    // but only warn was forwarded.
    expect(events.map((e) => e.payload.message)).toEqual(['keepme']);
  });

  it('scrubs PII out of the forwarded message by default', () => {
    const { transport, events } = fakeLogTransport();
    const { logger } = fakeLogger();
    new LogBridge({ transport }).install(logger);
    logger.info('contact bob@example.com now');
    expect(events[0].payload.message).toBe('contact [REDACTED] now');
  });

  it('uninstall restores the original methods', () => {
    const { transport, events } = fakeLogTransport();
    const { logger, seen } = fakeLogger();
    const bridge = new LogBridge({ transport });
    bridge.install(logger);
    bridge.uninstall();
    logger.info('after uninstall');
    expect(seen).toEqual([{ level: 'info', args: ['after uninstall'] }]);
    expect(events).toHaveLength(0);
  });

  it('is idempotent across instances (a second wrap is skipped)', () => {
    const { transport, events } = fakeLogTransport();
    const { logger } = fakeLogger();
    new LogBridge({ transport }).install(logger);
    const second = new LogBridge({ transport });
    expect(second.install(logger)).toBe(false); // already wrapped
    logger.error('once');
    expect(events).toHaveLength(1);
  });

  it('install no-ops on a missing logger', () => {
    const { transport } = fakeLogTransport();
    expect(new LogBridge({ transport }).install(undefined)).toBe(false);
    expect(new LogBridge({ transport }).install(null)).toBe(false);
  });

  it('forwarding failure never breaks the host log call', () => {
    const throwingTransport = {
      enqueueLog: () => { throw new Error('transport blew up'); },
      isDisabled: () => false,
    };
    const { logger, seen } = fakeLogger();
    new LogBridge({ transport: throwingTransport }).install(logger);
    expect(() => logger.info('still logs')).not.toThrow();
    expect(seen).toEqual([{ level: 'info', args: ['still logs'] }]);
  });
});

// ── plugin integration ────────────────────────────────────────────────────────

describe('@allstak/fastify plugin — log bridge', () => {
  it('wraps fastify.log on onReady when enableLogBridge is explicitly enabled', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const { logger, seen } = fakeLogger();
    const { app, hooks } = makeApp(logger);
    allstakFastify(app, {
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      flushIntervalMs: 0,
      fetch: fetchSpy as unknown as typeof fetch,
      enableLogBridge: true,
    });
    await new Promise<void>((resolve) => hooks.onReady?.(() => resolve()));
    logger.error('plugin level error');
    expect(seen.some((s) => s.level === 'error')).toBe(true);
    await vi.waitFor(() => {
      const logCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/ingest/v1/logs'));
      expect(logCall, 'logs ingest call expected').toBeTruthy();
    });
    const logCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/ingest/v1/logs'))!;
    expect(JSON.parse((logCall[1] as any).body).message).toBe('plugin level error');
    // Clean up the wrap.
    await new Promise<void>((resolve) => hooks.onClose?.({}, () => resolve()));
  });
});
