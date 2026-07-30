import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { CdkAppConfig } from './config.js';

export interface GhostSesProxyStackProps extends StackProps {
  readonly config: CdkAppConfig;
}

const EMAIL_SENDING_EVENTS = [
  ses.EmailSendingEvent.SEND,
  ses.EmailSendingEvent.DELIVERY,
  ses.EmailSendingEvent.OPEN,
  ses.EmailSendingEvent.CLICK,
  ses.EmailSendingEvent.BOUNCE,
  ses.EmailSendingEvent.COMPLAINT,
  ses.EmailSendingEvent.REJECT,
];

const SPF_RECORD_VALUE = 'v=spf1 include:amazonses.com ~all';

export class GhostSesProxyStack extends Stack {
  public readonly topic: sns.Topic;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue?: sqs.Queue;
  public readonly configurationSet: ses.ConfigurationSet;
  public readonly emailIdentity: ses.EmailIdentity;
  public readonly user: iam.User;
  public readonly accessKey: iam.AccessKey;
  public readonly credentialsSecret: secretsmanager.Secret;

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

    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: cfg.sesConfigurationSet,
    });
    this.configurationSet.addEventDestination('SnsDestination', {
      destination: ses.EventDestination.snsTopic(this.topic),
      events: EMAIL_SENDING_EVENTS,
    });

    const hostedZone = cfg.hostedZoneName
      ? route53.HostedZone.fromLookup(this, 'Zone', { domainName: cfg.hostedZoneName })
      : undefined;
    const apexZone = hostedZone && cfg.sesDomain === cfg.hostedZoneName ? hostedZone : undefined;
    const mailFromDomain = cfg.sesMailFromSubdomain
      ? `${cfg.sesMailFromSubdomain}.${cfg.sesDomain}`
      : undefined;

    this.emailIdentity = new ses.EmailIdentity(this, 'Identity', {
      identity: apexZone
        ? ses.Identity.publicHostedZone(apexZone)
        : ses.Identity.domain(cfg.sesDomain),
      configurationSet: this.configurationSet,
      mailFromDomain,
    });

    if (hostedZone && !apexZone) {
      this.emailIdentity.dkimRecords.forEach((record, index) => {
        // CnameRecord would append the zone name to the already-fully-qualified DKIM token.
        new route53.CfnRecordSet(this, `DkimRecord${index + 1}`, {
          hostedZoneId: hostedZone.hostedZoneId,
          name: record.name,
          type: 'CNAME',
          resourceRecords: [record.value],
          ttl: '1800',
        });
      });

      if (mailFromDomain) {
        new route53.MxRecord(this, 'MailFromMxRecord', {
          zone: hostedZone,
          recordName: mailFromDomain,
          values: [{ priority: 10, hostName: this.mailFromMxHost() }],
        });
        new route53.TxtRecord(this, 'MailFromTxtRecord', {
          zone: hostedZone,
          recordName: mailFromDomain,
          values: [SPF_RECORD_VALUE],
        });
      }
    }

    this.user = new iam.User(this, 'ProxyUser', { userName: cfg.iamUserName });
    this.user.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendRawEmail'],
        resources: [
          this.emailIdentity.emailIdentityArn,
          this.formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: this.configurationSet.configurationSetName,
          }),
        ],
      }),
    );
    this.user.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
        resources: [this.queue.queueArn],
      }),
    );

    this.accessKey = new iam.AccessKey(this, 'ProxyAccessKey', {
      user: this.user,
      serial: cfg.accessKeySerial,
    });
    this.credentialsSecret = new secretsmanager.Secret(this, 'ProxyCredentials', {
      secretName: cfg.credentialsSecretName,
      secretObjectValue: {
        accessKeyId: SecretValue.unsafePlainText(this.accessKey.accessKeyId),
        secretAccessKey: this.accessKey.secretAccessKey,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, 'SqsQueueUrl', { value: this.queue.queueUrl });
    new CfnOutput(this, 'SesConfigurationSet', { value: this.configurationSet.configurationSetName });
    new CfnOutput(this, 'SendingDomain', { value: cfg.sesDomain });
    new CfnOutput(this, 'AwsRegion', { value: this.region });
    new CfnOutput(this, 'CredentialsSecretArn', { value: this.credentialsSecret.secretArn });

    if (!hostedZone) {
      this.emailIdentity.dkimRecords.forEach((record, index) => {
        new CfnOutput(this, `DkimCnameName${index + 1}`, { value: record.name });
        new CfnOutput(this, `DkimCnameValue${index + 1}`, { value: record.value });
      });

      if (mailFromDomain) {
        new CfnOutput(this, 'MailFromMxRecord', {
          value: `${mailFromDomain} MX 10 ${this.mailFromMxHost()}`,
        });
        new CfnOutput(this, 'MailFromSpfRecord', {
          value: `${mailFromDomain} TXT "${SPF_RECORD_VALUE}"`,
        });
      }
    }
  }

  private mailFromMxHost(): string {
    return `feedback-smtp.${this.region}.amazonses.com`;
  }
}
