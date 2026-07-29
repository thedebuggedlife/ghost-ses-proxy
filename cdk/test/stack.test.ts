import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../lib/config.js';
import { GhostSesProxyStack } from '../lib/ghost-ses-proxy-stack.js';

const BASE_ENV: Record<string, string> = { SES_DOMAIN: 'example.com' };
const LOOKUP_ACCOUNT = '123456789012';

interface MakeTemplateOptions {
  /** Pre-seed the app context with a Route53 hosted-zone lookup result. */
  readonly hostedZoneLookup?: boolean;
}

function makeTemplate(
  envOverrides: Record<string, string> = {},
  options: MakeTemplateOptions = {},
): Template {
  const env = { ...BASE_ENV, ...envOverrides };
  if (options.hostedZoneLookup) env.AWS_ACCOUNT_ID ??= LOOKUP_ACCOUNT;

  const config = parseConfig(env);
  const context = options.hostedZoneLookup
    ? {
        [`hosted-zone:account=${config.awsAccountId}:domainName=${config.hostedZoneName}:region=${config.awsRegion}`]:
          { Id: '/hostedzone/Z123', Name: `${config.hostedZoneName}.` },
      }
    : undefined;

  const app = new App({ context });
  const stack = new GhostSesProxyStack(app, config.stackName, {
    config,
    env: { account: config.awsAccountId, region: config.awsRegion },
  });
  return Template.fromStack(stack);
}

const ZONE_ENV: Record<string, string> = { HOSTED_ZONE_NAME: 'example.com' };
const WITH_ZONE: MakeTemplateOptions = { hostedZoneLookup: true };

describe('messaging resources', () => {
  it('creates the SNS topic with the derived name', () => {
    makeTemplate().hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'ghost-ses-proxy-events',
    });
  });

  it('creates the queue with the derived name, retention and visibility timeout', () => {
    makeTemplate().hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'ghost-ses-proxy-events',
      MessageRetentionPeriod: 1209600,
      VisibilityTimeout: 30,
    });
  });

  it('honours configured retention and visibility timeout', () => {
    makeTemplate({
      SQS_RETENTION_DAYS: '4',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '120',
    }).hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'ghost-ses-proxy-events',
      MessageRetentionPeriod: 345600,
      VisibilityTimeout: 120,
    });
  });

  it('creates a DLQ and redrives to it with the configured maxReceiveCount', () => {
    const template = makeTemplate();

    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'ghost-ses-proxy-events-dlq',
      MessageRetentionPeriod: 1209600,
    });

    const dlqLogicalId = Object.keys(
      template.findResources('AWS::SQS::Queue', {
        Properties: { QueueName: 'ghost-ses-proxy-events-dlq' },
      }),
    )[0];
    expect(dlqLogicalId).toBeDefined();

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'ghost-ses-proxy-events',
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [dlqLogicalId, 'Arn'] },
        maxReceiveCount: 5,
      },
    });
  });

  it('omits the DLQ entirely when DLQ_MAX_RECEIVE_COUNT is 0', () => {
    const template = makeTemplate({ DLQ_MAX_RECEIVE_COUNT: '0' });

    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'ghost-ses-proxy-events',
      RedrivePolicy: Match.absent(),
    });
  });

  it('uses explicit topic and queue names when configured', () => {
    const template = makeTemplate({
      SNS_TOPIC_NAME: 'custom-topic',
      SQS_QUEUE_NAME: 'custom-queue',
    });

    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'custom-topic' });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'custom-queue' });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'custom-queue-dlq' });
  });

  it('lets SNS send to the queue, conditioned on the topic ARN', () => {
    const template = makeTemplate();
    const topicLogicalId = Object.keys(template.findResources('AWS::SNS::Topic'))[0];

    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sqs:SendMessage',
            Effect: 'Allow',
            Principal: { Service: 'sns.amazonaws.com' },
            Condition: { ArnEquals: { 'aws:SourceArn': { Ref: topicLogicalId } } },
          }),
        ]),
      },
    });
  });

  it('subscribes the queue to the topic without raw message delivery', () => {
    const template = makeTemplate();
    const topicLogicalId = Object.keys(template.findResources('AWS::SNS::Topic'))[0];

    template.resourceCountIs('AWS::SNS::Subscription', 1);

    const [subscription] = Object.values(template.findResources('AWS::SNS::Subscription'));
    expect(subscription.Properties.Protocol).toBe('sqs');
    expect(subscription.Properties.TopicArn).toEqual({ Ref: topicLogicalId });
    expect(subscription.Properties.RawMessageDelivery ?? false).toBe(false);
  });

  it('outputs the queue URL', () => {
    makeTemplate().hasOutput('SqsQueueUrl', {});
  });
});

