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

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/josephsellers/ghost-ses-proxy.git
cd ghost-ses-proxy
cp .env.example .env
# Edit .env with your AWS credentials and settings
```

Don't have the AWS resources yet? See [AWS infrastructure setup](#aws-infrastructure-setup) — the CDK app provisions everything and writes this `.env` for you.

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

## AWS infrastructure setup

The proxy needs a verified SES domain, an SES Configuration Set, an SNS topic, an SQS queue, and an IAM user with credentials. There are two ways to provision them:

- **[Option A — deploy with CDK](#option-a-deploy-with-cdk) (recommended)** — one command, repeatable, and it writes the proxy's `.env` for you
- **[Option B — manual console setup](#option-b-manual-console-setup)** — click through the AWS Console yourself

### Option A: Deploy with CDK

The `cdk/` directory is a self-contained AWS CDK app that provisions everything above, including a dead-letter queue and DNS records when your domain is hosted in Route53.

#### Prerequisites

- An AWS account with CLI credentials configured — `aws sts get-caller-identity` must succeed
- Node.js 20 or newer
- A domain you own (optionally with DNS hosted in Route53, for full automation)

#### 1. Configure

```bash
cd cdk
npm install
cp .env.example .env
# Edit cdk/.env: set SES_DOMAIN (and HOSTED_ZONE_NAME if your DNS is in Route53)
```

`SES_DOMAIN` is the only required variable. Everything else has a default:

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `SES_DOMAIN` | **Yes** | — | Sending domain (becomes `MAILGUN_DOMAIN` in the proxy's `.env`) |
| `AWS_REGION` | No | `us-east-1` | Region for the stack and all resources |
| `AWS_ACCOUNT_ID` | No | resolved from your CLI credentials | Explicit account id. Only needed when `HOSTED_ZONE_NAME` is set |
| `HOSTED_ZONE_NAME` | No | *(unset)* | Route53 public hosted zone containing `SES_DOMAIN`. When set, DKIM and MAIL FROM records are created for you |
| `STACK_NAME` | No | `GhostSesProxy` | CloudFormation stack name. All resource-name defaults derive from it (kebab-cased: `GhostSesProxy` → `ghost-ses-proxy`) |
| `SES_CONFIGURATION_SET` | No | `ghost-ses-proxy` | Configuration Set name |
| `SNS_TOPIC_NAME` | No | `ghost-ses-proxy-events` | SNS topic name |
| `SQS_QUEUE_NAME` | No | `ghost-ses-proxy-events` | SQS queue name (the DLQ is `<name>-dlq`) |
| `IAM_USER_NAME` | No | `ghost-ses-proxy` | IAM user name |
| `CREDENTIALS_SECRET_NAME` | No | `ghost-ses-proxy/credentials` | Secrets Manager secret holding the access key |
| `ACCESS_KEY_SERIAL` | No | `1` | Increment to rotate the IAM access key on the next deploy |
| `SQS_RETENTION_DAYS` | No | `14` | Queue message retention, max 14 |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | No | `30` | Queue visibility timeout |
| `DLQ_MAX_RECEIVE_COUNT` | No | `5` | Receives before a message moves to the DLQ; `0` disables the DLQ |
| `SES_MAIL_FROM_SUBDOMAIN` | No | *(unset)* | e.g. `bounce` → custom MAIL FROM domain `bounce.<SES_DOMAIN>` |

The same list, with commentary, lives in [`cdk/.env.example`](cdk/.env.example). Invalid or missing values are reported all at once before anything is deployed.

#### 2. Deploy

```bash
npx cdk bootstrap   # first time only, per account/region
npx cdk deploy
```

#### 3. Add DNS records (skip if you set `HOSTED_ZONE_NAME`)

The deploy prints `DkimCnameName1..3` and `DkimCnameValue1..3` outputs — add those three CNAME records at your DNS provider. If you set `SES_MAIL_FROM_SUBDOMAIN`, also add the `MailFromMxRecord` and `MailFromSpfRecord` entries. SES marks the identity **Verified** once DNS propagates (usually minutes, up to 72 hours).

With `HOSTED_ZONE_NAME` set, these records are created in Route53 automatically and no outputs are printed.

#### 4. Generate the proxy's `.env`

```bash
npm run generate-env
```

This reads the stack outputs and the generated credentials, then writes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `SQS_QUEUE_URL`, `SES_CONFIGURATION_SET`, and `MAILGUN_DOMAIN` into the repo-root `.env` (mode `0600`). Use `npm run generate-env -- --out /path/to/.env` to write elsewhere.

It is safe to re-run: managed values are replaced in place, while `PROXY_API_KEY`, `PORT`, `LOG_LEVEL`, comments, and any other keys are preserved verbatim. If there is no `PROXY_API_KEY` yet, a random one is generated for you — that is the key Ghost authenticates with, so copy it into Ghost's `mailgun_api_key` setting (Quick start step 4). Secret values are never printed to the console.

#### 5. Request SES production access (one time)

New AWS accounts are in the SES sandbox: you can only send to verified addresses, capped at 200 emails/day. Request production access in the Console under **SES > Account dashboard > Request production access**. AWS reviews this manually; it cannot be automated.

#### 6. Start the proxy

```bash
cd ..
docker compose up -d
curl http://localhost:3003/health
```

#### Day-2 operations

- **Change a setting:** edit `cdk/.env` → `npx cdk deploy` → re-run `npm run generate-env` if any output changed, then restart the proxy.
- **Rotate credentials:** bump `ACCESS_KEY_SERIAL` → `npx cdk deploy` → `npm run generate-env` → restart the proxy.
- **Renaming a resource replaces it.** Changing `SQS_QUEUE_NAME` creates a new queue with a new URL and drops any in-flight messages; re-run `generate-env` afterwards.
- **Second deployment** (e.g. a second Ghost instance): copy `cdk/.env` and change `STACK_NAME`. Every resource name derives from it, so the two stacks coexist in one account with no other overrides.
- **Tear down:** `npx cdk destroy` removes everything, including the credentials secret. Events still sitting in the queue are lost.

#### Troubleshooting

- **"Resource already exists"** — you previously created some of these resources by hand. Either point `cdk/.env` at different names (or a different `STACK_NAME`), or delete the manual resources first. Importing existing resources into the stack is not supported.
- **Emails only reach a few addresses** — you are still in the SES sandbox; see step 5.
- **Identity stuck at "Pending verification"** — the DKIM CNAMEs are missing, mistyped, or not yet propagated; see step 3.
- **`npm run generate-env` says the stack does not exist** — run `npx cdk deploy` first, and check that `AWS_REGION`/`STACK_NAME` in `cdk/.env` match what you deployed.

### Option B: Manual console setup

You need four AWS resources: a verified SES domain, a Configuration Set, an SNS topic, and an SQS queue.

> The IAM policy below grants `ses:SendRawEmail` on `"Resource": "*"`. The CDK app (Option A) scopes the same permission to just the email identity and Configuration Set it creates.

#### 1. Verify your domain in SES

In the AWS Console under **SES > Verified identities**, add your sending domain. Complete DNS verification by adding the DKIM CNAME records to your domain's DNS.

#### 2. Create an SES Configuration Set

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

#### 3. Create an SNS topic

Create a standard SNS topic (e.g., `ghost-ses-events`). No special configuration needed — it just bridges SES to SQS.

#### 4. Create an SQS queue

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

#### 5. Create an IAM user

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
| `POST` | `/v3/:domain/messages` | Send email — accepts Mailgun multipart form data |
| `GET` | `/v3/:domain/events` | Fetch events — supports Mailgun query params (`event`, `tags`, `begin`, `end`, `limit`) |
| `GET` | `/v3/:domain/events/:pageToken` | Fetch next page of events (cursor-based pagination) |
| `DELETE` | `/v3/:domain/:type/:email` | Delete a suppression (bounces, complaints, unsubscribes) |

All `/v3/*` endpoints require Basic auth with any username and your `PROXY_API_KEY` as the password (matching Mailgun's auth scheme).

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
| `LOG_LEVEL` | No | `info` | Set to `debug` for per-recipient send logs |
| `SEND_CONCURRENCY` | No | `10` | Max parallel SES sends per batch |

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

The proxy uses SQLite (via `better-sqlite3`) stored at `/data/ses-proxy.db`. Four tables:

- **message_map** — Batch metadata from send requests (Ghost email ID, tags)
- **recipient_emails** — Maps SES message IDs to batch/recipient for event correlation
- **events** — Normalized events in Mailgun format, queried by Ghost
- **suppressions** — Permanent bounces and complaints

A cleanup job runs daily, deleting records older than 90 days.

## Limitations

- Only implements the Mailgun API endpoints Ghost uses — not a general-purpose Mailgun replacement
- No support for attachments (Ghost newsletters don't use them)
- Event polling is near-real-time (SQS long-poll), not instant webhooks
- SQLite is single-node; this proxy is designed to run as a single instance

## License

MIT
