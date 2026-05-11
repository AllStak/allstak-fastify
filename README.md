# @allstak/fastify

**AllStak error tracking and request telemetry for Fastify.**

[![npm version](https://img.shields.io/npm/v/@allstak/fastify.svg)](https://www.npmjs.com/package/@allstak/fastify)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

AllStak SDK for Fastify (beta) — captures errors, inbound request telemetry, and distributed traces as a Fastify plugin. Independently installable with no dependency on other `@allstak/*` packages at runtime.

## Installation

```sh
npm install @allstak/fastify
```

## Quick Start

```ts
import Fastify from "fastify";
import allstakFastify from "@allstak/fastify";

const app = Fastify();
await app.register(allstakFastify, {
  dsn: process.env.ALLSTAK_DSN,
  endpoint: "https://api.allstak.sa",
  release: process.env.RELEASE,
  environment: process.env.NODE_ENV,
});
```

The plugin is wrapped with `fastify-plugin`, so hooks apply globally even when
registered inside an encapsulated child context.

## Configuration Reference

| Option          | Type     | Default                   | Description                                  |
| --------------- | -------- | ------------------------- | -------------------------------------------- |
| `apiKey`        | `string` | —                         | AllStak API key (alternative to `dsn`)       |
| `dsn`           | `string` | —                         | AllStak DSN (alternative to `apiKey`)        |
| `host`          | `string` | `https://api.allstak.sa`  | Ingest API base URL (alternative to `endpoint`) |
| `endpoint`      | `string` | `https://api.allstak.sa`  | Ingest API base URL (alternative to `host`)  |
| `environment`   | `string` | `""`                      | Environment tag (e.g. `production`, `staging`) |
| `release`       | `string` | `""`                      | Release/version identifier                   |
| `serviceName`   | `string` | `""`                      | Logical service name for filtering           |

Either `apiKey` or `dsn` must be set — without one, telemetry is silently dropped.

## Trace Propagation

The plugin automatically participates in W3C `traceparent` propagation:

```
           ┌──────────────┐         ┌──────────────┐
           │  Upstream    │         │  Your Fastify │
           │  Service     │────────▶│  App          │
           └──────────────┘         └──────────────┘
  traceparent: 00-<traceId>-<spanId>-01
                                     │
                                     ▼
                              Response headers:
                              traceparent: 00-<traceId>-<newSpanId>-01
                              x-allstak-trace-id: <traceId>
                              x-allstak-request-id: <requestId>
```

**Inbound:** If the incoming request carries a `traceparent` header, the SDK
extracts the trace ID and parent span ID. It also respects `x-allstak-trace-id`,
`x-allstak-request-id`, and `x-request-id` headers from upstream callers.

**Outbound:** Every response includes `traceparent`, `x-allstak-trace-id`, and
`x-allstak-request-id` headers so downstream services can continue the trace.

The trace context is attached to the request object as `request.allstakTraceId`,
`request.allstakSpanId`, and `request.allstakRequestId` for use in handlers:

```ts
app.get("/order/:id", async (req) => {
  console.log("trace:", req.allstakTraceId);
  // Forward to downstream service:
  await fetch("https://billing.internal/charge", {
    headers: { traceparent: `00-${req.allstakTraceId}-${req.allstakSpanId}-01` },
  });
});
```

## License

MIT © AllStak
