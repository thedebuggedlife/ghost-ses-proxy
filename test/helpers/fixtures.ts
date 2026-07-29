import capturedSesEventInputs from '../golden/captured/ses-event-inputs.json';
import type { SesEvent } from '../../src/types';

/**
 * The SES payloads are the ones the Phase 0 capture harness fed to the legacy
 * `mapSesEvent`; `captured/event-map-*.json` is the output it recorded for each.
 * Restating them here would let the two copies drift, which would make the
 * Phase 15 contract test red for a reason unrelated to the rewrite.
 */
export const sesEventInputs = capturedSesEventInputs as unknown as Record<
  string,
  SesEvent
>;

export type SesFixtureName = keyof typeof capturedSesEventInputs;

export const sesFixtureNames = Object.keys(
  capturedSesEventInputs,
) as SesFixtureName[];

/** A structurally-shared fixture that one test mutated would corrupt every later test. */
export function sesEvent(name: SesFixtureName): SesEvent {
  const fixture = sesEventInputs[name];
  if (!fixture) throw new Error(`unknown SES fixture: ${name}`);
  return structuredClone(fixture);
}

export interface SnsEnvelope {
  Type: 'Notification';
  MessageId: string;
  TopicArn: string;
  Message: string;
}

export function snsEnvelope(event: unknown): SnsEnvelope {
  return {
    Type: 'Notification',
    MessageId: 'sns-00000000-0000-0000-0000-000000000000',
    TopicArn: 'arn:aws:sns:us-east-1:000000000000:ghost-ses-proxy-events',
    Message: JSON.stringify(event),
  };
}

/** SNS-enveloped variant of every captured fixture, for the Phase 14 poller tests. */
export function snsEvent(name: SesFixtureName): SnsEnvelope {
  return snsEnvelope(sesEvent(name));
}

/** Body of an SQS message carrying a raw (un-enveloped) SES event. */
export function rawSqsBody(name: SesFixtureName): string {
  return JSON.stringify(sesEvent(name));
}

/** Body of an SQS message carrying an SNS-enveloped SES event. */
export function snsSqsBody(name: SesFixtureName): string {
  return JSON.stringify(snsEvent(name));
}

/**
 * D7 (design §5.5): a recognized `eventType` whose event block is missing.
 * Not captured — the legacy implementation throws a `TypeError` on these.
 */
export function withoutEventBlock(
  name: SesFixtureName,
  block: 'delivery' | 'bounce' | 'complaint',
): SesEvent {
  const event = sesEvent(name);
  delete event[block];
  return event;
}
