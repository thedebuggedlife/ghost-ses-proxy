import { describe, expect, it } from 'vitest';
import { parseConfig } from '../lib/config.js';

const minimal = { SES_DOMAIN: 'example.com' };

describe('parseConfig', () => {
  it('applies every documented default from a minimal env', () => {
    expect(parseConfig({ ...minimal })).toEqual({
      sesDomain: 'example.com',
      awsRegion: 'us-east-1',
      awsAccountId: undefined,
      hostedZoneName: undefined,
      stackName: 'GhostSesProxy',
      sesConfigurationSet: 'ghost-ses-proxy',
      snsTopicName: 'ghost-ses-proxy-events',
      sqsQueueName: 'ghost-ses-proxy-events',
      iamUserName: 'ghost-ses-proxy',
      credentialsSecretName: 'ghost-ses-proxy/credentials',
      accessKeySerial: 1,
      sqsRetentionDays: 14,
      sqsVisibilityTimeoutSeconds: 30,
      dlqMaxReceiveCount: 5,
      sesMailFromSubdomain: undefined,
    });
  });

  it('reflects every variable when all are set', () => {
    const env = {
      SES_DOMAIN: 'mail.example.com',
      AWS_REGION: 'eu-west-1',
      AWS_ACCOUNT_ID: '123456789012',
      HOSTED_ZONE_NAME: 'example.com',
      STACK_NAME: 'MyBlog',
      SES_CONFIGURATION_SET: 'custom-config-set',
      SNS_TOPIC_NAME: 'custom-topic',
      SQS_QUEUE_NAME: 'custom-queue',
      IAM_USER_NAME: 'custom-user',
      CREDENTIALS_SECRET_NAME: 'custom/secret',
      ACCESS_KEY_SERIAL: '3',
      SQS_RETENTION_DAYS: '7',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '60',
      DLQ_MAX_RECEIVE_COUNT: '2',
      SES_MAIL_FROM_SUBDOMAIN: 'bounce',
    };

    expect(parseConfig(env)).toEqual({
      sesDomain: 'mail.example.com',
      awsRegion: 'eu-west-1',
      awsAccountId: '123456789012',
      hostedZoneName: 'example.com',
      stackName: 'MyBlog',
      sesConfigurationSet: 'custom-config-set',
      snsTopicName: 'custom-topic',
      sqsQueueName: 'custom-queue',
      iamUserName: 'custom-user',
      credentialsSecretName: 'custom/secret',
      accessKeySerial: 3,
      sqsRetentionDays: 7,
      sqsVisibilityTimeoutSeconds: 60,
      dlqMaxReceiveCount: 2,
      sesMailFromSubdomain: 'bounce',
    });
  });

  it('throws naming SES_DOMAIN when it is missing', () => {
    expect(() => parseConfig({})).toThrow(/SES_DOMAIN/);
  });

  it('treats an empty string as unset', () => {
    expect(() => parseConfig({ SES_DOMAIN: '   ' })).toThrow(/SES_DOMAIN/);
  });

  it('rejects a domain with a scheme, slash or @', () => {
    for (const bad of ['https://example.com', 'example.com/path', 'user@example.com', 'example']) {
      expect(() => parseConfig({ SES_DOMAIN: bad })).toThrow(/SES_DOMAIN/);
    }
  });

  it('collects every validation error into a single error', () => {
    let message = '';
    try {
      parseConfig({
        SQS_RETENTION_DAYS: '15',
        DLQ_MAX_RECEIVE_COUNT: 'abc',
        STACK_NAME: '9Bad',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('SES_DOMAIN');
    expect(message).toContain('SQS_RETENTION_DAYS');
    expect(message).toContain('DLQ_MAX_RECEIVE_COUNT');
    expect(message).toContain('STACK_NAME');
  });

  describe('hosted zone containment', () => {
    it('throws when SES_DOMAIN is outside the zone', () => {
      expect(() =>
        parseConfig({ SES_DOMAIN: 'other.com', HOSTED_ZONE_NAME: 'example.com' }),
      ).toThrow(/HOSTED_ZONE_NAME/);
    });

    it('throws when SES_DOMAIN only shares a suffix with the zone', () => {
      expect(() =>
        parseConfig({ SES_DOMAIN: 'notexample.com', HOSTED_ZONE_NAME: 'example.com' }),
      ).toThrow(/HOSTED_ZONE_NAME/);
    });

    it('accepts a domain equal to the zone', () => {
      const config = parseConfig({ SES_DOMAIN: 'example.com', HOSTED_ZONE_NAME: 'example.com' });
      expect(config.hostedZoneName).toBe('example.com');
    });

    it('accepts a subdomain of the zone', () => {
      const config = parseConfig({
        SES_DOMAIN: 'mail.example.com',
        HOSTED_ZONE_NAME: 'example.com',
      });
      expect(config.sesDomain).toBe('mail.example.com');
    });

    it('parses with a hosted zone and no account — account is enforced in bin/, not here', () => {
      const config = parseConfig({ SES_DOMAIN: 'example.com', HOSTED_ZONE_NAME: 'example.com' });
      expect(config.awsAccountId).toBeUndefined();
    });
  });

  describe('numeric validation', () => {
    it.each([
      ['SQS_RETENTION_DAYS', 'abc'],
      ['SQS_RETENTION_DAYS', '-1'],
      ['SQS_RETENTION_DAYS', '0'],
      ['SQS_RETENTION_DAYS', '15'],
      ['SQS_VISIBILITY_TIMEOUT_SECONDS', '-1'],
      ['SQS_VISIBILITY_TIMEOUT_SECONDS', '43201'],
      ['SQS_VISIBILITY_TIMEOUT_SECONDS', '1.5'],
      ['DLQ_MAX_RECEIVE_COUNT', '-1'],
      ['DLQ_MAX_RECEIVE_COUNT', 'five'],
      ['ACCESS_KEY_SERIAL', '0'],
      ['ACCESS_KEY_SERIAL', '-2'],
    ])('rejects %s=%s', (name, value) => {
      expect(() => parseConfig({ ...minimal, [name]: value })).toThrow(new RegExp(name));
    });

    it('accepts DLQ_MAX_RECEIVE_COUNT=0 (disables the DLQ)', () => {
      expect(parseConfig({ ...minimal, DLQ_MAX_RECEIVE_COUNT: '0' }).dlqMaxReceiveCount).toBe(0);
    });

    it('accepts SQS_VISIBILITY_TIMEOUT_SECONDS=0 and the 43200 upper bound', () => {
      expect(
        parseConfig({ ...minimal, SQS_VISIBILITY_TIMEOUT_SECONDS: '0' })
          .sqsVisibilityTimeoutSeconds,
      ).toBe(0);
      expect(
        parseConfig({ ...minimal, SQS_VISIBILITY_TIMEOUT_SECONDS: '43200' })
          .sqsVisibilityTimeoutSeconds,
      ).toBe(43200);
    });
  });

  describe('name derivation', () => {
    it('derives names from the default stack name', () => {
      const config = parseConfig({ ...minimal });
      expect(config.sesConfigurationSet).toBe('ghost-ses-proxy');
      expect(config.iamUserName).toBe('ghost-ses-proxy');
      expect(config.snsTopicName).toBe('ghost-ses-proxy-events');
      expect(config.sqsQueueName).toBe('ghost-ses-proxy-events');
      expect(config.credentialsSecretName).toBe('ghost-ses-proxy/credentials');
    });

    it('derives names from a custom stack name', () => {
      const config = parseConfig({ ...minimal, STACK_NAME: 'MyBlog' });
      expect(config.sesConfigurationSet).toBe('my-blog');
      expect(config.iamUserName).toBe('my-blog');
      expect(config.snsTopicName).toBe('my-blog-events');
      expect(config.sqsQueueName).toBe('my-blog-events');
      expect(config.credentialsSecretName).toBe('my-blog/credentials');
    });

    it('kebab-cases a stack name that already contains hyphens', () => {
      const config = parseConfig({ ...minimal, STACK_NAME: 'second-Blog' });
      expect(config.sqsQueueName).toBe('second-blog-events');
    });

    it('lets explicit name variables override derivation', () => {
      const config = parseConfig({
        ...minimal,
        STACK_NAME: 'MyBlog',
        SES_CONFIGURATION_SET: 'explicit-set',
        SNS_TOPIC_NAME: 'explicit-topic',
        SQS_QUEUE_NAME: 'explicit-queue',
        IAM_USER_NAME: 'explicit-user',
        CREDENTIALS_SECRET_NAME: 'explicit/secret',
      });
      expect(config.sesConfigurationSet).toBe('explicit-set');
      expect(config.snsTopicName).toBe('explicit-topic');
      expect(config.sqsQueueName).toBe('explicit-queue');
      expect(config.iamUserName).toBe('explicit-user');
      expect(config.credentialsSecretName).toBe('explicit/secret');
    });

    it.each([['My_Blog'], ['9Blog'], ['-Blog'], ['My Blog'], ['My.Blog']])(
      'rejects the invalid stack name %s',
      (stackName) => {
        expect(() => parseConfig({ ...minimal, STACK_NAME: stackName })).toThrow(/STACK_NAME/);
      },
    );

    it('rejects a stack name longer than 50 characters', () => {
      expect(() => parseConfig({ ...minimal, STACK_NAME: 'A'.repeat(51) })).toThrow(/STACK_NAME/);
      expect(parseConfig({ ...minimal, STACK_NAME: `A${'b'.repeat(49)}` }).stackName).toHaveLength(
        50,
      );
    });
  });

  describe('resolved name length limits', () => {
    it('rejects a derived queue name that would push the DLQ past the SQS limit', () => {
      expect(() => parseConfig({ ...minimal, STACK_NAME: 'Ab'.repeat(25) })).toThrow(
        /SQS_QUEUE_NAME/,
      );
    });

    it('rejects an overridden queue name longer than 76 characters', () => {
      expect(() => parseConfig({ ...minimal, SQS_QUEUE_NAME: 'q'.repeat(77) })).toThrow(
        /SQS_QUEUE_NAME/,
      );
      expect(parseConfig({ ...minimal, SQS_QUEUE_NAME: 'q'.repeat(76) }).sqsQueueName).toHaveLength(
        76,
      );
    });

    it('rejects an IAM user name longer than 64 characters', () => {
      expect(() => parseConfig({ ...minimal, IAM_USER_NAME: 'u'.repeat(65) })).toThrow(
        /IAM_USER_NAME/,
      );
    });

    it('rejects a configuration set name longer than 64 characters', () => {
      expect(() => parseConfig({ ...minimal, SES_CONFIGURATION_SET: 'c'.repeat(65) })).toThrow(
        /SES_CONFIGURATION_SET/,
      );
    });
  });
});
