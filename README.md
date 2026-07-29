# ghost-ses-proxy

Send Ghost newsletter emails through **AWS SES** instead of Mailgun. This proxy impersonates the Mailgun API so Ghost doesn't know the difference — no Ghost code changes required. At scale, SES costs a fraction of Mailgun: sending 600k+ emails/month costs ~$60 on SES vs ~$800 on Mailgun.

## How it works

Ghost only supports Mailgun for bulk newsletter sending. This proxy sits between Ghost and AWS SES, translating Mailgun API calls into SES operations and feeding delivery events back in the format Ghost expects.

```
Sending:
  Ghost ──POST /v3/:domain/messages──▶ ghost-ses-proxy ──SES SendRawEmail──▶ AWS SES ──▶ Recipients

Events (delivery, opens, clicks, bounces, complaints):
  AWS SES ──▶ SNS Topic ──▶ SQS Queue ──▶ ghost-ses-proxy ──▶ SQLite
  Ghost ──GET /v3/:domain/events──▶ ghost-ses-proxy ──▶ reads from SQLite
```

The proxy handles:
- **Sending** — Parses Mailgun multipart form data, substitutes `%recipient.*%` template variables, builds raw MIME messages, sends via SES with concurrency limiting
- **Event tracking** — Polls SQS for SES events (delivery, open, click, bounce, complaint), maps them to Mailgun event format, stores in SQLite
- **Suppressions** — Automatically records permanent bounces and complaints; Ghost can delete suppressions via the Mailgun API
- **Authentication** — Validates Ghost's Mailgun Basic auth against your configured API key
- **Observability** — Structured JSON logs on stdout and Prometheus metrics at `GET /metrics`

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/josephsellers/ghost-ses-proxy.git
cd ghost-ses-proxy
cp .env.example .env
# Edit .env with your AWS credentials and settings
```

### 2. Run with Docker Compose

```bash
# Using the example compose file
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Or add to your existing Ghost compose stack:

```yaml
services:
  ghost-ses-proxy:
    build: ./ghost-ses-proxy
    ports:
      - "3003:3003"
    volumes:
      - ./ghost-ses-proxy-data:/data
    env_file:
      - ./ghost-ses-proxy/.env
    restart: unless-stopped
```

### 3. Verify the proxy is running

```bash
curl http://localhost:3003/health
# {"status":"ok","tables":{"message_map":0,"recipient_emails":0,"events":0,"suppressions":0}}
```

### 4. Point Ghost at the proxy

Ghost stores its Mailgun configuration in the database. Update it with these SQL statements (adjust the URL and API key to match your setup):

```sql
-- Set Ghost to use your proxy instead of Mailgun
UPDATE settings SET value = '"http://your-proxy-host:3003/v3"'
  WHERE key = 'mailgun_base_url';

UPDATE settings SET value = '"your-secure-api-key-here"'
  WHERE key = 'mailgun_api_key';

UPDATE settings SET value = '"example.com"'
  WHERE key = 'mailgun_domain';
```

> **Note:** The values must be JSON-encoded strings (wrapped in double quotes inside single quotes). After updating, restart Ghost to pick up the changes.

## AWS setup guide

You need four AWS resources: a verified SES domain, a Configuration Set, an SNS topic, and an SQS queue.

### 1. Verify your domain in SES

In the AWS Console under **SES > Verified identities**, add your sending domain. Complete DNS verification by adding the DKIM CNAME records to your domain's DNS.

### 2. Create an SES Configuration Set

Under **SES > Configuration sets**, create one named `ghost-ses-proxy` (or whatever you set in `SES_CONFIGURATION_SET`).

Add an **SNS event destination** that publishes these event types:
- Sends
- Deliveries
- Opens
- Clicks
- Bounces
- Complaints
- Rejects

Point this destination at the SNS topic you'll create next.

### 3. Create an SNS topic

Create a standard SNS topic (e.g., `ghost-ses-events`). No special configuration needed — it just bridges SES to SQS.

### 4. Create an SQS queue

Create a standard SQS queue (e.g., `ghost-ses-events`). Subscribe it to the SNS topic.

Set the queue's access policy to allow your SNS topic to send messages:

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "sns.amazonaws.com"},
    "Action": "sqs:SendMessage",
    "Resource": "arn:aws:sqs:REGION:ACCOUNT:ghost-ses-events",
    "Condition": {
      "ArnEquals": {
        "aws:SourceArn": "arn:aws:sns:REGION:ACCOUNT:ghost-ses-events"
      }
    }
  }]
}
```

### 5. Create an IAM user

Create an IAM user with programmatic access and attach this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ses:SendRawEmail"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:REGION:ACCOUNT:ghost-ses-events"
    }
  ]
}
```

Use this user's access key and secret in your `.env`.

## API reference

