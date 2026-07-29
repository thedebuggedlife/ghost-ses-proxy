import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../lib/config.js';
import { GhostSesProxyStack } from '../lib/ghost-ses-proxy-stack.js';

const BASE_ENV: Record<string, string> = { SES_DOMAIN: 'example.com' };

export function makeTemplate(envOverrides: Record<string, string> = {}): Template {
  const config = parseConfig({ ...BASE_ENV, ...envOverrides });
  const app = new App();
  const stack = new GhostSesProxyStack(app, config.stackName, {
    config,
    env: { account: config.awsAccountId, region: config.awsRegion },
  });
  return Template.fromStack(stack);
}

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
