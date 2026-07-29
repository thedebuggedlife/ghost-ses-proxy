import { describe, expect, it } from 'vitest';
import {
  MANAGED_KEYS,
  ensureProxyApiKey,
  formatEnvFile,
  generateApiKey,
  hasProxyApiKey,
  mergeEnvFile,
  parseEnvContent,
} from '../scripts/generate-proxy-env.js';

const MANAGED: Record<string, string> = {
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret-value',
  AWS_REGION: 'eu-west-1',
  SQS_QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/123456789012/ghost-ses-proxy-events',
  SES_CONFIGURATION_SET: 'ghost-ses-proxy',
  MAILGUN_DOMAIN: 'example.com',
};

const EXISTING_FILE = `# AWS credentials (IAM user with SES send + SQS receive permissions)
AWS_ACCESS_KEY_ID=AKIAOLD
AWS_SECRET_ACCESS_KEY=old-secret
AWS_REGION=us-east-1

# SQS queue URL (receives SES events via SNS)
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/999999999999/old-queue

# SES Configuration Set name
SES_CONFIGURATION_SET=old-config-set

PROXY_API_KEY=existing-api-key
MAILGUN_DOMAIN=old.example.com

# Optional: port to listen on (default: 3003)
PORT=3003
SOME_UNKNOWN_KEY=keep-me
`;

function run(content: string, generate = () => 'generated-key'): string {
  const lines = parseEnvContent(content);
  return formatEnvFile(ensureProxyApiKey(mergeEnvFile(lines, MANAGED), generate));
}

describe('parseEnvContent / formatEnvFile', () => {
  it('round-trips a file with a trailing newline', () => {
    expect(formatEnvFile(parseEnvContent(EXISTING_FILE))).toBe(EXISTING_FILE);
  });

  it('treats empty content as no lines', () => {
    expect(parseEnvContent('')).toEqual([]);
    expect(formatEnvFile([])).toBe('');
  });
});

describe('mergeEnvFile', () => {
  it('writes every managed key when the file is empty', () => {
    const result = mergeEnvFile([], MANAGED);
    expect(result).toEqual([
      'AWS_ACCESS_KEY_ID=AKIAEXAMPLE',
      'AWS_SECRET_ACCESS_KEY=secret-value',
      'AWS_REGION=eu-west-1',
      'SQS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/123456789012/ghost-ses-proxy-events',
      'SES_CONFIGURATION_SET=ghost-ses-proxy',
      'MAILGUN_DOMAIN=example.com',
    ]);
    for (const key of MANAGED_KEYS) {
      expect(result.some((line) => line.startsWith(`${key}=`))).toBe(true);
    }
  });

  it('replaces managed values in place without reordering', () => {
    const lines = mergeEnvFile(parseEnvContent(EXISTING_FILE), MANAGED);
    expect(lines[0]).toBe('# AWS credentials (IAM user with SES send + SQS receive permissions)');
    expect(lines[1]).toBe('AWS_ACCESS_KEY_ID=AKIAEXAMPLE');
    expect(lines[2]).toBe('AWS_SECRET_ACCESS_KEY=secret-value');
    expect(lines[3]).toBe('AWS_REGION=eu-west-1');
    expect(lines[4]).toBe('');
    expect(lines.indexOf('MAILGUN_DOMAIN=example.com')).toBeLessThan(
      lines.indexOf('# Optional: port to listen on (default: 3003)'),
    );
  });

  it('preserves comments, blank lines, PORT and unknown keys verbatim', () => {
    const lines = mergeEnvFile(parseEnvContent(EXISTING_FILE), MANAGED);
    expect(lines).toContain('# SQS queue URL (receives SES events via SNS)');
    expect(lines).toContain('# Optional: port to listen on (default: 3003)');
    expect(lines).toContain('PORT=3003');
    expect(lines).toContain('SOME_UNKNOWN_KEY=keep-me');
    expect(lines.filter((line) => line === '')).toHaveLength(4);
  });

  it('appends only the managed keys that were absent', () => {
    const lines = mergeEnvFile(['AWS_REGION=us-east-1', 'PORT=3003'], MANAGED);
    expect(lines[0]).toBe('AWS_REGION=eu-west-1');
    expect(lines[1]).toBe('PORT=3003');
    expect(lines.slice(2)).toEqual([
      'AWS_ACCESS_KEY_ID=AKIAEXAMPLE',
      'AWS_SECRET_ACCESS_KEY=secret-value',
      'SQS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/123456789012/ghost-ses-proxy-events',
      'SES_CONFIGURATION_SET=ghost-ses-proxy',
      'MAILGUN_DOMAIN=example.com',
    ]);
  });

  it('rewrites every duplicate of a managed key', () => {
    const lines = mergeEnvFile(['AWS_REGION=us-east-1', 'AWS_REGION=us-west-2'], {
      AWS_REGION: 'eu-west-1',
    });
    expect(lines).toEqual(['AWS_REGION=eu-west-1', 'AWS_REGION=eu-west-1']);
  });

  it('ignores commented-out assignments', () => {
    const lines = mergeEnvFile(['# AWS_REGION=us-east-1'], { AWS_REGION: 'eu-west-1' });
    expect(lines).toEqual(['# AWS_REGION=us-east-1', 'AWS_REGION=eu-west-1']);
  });
});

describe('ensureProxyApiKey', () => {
  it('appends a generated key when none is present', () => {
    expect(ensureProxyApiKey([], () => 'abc123')).toEqual(['PROXY_API_KEY=abc123']);
  });

  it('leaves an existing key untouched', () => {
    const lines = ['PROXY_API_KEY=existing-api-key', 'PORT=3003'];
    expect(ensureProxyApiKey(lines, () => 'abc123')).toEqual(lines);
  });

  it('detects an existing key regardless of surrounding whitespace', () => {
    expect(hasProxyApiKey(['  PROXY_API_KEY = existing'])).toBe(true);
    expect(hasProxyApiKey(['# PROXY_API_KEY=commented'])).toBe(false);
  });

  it('generates 32 bytes of hex', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(generateApiKey());
  });
});

describe('full merge', () => {
  it('produces all managed keys plus a generated PROXY_API_KEY from an empty file', () => {
    expect(run('')).toBe(
      [
        'AWS_ACCESS_KEY_ID=AKIAEXAMPLE',
        'AWS_SECRET_ACCESS_KEY=secret-value',
        'AWS_REGION=eu-west-1',
        'SQS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/123456789012/ghost-ses-proxy-events',
        'SES_CONFIGURATION_SET=ghost-ses-proxy',
        'MAILGUN_DOMAIN=example.com',
        'PROXY_API_KEY=generated-key',
        '',
      ].join('\n'),
    );
  });

  it('keeps an existing PROXY_API_KEY', () => {
    const result = run(EXISTING_FILE);
    expect(result).toContain('PROXY_API_KEY=existing-api-key');
    expect(result).not.toContain('generated-key');
  });

  it('is idempotent — a second run is byte-identical', () => {
    const first = run(EXISTING_FILE);
    const second = run(first);
    expect(second).toBe(first);
  });

  it('is idempotent starting from an empty file', () => {
    const first = run('');
    expect(run(first)).toBe(first);
  });
});
