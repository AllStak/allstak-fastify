# AllStak Fastify Demo

Minimal Fastify app demonstrating the `@allstak/fastify` plugin for request tracing, error capture, and outbound call instrumentation.

## Setup

```bash
# Install dependencies (links the local SDK via file:../../)
npm install

# Copy and fill in your API key
cp .env.example .env

# Start the server
npm start
```

The server starts on `http://localhost:3000`.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Returns `{ status: "ok" }` — verifies request/response telemetry |
| `GET /error` | Throws an error — demonstrates automatic error capture |
| `GET /trace` | Makes an outbound `fetch` to httpbin.org — demonstrates trace propagation |
| `GET /user/:id` | Parameterized route — shows low-cardinality path grouping |

## What gets sent to AllStak

- **Every request**: method, path, status code, duration, trace IDs via `onResponse` hook
- **Errors**: exception class, message, stack trace via `onError` hook
- **Trace context**: `traceparent` and `x-allstak-trace-id` headers are set on responses automatically