describe('SES configuration set', () => {
  it('creates the configuration set with the derived name', () => {
    makeTemplate().hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: 'ghost-ses-proxy',
    });
  });

  it('uses an explicit configuration set name when configured', () => {
    makeTemplate({ SES_CONFIGURATION_SET: 'custom-set' }).hasResourceProperties(
      'AWS::SES::ConfigurationSet',
      { Name: 'custom-set' },
    );
  });

  it('publishes exactly the seven event types to the SNS topic', () => {
    const template = makeTemplate();
    const topicLogicalId = Object.keys(template.findResources('AWS::SNS::Topic'))[0];

    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 1);
    template.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: Match.exact([
          'send',
          'delivery',
          'open',
          'click',
          'bounce',
          'complaint',
          'reject',
        ]),
        SnsDestination: { TopicARN: { Ref: topicLogicalId } },
      },
    });
  });
});

describe('SES email identity', () => {
  it('verifies the sending domain and attaches the configuration set', () => {
    const template = makeTemplate();
    const configSetLogicalId = Object.keys(
      template.findResources('AWS::SES::ConfigurationSet'),
    )[0];

    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'example.com',
      ConfigurationSetAttributes: { ConfigurationSetName: { Ref: configSetLogicalId } },
      MailFromAttributes: Match.absent(),
    });
  });

  it('keeps DKIM signing on by default (no DkimAttributes override)', () => {
    makeTemplate().hasResourceProperties('AWS::SES::EmailIdentity', {
      DkimAttributes: Match.absent(),
    });
  });

  it('sets the MAIL FROM domain when a subdomain is configured', () => {
    makeTemplate({ SES_MAIL_FROM_SUBDOMAIN: 'bounce' }).hasResourceProperties(
      'AWS::SES::EmailIdentity',
      { MailFromAttributes: { MailFromDomain: 'bounce.example.com' } },
    );
  });
});

describe('DNS without a hosted zone', () => {
  it('creates no Route53 records', () => {
    makeTemplate({ SES_MAIL_FROM_SUBDOMAIN: 'bounce' }).resourceCountIs(
      'AWS::Route53::RecordSet',
      0,
    );
  });

  it('outputs the six DKIM CNAME name/value pairs', () => {
    const template = makeTemplate();
    const identityLogicalId = Object.keys(template.findResources('AWS::SES::EmailIdentity'))[0];

    for (const index of [1, 2, 3]) {
      template.hasOutput(`DkimCnameName${index}`, {
        Value: { 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenName${index}`] },
      });
      template.hasOutput(`DkimCnameValue${index}`, {
        Value: { 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenValue${index}`] },
      });
    }
  });

  it('omits the MAIL FROM outputs when no MAIL FROM subdomain is configured', () => {
    const outputs = makeTemplate().toJSON().Outputs ?? {};
    expect(outputs.MailFromMxRecord).toBeUndefined();
    expect(outputs.MailFromSpfRecord).toBeUndefined();
  });

  it('outputs the MAIL FROM MX and SPF records to add manually', () => {
    const template = makeTemplate({ SES_MAIL_FROM_SUBDOMAIN: 'bounce' });

    template.hasOutput('MailFromMxRecord', {
      Value: 'bounce.example.com MX 10 feedback-smtp.us-east-1.amazonses.com',
    });
    template.hasOutput('MailFromSpfRecord', {
      Value: 'bounce.example.com TXT "v=spf1 include:amazonses.com ~all"',
    });
  });
});