The proxy implements the subset of the Mailgun API that Ghost actually uses:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/health` | Health check (unauthenticated) — returns table row counts |
| `GET` | `/metrics` | Prometheus exposition (unauthenticated) |
| `POST` | `/v3/:domain/messages` | Send email — accepts Mailgun multipart form data |
| `GET` | `/v3/:domain/events` | Fetch events — supports Mailgun query params (`event`, `tags`, `begin`, `end`, `limit`) |
| `GET` | `/v3/:domain/events/:pageToken` | Fetch next page of events (cursor-based pagination) |
| `DELETE` | `/v3/:domain/:type/:email` | Delete a suppression (bounces, complaints, unsubscribes) |

All `/v3/*` endpoints require Basic auth with any username and your `PROXY_API_KEY` as the password (matching Mailgun's auth scheme). `/health` and `/metrics` are unauthenticated: the container is reachable only on the internal Docker network, and requiring the API key would push the credential into your Prometheus scrape config for no gain. Do not route either path through a public reverse proxy.

### Send response shape

A send returns `200 {"id": "<batch-message-id>", "message": "Queued. Thank you."}` when at least one recipient was accepted, and `500 {"message": "Failed to send to all recipients", "errors": [...]}` only when every recipient failed.

> **One intentional change from earlier versions.** A batch in which some recipients fail *before* their SES call used to return `500 Internal server error`, discarding any record of the recipients that did succeed. It now returns `200` — the successful recipients are genuinely queued, and the partial failure is reported through `ghost_ses_proxy_send_batches_total{outcome="partial"}` and a `warn` log line rather than by failing the whole request. Reporting a partly-successful newsletter as a total server error made real incidents unreadable.

## Configuration reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_ACCESS_KEY_ID` | Yes | — | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | — | IAM secret key |
| `AWS_REGION` | No | `us-east-1` | AWS region for SES and SQS |
| `SQS_QUEUE_URL` | Yes | — | Full SQS queue URL |
| `SES_CONFIGURATION_SET` | No | `ghost-ses-proxy` | SES Configuration Set name |
| `PROXY_API_KEY` | Yes | — | API key for Ghost authentication |
| `MAILGUN_DOMAIN` | Yes | — | Your sending domain |
| `PORT` | No | `3003` | HTTP port |
| `LOG_LEVEL` | No | `info` | `trace`, `debug`, `info`, `warn`, `error` or `fatal`. Gates **every** log call; an invalid value aborts startup. `debug` adds per-recipient send lines |
| `SEND_CONCURRENCY` | No | `10` | Max parallel SES sends per batch |
| `DB_PATH` | No | `/data/ses-proxy.db` | SQLite database path. Change it only alongside the volume mount |

Missing or invalid configuration is reported as a single startup error listing every problem at once, and the process exits 1 rather than starting in a half-configured state.

## Observability

### Metrics

`GET /metrics` serves the Prometheus exposition format. Application series carry the `ghost_ses_proxy_` prefix; Node's default process metrics (`process_cpu_seconds_total`, `nodejs_eventloop_lag_seconds`, …) keep their conventional unprefixed names.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: ghost-ses-proxy
    static_configs:
      - targets: ['ghost-ses-proxy:3003']
```

The series worth alerting on first:

| Metric | Why |
|--------|-----|
| `ghost_ses_proxy_sqs_last_poll_timestamp_seconds` | The only way to tell "no events because nobody sent a newsletter" from "no events because the poller is dead". Alert when `time() - <metric> > 300` |
| `ghost_ses_proxy_send_batches_total{outcome="failure"}` | A newsletter that reached nobody |
| `ghost_ses_proxy_send_batches_total{outcome="partial"}` | A newsletter some subscribers silently missed |
| `ghost_ses_proxy_events_stored_total{event_type="failed",severity="permanent"}` | Bounce rate — SES suspends accounts above 5% |
| `ghost_ses_proxy_events_stored_total{event_type="complained"}` | Complaint rate — SES threshold is 0.1% |
| `ghost_ses_proxy_send_in_flight` | Held concurrency slots. Pinned at `SEND_CONCURRENCY` with no send throughput means the send path is wedged |
| `ghost_ses_proxy_ses_errors_total{error_type="Throttling"}` | SES sending-rate cap hit |
| `ghost_ses_proxy_event_correlation_total{result="unmatched"}` | Events arriving with no matching send record — Ghost's per-newsletter analytics are degrading |

Route labels use the Express route template (`/v3/:domain/messages`), never the raw path, so a subscriber's email address in `DELETE /v3/:domain/:type/:email` never reaches Prometheus.

### Logs

One JSON object per line, all on **stdout** — including errors. Every line carries `time` (ISO-8601), `level` (a string, not a number), `service`, `version` and `msg`. Beyond that:

| Field | Where | Meaning |
|-------|-------|---------|
| `component` | all | `http`, `send`, `ses`, `sqs`, `suppression`, `db`, `config`, `lifecycle` |
| `reqId` | http, send, ses | Per-request UUID, propagated from the HTTP layer into the send and SES lines it causes |
| `batchId` | send, ses | Batch message ID without angle brackets |
| `ghostEmailId` | send, sqs | Ghost's `v:email-id` |
| `recipient` | send, ses, sqs | Full email address |
| `sesMessageId` | ses, sqs | SES `MessageId` |
| `eventType` / `sesEventType` | sqs | Normalized (`delivered`) and raw SES (`Delivery`) event type |
| `recipientCount`, `succeeded`, `failed` | send | Batch outcome |
| `durationMs` | http, ses | Elapsed time |
| `err` | any | Serialized error with stack |

The `authorization` and `cookie` request headers are redacted. Access logging skips `/health` and `/metrics` — a 30-second healthcheck would otherwise write ~2,880 lines a day into your log store — but metrics still count those requests.

For readable local output, pipe through `pino-pretty`:

```bash
npm start | npx pino-pretty
```

`pino-pretty` is deliberately **not** a dependency of the image: production output is machine-readable JSON, and pretty-printing belongs at the terminal, not in the container.

## Development

```bash
npm ci
npm run dev            # tsx watch on src/index.ts
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:coverage  # vitest run --coverage (thresholds enforced, blocking in CI)
npm run build          # tsc -p tsconfig.build.json → dist/
```

The source is TypeScript under `src/`, compiled to CommonJS in `dist/`. Tests live in `test/`, mirroring `src/`, and run against a real `better-sqlite3` `:memory:` database with the AWS SDK intercepted by `aws-sdk-client-mock`.

`test/golden/` holds the backward-compatibility fixtures asserted by `test/contract.test.ts`: `captured/` records behavior observed from the original JavaScript implementation, `intent/` hand-encodes the behavior that was deliberately *changed*, and `REJECTED.md` records what was not captured and why. `scripts/capture-golden.cjs` is the harness that produced `captured/`; it is kept for reproducibility and never runs in CI.

## Upgrading

The image is a drop-in replacement for earlier versions: same port, same environment variables (`DB_PATH` is new and optional), same `/data` volume, same database file, same container user. No migration step is required. Roll back by re-pinning the previous image tag.

## Event pipeline detail

1. Ghost sends a newsletter → proxy receives multipart form data at `POST /v3/:domain/messages`
2. Proxy parses recipients, substitutes `%recipient.*%` template variables, builds raw MIME for each recipient
3. Each email sent via SES `SendRawEmail` with the configured Configuration Set
4. Proxy stores a mapping: SES Message ID → Ghost batch ID + email ID + recipient
5. SES generates events (delivery, open, click, bounce, complaint) → publishes to SNS → SQS
6. Proxy's SQS poller (long-polling, 20s interval) receives events, maps SES event types to Mailgun equivalents, correlates with stored send data, writes to SQLite
7. Ghost polls `GET /v3/:domain/events` → proxy queries SQLite, returns Mailgun-format event objects with cursor pagination

### Event type mapping

| SES Event | Mailgun Event | Notes |
|-----------|--------------|-------|
| Delivery | `delivered` | |
| Open | `opened` | |
| Click | `clicked` | |
| Bounce (Permanent) | `failed` (severity: permanent) | Also creates suppression |
| Bounce (Transient) | `failed` (severity: temporary) | |
| Complaint | `complained` | Also creates suppression |
| Reject | `failed` (severity: permanent) | Also creates suppression |
| Send, DeliveryDelay | *(skipped)* | No Mailgun equivalent |

## Database

The proxy uses SQLite (via `better-sqlite3`) stored at `/data/ses-proxy.db`, or wherever `DB_PATH` points. Four tables:

- **message_map** — Batch metadata from send requests (Ghost email ID, tags)
- **recipient_emails** — Maps SES message IDs to batch/recipient for event correlation
- **events** — Normalized events in Mailgun format, queried by Ghost
- **suppressions** — Permanent bounces and complaints

A cleanup job runs daily, deleting rows older than 90 days from `message_map`, `recipient_emails` and `events`. **Suppressions never expire** — letting a hard bounce lapse means re-mailing an address that already bounced, which is exactly what degrades SES sending reputation. The only way to remove a suppression is the `DELETE /v3/:domain/:type/:email` endpoint Ghost already uses.

## Limitations

- Only implements the Mailgun API endpoints Ghost uses — not a general-purpose Mailgun replacement
- No support for attachments (Ghost newsletters don't use them)
- Event polling is near-real-time (SQS long-poll), not instant webhooks
- SQLite is single-node; this proxy is designed to run as a single instance

## License

MIT
