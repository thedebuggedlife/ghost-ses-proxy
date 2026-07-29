import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { Deps } from '../types';

export const UNMATCHED_ROUTE = 'unmatched';

/** Excluded from access logging only — metrics still count these (design §3, P5). */
export const ACCESS_LOG_IGNORED_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/metrics',
]);

interface RoutedRequest {
  baseUrl?: string;
  originalUrl?: string;
  route?: { path?: unknown };
}

/**
 * The Express route template, never the raw path: `DELETE /v3/:domain/:type/:email`
 * embeds a subscriber address, which would leak PII into Prometheus and make
 * cardinality unbounded.
 */
export function routeLabel(req: IncomingMessage): string {
  const { baseUrl, route } = req as IncomingMessage & RoutedRequest;
  if (typeof route?.path !== 'string') return UNMATCHED_ROUTE;
  return `${typeof baseUrl === 'string' ? baseUrl : ''}${route.path}`;
}

/** Path without the query string, as seen before routing rewrites `req.url`. */
export function requestPath(url: string | undefined): string {
  const value = url ?? '';
  const query = value.indexOf('?');
  return query === -1 ? value : value.slice(0, query);
}

export interface SerializedRequest {
  method: string | undefined;
  url: string;
}

export function serializeRequest(req: IncomingMessage): SerializedRequest {
  const { originalUrl } = req as IncomingMessage & RoutedRequest;
  return {
    method: req.method,
    url: originalUrl ?? req.url ?? '',
  };
}

export interface SerializedResponse {
  statusCode: number;
}

export function serializeResponse(res: ServerResponse): SerializedResponse {
  return { statusCode: res.statusCode };
}

export function createHttpLogger(deps: Pick<Deps, 'logger'>): RequestHandler {
  const middleware = pinoHttp({
    logger: deps.logger.child({ component: 'http' }),
    genReqId: () => randomUUID(),
    quietReqLogger: true,
    // Without this the custom serializers receive pino-std-serializers' output,
    // which has already dropped `route` and rewritten `url`.
    wrapSerializers: false,
    customLogLevel: (_req, res) => {
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: {
      ignore: (req) => ACCESS_LOG_IGNORED_PATHS.has(requestPath(req.url)),
    },
    // `route` cannot live in the req serializer: pino resolves child bindings
    // eagerly, and routing has not happened when pino-http binds the request.
    customSuccessObject: (req, _res, val: object) => ({
      ...val,
      route: routeLabel(req),
    }),
    customErrorObject: (req, _res, _err, val: object) => ({
      ...val,
      route: routeLabel(req),
    }),
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
    },
  });

  return middleware as unknown as RequestHandler;
}

export function createHttpMetrics(deps: Pick<Deps, 'metrics'>): RequestHandler {
  const { httpRequestsTotal, httpRequestDurationSeconds } = deps.metrics;

  return function httpMetrics(req, res, next) {
    const startedAt = performance.now();

    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: routeLabel(req),
        status_code: String(res.statusCode),
      };
      httpRequestsTotal.inc(labels);
      httpRequestDurationSeconds.observe(
        labels,
        (performance.now() - startedAt) / 1000,
      );
    });

    next();
  };
}