describe('DNS with a hosted zone', () => {
  it('drops the manual DNS outputs entirely', () => {
    const outputs =
      makeTemplate({ ...ZONE_ENV, SES_MAIL_FROM_SUBDOMAIN: 'bounce' }, WITH_ZONE).toJSON()
        .Outputs ?? {};

    for (const key of Object.keys(outputs)) {
      expect(key).not.toMatch(/^(DkimCname|MailFrom)/);
    }
    expect(Object.keys(outputs).sort()).toEqual([
      'AwsRegion',
      'CredentialsSecretArn',
      'SendingDomain',
      'SesConfigurationSet',
      'SqsQueueUrl',
    ]);
  });

  it('verifies the zone apex and lets the construct create the DKIM records', () => {
    const template = makeTemplate(ZONE_ENV, WITH_ZONE);
    const identityLogicalId = Object.keys(template.findResources('AWS::SES::EmailIdentity'))[0];

    template.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'example.com' });
    template.resourceCountIs('AWS::Route53::RecordSet', 3);

    for (const index of [1, 2, 3]) {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        HostedZoneId: 'Z123',
        Type: 'CNAME',
        Name: { 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenName${index}`] },
        ResourceRecords: [{ 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenValue${index}`] }],
      });
    }
  });

  it('creates the DKIM records itself when the identity is a subdomain of the zone', () => {
    const template = makeTemplate({ ...ZONE_ENV, SES_DOMAIN: 'mail.example.com' }, WITH_ZONE);
    const identityLogicalId = Object.keys(template.findResources('AWS::SES::EmailIdentity'))[0];

    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'mail.example.com',
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 3);

    for (const index of [1, 2, 3]) {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        HostedZoneId: 'Z123',
        Type: 'CNAME',
        Name: { 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenName${index}`] },
        ResourceRecords: [{ 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenValue${index}`] }],
      });
    }
  });

  it.each([
    ['apex', 'example.com', 'bounce.example.com.'],
    ['subdomain', 'mail.example.com', 'bounce.mail.example.com.'],
  ])('creates the MAIL FROM MX and TXT records (%s identity)', (_case, sesDomain, recordName) => {
    const template = makeTemplate(
      { ...ZONE_ENV, SES_DOMAIN: sesDomain, SES_MAIL_FROM_SUBDOMAIN: 'bounce' },
      WITH_ZONE,
    );

    template.resourceCountIs('AWS::Route53::RecordSet', 5);
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      HostedZoneId: 'Z123',
      Type: 'MX',
      Name: recordName,
      ResourceRecords: ['10 feedback-smtp.us-east-1.amazonses.com'],
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      HostedZoneId: 'Z123',
      Type: 'TXT',
      Name: recordName,
      ResourceRecords: ['"v=spf1 include:amazonses.com ~all"'],
    });
  });
});

describe('proxy IAM user', () => {
  it('creates the user with the derived name', () => {
    makeTemplate().hasResourceProperties('AWS::IAM::User', { UserName: 'ghost-ses-proxy' });
  });

  it('uses an explicit user name when configured', () => {
    makeTemplate({ IAM_USER_NAME: 'custom-user' }).hasResourceProperties('AWS::IAM::User', {
      UserName: 'custom-user',
    });
  });

  it('scopes ses:SendRawEmail to the identity and configuration set ARNs', () => {
    const template = makeTemplate();
    const identityLogicalId = Object.keys(template.findResources('AWS::SES::EmailIdentity'))[0];
    const configSetLogicalId = Object.keys(
      template.findResources('AWS::SES::ConfigurationSet'),
    )[0];

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ses:SendRawEmail',
            Effect: 'Allow',
            Resource: [
              {
                'Fn::Join': [
                  '',
                  Match.arrayWith([':identity/', { Ref: identityLogicalId }]),
                ],
              },
              {
                'Fn::Join': [
                  '',
                  Match.arrayWith([':configuration-set/', { Ref: configSetLogicalId }]),
                ],
              },
            ],
          }),
        ]),
      },
    });
  });

  it('scopes the SQS actions to the queue ARN', () => {
    const template = makeTemplate();
    const queueLogicalId = Object.keys(
      template.findResources('AWS::SQS::Queue', {
        Properties: { QueueName: 'ghost-ses-proxy-events' },
      }),
    )[0];

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
            Effect: 'Allow',
            Resource: { 'Fn::GetAtt': [queueLogicalId, 'Arn'] },
          }),
        ]),
      },
    });
  });

  it('never grants a wildcard resource', () => {
    const [policy] = Object.values(makeTemplate().findResources('AWS::IAM::Policy'));

    for (const statement of policy.Properties.PolicyDocument.Statement) {
      expect(statement.Resource).not.toBe('*');
      expect(Array.isArray(statement.Resource) ? statement.Resource : []).not.toContain('*');
    }
  });
});

