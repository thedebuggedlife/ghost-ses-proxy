import type { Config, LogLevel } from './types';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const REQUIRED = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'SQS_QUEUE_URL',
  'PROXY_API_KEY',
  'MAILGUN_DOMAIN',
] as const;

export const LOG_LEVELS: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

const DEFAULTS = {
  AWS_REGION: 'us-east-1',
  SES_CONFIGURATION_SET: 'ghost-ses-proxy',
  PORT: 3003,
  SEND_CONCURRENCY: 10,
  LOG_LEVEL: 'info' as LogLevel,
  DB_PATH: '/data/ses-proxy.db',
};

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    problems.push(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const readPositiveInt = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
      problems.push(`${name} must be a positive integer, got "${raw}"`);
      return fallback;
    }
    return Number(trimmed);
  };

  const port = readPositiveInt('PORT', DEFAULTS.PORT);
  const sendConcurrency = readPositiveInt('SEND_CONCURRENCY', DEFAULTS.SEND_CONCURRENCY);

  const rawLogLevel = env.LOG_LEVEL;
  let logLevel: LogLevel = DEFAULTS.LOG_LEVEL;
  if (rawLogLevel !== undefined && rawLogLevel.trim() !== '') {
    const candidate = rawLogLevel.trim();
    if (isLogLevel(candidate)) {
      logLevel = candidate;
    } else {
      problems.push(
        `LOG_LEVEL must be one of ${LOG_LEVELS.join('|')}, got "${rawLogLevel}"`,
      );
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems.join('; '));
  }

  return {
    port,
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID as string,
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
    awsRegion: env.AWS_REGION || DEFAULTS.AWS_REGION,
    sesConfigurationSet: env.SES_CONFIGURATION_SET || DEFAULTS.SES_CONFIGURATION_SET,
    sqsQueueUrl: env.SQS_QUEUE_URL as string,
    proxyApiKey: env.PROXY_API_KEY as string,
    mailgunDomain: env.MAILGUN_DOMAIN as string,
    logLevel,
    sendConcurrency,
    dbPath: env.DB_PATH || DEFAULTS.DB_PATH,
  };
}
