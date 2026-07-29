#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  type Output,
} from '@aws-sdk/client-cloudformation';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { config as loadDotenv } from 'dotenv';
import { parseConfig } from '../lib/config.js';

export const MANAGED_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'SQS_QUEUE_URL',
  'SES_CONFIGURATION_SET',
  'MAILGUN_DOMAIN',
] as const;

export const PROXY_API_KEY = 'PROXY_API_KEY';

const REQUIRED_OUTPUTS = [
  'SqsQueueUrl',
  'SesConfigurationSet',
  'SendingDomain',
  'CredentialsSecretArn',
] as const;

const ASSIGNMENT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function keyOf(line: string): string | undefined {
  return ASSIGNMENT_PATTERN.exec(line)?.[1];
}

export function parseEnvContent(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function formatEnvFile(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export function mergeEnvFile(existingLines: string[], managed: Record<string, string>): string[] {
  const replaced = new Set<string>();
  const merged = existingLines.map((line) => {
    const key = keyOf(line);
    if (key === undefined || !Object.hasOwn(managed, key)) return line;
    replaced.add(key);
    return `${key}=${managed[key]}`;
  });

  for (const [key, value] of Object.entries(managed)) {
    if (!replaced.has(key)) merged.push(`${key}=${value}`);
  }
  return merged;
}

export function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

export function hasProxyApiKey(lines: string[]): boolean {
  return lines.some((line) => keyOf(line) === PROXY_API_KEY);
}

export function ensureProxyApiKey(lines: string[], generate = generateApiKey): string[] {
  return hasProxyApiKey(lines) ? lines : [...lines, `${PROXY_API_KEY}=${generate()}`];
}

function parseArgs(argv: string[]): { out?: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[i + 1];
      if (out === undefined) throw new Error('--out requires a path argument');
      i += 1;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else {
      throw new Error(`Unknown argument "${arg}" (usage: generate-env [--out <path>])`);
    }
  }
  return { out };
}

function defaultOutPath(): string {
  return fileURLToPath(new URL('../../.env', import.meta.url));
}

function isStackNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ValidationError' &&
    /does not exist/i.test(error.message)
  );
}

async function fetchStackOutputs(
  stackName: string,
  region: string,
): Promise<Record<string, string>> {
  const client = new CloudFormationClient({ region });
  let stackOutputs: Output[] | undefined;
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    stackOutputs = response.Stacks?.[0]?.Outputs;
  } catch (error) {
    if (isStackNotFound(error)) {
      throw new Error(
        `CloudFormation stack "${stackName}" was not found in ${region} — run "npx cdk deploy" first.`,
      );
    }
    throw error;
  }

  const outputs: Record<string, string> = {};
  for (const output of stackOutputs ?? []) {
    if (output.OutputKey && output.OutputValue !== undefined) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }

  const missing = REQUIRED_OUTPUTS.filter((key) => outputs[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `CloudFormation stack "${stackName}" is missing expected outputs: ${missing.join(', ')} — redeploy with "npx cdk deploy".`,
    );
  }
  return outputs;
}

async function fetchCredentials(
  secretId: string,
  region: string,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const client = new SecretsManagerClient({ region });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!response.SecretString) {
    throw new Error(`Secret ${secretId} has no string value — redeploy with "npx cdk deploy".`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    throw new Error(`Secret ${secretId} is not valid JSON.`);
  }

  const { accessKeyId, secretAccessKey } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') {
    throw new Error(`Secret ${secretId} must contain "accessKeyId" and "secretAccessKey".`);
  }
  return { accessKeyId, secretAccessKey };
}

export async function main(argv: string[]): Promise<void> {
  const { out } = parseArgs(argv);
  loadDotenv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
  const config = parseConfig(process.env);
  const outPath = out === undefined ? defaultOutPath() : resolve(process.cwd(), out);

  const outputs = await fetchStackOutputs(config.stackName, config.awsRegion);
  const credentials = await fetchCredentials(outputs.CredentialsSecretArn, config.awsRegion);

  const managed: Record<string, string> = {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: config.awsRegion,
    SQS_QUEUE_URL: outputs.SqsQueueUrl,
    SES_CONFIGURATION_SET: outputs.SesConfigurationSet,
    MAILGUN_DOMAIN: outputs.SendingDomain,
  };

  const existing = existsSync(outPath) ? parseEnvContent(readFileSync(outPath, 'utf8')) : [];
  const apiKeyPreserved = hasProxyApiKey(existing);
  const merged = ensureProxyApiKey(mergeEnvFile(existing, managed));

  writeFileSync(outPath, formatEnvFile(merged), { mode: 0o600 });
  chmodSync(outPath, 0o600);

  console.log(`Wrote ${outPath} (mode 0600)`);
  console.log(
    `  updated: ${MANAGED_KEYS.join(', ')} (AWS_REGION from cdk/.env; rest from stack "${config.stackName}")`,
  );
  console.log(`  ${PROXY_API_KEY}: ${apiKeyPreserved ? 'preserved' : 'generated'}`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
