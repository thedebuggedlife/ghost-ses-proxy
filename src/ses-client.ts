import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import type { Logger } from 'pino';
import { toSesErrorType } from './metrics';
import type { Config, Metrics, SesClient } from './types';

export interface SesClientDeps {
  logger: Logger;
  metrics: Metrics;
}

function errorName(err: unknown): string | undefined {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

function toBuffer(rawMessage: string | Uint8Array): Buffer {
  return typeof rawMessage === 'string'
    ? Buffer.from(rawMessage, 'utf8')
    : Buffer.from(rawMessage);
}

export function createSesClient(
  config: Config,
  deps: SesClientDeps,
  client: SESClient = new SESClient({
    region: config.awsRegion,
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    },
  }),
): SesClient {
  const log = deps.logger.child({ component: 'ses' });
  const { sesSendDurationSeconds, sesErrorsTotal } = deps.metrics;

  return {
    async sendRawEmail(rawMessage, configurationSetName, context = {}) {
      const command = new SendRawEmailCommand({
        RawMessage: { Data: toBuffer(rawMessage) },
        ConfigurationSetName: configurationSetName,
      });

      const startedAt = performance.now();
      try {
        const response = await client.send(command);
        const durationMs = performance.now() - startedAt;
        sesSendDurationSeconds.observe(
          { outcome: 'success' },
          durationMs / 1000,
        );
        log.debug(
          {
            ...context,
            sesMessageId: response.MessageId,
            durationMs: Math.round(durationMs),
          },
          'sent raw email',
        );
        return { messageId: response.MessageId };
      } catch (err) {
        const durationMs = performance.now() - startedAt;
        sesSendDurationSeconds.observe({ outcome: 'error' }, durationMs / 1000);
        const errorType = toSesErrorType(errorName(err));
        sesErrorsTotal.inc({ error_type: errorType });
        log.error(
          { ...context, err, errorType, durationMs: Math.round(durationMs) },
          'SES send failed',
        );
        throw err;
      }
    },

    destroy() {
      client.destroy();
    },
  };
}
