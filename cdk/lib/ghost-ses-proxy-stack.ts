import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { CdkAppConfig } from './config.js';

export interface GhostSesProxyStackProps extends StackProps {
  readonly config: CdkAppConfig;
}

export class GhostSesProxyStack extends Stack {
  public readonly topic: sns.Topic;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue?: sqs.Queue;

  constructor(scope: Construct, id: string, props: GhostSesProxyStackProps) {
    super(scope, id, props);
    const cfg = props.config;

    this.topic = new sns.Topic(this, 'EventsTopic', { topicName: cfg.snsTopicName });

    this.deadLetterQueue =
      cfg.dlqMaxReceiveCount > 0
        ? new sqs.Queue(this, 'EventsDlq', {
            queueName: `${cfg.sqsQueueName}-dlq`,
            retentionPeriod: Duration.days(14),
          })
        : undefined;

    this.queue = new sqs.Queue(this, 'EventsQueue', {
      queueName: cfg.sqsQueueName,
      retentionPeriod: Duration.days(cfg.sqsRetentionDays),
      visibilityTimeout: Duration.seconds(cfg.sqsVisibilityTimeoutSeconds),
      deadLetterQueue: this.deadLetterQueue
        ? { queue: this.deadLetterQueue, maxReceiveCount: cfg.dlqMaxReceiveCount }
        : undefined,
    });

    this.topic.addSubscription(
      new subscriptions.SqsSubscription(this.queue, { rawMessageDelivery: false }),
    );

    new CfnOutput(this, 'SqsQueueUrl', { value: this.queue.queueUrl });
  }
}
