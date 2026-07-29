import { describe, expect, it } from 'vitest';
import { ConfigError, LOG_LEVELS, loadConfig } from '../src/config';

const baseEnv = (): NodeJS.ProcessEnv => ({
  AWS_ACCESS_KEY_ID: 'AKIAFAKE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/fake',
  PROXY_API_KEY: 'test-key',
  MAILGUN_DOMAIN: 'example.com',
});

describe('loadConfig — required variables', () => {
  it('names every missing variable in a single ConfigError', () => {
    let thrown: unknown;
    try {
      loadConfig({});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).name).toBe('ConfigError');
    const message = (thrown as ConfigError).message;
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'SQS_QUEUE_URL',
      'PROXY_API_KEY',
      'MAILGUN_DOMAIN',
    ]) {
      expect(message).toContain(name);
    }
  });

  it('names only the variables that are actually missing', () => {
    const env = baseEnv();
    delete env.PROXY_API_KEY;

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/PROXY_API_KEY/);
    try {
      loadConfig(env);
    } catch (err) {
      expect((err as ConfigError).message).not.toContain('MAILGUN_DOMAIN');
    }
  });

  it('treats an empty string as missing', () => {
    const env = { ...baseEnv(), MAILGUN_DOMAIN: '' };
    expect(() => loadConfig(env)).toThrow(/MAILGUN_DOMAIN/);
  });

  it('does not mutate the injected env object', () => {
    const env = baseEnv();
    const snapshot = { ...env };
    loadConfig(env);
    expect(env).toEqual(snapshot);
  });
});

describe('loadConfig — defaults', () => {
  it('applies every default when only required vars are present', () => {
    const config = loadConfig(baseEnv());

    expect(config).toEqual({
      port: 3003,
      awsAccessKeyId: 'AKIAFAKE',
      awsSecretAccessKey: 'secret',
      awsRegion: 'us-east-1',
      sesConfigurationSet: 'ghost-ses-proxy',
      sqsQueueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/fake',
      proxyApiKey: 'test-key',
      mailgunDomain: 'example.com',
      logLevel: 'info',
      sendConcurrency: 10,
      dbPath: '/data/ses-proxy.db',
    });
  });

  it('honours overrides for the optional variables', () => {
    const config = loadConfig({
      ...baseEnv(),
      AWS_REGION: 'eu-west-1',
      SES_CONFIGURATION_SET: 'other-set',
      PORT: '8080',
      SEND_CONCURRENCY: '25',
      LOG_LEVEL: 'debug',
      DB_PATH: ':memory:',
    });

    expect(config.awsRegion).toBe('eu-west-1');
    expect(config.sesConfigurationSet).toBe('other-set');
    expect(config.port).toBe(8080);
    expect(config.sendConcurrency).toBe(25);
    expect(config.logLevel).toBe('debug');
    expect(config.dbPath).toBe(':memory:');
  });

  it('falls back to defaults when optional variables are blank', () => {
    const config = loadConfig({
      ...baseEnv(),
      AWS_REGION: '',
      SES_CONFIGURATION_SET: '',
      PORT: '',
      SEND_CONCURRENCY: '   ',
      LOG_LEVEL: '',
      DB_PATH: '',
    });

    expect(config.awsRegion).toBe('us-east-1');
    expect(config.sesConfigurationSet).toBe('ghost-ses-proxy');
    expect(config.port).toBe(3003);
    expect(config.sendConcurrency).toBe(10);
    expect(config.logLevel).toBe('info');
    expect(config.dbPath).toBe('/data/ses-proxy.db');
  });
});

describe('loadConfig — LOG_LEVEL validation', () => {
  it.each(LOG_LEVELS)('accepts %s', (level) => {
    expect(loadConfig({ ...baseEnv(), LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it('trims surrounding whitespace', () => {
    expect(loadConfig({ ...baseEnv(), LOG_LEVEL: '  warn  ' }).logLevel).toBe('warn');
  });

  it.each(['verbose', 'INFO', 'silly', '0'])('rejects %s', (level) => {
    expect(() => loadConfig({ ...baseEnv(), LOG_LEVEL: level })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv(), LOG_LEVEL: level })).toThrow(/LOG_LEVEL/);
  });
});

describe('loadConfig — integer parsing', () => {
  it.each(['PORT', 'SEND_CONCURRENCY'])('parses %s as an integer', (name) => {
    const config = loadConfig({ ...baseEnv(), [name]: ' 42 ' });
    expect(name === 'PORT' ? config.port : config.sendConcurrency).toBe(42);
  });

  it.each(['abc', '12abc', '1.5', '-1', '0', 'NaN'])(
    'rejects PORT=%s',
    (value) => {
      expect(() => loadConfig({ ...baseEnv(), PORT: value })).toThrow(ConfigError);
      expect(() => loadConfig({ ...baseEnv(), PORT: value })).toThrow(/PORT/);
    },
  );

  it('rejects a non-numeric SEND_CONCURRENCY', () => {
    expect(() => loadConfig({ ...baseEnv(), SEND_CONCURRENCY: 'ten' })).toThrow(
      /SEND_CONCURRENCY/,
    );
  });

  it('reports every problem in one error', () => {
    let message = '';
    try {
      loadConfig({ PORT: 'abc', SEND_CONCURRENCY: 'x', LOG_LEVEL: 'loud' });
    } catch (err) {
      message = (err as ConfigError).message;
    }

    expect(message).toContain('Missing required environment variables');
    expect(message).toContain('PORT');
    expect(message).toContain('SEND_CONCURRENCY');
    expect(message).toContain('LOG_LEVEL');
  });
});
