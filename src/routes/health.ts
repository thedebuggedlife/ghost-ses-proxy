import type { RequestHandler } from 'express';
import type { Stats } from '../types';

export function createHealthRoute(stats: Stats): RequestHandler {
  return function health(_req, res) {
    res.json({ status: 'ok', tables: stats.getCounts() });
  };
}
