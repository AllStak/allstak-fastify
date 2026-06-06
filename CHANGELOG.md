# Changelog

All notable changes to @allstak/fastify will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.2.2] — 2026-06-06

### Fixed

- Added top-level `sdkName`, `sdkVersion`, and `platform` fields to Fastify
  error payloads so DEV and catalog detail pages can identify the SDK without
  relying only on nested metadata.

## [0.2.0] — 2026-05-30

Auto-instrumentation wave: the listed features are now AUTOMATIC (default-on,
near-zero config) after `register`. Each is individually toggleable and fully
fail-open; existing behavior is preserved.

### Added — Process-global crash handlers
- Installs `process.on('uncaughtException')` + `process.on('unhandledRejection')`
  once per process (Symbol-guarded). A fatal crash that escapes Fastify is now
  captured at `fatal` level through the normal capture pipeline, records a crash
  on the release-health session (`SessionTracker.recordCrash`), is flushed
  synchronously within a bounded budget, then preserves Node's exit semantics
  (force-exit only when no app-owned `uncaughtException` listener exists;
  `unhandledRejection` never force-exits). Gated by `enableCrashHandlers`
  (default on). New `installCrashHandlers` export.

### Added — Database auto-instrumentation
- Monkey-patches `pg`, `mysql2`, and the SQLite family (`better-sqlite3` /
  `sqlite3` / `node:sqlite`) at registration so queries produce
  `POST /ingest/v1/db` rows automatically: normalized SQL, stable hash, query
  type, duration, status, rows affected, plus the active request's trace/span
  ids. Drivers are optional host peer deps (a missing driver turns that one
  integration off). Batched + fail-open. Gated by `enableDbInstrumentation`
  (default on). New `DbInstrumentation` / `DbQueryItem` exports and
  `normalizeQuery` / `hashQuery` / `detectQueryType` helpers.

### Added — pino log bridge
- Wraps Fastify's pino logger (root + per-request child loggers) so application
  and framework logs ship to `POST /ingest/v1/logs` automatically; the original
  pino call is preserved (stdout logs unchanged). Error/fatal logs are promoted
  with throwable details folded into the log metadata, and every log is stamped
  with the active request's trace/span/request ids. Value-scrubbed for PII.
  Gated by `enableLogBridge` (default on) with `logBridgeMinLevel`. New
  `LogBridge` / `parsePinoArgs` exports.

### Added — Automatic HTTP breadcrumbs
- An `http` breadcrumb (`http.server`) is recorded on the active request scope
  for every inbound request, so an error captured during that request carries it
  as context with no per-call `addBreadcrumb`. Gated by `enableAutoBreadcrumbs`
  (default on).

### Transport
- New batched `/ingest/v1/db` and per-record `/ingest/v1/logs` queues alongside
  the existing `/http-requests` and `/spans` batching, sharing the same
  redaction, retry/backoff, offline-spool, and `beforeSend` pipeline.

## [0.1.0] — 2026-05-29

Features landed on `main` since `v0.1.0-beta.4`.

### Added — Release-health session tracking
- Per-process release-health sessions: `POST /ingest/v1/sessions/start` on the
  Fastify `onReady` hook and `POST /ingest/v1/sessions/end` on `onClose`, with
  final status (`ok` / `errored` / `crashed`) and total duration, enabling
  crash-free session/user rates. Gated by `enableAutoSessionTracking`.
  Sessions are NEVER sampled and are NEVER spooled (a replayed stale session
  would skew durations). New `SessionTracker` / `SessionStatus` exports.

### Added — Offline / persistent transport queue
- Filesystem spool for un-sent, already-PII-scrubbed telemetry envelopes
  (Node/server analogue of an offline cache). On delivery failure (outage,
  retries exhausted, shutdown with buffered events) payloads are written one
  JSON file per envelope and replayed through the normal retry/backoff pipeline
  on the next init. Bounded by count, total bytes, and max age (drop-oldest);
  fully fail-open when the dir is not writable (read-only FS, serverless,
  sandbox). Gated by `enableOfflineQueue` with `offlineQueueDir`,
  `offlineQueueMaxEntries`, and byte/age limits. New `FileSpool` /
  `SpoolEnvelope` / `SpoolFs` / `FileSpoolOptions` exports.

### Added — Value-pattern PII scrubbing + sendDefaultPii
- Value-pattern (not just key-name) PII scrubbing with data-scrubbing
  parity: always redacts Luhn-valid credit-card numbers and hyphenated US SSNs;
  redacts email addresses and valid IPv4/IPv6 unless `sendDefaultPii` is true
  (default false). Conservative matchers (Luhn checksum, literal SSN hyphens)
  avoid nuking order ids / timestamps. Applied as defense-in-depth before the
  payload leaves the transport. New `sendDefaultPii` option.

### Added — Outbound (egress) HTTP instrumentation
- Distributed-trace propagation on outbound calls: subscribes to undici
  `diagnostics_channel` (global `fetch`, `undici.request`, most modern clients)
  and injects W3C `traceparent` + `baggage` and AllStak correlation headers
  continuing the active request's trace context (read from the ALS trace store),
  then emits a client span and an outbound `HttpRequestPayload`
  (`direction: 'outbound'`). The SDK's own ingest host is skipped to avoid a
  feedback loop. Gated by `captureOutboundHttp` (default on) and fully
  fail-open. New `OutboundInstrumentation` export and related option types.

### Added — Manual capture + scope API
- Manual `captureException` / `captureMessage` plus a scope API
  (user / tags / context) with per-request isolation via Node
  `AsyncLocalStorage`, so concurrently-served requests never cross-contaminate
  scope.

### Added — Runtime release auto-detection
- Auto-detects the runtime release from environment variables and local git
  (no CI step required) and auto-registers runtime releases, so release-health
  and error grouping get a release identifier out of the box.

### Added — Sampling for errors + tracesSampleRate
- Sampling extended to errors with a configurable `sampleRate`, plus a separate
  `tracesSampleRate` that drives the propagated W3C `sampled` flag
  independently of error sampling.

### Fixed — Transport
- Honor the `Retry-After` header on `429` / `503` responses instead of using
  the fixed backoff.

## [0.1.0-beta.4] — 2026-05-18

### Consolidation
Lands the full SDK source on the canonical AllStak repo (`redaction.ts`, `version.ts`, full `index.ts`, full test files). Prior betas were built from source files that never made it to `AllStak/allstak-fastify` on git.

### Added — Transport-level wire scrub + canonical denylist parity
- `redaction.ts` extended with 7 canonical terms: bearer, jwt, pwd, credit_card, card_number, cvv, ssn.
- `FastifyTransport.sendOnce` scrubs full payload before `JSON.stringify` — defense-in-depth. Pure, fail-open.

### Live canary E2E
- Verified against `api.allstak.sa`: zero leak positions across all ingested fields. Canary `should_not_leak_fastify` in 11 fields + 3-level-nested token — all scrubbed.

### Tests
- 16/16 vitest pass.

## [0.1.0-beta.1] - 2026-04-25

### Added
- Initial public release.
