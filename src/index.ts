const DEFAULT_HOST = 'https://api.allstak.sa';

export interface AllStakFastifyConfig {
  apiKey: string;
  host?: string;
  environment?: string;
  release?: string;
  serviceName?: string;
}

interface FastifyRequestLike {
  method: string;
  url: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: string | number; email?: string };
  allstakStartedAt?: number;
}

interface FastifyReplyLike {
  statusCode: number;
}

interface FastifyLike {
  addHook(name: 'onRequest' | 'onResponse', fn: (...args: any[]) => void): void;
  setErrorHandler?(fn: (error: Error, request: FastifyRequestLike, reply: FastifyReplyLike) => void): void;
}

function normalizeHost(host?: string): string {
  return (host || DEFAULT_HOST).replace(/\/$/, '');
}

function pathOnly(url: string): string {
  const index = url.indexOf('?');
  return index >= 0 ? url.slice(0, index) : url || '/';
}

function requestHost(request: FastifyRequestLike): string {
  const header = request.headers.host;
  return typeof header === 'string' ? header : request.hostname || 'unknown';
}

async function send(config: AllStakFastifyConfig, path: string, payload: unknown): Promise<void> {
  await fetch(`${normalizeHost(config.host)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AllStak-Key': config.apiKey,
    },
    body: JSON.stringify(payload),
  });
}

export function allstakFastify(fastify: FastifyLike, config: AllStakFastifyConfig): void {
  fastify.addHook('onRequest', (request: FastifyRequestLike, _reply: FastifyReplyLike, done: (err?: Error) => void) => {
    request.allstakStartedAt = Date.now();
    done();
  });

  fastify.addHook('onResponse', (request: FastifyRequestLike, reply: FastifyReplyLike, done: (err?: Error) => void) => {
    const startedAt = request.allstakStartedAt || Date.now();
    const userId = request.user?.id == null ? undefined : String(request.user.id);
    void send(config, '/ingest/v1/http-requests', {
      requests: [{
        direction: 'inbound',
        method: request.method.toUpperCase(),
        host: requestHost(request),
        path: pathOnly(request.url),
        statusCode: reply.statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        timestamp: new Date(startedAt).toISOString(),
        environment: config.environment || '',
        release: config.release || '',
        service: config.serviceName || '',
        userId,
      }],
    }).catch(() => undefined);
    done();
  });

  fastify.setErrorHandler?.((error: Error, request: FastifyRequestLike, _reply: FastifyReplyLike) => {
    void send(config, '/ingest/v1/errors', {
      exceptionClass: error.name || 'Error',
      message: error.message,
      stackTrace: error.stack ? error.stack.split('\n') : [],
      level: 'error',
      environment: config.environment || '',
      release: config.release || '',
      metadata: {
        sdkName: '@allstak/fastify',
        service: config.serviceName || '',
        httpMethod: request.method,
        httpPath: pathOnly(request.url),
      },
    }).catch(() => undefined);
    throw error;
  });
}

export default allstakFastify;
