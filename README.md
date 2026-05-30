# @allstak/fastify

AllStak SDK for Fastify. Captures inbound requests, errors, server spans, and distributed trace headers with one plugin.

## Install

```bash
npm install @allstak/fastify fastify
```

## Setup

```ts
import Fastify from 'fastify';
import allstakFastify from '@allstak/fastify';

const app = Fastify();

await app.register(allstakFastify, {
  apiKey: process.env.ALLSTAK_API_KEY,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.ALLSTAK_RELEASE,
  serviceName: 'checkout-api',
  captureRequestHeaders: true,
});

app.get('/health', async () => ({ ok: true }));
await app.listen({ port: 3000 });
```

## What is captured

Everything below is automatic after `register` — no per-call code.

- Request method, path, host, status code, duration, environment, release, and service.
- Unhandled route errors with stack traces and request correlation.
- **Fatal crashes**: process-global `uncaughtException` and `unhandledRejection`
  are captured at `fatal` level, mark the release-health session crashed, and
  are flushed before the process exits (Node exit semantics preserved).
- **Database queries**: `pg`, `mysql2`, and the SQLite family
  (`better-sqlite3` / `sqlite3` / `node:sqlite`) are auto-instrumented when
  installed — normalized SQL, query type, duration, status, rows affected, and
  the request's trace/span ids.
- **Logs**: Fastify's pino logger is bridged so application and framework logs
  ship to AllStak (your stdout logs are unchanged). Error/fatal logs are
  promoted with throwable details; every log carries the request trace/span ids.
- **Breadcrumbs**: an `http` breadcrumb is recorded per inbound request and
  attached to any error captured during that request.
- Server spans for each request, plus outbound HTTP client spans.
- Response propagation headers: `traceparent`, `baggage`, `allstak-baggage`, `x-allstak-trace-id`, and `x-allstak-request-id`.

Each feature is default-on and independently toggleable (see Configuration). To
record DB queries, install the relevant driver in your app:

```bash
npm install pg              # PostgreSQL
npm install mysql2          # MySQL
npm install better-sqlite3  # SQLite
```

## Configuration

| Option | Description |
| --- | --- |
| `apiKey` | Project API key. |
| `dsn` | Alias for `apiKey`. |
| `environment` | Deployment environment. |
| `release` | App version or commit SHA. |
| `serviceName` | Logical service name. |
| `captureRequestHeaders` | Capture redacted inbound headers. Default: `false`. |
| `sampleRate` | Request capture sample rate from `0` to `1`. |
| `beforeSend` | Optional hook to modify or drop outbound telemetry. |
| `enableDbInstrumentation` | Auto-instrument `pg` / `mysql2` / SQLite drivers. Default: `true`. |
| `enableLogBridge` | Bridge Fastify's pino logger to AllStak logs. Default: `true`. |
| `logBridgeMinLevel` | Minimum log level forwarded. Default: `info`. |
| `enableAutoBreadcrumbs` | Record an `http` breadcrumb per request. Default: `true`. |
| `enableCrashHandlers` | Install process-global crash handlers. Default: `true`. |
| `captureOutboundHttp` | Instrument outbound HTTP egress. Default: `true`. |
| `enableAutoSessionTracking` | Open a release-health session per process. Default: `true`. |
| `enableOfflineQueue` | Persist un-sent telemetry to disk and replay on restart. Default: `true` on Node. |

## Privacy

Sensitive header and metadata keys are redacted before telemetry is sent. Add `redactKeys` for application-specific fields.

## Troubleshooting

- No events: confirm the API key is present and the plugin is registered before routes.
- Missing request correlation: keep upstream `traceparent` or `x-request-id` headers when proxying traffic.
- Short-lived tests or scripts: wait briefly or call the plugin transport shutdown in your test harness.

## Contributing and Support

- Report bugs with the GitHub bug report template: https://github.com/AllStak/allstak-fastify/issues/new/choose
- Open pull requests using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT
