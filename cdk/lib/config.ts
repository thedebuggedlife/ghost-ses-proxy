export interface CdkAppConfig {
  readonly sesDomain: string;
  readonly awsRegion: string;
  readonly awsAccountId?: string;
  readonly hostedZoneName?: string;
  readonly stackName: string;
  readonly sesConfigurationSet: string;
  readonly snsTopicName: string;
  readonly sqsQueueName: string;
  readonly iamUserName: string;
  readonly credentialsSecretName: string;
  readonly accessKeySerial: number;
  readonly sqsRetentionDays: number;
  readonly sqsVisibilityTimeoutSeconds: number;
  readonly dlqMaxReceiveCount: number;
  readonly sesMailFromSubdomain?: string;
}

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_STACK_NAME = 'GhostSesProxy';
const STACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const STACK_NAME_MAX_LENGTH = 50;
const DOMAIN_PATTERN =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function kebabCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    errors.push(`${name} must be an integer (got "${raw}")`);
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    errors.push(`${name} must be between ${min} and ${max} (got ${value})`);
    return fallback;
  }
  return value;
}

export function parseConfig(env: NodeJS.ProcessEnv): CdkAppConfig {
  const errors: string[] = [];

  const sesDomain = optional(env, 'SES_DOMAIN');
  if (sesDomain === undefined) {
    errors.push('SES_DOMAIN is required (the domain you send from, e.g. example.com)');
  } else if (!DOMAIN_PATTERN.test(sesDomain)) {
    errors.push(
      `SES_DOMAIN must be a bare domain name with no scheme, slash or "@" (got "${sesDomain}")`,
    );
  }

  const hostedZoneName = optional(env, 'HOSTED_ZONE_NAME');
  if (hostedZoneName !== undefined && sesDomain !== undefined) {
    const contained = sesDomain === hostedZoneName || sesDomain.endsWith(`.${hostedZoneName}`);
    if (!contained) {
      errors.push(
        `SES_DOMAIN ("${sesDomain}") must equal HOSTED_ZONE_NAME ("${hostedZoneName}") or be a subdomain of it`,
      );
    }
  }

  const stackName = optional(env, 'STACK_NAME') ?? DEFAULT_STACK_NAME;
  let namePrefix = kebabCase(DEFAULT_STACK_NAME);
  if (!STACK_NAME_PATTERN.test(stackName)) {
    errors.push(
      `STACK_NAME must start with a letter and contain only letters, digits and hyphens (got "${stackName}")`,
    );
  } else if (stackName.length > STACK_NAME_MAX_LENGTH) {
    errors.push(
      `STACK_NAME must be at most ${STACK_NAME_MAX_LENGTH} characters (got ${stackName.length})`,
    );
  } else {
    namePrefix = kebabCase(stackName);
  }

  const accessKeySerial = parseInteger(env, 'ACCESS_KEY_SERIAL', 1, 1, Number.MAX_SAFE_INTEGER, errors);
  const sqsRetentionDays = parseInteger(env, 'SQS_RETENTION_DAYS', 14, 1, 14, errors);
  const sqsVisibilityTimeoutSeconds = parseInteger(
    env,
    'SQS_VISIBILITY_TIMEOUT_SECONDS',
    30,
    0,
    43200,
    errors,
  );
  const dlqMaxReceiveCount = parseInteger(
    env,
    'DLQ_MAX_RECEIVE_COUNT',
    5,
    0,
    Number.MAX_SAFE_INTEGER,
    errors,
  );

  const sesConfigurationSet = optional(env, 'SES_CONFIGURATION_SET') ?? namePrefix;
  const snsTopicName = optional(env, 'SNS_TOPIC_NAME') ?? `${namePrefix}-events`;
  const sqsQueueName = optional(env, 'SQS_QUEUE_NAME') ?? `${namePrefix}-events`;
  const iamUserName = optional(env, 'IAM_USER_NAME') ?? namePrefix;
  const credentialsSecretName =
    optional(env, 'CREDENTIALS_SECRET_NAME') ?? `${namePrefix}/credentials`;

  const checkLength = (label: string, value: string, max: number, why: string) => {
    if (value.length > max) {
      errors.push(`${label} ("${value}") must be at most ${max} characters (${why})`);
    }
  };
  checkLength('SQS_QUEUE_NAME', sqsQueueName, 76, 'the "-dlq" suffix must fit SQS’s 80-char limit');
  checkLength('IAM_USER_NAME', iamUserName, 64, 'IAM user name limit');
  checkLength('SES_CONFIGURATION_SET', sesConfigurationSet, 64, 'SES configuration set name limit');
  checkLength('SNS_TOPIC_NAME', snsTopicName, 256, 'SNS topic name limit');
  checkLength('CREDENTIALS_SECRET_NAME', credentialsSecretName, 512, 'Secrets Manager name limit');

  if (errors.length > 0) {
    throw new Error(
      `Invalid CDK configuration (see cdk/.env.example):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  return {
    sesDomain: sesDomain as string,
    awsRegion: optional(env, 'AWS_REGION') ?? DEFAULT_REGION,
    awsAccountId: optional(env, 'AWS_ACCOUNT_ID'),
    hostedZoneName,
    stackName,
    sesConfigurationSet,
    snsTopicName,
    sqsQueueName,
    iamUserName,
    credentialsSecretName,
    accessKeySerial,
    sqsRetentionDays,
    sqsVisibilityTimeoutSeconds,
    dlqMaxReceiveCount,
    sesMailFromSubdomain: optional(env, 'SES_MAIL_FROM_SUBDOMAIN'),
  };
}
