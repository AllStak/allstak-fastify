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

- Request method, path, host, status code, duration, environment, release, and service.
- Unhandled route errors with stack traces and request correlation.
- Server spans for each request.
- Response propagation headers: `traceparent`, `baggage`, `allstak-baggage`, `x-allstak-trace-id`, and `x-allstak-request-id`.

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

## Privacy

Sensitive header and metadata keys are redacted before telemetry is sent. Add `redactKeys` for application-specific fields.

## Troubleshooting

- No events: confirm the API key is present and the plugin is registered before routes.
- Missing request correlation: keep upstream `traceparent` or `x-request-id` headers when proxying traffic.
- Short-lived tests or scripts: wait briefly or call the plugin transport shutdown in your test harness.

## License

MIT
