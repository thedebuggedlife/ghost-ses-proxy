import type { RequestHandler } from 'express';
import { SUPPRESSION_TYPES } from '../metrics';
import type { Deps, SuppressionType } from '../types';

const VALID_TYPES: ReadonlySet<string> = new Set<SuppressionType>(
  SUPPRESSION_TYPES,
);

function isSuppressionType(value: string): value is SuppressionType {
  return VALID_TYPES.has(value);
}

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

    if (!isSuppressionType(type)) {
      log.warn({ type }, 'unknown suppression type');
      res.status(404).json({ message: `Unknown suppression type: ${type}` });
      return;
    }

    const removed = deps.db.deleteSuppression(email, type);
    // Counts rows actually deleted, not delete requests — Ghost re-sends these
    // for addresses that were never suppressed, and those are not removals.
    if (removed > 0) {
      deps.metrics.suppressionsRemovedTotal.inc({ type }, removed);
    }
    log.info({ recipient: email, type, removed }, 'suppression removed');

    res.json({
      message: 'Address has been removed',
      value: '',
      address: email,
    });
  };
}
