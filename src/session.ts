import { SDK_NAME, SDK_VERSION } from './version';

/**
 * Lifecycle status of a release-health session.
 *
 * Mirrors the AllStak Java SDK's `SessionStatus` and the backend's
 * `/ingest/v1/sessions/end` contract / Sentry release-health conventions:
 *   - `ok`       — session ended normally with at most non-fatal logs.
 *   - `errored`  — at least one HANDLED error landed during the session, but
 *                  the process kept running.
 *   - `crashed`  — an UNHANDLED / fatal error ended the process (only reported
 *                  when the SDK observes it).
 *   - `abnormal` — the process ended without a normal flush. Reserved.
 */
export type SessionStatus = 'ok' | 'errored' | 'crashed' | 'abnormal';

/**
 * Minimal transport seam the {@link SessionTracker} needs. Satisfied by the
 * plugin's `FastifyTransport` (via `sendNow`). Sessions are NEVER sampled.
 */
export interface SessionTransportLike {
  sendNow(ev: { path: string; payload: Record<string, unknown> }): void;
  /** Whether the transport has no API key and therefore cannot emit. */
  isDisabled?(): boolean;
}

export interface SessionTrackerOptions {
  /** Resolved release (already falls back to the SDK version when unset). */
  release: string;
  environment?: string;
  /** Optional initial user id attributed to the session at start. */
  userId?: string;
  platform?: string;
  /** Deterministic clock seam for tests. Defaults to Date.now. */
  now?: () => number;
  /** Deterministic id seam for tests. Defaults to a random hex id. */
  sessionId?: string;
}

const PATH_START = '/ingest/v1/sessions/start';
const PATH_END = '/ingest/v1/sessions/end';

function randomSessionId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const data = new Uint8Array(16);
    c.getRandomValues(data);
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Server-mode "single session per process" tracker. One instance per plugin
 * registration.
 *
 * On {@link start} it POSTs `/ingest/v1/sessions/start` with the session id,
 * release, environment and SDK identity. Errored / crashed transitions are
 * recorded in-memory only; on {@link end} it POSTs `/ingest/v1/sessions/end`
 * with the final status + total duration. All network I/O is fire-and-forget
 * through the SDK's existing transport and fully fail-open — nothing here ever
 * throws or blocks the host application.
 *
 * Re-entrancy safe: a second {@link start} is a no-op; once ended the tracker
 * does not re-arm.
 */
export class SessionTracker {
  readonly sessionId: string;
  private readonly transport: SessionTransportLike;
  private readonly opts: SessionTrackerOptions;
  private readonly now: () => number;

  private sessionStart = 0;
  private status: SessionStatus = 'ok';
  private errorCount = 0;
  private started = false;
  private ended = false;

  constructor(transport: SessionTransportLike, opts: SessionTrackerOptions) {
    this.transport = transport;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sessionId = opts.sessionId ?? randomSessionId();
  }

  /** Current in-memory status (for tests / introspection). */
  getStatus(): SessionStatus {
    return this.status;
  }

  /** Idempotent. Records the start timestamp and POSTs `/sessions/start`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.sessionStart = this.now();
    this.status = 'ok';

    // Sessions are NEVER sampled; release always present (version fallback).
    if (this.transport.isDisabled?.() || !this.opts.release) return;

    const payload: Record<string, unknown> = {
      sessionId: this.sessionId,
      release: this.opts.release,
      environment: this.opts.environment,
      userId: this.opts.userId,
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: this.opts.platform,
    };
    try {
      this.transport.sendNow({ path: PATH_START, payload });
    } catch {
      // Network/transport failure must never crash app boot.
    }
  }

  /**
   * Record a HANDLED error. Bumps status OK→ERRORED; never downgrades a
   * session that has already CRASHED. No I/O.
   */
  recordError(): void {
    if (this.ended) return;
    this.errorCount++;
    if (this.status === 'ok') this.status = 'errored';
  }

  /**
   * Record an UNHANDLED / fatal crash. Terminal — overrides ERRORED. No I/O;
   * the end-of-session POST carries the status.
   */
  recordCrash(): void {
    if (this.ended) return;
    this.errorCount++;
    this.status = 'crashed';
  }

  /** Promote to ABNORMAL only if still OK or ERRORED (not after a crash). */
  recordAbnormalExit(): void {
    if (this.ended) return;
    if (this.status === 'ok' || this.status === 'errored') this.status = 'abnormal';
  }

  /**
   * Terminate the session and POST `/sessions/end`. Idempotent. If
   * `finalStatus` is omitted the session's accumulated status is used. The
   * backend does not downgrade an already-crashed session.
   */
  end(finalStatus?: SessionStatus): void {
    if (this.ended || !this.started) return;
    this.ended = true;

    const status = finalStatus ?? this.status;
    if (this.transport.isDisabled?.() || !this.opts.release) return;

    const durationMs = Math.max(0, this.now() - this.sessionStart);
    const payload: Record<string, unknown> = {
      sessionId: this.sessionId,
      durationMs,
      status,
    };
    try {
      this.transport.sendNow({ path: PATH_END, payload });
    } catch {
      // Best-effort; shutdown must not throw or block.
    }
  }
}
