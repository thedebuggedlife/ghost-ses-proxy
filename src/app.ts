import express, { type Express } from 'express';
import { createAuthMiddleware } from './middleware/auth';
import { createHttpLogger, createHttpMetrics } from './middleware/observability';
import { createEventsRoute } from './routes/events';
import { createHealthRoute } from './routes/health';
import { createMetricsRoute } from './routes/metrics';
import { createSendEmailRoute } from './routes/send-email';
import { createSuppressionRoute } from './routes/suppression';
import type { Deps, Stats } from './types';

export type AppDeps = Deps & { stats: Stats };

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(createHttpLogger(deps));
  app.use(createHttpMetrics(deps));

  app.get('/health', createHealthRoute(deps.stats));
  app.get('/metrics', createMetricsRoute(deps.metrics.register));

  app.use('/v3', createAuthMiddleware(deps.config));

  // --- /v3 routes, in `server.js` registration order ---

  app.post('/v3/:domain/messages', createSendEmailRoute(deps));

  app.get('/v3/:domain/events', createEventsRoute(deps));
  app.get('/v3/:domain/events/:pageToken', createEventsRoute(deps));

  app.delete('/v3/:domain/:type/:email', createSuppressionRoute(deps));

  return app;
}
