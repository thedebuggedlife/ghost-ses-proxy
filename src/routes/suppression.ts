import type { RequestHandler } from 'express';
import type { Deps, SuppressionType } from '../types';

const VALID_TYPES: ReadonlySet<string> = new Set<SuppressionType>([
  'bounces',
  'complaints',
  'unsubscribes',
]);

export interface SuppressionParams {
  domain: string;
  type: string;
  email: string;
}

export function createSuppressionRoute(
  deps: Pick<Deps, 'db' | 'logger' | 'metrics'>,
): RequestHandler<SuppressionParams> {
  const log = deps.logger.child({ component: 'suppression' });

  return function deleteSuppression(req, res) {
    const { type } = req.params;
    // Express has already decoded the param; the second pass is preserved from
    // `lib/suppression-api.js` so double-encoded addresses resolve identically.
    const email = decodeURIComponent(req.params.email);

    if (!VALID_TYPES.has(type)) {
      log.warn({ type }, 'unknown suppression type');
      res.status(404).json({ message: `Unknown suppression type: ${type}` });
      return;
    }

    const removed = deps.db.deleteSuppression(email, type);
    deps.metrics.suppressionsRemovedTotal.inc({ type });
    log.info({ recipient: email, type, removed }, 'suppression removed');

    res.json({
      message: 'Address has been removed',
      value: '',
      address: email,
    });
  };
}