describe('access key and credentials secret', () => {
  it('creates an access key for the user with the configured serial', () => {
    const template = makeTemplate({ ACCESS_KEY_SERIAL: '3' });
    const userLogicalId = Object.keys(template.findResources('AWS::IAM::User'))[0];

    template.resourceCountIs('AWS::IAM::AccessKey', 1);
    template.hasResourceProperties('AWS::IAM::AccessKey', {
      Serial: 3,
      UserName: { Ref: userLogicalId },
    });
  });

  it('defaults the access key serial to 1', () => {
    makeTemplate().hasResourceProperties('AWS::IAM::AccessKey', { Serial: 1 });
  });

  it('stores the key material in a secret that is destroyed with the stack', () => {
    const template = makeTemplate();
    const accessKeyLogicalId = Object.keys(template.findResources('AWS::IAM::AccessKey'))[0];

    template.hasResource('AWS::SecretsManager::Secret', {
      Properties: {
        Name: 'ghost-ses-proxy/credentials',
        SecretString: {
          'Fn::Join': [
            '',
            Match.arrayWith([
              { Ref: accessKeyLogicalId },
              { 'Fn::GetAtt': [accessKeyLogicalId, 'SecretAccessKey'] },
            ]),
          ],
        },
      },
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  it('uses an explicit secret name when configured', () => {
    makeTemplate({ CREDENTIALS_SECRET_NAME: 'custom/creds' }).hasResourceProperties(
      'AWS::SecretsManager::Secret',
      { Name: 'custom/creds' },
    );
  });

  it('resolves the secret access key at deploy time rather than embedding it', () => {
    const template = makeTemplate();
    const accessKeyLogicalId = Object.keys(template.findResources('AWS::IAM::AccessKey'))[0];
    const [secret] = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    const parts: unknown[] = secret.Properties.SecretString['Fn::Join'][1];

    expect(parts).toContainEqual({ 'Fn::GetAtt': [accessKeyLogicalId, 'SecretAccessKey'] });
    expect(parts.filter((part) => typeof part === 'string')).toEqual([
      '{"accessKeyId":"',
      '","secretAccessKey":"',
      '"}',
    ]);
  });
});

describe('always-present outputs', () => {
  it('exposes the configuration set, sending domain and region', () => {
    const template = makeTemplate();
    const configSetLogicalId = Object.keys(
      template.findResources('AWS::SES::ConfigurationSet'),
    )[0];

    template.hasOutput('SesConfigurationSet', { Value: { Ref: configSetLogicalId } });
    template.hasOutput('SendingDomain', { Value: 'example.com' });
    template.hasOutput('AwsRegion', { Value: 'us-east-1' });
  });

  it('reflects a non-default region', () => {
    makeTemplate({ AWS_REGION: 'eu-west-1' }).hasOutput('AwsRegion', { Value: 'eu-west-1' });
  });

  it('outputs the credentials secret ARN', () => {
    const template = makeTemplate();
    const secretLogicalId = Object.keys(
      template.findResources('AWS::SecretsManager::Secret'),
    )[0];

    template.hasOutput('CredentialsSecretArn', { Value: { Ref: secretLogicalId } });
  });

  it('always emits the five outputs the generate-env script depends on', () => {
    for (const options of [{}, WITH_ZONE]) {
      const envOverrides = options === WITH_ZONE ? ZONE_ENV : {};
      const outputs = makeTemplate(envOverrides, options).toJSON().Outputs ?? {};

      for (const key of [
        'SqsQueueUrl',
        'SesConfigurationSet',
        'SendingDomain',
        'AwsRegion',
        'CredentialsSecretArn',
      ]) {
        expect(outputs[key]).toBeDefined();
      }
    }
  });
});
