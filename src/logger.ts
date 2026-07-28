import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';
import type { Config } from './types';

/**
 * Reads the version through an untyped `require` so `package.json` never enters
 * the build program — a typed import widens `rootDir` and relocates `dist/`.
 */
export function getVersion(load?: (id: string) => unknown): string {
  try {
    const req = load ?? require;
    return (req('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export function createLogger(
  config: Config,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: { service: 'ghost-ses-proxy', version: getVersion() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  };

  return destination ? pino(options, destination) : pino(options);
}
