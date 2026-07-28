import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger, getVersion } from '../src/logger';
import type { Config, LogLevel } from '../src/types';
import pkg from '../package.json';

const makeConfig = (logLevel: LogLevel = 'info'): Config => ({
  port: 3003,
  awsAccessKeyId: 'AKIAFAKE',
  awsSecretAccessKey: 'secret',
  awsRegion: 'us-east-1',
  sesConfigurationSet: 'ghost-ses-proxy',
  sqsQueueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/fake',
  proxyApiKey: 'test-key',
  mailgunDomain: 'example.com',
  logLevel,
  sendConcurrency: 10,
  dbPath: ':memory:',
});

interface Capture {
  lines: Record<string, unknown>[];
  stream: DestinationStream;
}

function capture(): Capture {
  const lines: Record<string, unknown>[] = [];
  const stream: DestinationStream = {
    write(chunk: string): void {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') lines.push(JSON.parse(line));
      }
    },
  };
  return { lines, stream };
}

describe('getVersion', () => {
  it('reads the version from package.json', () => {
    expect(getVersion()).toBe(pkg.version);
  });

  it('falls back to "unknown" when the version cannot be read', () => {
    expect(
      getVersion(() => {
        throw new Error('ENOENT');
      }),
    ).toBe('unknown');
  });
});

describe('createLogger — line shape', () => {
  it('emits level as a string, not pino numeric default', () => {
    const { lines, stream } = capture();
    createLogger(makeConfig(), stream).info('hello');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('info');
    expect(typeof lines[0]?.level).toBe('string');
  });

  it('emits an ISO-8601 time field', () => {
    const { lines, stream } = capture();
    createLogger(makeConfig(), stream).info('hello');

    const time = lines[0]?.time;
    expect(typeof time).toBe('string');
    expect(time as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(time as string))).toBe(false);
  });

  it('carries service and version on every line', () => {
    const { lines, stream } = capture();
    const logger = createLogger(makeConfig('trace'), stream);
    logger.trace('a');
    logger.info('b');
    logger.error('c');

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.service).toBe('ghost-ses-proxy');
      expect(line.version).toBe(pkg.version);
    }
  });

  it('preserves msg and extra fields', () => {
    const { lines, stream } = capture();
    createLogger(makeConfig(), stream).info(
      { recipient: 'alice@example.com', durationMs: 12 },
      'sent',
    );

    expect(lines[0]?.msg).toBe('sent');
    expect(lines[0]?.recipient).toBe('alice@example.com');
    expect(lines[0]?.durationMs).toBe(12);
  });

  it('writes error-level lines to the same destination as info', () => {
    const { lines, stream } = capture();
    const logger = createLogger(makeConfig(), stream);
    logger.info('one');
    logger.error('two');

    expect(lines.map((l) => l.level)).toEqual(['info', 'error']);
  });
});

describe('createLogger — level gating', () => {
  it('suppresses info and below when the level is warn', () => {
    const { lines, stream } = capture();
    const logger = createLogger(makeConfig('warn'), stream);
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');

    expect(lines.map((l) => l.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('emits everything at trace', () => {
    const { lines, stream } = capture();
    const logger = createLogger(makeConfig('trace'), stream);
    logger.trace('t');
    logger.debug('d');
    logger.info('i');

    expect(lines).toHaveLength(3);
  });
});

describe('createLogger — redaction', () => {
  it('redacts req.headers.authorization', () => {
    const { lines, stream } = capture();
    createLogger(makeConfig(), stream).info(
      {
        req: {
          method: 'POST',
          headers: { authorization: 'Basic c2VjcmV0', 'user-agent': 'ghost' },
        },
      },
      'request',
    );

    const req = lines[0]?.req as { headers: Record<string, string> };
    expect(req.headers.authorization).toBe('[Redacted]');
    expect(req.headers['user-agent']).toBe('ghost');
  });

  it('redacts req.headers.cookie', () => {
    const { lines, stream } = capture();
    createLogger(makeConfig(), stream).info(
      { req: { headers: { cookie: 'session=abc' } } },
      'request',
    );

    const req = lines[0]?.req as { headers: Record<string, string> };
    expect(req.headers.cookie).toBe('[Redacted]');
  });
});

describe('createLogger — child bindings', () => {
  it('propagates child bindings onto every child line', () => {
    const { lines, stream } = capture();
    const logger = createLogger(makeConfig(), stream);
    const child = logger.child({ component: 'send' });
    child.info({ batchId: 'b-1' }, 'sending');
    logger.info('parent');

    expect(lines[0]?.component).toBe('send');
    expect(lines[0]?.batchId).toBe('b-1');
    expect(lines[0]?.service).toBe('ghost-ses-proxy');
    expect(lines[1]?.component).toBeUndefined();
  });
});

describe('createLogger — default destination', () => {
  it('constructs without a destination', () => {
    const logger = createLogger(makeConfig('fatal'));
    expect(logger.level).toBe('fatal');
  });
});
