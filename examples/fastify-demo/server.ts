import Fastify from 'fastify';
import allstak from '@allstak/fastify';

const fastify = Fastify({ logger: true });

// Register AllStak plugin — hooks into onRequest / onResponse / onError
// automatically for every route.
fastify.register(allstak, {
  apiKey: process.env.ALLSTAK_API_KEY || 'ask_dev_demo_key',
  host: process.env.ALLSTAK_HOST || 'https://api.allstak.sa',
  environment: 'development',
  release: '1.0.0',
  serviceName: 'fastify-demo',
});

// Health / status endpoint
fastify.get('/', async () => {
  return { status: 'ok', service: 'fastify-demo' };
});

// Error capture demo — AllStak's onError hook captures the thrown error
// and sends it to /ingest/v1/errors with full stack trace.
fastify.get('/error', async () => {
  throw new Error('Demo error — captured by AllStak');
});

// Tracing demo — makes an outbound fetch call so you can verify
// trace context propagation (traceparent header) in AllStak's dashboard.
fastify.get('/trace', async (request) => {
  const traceId = (request as any).allstakTraceId ?? 'unknown';

  const response = await fetch('https://httpbin.org/get', {
    headers: { traceparent: `00-${traceId}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}-01` },
  });

  const data = await response.json();
  return {
    message: 'Outbound call completed',
    traceId,
    upstream: { status: response.status, url: data.url },
  };
});

// Parameterized route demo — AllStak records the path as /user/:id,
// keeping cardinality low in the dashboard.
fastify.get<{ Params: { id: string } }>('/user/:id', async (request) => {
  const { id } = request.params;
  return {
    user: { id, name: `User ${id}`, email: `user-${id}@example.com` },
  };
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('Fastify demo listening on http://localhost:3000');
    console.log('Routes:');
    console.log('  GET /         — status check');
    console.log('  GET /error    — error capture demo');
    console.log('  GET /trace    — outbound fetch tracing demo');
    console.log('  GET /user/:id — parameterized route demo');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
