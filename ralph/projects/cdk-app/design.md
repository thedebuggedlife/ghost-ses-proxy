# CDK Infrastructure App — Design Specification

> **Status:** Draft
> **Date:** 2026-07-28

## Goal

Replace the README's manual "AWS setup guide" (console-clicking through SES identity, Configuration Set, SNS topic, SQS queue, IAM user, and access keys) with a self-contained AWS CDK application under `cdk/` that provisions everything in one idempotent `cdk deploy`, configured entirely through a gitignored `.env` file, and generates the proxy's runtime `.env` automatically. Manual steps shrink to: procure a domain, add DNS records only if the domain is *not* in Route53, and request SES production access once.

## Current State

### What exists

- The proxy is a Node.js app (`server.js` + `lib/*.js` on this branch) deployed via Docker Compose next to Ghost. It consumes AWS resources but nothing in the repo creates them.
- `README.md` § "AWS setup guide" documents five manual console steps: verify SES domain, create a Configuration Set named `ghost-ses-proxy` with an SNS event destination (Sends, Deliveries, Opens, Clicks, Bounces, Complaints, Rejects), create SNS topic `ghost-ses-events`, create SQS queue `ghost-ses-events` subscribed to the topic with a hand-written access policy, create an IAM user with an inline policy and paste its keys into `.env`.
- `lib/sqs-poller.js:21-25` unwraps the SNS notification envelope (`{Type: 'Notification', Message: '...'}`) and also accepts raw SES event JSON — so a standard (non-raw) SNS→SQS subscription matches current behavior.
- `.env.example` lists the proxy's runtime configuration: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `SQS_QUEUE_URL`, `SES_CONFIGURATION_SET`, `PROXY_API_KEY`, `MAILGUN_DOMAIN`, plus optional `PORT`, `LOG_LEVEL`, `SEND_CONCURRENCY`.
- `.gitignore` contains only `node_modules/`, `data/`, `.env`.
- CI (`.github/workflows/ci.yml`) builds the Docker image and syntax-checks `lib/*.js`. There is **no test framework** on this branch (a TypeScript port with vitest is in progress on another branch; this feature must not collide with it).

### Problems

1. Five error-prone manual console steps (JSON policies typed by hand, event-type checkboxes easy to miss — a missing event type silently drops Ghost analytics).
2. No reproducibility: a second environment or a teardown/rebuild repeats all the manual work; drift between the docs and what's actually in the account is invisible.
3. Secret handling is manual: IAM keys are created in the console and pasted into `.env` by hand.
4. The proxy `.env` must be assembled by hand from values scattered across the console (queue URL, region, config set name).
5. No dead-letter queue: a poison SQS message would be retried forever.

## Design Sections

### 1. Package layout and toolchain

A self-contained npm package at `cdk/` — its own `package.json`, lockfile, and `node_modules`; the root `package.json` is not touched (avoids conflicts with the concurrent TypeScript port).

```
cdk/
├── package.json          # private, own deps — never merged into root
├── package-lock.json
├── tsconfig.json
├── cdk.json              # { "app": "npx tsx bin/cdk-app.ts" }
├── vitest.config.ts
├── .env.example          # committed template; cdk/.env is gitignored
├── bin/
│   └── cdk-app.ts        # entry: load .env → parse config → new GhostSesProxyStack
├── lib/
│   ├── config.ts         # env parsing + validation → typed CdkAppConfig
│   └── ghost-ses-proxy-stack.ts
├── scripts/
│   └── generate-proxy-env.ts
└── test/
    ├── config.test.ts
    ├── stack.test.ts
    └── generate-proxy-env.test.ts
```

Dependencies:

| Package | Kind | Purpose |
|---------|------|---------|
| `aws-cdk-lib` ^2 (latest), `constructs` ^10 | dep | CDK constructs |
| `dotenv` | dep | load `cdk/.env` in `bin/cdk-app.ts` and the script |
| `@aws-sdk/client-cloudformation`, `@aws-sdk/client-secrets-manager` | dep | `generate-proxy-env.ts` |
| `aws-cdk` ^2, `tsx`, `typescript`, `vitest` | devDep | CLI, TS execution, tests |

