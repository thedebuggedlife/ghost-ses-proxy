import express, { type Express } from 'express';
import { createAuthMiddleware } from './middleware/auth';
import { createHttpLogger, createHttpMetrics } from './middleware/observability';
import { createHealthRoute } from './routes/health';
import { createMetricsRoute } from './routes/metrics';
import type { Deps, Stats } from './types';

export type AppDeps = Deps & { stats: Stats };

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use(createHttpLogger(deps));
  app.use(createHttpMetrics(deps));

  app.get('/health', createHealthRoute(deps.stats));
  app.get('/metrics', createMetricsRoute(deps.metrics.register));

  app.use('/v3', createAuthMiddleware(deps.config));

  // --- /v3 routes are registered here (Phases 12 and 13) ---

  return app;
}
