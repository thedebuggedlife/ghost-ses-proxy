import type { RequestHandler } from 'express';
import type { Config } from '../types';

/** Ghost's mailgun.js sends `Authorization: Basic base64("api:" + apiKey)`. */
export function createAuthMiddleware(config: Config): RequestHandler {
  return function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.status(401).json({ message: 'Unauthorized: missing credentials' });
      return;
    }

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');

    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      res.status(401).json({ message: 'Unauthorized: invalid credentials' });
      return;
    }

    const password = decoded.slice(colonIndex + 1);
    if (password !== config.proxyApiKey) {
      res.status(401).json({ message: 'Unauthorized: invalid API key' });
      return;
    }

    next();
  };
}