npm scripts: `"synth": "cdk synth"`, `"deploy": "cdk deploy"`, `"destroy": "cdk destroy"`, `"generate-env": "tsx scripts/generate-proxy-env.ts"`, `"test": "vitest run"`.

`tsx` (not `ts-node`) runs the app — no compile step, no `dist/` for the CDK package.

### 2. Configuration (`cdk/.env`)

`bin/cdk-app.ts` calls `dotenv.config()` then `parseConfig(process.env)` from `lib/config.ts`. `parseConfig` is a pure function (testable) returning `CdkAppConfig`; it throws a single error listing **all** missing/invalid variables at once.

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `SES_DOMAIN` | **Yes** | — | Sending domain (becomes `MAILGUN_DOMAIN` in the proxy env) |
| `AWS_REGION` | No | `us-east-1` | Region for the stack and all resources |
| `AWS_ACCOUNT_ID` | No | resolved from CLI credentials (`CDK_DEFAULT_ACCOUNT`) | Explicit account for the Route53 lookup env. Only needed for synth/deploy with `HOSTED_ZONE_NAME` set — enforced in `bin/cdk-app.ts`, never in `parseConfig` (see §5) |
| `HOSTED_ZONE_NAME` | No | *(unset)* | Route53 public hosted zone name (e.g. `example.com`). When set, DKIM/MAIL FROM DNS records are created automatically |
| `STACK_NAME` | No | `GhostSesProxy` | CloudFormation stack name. All resource-name defaults derive from it (kebab-cased `<prefix>`, e.g. `GhostSesProxy` → `ghost-ses-proxy`), so changing it alone yields a collision-free second deployment |
| `SES_CONFIGURATION_SET` | No | `<prefix>` (`ghost-ses-proxy`) | Configuration Set name |
| `SNS_TOPIC_NAME` | No | `<prefix>-events` (`ghost-ses-proxy-events`) | SNS topic name |
| `SQS_QUEUE_NAME` | No | `<prefix>-events` (`ghost-ses-proxy-events`) | SQS queue name (DLQ is `<name>-dlq`) |
| `IAM_USER_NAME` | No | `<prefix>` (`ghost-ses-proxy`) | IAM user name |
| `CREDENTIALS_SECRET_NAME` | No | `<prefix>/credentials` (`ghost-ses-proxy/credentials`) | Secrets Manager secret name |
| `ACCESS_KEY_SERIAL` | No | `1` | Increment to rotate the IAM access key on next deploy |
| `SQS_RETENTION_DAYS` | No | `14` | Queue message retention (max 14; > SQS's 4-day default so events survive proxy downtime) |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | No | `30` | Queue visibility timeout |
| `DLQ_MAX_RECEIVE_COUNT` | No | `5` | Receives before a message moves to the DLQ; `0` disables the DLQ entirely |
| `SES_MAIL_FROM_SUBDOMAIN` | No | *(unset)* | e.g. `bounce` → custom MAIL FROM domain `bounce.<SES_DOMAIN>` |

Validation rules in `parseConfig`:
- `SES_DOMAIN` present, no scheme/slash/`@`, at least one dot.
- If `HOSTED_ZONE_NAME` is set: `SES_DOMAIN` must equal it or end with `.<HOSTED_ZONE_NAME>`.
- `parseConfig` never requires an account. Account resolution (`AWS_ACCOUNT_ID` ?? `CDK_DEFAULT_ACCOUNT`) is enforced in `bin/cdk-app.ts` when `HOSTED_ZONE_NAME` is set — `CDK_DEFAULT_ACCOUNT` exists only under the CDK CLI, and `generate-proxy-env.ts` reuses `parseConfig` outside it, so a parse-time account check would break `npm run generate-env` for every Route53 user.
- Numeric vars parse as positive integers (`DLQ_MAX_RECEIVE_COUNT` ≥ 0); `SQS_RETENTION_DAYS` in 1–14; `SQS_VISIBILITY_TIMEOUT_SECONDS` in 0–43200.
- `STACK_NAME` must match CloudFormation's constraint (`/^[A-Za-z][A-Za-z0-9-]*$/`) and be ≤ 50 chars so every derived name stays within AWS limits. The derived `<prefix>` is the stack name kebab-cased: split on case boundaries, lowercase, join with `-` (`GhostSesProxy` → `ghost-ses-proxy`, `MyBlog` → `my-blog`). Explicit `*_NAME`/secret-name vars always override the derived defaults.

`cdk/.env.example` mirrors `.env.example`'s commented style, with only `SES_DOMAIN` uncommented.

### 3. The stack (`lib/ghost-ses-proxy-stack.ts`)

One stack, `GhostSesProxyStack extends Stack`, taking `CdkAppConfig` via props. Resource graph:

```
EmailIdentity (SES_DOMAIN, dkim)
   └─ default ConfigurationSet ──┐
ConfigurationSet ────────────────┤
   └─ EventDestination (SNS) ──▶ SNS Topic ──subscription──▶ SQS Queue ──redrive──▶ DLQ
IAM User ── inline policy: ses:SendRawEmail (identity+config-set ARNs), sqs:* (queue ARN)
   └─ AccessKey (serial) ──secret──▶ Secrets Manager Secret
CfnOutputs: queue URL, config set, domain, secret ARN, DKIM CNAMEs (non-Route53), MAIL FROM records
```

Construction order and sketch:

```ts
export class GhostSesProxyStack extends Stack {
  constructor(scope: Construct, id: string, props: GhostSesProxyStackProps) {
    super(scope, id, { ...props, env: { account, region } });
    const cfg = props.config;

    const topic = new sns.Topic(this, 'EventsTopic', { topicName: cfg.snsTopicName });

    const dlq = cfg.dlqMaxReceiveCount > 0
      ? new sqs.Queue(this, 'EventsDlq', {
          queueName: `${cfg.sqsQueueName}-dlq`,
          retentionPeriod: Duration.days(14),
        })
      : undefined;
    const queue = new sqs.Queue(this, 'EventsQueue', {
      queueName: cfg.sqsQueueName,
      retentionPeriod: Duration.days(cfg.sqsRetentionDays),
      visibilityTimeout: Duration.seconds(cfg.sqsVisibilityTimeoutSeconds),
      deadLetterQueue: dlq ? { queue: dlq, maxReceiveCount: cfg.dlqMaxReceiveCount } : undefined,
    });
    topic.addSubscription(new subscriptions.SqsSubscription(queue, { rawMessageDelivery: false }));

    const configurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: cfg.sesConfigurationSet,
    });
    configurationSet.addEventDestination('SnsDestination', {
      destination: ses.EventDestination.snsTopic(topic),
      events: [
        ses.EmailSendingEvent.SEND, ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.OPEN, ses.EmailSendingEvent.CLICK,
        ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
      ],
    });

    const hostedZone = cfg.hostedZoneName
      ? route53.HostedZone.fromLookup(this, 'Zone', { domainName: cfg.hostedZoneName })
      : undefined;
    const identity = new ses.EmailIdentity(this, 'Identity', {
      identity: hostedZone
        ? ses.Identity.publicHostedZone(hostedZone)   // auto-creates DKIM (and MAIL FROM) records
        : ses.Identity.domain(cfg.sesDomain),
      configurationSet,                                // safety net; proxy also passes it per-send
      mailFromDomain: cfg.sesMailFromSubdomain
        ? `${cfg.sesMailFromSubdomain}.${cfg.sesDomain}` : undefined,
    });

    const user = new iam.User(this, 'ProxyUser', { userName: cfg.iamUserName });
    user.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendRawEmail'],
      resources: [identity.emailIdentityArn, configurationSet.configurationSetArn],
    }));
    user.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      resources: [queue.queueArn],
    }));
    const accessKey = new iam.AccessKey(this, 'ProxyAccessKey', { user, serial: cfg.accessKeySerial });
    const secret = new secretsmanager.Secret(this, 'ProxyCredentials', {
      secretName: cfg.credentialsSecretName,
      secretObjectValue: {
        accessKeyId: SecretValue.unsafePlainText(accessKey.accessKeyId),
        secretAccessKey: accessKey.secretAccessKey,
      },
    });
  }
}
```

Notes and decisions baked in:

- **Route53 identity edge case:** `Identity.publicHostedZone(zone)` uses the zone's name as the identity. When `SES_DOMAIN` is a *subdomain* of the zone (e.g. `mail.example.com` in zone `example.com`), use `Identity.domain(cfg.sesDomain)` plus three explicit `route53.CnameRecord`s built from `identity.dkimDnsTokenName1..3` / `dkimDnsTokenValue1..3` targeting the zone. Implement a small branch: `sesDomain === hostedZoneName` → `publicHostedZone`; subdomain → manual records. If the CDK version in use auto-handles subdomains, the manual branch can be dropped — verify against `Template` assertions at implementation time. **MAIL FROM in a hosted zone:** when `SES_MAIL_FROM_SUBDOMAIN` is set and a hosted zone is used, the MAIL FROM MX/TXT records must end up in the zone — verify whether `EmailIdentity` auto-creates them (apex branch); where it doesn't (notably the manual-DKIM subdomain branch), add explicit `route53.MxRecord` (`10 feedback-smtp.<region>.amazonses.com`) and `route53.TxtRecord` (`"v=spf1 include:amazonses.com ~all"`) on the MAIL FROM domain. The MAIL FROM *outputs* remain non-Route53-only (§4).
- **`rawMessageDelivery: false`** — matches today's documented console setup; `lib/sqs-poller.js` unwraps the envelope. Do not enable raw delivery even though the poller would tolerate it; keeps parity with existing deployments.
- **Queue policy:** `SqsSubscription` auto-generates the `sqs:SendMessage` policy conditioned on the topic ARN — replaces the hand-written policy in the README verbatim in effect.
- **IAM scoping** is tighter than the README's `"Resource": "*"` for SES: scoped to the created identity and configuration set ARNs. This is an intentional improvement; note it in the README.
- **Event types are not configurable.** The seven types are the contract the proxy's event mapper expects (`Send`/`DeliveryDelay` skipped downstream). Making them configurable invites silently breaking Ghost analytics.
- **Key rotation:** bumping `ACCESS_KEY_SERIAL` replaces the `AccessKey` resource on next deploy; the secret updates in place; rerun `generate-env` afterwards.
- **`secretObjectValue` with `unsafePlainText`** for the key ID is fine — the key ID is not secret; the secret access key uses the `SecretValue` from the `AccessKey` construct and never appears in the template.
- **Teardown:** the secret gets `removalPolicy: RemovalPolicy.DESTROY` so `cdk destroy` fully cleans up. Everything is recreatable; nothing in this stack holds durable data (in-flight SQS events are lost on destroy — acceptable, documented).

### 4. Stack outputs

Stable output keys — the generate-env script depends on them; renaming any of these is a breaking change to the script:

| Output key | Value | Condition |
|------------|-------|-----------|
| `SqsQueueUrl` | `queue.queueUrl` | always |
| `SesConfigurationSet` | config set name | always |
| `SendingDomain` | `cfg.sesDomain` | always |
| `AwsRegion` | stack region | always |
| `CredentialsSecretArn` | `secret.secretArn` | always |
| `DkimCnameName1..3` / `DkimCnameValue1..3` | `identity.dkimDnsTokenName1..3` / `Value1..3` | only when no hosted zone (records the user must create) |
| `MailFromMxRecord` / `MailFromSpfRecord` | `10 feedback-smtp.<region>.amazonses.com` / `"v=spf1 include:amazonses.com ~all"` for the MAIL FROM domain | only when `SES_MAIL_FROM_SUBDOMAIN` set and no hosted zone |

After a non-Route53 deploy, the CLI output therefore *is* the DNS to-do list.

### 5. `scripts/generate-proxy-env.ts`

Bridges stack outputs → the proxy's runtime `.env`. Run as `npm run generate-env` (optionally `-- --out /path/to/.env`; default `../.env`, i.e. repo root).

```
1. dotenv.config() on cdk/.env → STACK_NAME, AWS_REGION via parseConfig — which imposes
   no account requirement (§2), so this runs outside the CDK CLI even with HOSTED_ZONE_NAME set
2. CloudFormation DescribeStacks(STACK_NAME) → outputs map; fail with a clear
   message if the stack doesn't exist ("run npx cdk deploy first")
3. SecretsManager GetSecretValue(CredentialsSecretArn output) → { accessKeyId, secretAccessKey }
4. Read the target .env if it exists; parse line-by-line
5. Merge and write (0600 permissions)
```

Merge semantics (pure function `mergeEnvFile(existingLines: string[], managed: Record<string,string>): string[]`, unit-tested):

- **Managed keys** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `SQS_QUEUE_URL`, `SES_CONFIGURATION_SET`, `MAILGUN_DOMAIN`: existing lines get their value replaced in place; missing keys are appended at the end.
- **`PROXY_API_KEY`**: preserved if present; otherwise generated as `crypto.randomBytes(32).toString('hex')` and appended. (Removes another manual step — the user never invents a key.)
- **Everything else** (comments, blank lines, `PORT`, `LOG_LEVEL`, unknown keys): passed through verbatim, order preserved.

The script prints which keys were written/preserved but **never prints secret values**. Running it repeatedly is idempotent: same stack → same file (modulo a `PROXY_API_KEY` generated on first run and preserved after).

### 6. Idempotency and re-deploy behavior

- `cdk deploy` is CloudFormation-backed: re-running with an unchanged `.env` is a no-op; changing a value converges the stack to it. This satisfies the idempotency requirement by construction.
- **Renaming caveat** (documented in README): changing a physical name (`SQS_QUEUE_NAME`, `IAM_USER_NAME`, etc.) replaces that resource. A queue replacement drops in-flight messages and changes the queue URL → rerun `generate-env` and restart the proxy. This is inherent to named resources; the names are kept explicit anyway so the AWS console matches the README's vocabulary.
- **Multiple deployments:** because resource-name defaults derive from `STACK_NAME`, setting e.g. `STACK_NAME=SecondBlog` yields a fully disjoint name set (`second-blog`, `second-blog-events`, `second-blog/credentials`, …) — two stacks coexist in one account with no other overrides. The derived topic/queue default (`ghost-ses-proxy-events`) intentionally differs from Option B's manual example (`ghost-ses-events`); the proxy only consumes the queue URL, so the difference is cosmetic.
- **Pre-existing manual resources:** a prior manual setup still collides on the config set / IAM user default (`ghost-ses-proxy`); `cdk deploy` fails with "already exists". README documents the two options: pick different names (or a different `STACK_NAME`) in `cdk/.env`, or delete the manual resources first (CloudFormation import is out of scope).
- `cdk bootstrap` is a documented one-time prerequisite per account/region.
- `cdk.context.json` (Route53 lookup cache) is **gitignored** — it contains per-user account/zone IDs; this repo is a template many users deploy, not a single-environment app.

### 7. Remaining manual steps (documented, not automated)

1. **Procure a domain** — inherently manual.
2. **DNS records** — only when DNS is *not* in Route53: add the 3 DKIM CNAMEs (+ MAIL FROM MX/TXT if enabled) from the stack outputs. With Route53, fully automated.
3. **SES production access** — new accounts are sandboxed (verified recipients only, 200/day). Exiting requires a request reviewed by AWS (Console → SES → Account dashboard → Request production access). Not automatable by design (human approval on AWS's side); `PutAccountDetails` API-based requests were considered and rejected — the console form is one-time and the API route still requires the same review, for more code.

The README's rewritten setup section lists exactly these three and nothing else.

### 8. Documentation (README walkthrough)

The README's "AWS setup guide" section is replaced by a new **"AWS infrastructure setup"** section with two options; the CDK path is the headline. Structure:

```markdown
## AWS infrastructure setup

Two ways to provision the AWS resources the proxy needs (SES identity,
Configuration Set, SNS topic, SQS queue, IAM credentials):

- **Option A — CDK app (recommended):** one command, idempotent, generates your .env
- **Option B — manual console setup:** today's step-by-step console guide, unchanged

### Option A: Deploy with CDK

#### Prerequisites
- An AWS account with CLI credentials configured (`aws sts get-caller-identity` works)
- Node.js 20+
- A domain you own (optionally with DNS hosted in Route53 for full automation)

#### 1. Configure
    cd cdk
    npm install
    cp .env.example .env     # edit: set SES_DOMAIN (and HOSTED_ZONE_NAME if using Route53)
(link to the full configuration table — every variable, default, and meaning, per §2)

#### 2. Deploy
    npx cdk bootstrap        # first time only, per account/region
    npx cdk deploy

#### 3. Verify your domain (skip if using Route53)
Add the 3 DKIM CNAME records printed in the stack outputs to your DNS provider.
SES shows the identity as "Verified" once DNS propagates (up to ~72h, usually minutes).

#### 4. Generate the proxy's .env
    npm run generate-env     # writes ../.env with credentials, queue URL, and a fresh PROXY_API_KEY

#### 5. Request SES production access (one time)
New AWS accounts are sandboxed (verified recipients only, 200 emails/day).
Console → SES → Account dashboard → Request production access.

#### 6. Start the proxy
    cd .. && docker compose up -d && curl localhost:3003/health

#### Day-2 operations
- **Change a setting:** edit cdk/.env → `npx cdk deploy` → rerun `npm run generate-env` if outputs changed
- **Rotate credentials:** bump ACCESS_KEY_SERIAL → deploy → `npm run generate-env` → restart proxy
- **Second deployment** (e.g. another Ghost instance): copy cdk/.env, change STACK_NAME — all resource names derive from it, so nothing collides
- **Tear down:** `npx cdk destroy` (removes everything including the secret)

#### Troubleshooting
- "Resource already exists": you previously created resources manually — rename in cdk/.env or delete the manual ones (§6)
- Emails only reach verified addresses: still in the SES sandbox (step 5)
- Identity stuck "Pending verification": DKIM CNAMEs missing or not yet propagated

### Option B: Manual console setup
(today's "AWS setup guide" content, unchanged, with a note that the CDK app's IAM
policy is scoped tighter than this guide's `"Resource": "*"`)
```

Rules for the README work:
- The Quick start section's step 1 gains one line pointing at "AWS infrastructure setup" so new users find the CDK path before the manual one.
- The Configuration reference table for the *proxy* stays where it is; the *CDK* configuration table lives in the new section (or `cdk/.env.example` is referenced directly) — the two must not be merged, they configure different programs.
- Option B's content is moved, not rewritten — byte-level churn there creates merge conflicts with the concurrent branch for no value.

### 9. CI gating

The existing `ci.yml` already runs on `pull_request` targeting `dev` — the new job slots into the same workflow so it gates the same PRs:

```yaml
  cdk-test:
    runs-on: ubuntu-latest
    defaults:
      run: { working-directory: cdk }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: cdk/package-lock.json }
      - run: npm ci
      - run: npm test
      - run: npx cdk synth --quiet
        env: { SES_DOMAIN: example.com }
```

- **No path filter** — the job runs on every PR, cheap (~1 min) and, more importantly, a required status check must be produced on every PR or GitHub blocks the merge waiting for a check that never runs. Skipping via `paths:` would break gating.
- The synth smoke test runs without AWS credentials (no `HOSTED_ZONE_NAME` → no context lookup), proving a clean checkout synthesizes with only `SES_DOMAIN` set.
- **Branch protection:** making `cdk-test` (and the existing `docker-build`) *required* checks is a one-time GitHub repo-settings change, not something the codebase can enforce. The execution phase ends with a note to the maintainer to add `cdk-test` to the required checks for `dev`; if branch protection is not configured, the job still runs and reports on every PR.

## Interaction with Existing Code

### What changes

| Location | Change |
|----------|--------|
| `README.md` | "AWS setup guide" becomes "AWS infrastructure setup" with Option A (CDK walkthrough) and Option B (today's console guide, moved not rewritten) — full blueprint in §8 |
| `.gitignore` | Add `cdk/cdk.out/` and `cdk/cdk.context.json` only — the existing unanchored `.env` pattern already ignores `cdk/.env`, and `node_modules/` already matches nested dirs. |
| `.github/workflows/ci.yml` | New `cdk-test` job (vitest + credential-free synth smoke) gating the same PRs as `docker-build` — YAML in §9 |

### What stays the same

- **No proxy runtime code changes** — `server.js`, `lib/*.js`, `Dockerfile`, `docker-compose.example.yml` are untouched. The CDK app provisions the resources the proxy already expects, with the same default names as the README.
- Root `package.json` untouched (no workspaces) — the concurrent TypeScript port owns that surface.
- `.env.example` at the root stays as-is: it documents the proxy's contract, which `generate-env` fills in.

### Migration path

None needed — existing manually-provisioned deployments keep working; CDK is additive. A user migrating an existing deployment either imports nothing (delete + recreate resources, accepting brief event loss) or keeps manual resources and ignores the CDK app.

## Test Plan

This branch has no test infrastructure; the CDK package brings its own **vitest** (consistent with the TS port's direction on the other branch) plus `aws-cdk-lib/assertions`. All tests live under `cdk/test/`, named `*.test.ts`, run by `npm test` in `cdk/` and by the new CI job.

### Unit tests

**`cdk/test/config.test.ts`** — `parseConfig` (pure, no mocks):
- Happy path: minimal env (`SES_DOMAIN` only) yields all documented defaults.
- Happy path: every variable set is reflected in the output.
- Missing `SES_DOMAIN` throws; the error message names the variable.
- Multiple invalid vars → one error listing all of them.
- `HOSTED_ZONE_NAME` set with `SES_DOMAIN` outside the zone throws; equal-to-zone and subdomain-of-zone both pass.
- `HOSTED_ZONE_NAME` set with no `AWS_ACCOUNT_ID`/`CDK_DEFAULT_ACCOUNT` still parses successfully — account enforcement is `bin/`-only; this guards `generate-env` for Route53 users.
- Numeric validation: non-numeric, negative, `SQS_RETENTION_DAYS=15` throw; `DLQ_MAX_RECEIVE_COUNT=0` is valid (disables DLQ).
- Name derivation: default `STACK_NAME` yields `ghost-ses-proxy` / `ghost-ses-proxy-events` / `ghost-ses-proxy/credentials`; `STACK_NAME=MyBlog` yields `my-blog`-based names; explicit `*_NAME` vars override derivation; invalid stack name (bad characters, > 50 chars) throws.

**`cdk/test/generate-proxy-env.test.ts`** — `mergeEnvFile` (pure) and key generation:
- Empty existing file → all managed keys + generated `PROXY_API_KEY` written.
- Existing file: managed values replaced in place; comments, ordering, `PORT`, unknown keys preserved verbatim; existing `PROXY_API_KEY` untouched.
- Second merge with same inputs is byte-identical (idempotency).
- AWS calls are not unit-tested; fetch logic stays thin in `main()` (mock-free by design).

### Integration tests (CDK `Template` assertions — component wiring without deploying)

**`cdk/test/stack.test.ts`** — synthesize with a fixed config and assert on the template. Fixtures: a `makeStack(overrides)` helper building `App` → `GhostSesProxyStack`; for Route53 cases, pass `App` context pre-seeded with the hosted-zone lookup key (`hosted-zone:account=123456789012:domainName=example.com:region=us-east-1` → `{ Id, Name }`) and an explicit `env`.
- Config set exists with the configured name; its event destination targets the SNS topic and lists exactly the 7 event types.
- SQS queue has the configured name, 14-day retention, redrive policy to `<name>-dlq` with `maxReceiveCount: 5`; DLQ absent when `DLQ_MAX_RECEIVE_COUNT=0`.
- Queue policy allows `sqs:SendMessage` from `sns.amazonaws.com` conditioned on the topic ARN; subscription has `RawMessageDelivery` false/absent.
- IAM user policy: `ses:SendRawEmail` scoped to identity + config set ARNs (not `*`); SQS actions scoped to the queue ARN.
- Access key resource exists with `Serial`; Secrets Manager secret references the access key's secret (assert the template contains no plaintext secret access key).
- EmailIdentity present with DKIM; `configurationSetName` attached; `MailFromDomain` set when configured.
- No hosted zone → six `DkimCname*` outputs present; hosted zone case → three `AWS::Route53::RecordSet` CNAMEs and no DKIM outputs; hosted zone + subdomain + `SES_MAIL_FROM_SUBDOMAIN` → MX and TXT RecordSets for the MAIL FROM domain present.
- `SqsQueueUrl`, `CredentialsSecretArn`, `SesConfigurationSet`, `SendingDomain`, `AwsRegion` outputs always present (guards the generate-env contract).

### Backward compatibility

- Snapshot-free by intent (assertions over snapshots — resilient to CDK lib upgrades).
- CI synth smoke test proves the app synthesizes from a clean checkout with only `SES_DOMAIN` set.
- Real `cdk deploy` verification is manual (documented in the README); no CI credentials assumed.

## Files Changed

| File | Change |
|------|--------|
| `cdk/package.json` | **New file.** Private package: deps, npm scripts (`synth`, `deploy`, `destroy`, `generate-env`, `test`) |
| `cdk/package-lock.json` | **New file.** Committed lockfile |
| `cdk/tsconfig.json` | **New file.** Strict TS config for tsx/vitest |
| `cdk/cdk.json` | **New file.** `{"app": "npx tsx bin/cdk-app.ts"}` + standard feature flags |
| `cdk/vitest.config.ts` | **New file.** Test runner config |
| `cdk/.env.example` | **New file.** Committed config template (§2 table) |
| `cdk/bin/cdk-app.ts` | **New file.** dotenv → `parseConfig` → stack instantiation |
| `cdk/lib/config.ts` | **New file.** `CdkAppConfig` type + `parseConfig` validation |
| `cdk/lib/ghost-ses-proxy-stack.ts` | **New file.** The stack (§3) + outputs (§4) |
| `cdk/scripts/generate-proxy-env.ts` | **New file.** Output/secret fetch + `mergeEnvFile` + writer (§5) |
| `cdk/test/config.test.ts` | **New file.** Config unit tests |
| `cdk/test/stack.test.ts` | **New file.** Template assertion tests |
| `cdk/test/generate-proxy-env.test.ts` | **New file.** Merge-logic unit tests |
| `README.md` | New "AWS infrastructure setup" section per §8: CDK walkthrough (prerequisites → configure → deploy → DNS → generate-env → production access → start proxy), day-2 ops, troubleshooting; Option B keeps today's console guide |
| `.gitignore` | Add `cdk/cdk.out/`, `cdk/cdk.context.json` (existing `.env` pattern already covers `cdk/.env`) |
| `.github/workflows/ci.yml` | Add `cdk-test` job per §9 (vitest + synth smoke, no path filter, PR-gating) |

## Open Questions

1. **Should the CDK app also deploy the proxy container in AWS (Fargate/App Runner), or provision AWS-side resources only?**
   _Resolved:_ AWS resources only. The proxy keeps running via Docker Compose next to Ghost, per the README's deployment model.

2. **How should the SES domain identity be handled — Route53-automated, manual, or both?**
   _Resolved:_ Both, switched by `HOSTED_ZONE_NAME` in `.env`. With a hosted zone, DKIM records are created automatically; without one, the stack outputs the CNAMEs to add manually.

3. **How are the IAM access keys delivered to the proxy's `.env`?**
   _Resolved:_ Stored in Secrets Manager (~$0.40/mo) by the stack; `npm run generate-env` fetches outputs + secret and writes/merges the proxy `.env`, auto-generating `PROXY_API_KEY` on first run.

4. **Where does the CDK app live?**
   _Resolved:_ `cdk/` directory, TypeScript, fully self-contained package — zero overlap with the concurrent TS port of the proxy.

5. **Is exiting the SES sandbox automatable?**
   _Resolved:_ No — AWS human review is required. Documented as the third (one-time) manual step alongside domain procurement and non-Route53 DNS records.

6. **How do multiple deployments avoid resource-name collisions?** (critique finding #3 — the original `STACK_NAME` claim was false with fixed name defaults)
   _Resolved:_ Resource-name defaults derive from `STACK_NAME` (kebab-cased prefix); changing the stack name alone is collision-free, and explicit `*_NAME` vars still override. Accepted cosmetic consequence: the derived topic/queue default is `ghost-ses-proxy-events`, while Option B's manual example keeps `ghost-ses-events`.
