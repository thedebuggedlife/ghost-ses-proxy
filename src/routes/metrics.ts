import type { RequestHandler } from 'express';
import type { Registry } from 'prom-client';

export function createMetricsRoute(register: Registry): RequestHandler {
  return function metrics(_req, res, next) {
    void register.metrics().then((body) => {
      // `res.send` would reorder the content-type parameters; `end` preserves them.
      res.set('Content-Type', register.contentType).end(body);
    }, next);
  };
}
