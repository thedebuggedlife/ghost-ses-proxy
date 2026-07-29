# CDK Infrastructure App — Execution Plan

> **Design document:** [design.md](./design.md)
> **Status:** Complete
> **Current phase:** All phases complete (Phase 7 done)

---

## How to Use This Plan

This plan is designed for the Ralph loop. Each phase:

1. Has **checkboxes** for every discrete task — mark `[x]` when done.
2. Has an **Observations** section — write notes, surprises, or decisions made during that iteration.
3. Is scoped so one phase fits comfortably in a single loop iteration.
4. Includes tests for all new logic introduced in that phase.
5. Ends with a **build + test gate** — confirm the project builds and all tests pass before moving on.

**After each loop iteration:** update the "Current phase" field at the top and record observations.

**Build + test gate (mandatory at the end of every phase):**

*Baseline (every phase from Phase 0 on):*

```bash
cd cdk && npx tsc --noEmit && npx vitest run --passWithNoTests && SES_DOMAIN=example.com npx cdk synth --quiet
```

All commands run from the `cdk/` directory (the CDK package is self-contained; the root `package.json` has no build or test scripts and must not be touched). The synth step must run **without AWS credentials** — it validates that a clean checkout synthesizes with only `SES_DOMAIN` set. Once test files exist (Phase 1+), `--passWithNoTests` is harmless and can stay.

A phase is **not complete** until the gate succeeds and **all** tests written or modified in that phase have been executed. Fix failures before marking the phase done.

---

## Summary

Build a self-contained AWS CDK TypeScript package under `cdk/` that provisions all AWS resources the proxy needs (SES identity + config set, SNS, SQS + DLQ, IAM user + keys in Secrets Manager), driven by a gitignored `cdk/.env`, plus a `generate-env` script that writes the proxy's runtime `.env`. Finish with README walkthrough and a PR-gating CI job. All architecture decisions are settled in [design.md](./design.md) — phases below reference its sections (§N).

## Design Decisions (made during planning)

- **Gate uses `tsc --noEmit`** as the "build": the package runs via `tsx` with no emit step (design §1), so type-checking is the build equivalent.
- **Dependency versions:** install latest `aws-cdk-lib@^2` / `constructs@^10` / `aws-cdk@^2` at Phase 0 and commit the lockfile; do not pin exact versions in `package.json`.
- **Phase 3 starts with an API-surface check** against the installed `aws-cdk-lib` typings (EmailIdentity attributes, `EventDestination.snsTopic`) because the design sketches were written without a resolved CDK version (design §3 notes this).

---

## Phase 0: Scaffold the `cdk/` package

**Goal:** A compilable, synthesizable CDK app skeleton with an empty stack, plus repo gitignore entries.

### Tasks

- [x] **0.1** Create `cdk/package.json`
  - File: `cdk/package.json`
  - `"private": true`, name `ghost-ses-proxy-cdk`. Dependencies: `aws-cdk-lib@^2`, `constructs@^10`, `dotenv`, `@aws-sdk/client-cloudformation`, `@aws-sdk/client-secrets-manager`. DevDependencies: `aws-cdk@^2`, `tsx`, `typescript`, `vitest`.
  - Scripts: `"synth": "cdk synth"`, `"deploy": "cdk deploy"`, `"destroy": "cdk destroy"`, `"generate-env": "tsx scripts/generate-proxy-env.ts"`, `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.
  - Run `npm install` inside `cdk/` and commit `cdk/package-lock.json`.

- [x] **0.2** Create `cdk/tsconfig.json`
  - File: `cdk/tsconfig.json`
  - Strict mode, `target`/`module` suitable for tsx + vitest (e.g. `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"strict": true`, `"noEmit": true`, `"types": ["node"]` — add `@types/node` devDep). Include `bin`, `lib`, `scripts`, `test`.

- [x] **0.3** Create `cdk/cdk.json` and `cdk/vitest.config.ts`
  - Files: `cdk/cdk.json`, `cdk/vitest.config.ts`
  - `cdk.json`: `{ "app": "npx tsx bin/cdk-app.ts" }` plus the current default feature-flags `context` block (copy from what `cdk init` would generate for the installed CLI version, or leave `context` minimal — record the choice in Observations).
  - `vitest.config.ts`: default node environment, include `test/**/*.test.ts`.

- [x] **0.4** Create minimal app entry and empty stack
  - Files: `cdk/bin/cdk-app.ts`, `cdk/lib/ghost-ses-proxy-stack.ts`
  - `bin/cdk-app.ts`: `dotenv.config()`, read `SES_DOMAIN`/`AWS_REGION`/`STACK_NAME` directly from `process.env` for now (Phase 1 replaces this with `parseConfig`), fail with a clear error if `SES_DOMAIN` is missing, then `new GhostSesProxyStack(app, stackName, { config: ... })`.
  - Stack: class accepting `{ config }` props, empty body. This exists only so the Phase 0 gate's synth passes; later phases fill it in.

- [x] **0.5** Create `cdk/.env.example`
  - File: `cdk/.env.example`
  - Every variable in the design §2 table (15 as of this writing), commented style mirroring the root `.env.example`, only `SES_DOMAIN=example.com` uncommented. For name vars whose defaults derive from `STACK_NAME`, the comment shows the derived default (e.g. `# SQS_QUEUE_NAME=ghost-ses-proxy-events  (default: <stack-prefix>-events)`).

- [x] **0.6** Update root `.gitignore`
  - File: `.gitignore`
  - Append `cdk/cdk.out/` and `cdk/cdk.context.json`. Do **not** add `cdk/.env` — the existing unanchored `.env` pattern already ignores it at any depth. Do not modify existing lines.

- [x] **0.7** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run --passWithNoTests && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

**Resolved versions (local install, lockfile committed):** `aws-cdk-lib` 2.262.1, `aws-cdk` CLI 2.1133.0, `constructs` ^10, `vitest` 4.1.10, `typescript` ^5.5, `tsx` ^4.16, `dotenv` ^16.4, `@types/node` ^20.14. Local toolchain: Node v24.13.1 / npm 11.8.0.

**Deviations / decisions:**
- **`vitest` pinned to `^4.0.0`, not `^2`.** The initial `^2` install produced 6 advisories (1 critical) in the vitest/vite/esbuild chain. Upgrading to vitest 4 cleared all of them. Vitest 4's API surface used here (`defineConfig`, `describe/it/expect`) is unchanged, so no test-authoring impact for later phases.
- **Remaining advisory is not fixable from this package:** `brace-expansion` (high, GHSA-mh99-v99m-4gvg) lives in `node_modules/aws-cdk-lib/node_modules/` as a bundled dependency of `aws-cdk-lib`. `npm audit fix` cannot touch it; only an upstream `aws-cdk-lib` release can. Do not attempt to "fix" this in later phases.
- **`cdk.json` `context` block: full default feature flags copied** from `cdk init app --language typescript --generate-only` run with the installed CLI 2.1133.0 (86 keys). The `app` line is `npx tsx bin/cdk-app.ts` — the generated template's `npx tsc && ...` prefix was dropped because the package is `noEmit`. The generated `watch` block was omitted (not needed).
- **`"type": "module"` set in `cdk/package.json`** so `vitest.config.ts` and ESM imports resolve cleanly under `moduleResolution: bundler`. Consequence for later phases: **relative imports need the `.js` extension** (e.g. `import { GhostSesProxyStack } from '../lib/ghost-ses-proxy-stack.js'`), and `scripts/generate-proxy-env.ts` (Phase 5) cannot use `require.main === module` for its main-guard — use `import.meta.url` compared against `process.argv[1]` instead.
- **`tsconfig.json` adds `noUnusedLocals`/`noUnusedParameters`.** The Phase 0 placeholder stack passes because `config` is only a props field; later phases consume it. If a later phase trips these, fix the code rather than loosening the config.
- **`bin/cdk-app.ts` uses `import 'dotenv/config'`** rather than `dotenv.config()` — equivalent, and it runs before the module body. Phase 1 may keep or switch it.

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run --passWithNoTests` OK (no test files yet), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with no AWS credentials.

**Files added:** `cdk/package.json`, `cdk/package-lock.json`, `cdk/tsconfig.json`, `cdk/cdk.json`, `cdk/vitest.config.ts`, `cdk/.env.example`, `cdk/bin/cdk-app.ts`, `cdk/lib/ghost-ses-proxy-stack.ts`. **Modified:** `.gitignore` (appended `cdk/cdk.out/`, `cdk/cdk.context.json`; verified `cdk/.env` and `cdk/node_modules` are already covered by the existing unanchored patterns).

---

## Phase 1: Configuration parsing (`parseConfig`)

**Goal:** Typed, validated configuration from environment variables, fully unit-tested, wired into the app entry.

### Tasks

- [x] **1.1** Implement `CdkAppConfig` and `parseConfig`
  - File: `cdk/lib/config.ts`
  - Pure function `parseConfig(env: NodeJS.ProcessEnv): CdkAppConfig`. Fields and defaults exactly per design §2 table (camelCase: `sesDomain`, `awsRegion`, `awsAccountId`, `hostedZoneName`, `stackName`, `sesConfigurationSet`, `snsTopicName`, `sqsQueueName`, `iamUserName`, `credentialsSecretName`, `accessKeySerial`, `sqsRetentionDays`, `sqsVisibilityTimeoutSeconds`, `dlqMaxReceiveCount`, `sesMailFromSubdomain`).
  - Collect **all** validation errors and throw one `Error` listing them (design §2). Validation rules verbatim from design §2: domain shape; hosted-zone containment (`sesDomain === hostedZoneName || sesDomain.endsWith('.' + hostedZoneName)`); integer ranges (`SQS_RETENTION_DAYS` 1–14, `SQS_VISIBILITY_TIMEOUT_SECONDS` 0–43200, `DLQ_MAX_RECEIVE_COUNT` ≥ 0, `ACCESS_KEY_SERIAL` ≥ 1).
  - **No account requirement in `parseConfig`** — account resolution is enforced in `bin/cdk-app.ts` (task 1.2) because `CDK_DEFAULT_ACCOUNT` exists only under the CDK CLI and `generate-proxy-env.ts` (Phase 5) reuses `parseConfig` (design §2).
  - **Name derivation** (design §2): validate `STACK_NAME` against `/^[A-Za-z][A-Za-z0-9-]*$/` and ≤ 50 chars; compute `namePrefix = kebabCase(stackName)` (split on case boundaries, lowercase, join with `-`: `GhostSesProxy` → `ghost-ses-proxy`). Defaults: `sesConfigurationSet` and `iamUserName` = `<prefix>`; `snsTopicName` and `sqsQueueName` = `<prefix>-events`; `credentialsSecretName` = `<prefix>/credentials`. Explicit env vars override the derived defaults.

- [x] **1.2** Wire `parseConfig` into the app entry
  - File: `cdk/bin/cdk-app.ts`
  - Replace the Phase 0 ad-hoc env reads: `dotenv.config()` → `const config = parseConfig(process.env)` → `new GhostSesProxyStack(app, config.stackName, { config, env: { account: config.awsAccountId ?? process.env.CDK_DEFAULT_ACCOUNT, region: config.awsRegion } })`. Stack props type moves to `{ config: CdkAppConfig } & StackProps`.
  - When `config.hostedZoneName` is set and the resolved account is undefined, exit with an actionable error ("Route53 lookup needs an account: set AWS_ACCOUNT_ID in cdk/.env or configure AWS credentials"). This check lives here, **not** in `parseConfig` (design §2).

- [x] **1.3** Unit tests for `parseConfig`
  - File: `cdk/test/config.test.ts`
  - Cases from design Test Plan: minimal env → all defaults; every var set → reflected; missing `SES_DOMAIN` throws naming it; multiple invalid vars → single error listing all; hosted-zone containment (outside → throw; equal and subdomain → pass); hosted zone set with no `AWS_ACCOUNT_ID`/`CDK_DEFAULT_ACCOUNT` → parses successfully (guards `generate-env` for Route53 users, design §2); numeric edges (non-numeric, negative, `SQS_RETENTION_DAYS=15` throw; `DLQ_MAX_RECEIVE_COUNT=0` valid); name derivation (default stack → `ghost-ses-proxy` / `ghost-ses-proxy-events` / `ghost-ses-proxy/credentials`; `STACK_NAME=MyBlog` → `my-blog`-based names; explicit `*_NAME` vars override; invalid stack name — bad chars or > 50 chars — throws).
  - Use plain object env fixtures — never mutate `process.env`.

- [x] **1.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run` OK (1 file, 34 tests passing), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with no AWS credentials. Also verified the failure path: `npx cdk synth` with no `SES_DOMAIN` exits 1 printing the aggregated config error.

**Implementation notes / decisions:**
- **`optional()` helper trims and treats `''` as unset.** An empty or whitespace-only env var (common when a user leaves `SES_DOMAIN=` in `.env`) is treated as missing rather than as an invalid value, so the error message is the "required" one. All string values are stored trimmed.
- **Error aggregation shape:** one `Error` whose message is `Invalid CDK configuration (see cdk/.env.example):` followed by one `  - <detail>` line per problem. Every detail line starts with the offending variable name, so tests match on `/VAR_NAME/`.
- **Ordering:** validation errors are collected in declaration order (`SES_DOMAIN` → hosted zone → `STACK_NAME` → numerics) and thrown before the config object is built, so a bad `STACK_NAME` never produces garbage derived names. When `STACK_NAME` is invalid the derivation falls back to the default prefix internally, but that value is unreachable because the throw happens first.
- **`kebabCase` is exported** from `lib/config.ts` (handles acronym runs, e.g. `MyAWSBlog` → `my-aws-blog`, plus already-hyphenated/underscored/spaced input) — Phase 6 docs or later phases may reuse it.
- **`ACCESS_KEY_SERIAL` upper bound** is `Number.MAX_SAFE_INTEGER` (design only specifies ≥ 1); same for `DLQ_MAX_RECEIVE_COUNT` (≥ 0). `parseInteger` rejects non-integers via `/^-?\d+$/`, so `1.5` is rejected rather than silently truncated by `parseInt`.
- **`SES_DOMAIN` shape** is checked with a full label regex (`example` with no dot is rejected; scheme/slash/`@` all fail it). `HOSTED_ZONE_NAME` gets no shape validation — only the containment rule from design §2 — to stay faithful to the spec.
- **`bin/cdk-app.ts`** wraps `parseConfig` in a `loadConfig()` helper so `process.exit(1)` (typed `never`) narrows the return type; the account check for `hostedZoneName` lives here per design §2, never in `parseConfig`.
- **Stack props now use `CdkAppConfig`** — the Phase 0 placeholder `GhostSesProxyStackConfig` interface was deleted from `lib/ghost-ses-proxy-stack.ts` and replaced with a type-only import from `./config.js`.

**For later phases:** `parseConfig` never requires an account, so Phase 5's `generate-proxy-env.ts` can call it directly (guarded by the test "parses with a hosted zone and no account"). Phase 2's `makeTemplate` helper should build env fixtures as plain objects and pass them straight to `parseConfig` — tests never touch `process.env`.

**Files added:** `cdk/lib/config.ts`, `cdk/test/config.test.ts`. **Modified:** `cdk/bin/cdk-app.ts`, `cdk/lib/ghost-ses-proxy-stack.ts`.

---

## Phase 2: Messaging resources — SNS topic, SQS queue, DLQ, subscription

**Goal:** The event-transport half of the stack, with Template-assertion tests.

### Tasks

- [x] **2.1** Add topic, queue, DLQ, and subscription to the stack
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3 sketch: `sns.Topic` (name `config.snsTopicName`); DLQ `sqs.Queue` named `` `${config.sqsQueueName}-dlq` `` with 14-day retention, created only when `config.dlqMaxReceiveCount > 0`; main `sqs.Queue` with configured name, retention, visibility timeout, and `deadLetterQueue` when DLQ exists; `topic.addSubscription(new subscriptions.SqsSubscription(queue, { rawMessageDelivery: false }))`.
  - Add `CfnOutput` `SqsQueueUrl` (design §4). Keep the queue/topic as stack fields (`public readonly`) for later phases.

- [x] **2.2** Test scaffolding + messaging assertions
  - File: `cdk/test/stack.test.ts`
  - Create the `makeTemplate(envOverrides?: Record<string,string>)` helper: builds env from a minimal base (`SES_DOMAIN=example.com`) + overrides → `parseConfig` → `new App()` → stack → `Template.fromStack`. (Route53 context seeding comes in Phase 3 — design Test Plan.)
  - Assertions per design Test Plan: queue name (`ghost-ses-proxy-events` under the default env — names derive from `STACK_NAME`, design §2)/retention (14 days = 1209600 s)/redrive to `<name>-dlq` with `maxReceiveCount: 5`; DLQ absent when `DLQ_MAX_RECEIVE_COUNT=0`; queue policy allows `sqs:SendMessage` from `sns.amazonaws.com` conditioned on the topic ARN; subscription `RawMessageDelivery` false or absent; `SqsQueueUrl` output present.

- [x] **2.3** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run` OK (2 files, 43 tests — 34 config + 9 stack), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with no AWS credentials.

**Implementation notes / decisions:**
- Stack exposes `public readonly topic`, `queue`, `deadLetterQueue?` (the last is `undefined` when `DLQ_MAX_RECEIVE_COUNT=0`). Phase 3 uses `topic` for the SES event destination; Phase 4 uses `queue.queueArn`.
- `CfnOutput` construct id is used verbatim as the CloudFormation output key (verified in the synthesized template: `Outputs.SqsQueueUrl`). No `exportName` is set — the outputs are for humans and `generate-env`, not cross-stack references. Later phases must keep using the design §4 key as the construct id.
- The visibility timeout is always emitted (`VisibilityTimeout: 30` by default), so tests can assert it directly.

**Observed synth output shape (useful for Phase 3/4 assertions):**
- `SqsSubscription` emits `RawMessageDelivery: false` explicitly (not omitted), plus an `AWS::SQS::QueuePolicy` with `Action: 'sqs:SendMessage'`, `Principal: { Service: 'sns.amazonaws.com' }`, `Condition: { ArnEquals: { 'aws:SourceArn': { Ref: <topicLogicalId> } } }`. The subscription resource `DependsOn` the queue policy.
- Logical IDs are hash-suffixed (`EventsQueueB96EB0D2`, `EventsDlqACDA5DFF`, `EventsTopic063726A1`). Tests never hardcode them — they resolve IDs via `template.findResources(...)` and feed them into `Fn::GetAtt`/`Ref` matchers. Keep that pattern in Phase 3/4.

**Test helper:** `makeTemplate(envOverrides?)` is **exported** from `cdk/test/stack.test.ts` (base env `SES_DOMAIN=example.com`, overrides merged in, straight through `parseConfig` — `process.env` is never touched). Phase 3 extends it with the optional Route53 context-seeding flag rather than writing a second helper.

**Files modified:** `cdk/lib/ghost-ses-proxy-stack.ts`. **Added:** `cdk/test/stack.test.ts`.

---

## Phase 3: SES resources — configuration set, event destination, email identity, DNS

**Goal:** The SES half of the stack including the Route53/manual-DNS branch and DKIM/MAIL FROM outputs, with tests for both branches.

### Tasks

- [x] **3.1** Verify CDK API surface against installed typings (record in Observations)
  - Files to inspect: `cdk/node_modules/aws-cdk-lib/aws-ses/lib/*.d.ts`
  - Confirm exact names/signatures for: `ses.ConfigurationSet`, `configurationSet.addEventDestination` + `ses.EventDestination.snsTopic(topic)`, `ses.EmailSendingEvent` enum members (SEND, DELIVERY, OPEN, CLICK, BOUNCE, COMPLAINT, REJECT), `ses.EmailIdentity` props (`identity`, `configurationSet`, `mailFromDomain`), `ses.Identity.domain` / `Identity.publicHostedZone`, and the DKIM token attributes (`dkimDnsTokenName1..3`, `dkimDnsTokenValue1..3`), `emailIdentityArn`, `configurationSetArn`. Also check whether `Identity.publicHostedZone` handles a subdomain identity (design §3 "Route53 identity edge case"), and whether `EmailIdentity` auto-creates the MAIL FROM MX/TXT records when a hosted-zone identity is used (design §3 MAIL FROM note). Record findings — deviations from the design sketch are fine; note them.

- [x] **3.2** Add configuration set + SNS event destination
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3: `ses.ConfigurationSet` named `config.sesConfigurationSet`; event destination publishing the exact 7 event types to the Phase 2 topic. Event types are hardcoded — not configurable (design §3 decision).

- [x] **3.3** Add email identity with Route53/manual branch
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3: when `config.hostedZoneName` set → `route53.HostedZone.fromLookup`; identity via `Identity.publicHostedZone(zone)` when `sesDomain === hostedZoneName`, else `Identity.domain(sesDomain)` + three explicit `route53.CnameRecord`s from the DKIM token attributes (subdomain case). No hosted zone → `Identity.domain` only. Attach `configurationSet` as the identity default; set `mailFromDomain` when `sesMailFromSubdomain` configured.
  - When a hosted zone is used and `sesMailFromSubdomain` is set, ensure the MAIL FROM MX/TXT records exist in the zone: rely on the construct where task 3.1 confirmed auto-creation, otherwise add explicit `route53.MxRecord` (`10 feedback-smtp.<region>.amazonses.com`) and `route53.TxtRecord` (`"v=spf1 include:amazonses.com ~all"`) for the MAIL FROM domain (design §3).

- [x] **3.4** Add conditional DNS outputs
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §4: no hosted zone → `DkimCnameName1..3`/`DkimCnameValue1..3` outputs; additionally when MAIL FROM configured → `MailFromMxRecord` (`10 feedback-smtp.<region>.amazonses.com`) and `MailFromSpfRecord` (`"v=spf1 include:amazonses.com ~all"`). With a hosted zone: none of these outputs.
  - Also add the always-present outputs `SesConfigurationSet`, `SendingDomain`, `AwsRegion` (design §4); `CredentialsSecretArn` comes in Phase 4.

- [x] **3.5** SES + DNS tests
  - File: `cdk/test/stack.test.ts`
  - Extend `makeTemplate` to support Route53 cases: accept an optional flag that pre-seeds `new App({ context })` with key `hosted-zone:account=123456789012:domainName=example.com:region=us-east-1` → `{ Id: '/hostedzone/Z123', Name: 'example.com.' }` and sets `AWS_ACCOUNT_ID=123456789012` (design Test Plan).
  - Assertions: config set name; event destination targets the topic with exactly the 7 types; EmailIdentity with DKIM, attached config set name, `MailFromDomain` when configured; no zone → six DKIM outputs (plus MAIL FROM outputs when configured); zone+apex → no DKIM outputs and no explicit RecordSets beyond what the construct emits (assert DKIM outputs absent); zone+subdomain (`SES_DOMAIN=mail.example.com`) → three `AWS::Route53::RecordSet` CNAMEs present; zone+subdomain+`SES_MAIL_FROM_SUBDOMAIN` → MX and TXT RecordSets for the MAIL FROM domain present (construct- or explicitly-created).

- [x] **3.6** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run` OK (2 files, 60 tests — 34 config + 26 stack), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with AWS credential env vars explicitly unset.

**Task 3.1 — API surface verified against `aws-cdk-lib` 2.262.1:**

Confirmed as designed:
- `ses.ConfigurationSet(scope, id, { configurationSetName })` → `AWS::SES::ConfigurationSet` with `Name`; exposes `configurationSetName` and `addEventDestination(id, { destination, events })`.
- `ses.EventDestination.snsTopic(topic)`; `ses.EmailSendingEvent` has all seven members — values are camelCase strings (`send`, `delivery`, `open`, `click`, `bounce`, `complaint`, `reject`).
- `ses.EmailIdentity` props `identity` / `configurationSet` / `mailFromDomain`; attributes `emailIdentityArn`, `dkimDnsTokenName1..3`, `dkimDnsTokenValue1..3`, plus a convenience `dkimRecords: { name, value }[]` (used instead of the six individual getters).
- `ses.Identity.domain(d)` and `ses.Identity.publicHostedZone(zone)` exist. `HostedZone.fromLookup` returns `IHostedZone`, and `IPublicHostedZone extends IHostedZone {}` is an *empty* extension, so it is structurally assignable — **no cast needed**.

**Deviations from the design sketch (all confirmed by reading the construct source):**
1. **`configurationSet.configurationSetArn` does NOT exist** in 2.262.1. `ConfigurationSet` only exposes `configurationSetName` (and `configurationSetRef`). **Phase 4 must build the ARN itself**, e.g. `this.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: this.configurationSet.configurationSetName })`. The design §3 sketch's `configurationSet.configurationSetArn` will not compile.
2. **`Identity.publicHostedZone(zone)` uses `zone.zoneName` as the identity value** (`{ value: hostedZone.zoneName, hostedZone }`), so it genuinely cannot express a subdomain identity — the design's subdomain branch is required, not optional.
3. **`route53.CnameRecord` cannot be used for the DKIM records.** `determineFullyQualifiedDomainName` is **not** token-aware: it sees the unresolved `dkimDnsTokenName1` token, finds it does not end with the zone suffix, and appends `.example.com.` — producing a double-suffixed record name. The plan said `CnameRecord`; the implementation uses `route53.CfnRecordSet` (`type: 'CNAME'`, `ttl: '1800'`) instead, which is exactly what `aws-cdk-lib`'s own `EasyDkim.bind()` does. One inline comment records this.
4. **MAIL FROM auto-creation is conditional on `props.identity.hostedZone`.** `EmailIdentity` creates `MailFromMxRecord`/`MailFromTxtRecord` only when `mailFromDomain` is set *and* the identity carries a hosted zone — i.e. the apex branch only. The subdomain branch therefore creates them explicitly (`route53.MxRecord` / `route53.TxtRecord`); those take a concrete record name, so the FQDN helper handles them correctly. Verified in synth: both branches emit MX `10 feedback-smtp.<region>.amazonses.com` and TXT `"v=spf1 include:amazonses.com ~all"` at `bounce.<domain>.`.

**Implementation notes:**
- Branch selector is `apexZone = hostedZone && cfg.sesDomain === cfg.hostedZoneName ? hostedZone : undefined` — this both selects the identity flavour and narrows the type without a non-null assertion.
- Stack now also exposes `public readonly configurationSet` and `emailIdentity` for Phase 4.
- `AwsRegion` output uses `this.region` (concrete because `bin/cdk-app.ts` and the test helper both pass `env.region`). `MailFrom*` output values and the MX host are built from `this.region` too, so they stay correct for non-default regions.
- The MAIL FROM outputs are human-readable one-liners (`bounce.example.com MX 10 feedback-smtp.us-east-1.amazonses.com`, `bounce.example.com TXT "v=spf1 include:amazonses.com ~all"`) rather than bare values — they are a DNS to-do list, per design §4.
- Adding the event destination also makes CDK emit an `AWS::SNS::TopicPolicy` (`EventsTopicPolicy…`) granting `ses.amazonaws.com` publish rights; the event destination `DependsOn` it. Nothing to do, but it changes SNS resource counts if a later phase asserts on them.

**Test helper change (Phase 4 must use it):** `makeTemplate(envOverrides?, options?)` gained a second parameter `{ hostedZoneLookup?: boolean }`. When true it defaults `AWS_ACCOUNT_ID` to `123456789012` and seeds `new App({ context })` with `hosted-zone:account=<acct>:domainName=<zone>:region=<region>` → `{ Id: '/hostedzone/Z123', Name: '<zone>.' }`. Module-level `ZONE_ENV` / `WITH_ZONE` constants wrap the common case.

**Files modified:** `cdk/lib/ghost-ses-proxy-stack.ts`, `cdk/test/stack.test.ts`.

---

## Phase 4: IAM user, access key, Secrets Manager secret

**Goal:** Proxy credentials provisioned with least-privilege policy and stored in Secrets Manager; all stack outputs complete.

### Tasks

- [x] **4.1** Add IAM user with scoped inline policies
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3: user named `config.iamUserName`; policy 1: `ses:SendRawEmail` on `[identity.emailIdentityArn, configurationSet.configurationSetArn]`; policy 2: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on `[queue.queueArn]`.

- [x] **4.2** Add access key and secret
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - `iam.AccessKey` with `serial: config.accessKeySerial`; `secretsmanager.Secret` named `config.credentialsSecretName` with `secretObjectValue: { accessKeyId: SecretValue.unsafePlainText(accessKey.accessKeyId), secretAccessKey: accessKey.secretAccessKey }` and `removalPolicy: RemovalPolicy.DESTROY` (design §3 teardown note). Add `CredentialsSecretArn` output.

- [x] **4.3** IAM + secret tests
  - File: `cdk/test/stack.test.ts`
  - Assertions per design Test Plan: user policy scopes SES actions to identity + config set ARNs (not `*`) and SQS actions to the queue ARN; `AWS::IAM::AccessKey` with `Serial`; secret exists and the synthesized template JSON contains no literal secret-access-key material (assert the secret's `SecretString`/`GenerateSecretString` references the access key attribute via `Fn::GetAtt`, e.g. by matching the template JSON string for `SecretAccessKey`); all five always-present outputs now exist (`SqsQueueUrl`, `SesConfigurationSet`, `SendingDomain`, `AwsRegion`, `CredentialsSecretArn`) — this guards the generate-env contract.

- [x] **4.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run` OK (2 files, 72 tests — 34 config + 38 stack), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with all AWS credential/region env vars explicitly unset.

**Implementation notes / decisions:**
- **Config set ARN built with `this.formatArn`** (Phase 3 observation #1: `configurationSetArn` does not exist in `aws-cdk-lib` 2.262.1). `formatArn({ service: 'ses', resource: 'configuration-set', resourceName: this.configurationSet.configurationSetName })` synthesizes to `arn:<partition>:ses:<region>:<account>:configuration-set/<Ref ConfigSet>`. The identity ARN uses `emailIdentity.emailIdentityArn` as designed → `…:identity/<Ref Identity>`.
- **`user.addToPolicy` produces a single `AWS::IAM::Policy`** (`ProxyUserDefaultPolicy…`) with both statements, not two separate policies — tests assert on statements within the one policy resource.
- **Secret synthesis shape (relevant to Phase 5):** `SecretString` is an `Fn::Join` of exactly `['{"accessKeyId":"', {Ref: <accessKey>}, '","secretAccessKey":"', {'Fn::GetAtt': [<accessKey>, 'SecretAccessKey']}, '"}']`. So `GetSecretValue` returns JSON `{ "accessKeyId": ..., "secretAccessKey": ... }` — exactly the keys `generate-proxy-env.ts` must parse. No `GenerateSecretString` is emitted.
- **`removalPolicy: RemovalPolicy.DESTROY`** emits both `DeletionPolicy: Delete` and `UpdateReplacePolicy: Delete`; the test asserts both.
- **`CredentialsSecretArn` output value is `{ Ref: <secretLogicalId> }`** — `AWS::SecretsManager::Secret`'s `Ref` *is* the ARN. The output test matches on the Ref, not a `Fn::GetAtt`.
- Stack now also exposes `public readonly user`, `accessKey`, `credentialsSecret`.
- The Phase 3 test "drops the manual DNS outputs entirely" asserted an exact sorted output-key list; `CredentialsSecretArn` was added to it. Future phases adding always-present outputs must update that list too.
- Added a `never grants a wildcard resource` test that walks every statement in the synthesized policy — it guards against a future refactor regressing to `Resource: '*'`.
- Added an "always emits the five outputs the generate-env script depends on" test that runs for both the no-zone and hosted-zone cases, since the DNS outputs are conditional but these five must not be.

**Files modified:** `cdk/lib/ghost-ses-proxy-stack.ts`, `cdk/test/stack.test.ts`.

---

## Phase 5: `generate-proxy-env` script

**Goal:** `npm run generate-env` turns stack outputs + secret into the proxy's `.env`, idempotently.

### Tasks

- [x] **5.1** Implement the merge logic as pure functions
  - File: `cdk/scripts/generate-proxy-env.ts`
  - Export `mergeEnvFile(existingLines: string[], managed: Record<string, string>): string[]` per design §5: managed keys replaced in place, missing ones appended; comments/blank/unknown lines passed through verbatim, order preserved. Export `ensureProxyApiKey(lines: string[]): string[]` (or fold into merge): preserve existing `PROXY_API_KEY`, else append one from `crypto.randomBytes(32).toString('hex')`.
  - Managed keys: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `SQS_QUEUE_URL`, `SES_CONFIGURATION_SET`, `MAILGUN_DOMAIN`.

- [x] **5.2** Implement `main()`
  - File: `cdk/scripts/generate-proxy-env.ts`
  - Per design §5 flow: `dotenv.config()` + `parseConfig` (for `stackName`/`awsRegion`); CloudFormation `DescribeStacks` → outputs map, with the "run npx cdk deploy first" error when the stack is missing; `GetSecretValue` on the `CredentialsSecretArn` output → parse JSON `{ accessKeyId, secretAccessKey }`; managed values assembled from outputs (`MAILGUN_DOMAIN` ← `SendingDomain`, `SES_CONFIGURATION_SET` ← output, `SQS_QUEUE_URL` ← output, `AWS_REGION` ← config); read target file if present, merge, write with mode `0o600`. `--out <path>` flag, default `../.env` relative to `cdk/`. Print which keys were written/preserved — never secret values. Guard `main()` behind `if` so importing the module for tests doesn't execute it (e.g. only run when invoked directly). Note: `parseConfig` deliberately imposes no account requirement, so this script works for Route53 users outside the CDK CLI (design §2; guarded by a Phase 1 test).

- [x] **5.3** Unit tests for merge logic
  - File: `cdk/test/generate-proxy-env.test.ts`
  - Per design Test Plan: empty input → all managed keys + generated `PROXY_API_KEY`; existing file → values replaced in place, comments/order/`PORT`/unknown keys verbatim, existing `PROXY_API_KEY` untouched; double-merge idempotency (second run byte-identical). AWS calls in `main()` are not unit-tested (design decision — keep `main()` thin).

- [x] **5.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run` OK (3 files, 88 tests — 34 config + 38 stack + 16 generate-proxy-env), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with all AWS credential/region/profile env vars explicitly unset.

**Implementation notes / decisions:**
- **Exports beyond the plan's two functions:** `MANAGED_KEYS`, `PROXY_API_KEY`, `parseEnvContent`, `formatEnvFile`, `mergeEnvFile`, `generateApiKey`, `hasProxyApiKey`, `ensureProxyApiKey`, `main`. Splitting content↔lines conversion out of the merge is what makes the byte-identical idempotency test possible. `formatEnvFile` always emits a trailing newline (empty line array → empty string).
- **`ensureProxyApiKey(lines, generate = generateApiKey)`** takes an injectable generator so tests are deterministic; production callers use the default (`crypto.randomBytes(32).toString('hex')`).
- **Assignment detection** is `/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/`. Commented-out assignments (`# AWS_REGION=…`) are therefore *not* matched — they pass through verbatim and the managed key is appended, which is the correct behaviour for a user who copied `.env.example`.
- **All duplicates of a managed key are rewritten**, not just the first. dotenv's last-wins semantics mean rewriting only the first occurrence could leave a stale value in effect.
- **`import 'dotenv/config'` deliberately avoided** — the test file imports this module, and a top-level side effect would load a developer's `cdk/.env` into `process.env` for the whole vitest run. `loadDotenv()` is called inside `main()` instead.
- **Main guard:** `import.meta.url === pathToFileURL(process.argv[1]).href` (the package is `"type": "module"`, so `require.main` is unavailable — flagged in the Phase 0 observations). Verified live: `npx tsx scripts/generate-proxy-env.ts --bogus` exits 1 with the usage error, and with no `SES_DOMAIN` it exits 1 printing the aggregated `parseConfig` error.
- **Default `--out`** resolves from `import.meta.url` (`../../.env` → repo root) rather than `process.cwd()`, so it is correct no matter where the script is invoked from. An explicit `--out` (both `--out path` and `--out=path` forms) resolves against cwd.
- **Output validation:** `fetchStackOutputs` requires `SqsQueueUrl`, `SesConfigurationSet`, `SendingDomain`, `CredentialsSecretArn` and names any that are missing. `AwsRegion` is intentionally *not* required — `AWS_REGION` in the proxy env comes from `config.awsRegion`, matching the plan's mapping.
- **Stack-not-found detection** is `error.name === 'ValidationError' && /does not exist/i` → "run \"npx cdk deploy\" first". Any other error is rethrown untouched.
- **File permissions:** `writeFileSync(..., { mode: 0o600 })` only applies the mode when creating a new file, so an explicit `chmodSync(outPath, 0o600)` follows it to cover the overwrite case.
- **Console output** lists the managed key *names* and whether `PROXY_API_KEY` was preserved or generated — never a value.

**For Phase 6:** the README day-2 section can state that `npm run generate-env` accepts `-- --out <path>`, is safe to re-run (idempotent, preserves `PROXY_API_KEY`, `PORT`, `LOG_LEVEL`, comments and unknown keys), and writes the file `0600`.

**Files added:** `cdk/scripts/generate-proxy-env.ts`, `cdk/test/generate-proxy-env.test.ts`. **Modified:** none.

---

## Phase 6: README documentation

**Goal:** README walks users through the CDK deployment as Option A; existing console guide preserved as Option B.

### Tasks

- [x] **6.1** Restructure the AWS setup section
  - File: `README.md`
  - Replace the `## AWS setup guide` heading/intro with `## AWS infrastructure setup` introducing Options A and B, per design §8 blueprint. **Move** the five existing console steps under `### Option B: Manual console setup` without rewording them (design §8: moved, not rewritten — avoids conflicts with the concurrent branch); add only the one-line note that the CDK IAM policy is scoped tighter than Option B's `"Resource": "*"`.

- [x] **6.2** Write Option A walkthrough
  - File: `README.md`
  - Follow design §8 structure exactly: prerequisites; steps 1–6 (configure, deploy, DNS-if-not-Route53, generate-env, production access, start proxy); day-2 operations (redeploy, `ACCESS_KEY_SERIAL` rotation, second deployment via `STACK_NAME` — names derive from it, `cdk destroy`); troubleshooting (already-exists, sandbox, pending verification). Include the CDK configuration table from design §2 (or an abridged table + pointer to `cdk/.env.example` — pick one, record in Observations).

- [x] **6.3** Add Quick start pointer
  - File: `README.md`
  - In `## Quick start` step 1, add one line pointing to "AWS infrastructure setup" so users find the CDK path first (design §8 rule).

- [x] **6.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass (docs phase; baseline gate confirms nothing broke)

### Observations

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run` OK (3 files, 88 tests — unchanged from Phase 5), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with all AWS credential/region/profile env vars explicitly unset. Docs-only phase, so no code changed.

**Decisions:**
- **Full CDK configuration table inlined in the README** (task 6.2 offered "full table" or "abridged + pointer"). All 15 design §2 variables are in the Option A "1. Configure" step, with `<prefix>`-derived defaults spelled out concretely (`ghost-ses-proxy`, `ghost-ses-proxy-events`, `ghost-ses-proxy/credentials`) rather than as templates — a user reading the README does not know what `<prefix>` means. A one-line pointer to `cdk/.env.example` follows the table for the commented long-form version.
- **Option B moved, not rewritten — verified by diff.** `git diff README.md` shows exactly six removed lines: the `## AWS setup guide` heading and the five `### N. …` step headings, each re-added at `####` to nest under `### Option B: Manual console setup`. Every other line of the console guide (including the "You need four AWS resources" intro, the JSON policy blocks, and the closing "Use this user's access key…") is byte-identical, so the concurrent branch's merge surface is unchanged.
- **The IAM scoping note is a blockquote directly above Option B's steps**, not inside step 5, so it is visible before a reader starts clicking through the console.
- **Anchor links** (`#option-a-deploy-with-cdk`, `#option-b-manual-console-setup`, `#aws-infrastructure-setup`) use GitHub's slug rules; verified against the emitted heading text.

**Additions beyond the design §8 blueprint** (all small, all judged worth it):
- Step 4 documents the `PROXY_API_KEY` behaviour and explicitly tells the user to copy the generated key into Ghost's `mailgun_api_key` setting — otherwise the generated-key convenience creates a dead end, since Quick start step 4 assumes the user invented the key.
- A fourth troubleshooting entry for `generate-env` reporting a missing stack (the Phase 5 "run npx cdk deploy first" error path), pointing at `AWS_REGION`/`STACK_NAME` mismatch as the second cause.
- A day-2 bullet for the design §6 renaming caveat (renaming a physical name replaces the resource; a queue replacement changes the URL and drops in-flight messages).

**For Phase 7:** the design's Files Changed table lists `README.md` as modified in Phase 6 only — that is now done, so 7.3's `git status` check should see `README.md` plus `.gitignore` and (after 7.1) `.github/workflows/ci.yml` as the only modified non-`cdk/` files.

**Files modified:** `README.md`.

---

## Phase 7: CI gating + final verification

**Goal:** CDK tests gate PR merges; whole feature verified against the design.

### Tasks

- [x] **7.1** Add `cdk-test` job to CI
  - File: `.github/workflows/ci.yml`
  - Add the job exactly per design §9 YAML: `working-directory: cdk` default, checkout, `setup-node` (Node 20, npm cache keyed on `cdk/package-lock.json`), `npm ci`, `npm test`, `SES_DOMAIN=example.com npx cdk synth --quiet`. No `paths:` filter (design §9 — a sometimes-skipped required check blocks merges). Do not modify the existing `docker-build` job.

- [x] **7.2** Sanity-check the workflow file
  - File: `.github/workflows/ci.yml`
  - Validate YAML parses (e.g. `node -e "..."` with a YAML parse via `npx js-yaml .github/workflows/ci.yml` or python `yaml.safe_load`). Confirm job names: `docker-build`, `cdk-test`.

- [x] **7.3** Design compliance pass
  - Re-read `ralph/projects/cdk-app/design.md` end-to-end. Verify: every row of the design's Files Changed table exists with the described content; `.gitignore` has the three new entries; no changes outside the listed files (`git status` — in particular `server.js`, `lib/*.js`, `Dockerfile`, root `package.json` untouched); stack outputs match the §4 table keys exactly; `cdk/.env.example` covers every §2 variable.

- [x] **7.4** Code review pass
  - Review `cdk/lib/*.ts`, `cdk/bin/*.ts`, `cdk/scripts/*.ts` for: no secrets or account IDs hardcoded; error messages actionable; comments follow repo convention (none unless a non-obvious why); consistent naming with the design (§2 config names, §4 output keys).

- [x] **7.5** Record the maintainer note
  - In this phase's Observations, record: "Maintainer action required: add `cdk-test` to the required status checks for the `dev` branch (GitHub → Settings → Branch protection). Not enforceable from the codebase." (design §9)

- [x] **7.6** Final build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

**Gate result:** `npx tsc --noEmit` OK, `npx vitest run` OK (3 files, 88 tests — unchanged from Phase 5/6), `SES_DOMAIN=example.com npx cdk synth --quiet` OK with `AWS_PROFILE`/`AWS_REGION`/`AWS_DEFAULT_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` all explicitly unset. Whole chain re-run with an explicit exit-code check: `GATE_EXIT=0`.

**MAINTAINER ACTION REQUIRED:** add `cdk-test` to the required status checks for the `dev` branch (GitHub → Settings → Branch protection). Not enforceable from the codebase. The job runs and reports on every PR regardless; only merge *blocking* needs the settings change. Consider adding the existing `docker-build` job at the same time.

**Task 7.1 — CI job:** added verbatim per design §9, with named steps (`Install dependencies` / `Run tests` / `Synthesize without AWS credentials`) instead of the design's bare `- run:` lines — cosmetic only, it makes the GitHub Actions log readable. No `paths:` filter and no change to the workflow-level `on:` trigger, so the job gates exactly the same PRs as `docker-build`. `docker-build` was not touched.

**Task 7.2 — validation:** `yaml.safe_load` via `python3` parses the file; jobs are exactly `['docker-build', 'cdk-test']`. (`npx js-yaml` was not used — no such binary in the root package, and the root `package.json` must not be touched.)

**Task 7.3 — design compliance:**
- Every row of the design's Files Changed table exists. All 13 `cdk/` files present (`bin/cdk-app.ts`, `lib/config.ts`, `lib/ghost-ses-proxy-stack.ts`, `scripts/generate-proxy-env.ts`, 3 test files, `package.json`, `package-lock.json`, `tsconfig.json`, `cdk.json`, `vitest.config.ts`, `.env.example`).
- **`.gitignore` has two new entries, not three.** Task 7.3's wording ("the three new entries") is stale — design §"What changes" and the Files Changed table both specify only `cdk/cdk.out/` and `cdk/cdk.context.json`, because the existing unanchored `.env` pattern already covers `cdk/.env`. Verified: the file is exactly `node_modules/`, `data/`, `.env`, `cdk/cdk.out/`, `cdk/cdk.context.json`. No discrepancy with the design.
- **No changes outside the listed files.** `git diff --name-only <merge-base>..HEAD` plus working-tree status covers only `.gitignore`, `README.md`, `.github/workflows/ci.yml`, the 13 `cdk/` files, and the `ralph/projects/cdk-app/*.md` planning docs. `server.js`, `lib/*.js`, `Dockerfile`, `docker-compose.example.yml`, root `package.json` and root `.env.example` are all untouched.
- **Stack outputs match the §4 table keys exactly**: always-present `SqsQueueUrl`, `SesConfigurationSet`, `SendingDomain`, `AwsRegion`, `CredentialsSecretArn`; no-hosted-zone-only `DkimCnameName1..3`/`DkimCnameValue1..3` and (with MAIL FROM) `MailFromMxRecord`/`MailFromSpfRecord`. No extras, no renames.
- **`cdk/.env.example` covers all 15 §2 variables**, only `SES_DOMAIN` uncommented.

**Task 7.4 — code review:** no secrets, account IDs, or region literals hardcoded anywhere in `bin/`, `lib/`, `scripts/` (the `123456789012` fixture account lives only in `test/stack.test.ts`, which is correct). Error messages all name the offending variable and the corrective action ("run \"npx cdk deploy\" first", "set AWS_ACCOUNT_ID in cdk/.env or configure AWS credentials"). Exactly one comment exists across the three directories — the single line at `lib/ghost-ses-proxy-stack.ts:98` explaining why `CfnRecordSet` replaces `CnameRecord` for DKIM — which matches the repo convention (comment only a non-obvious why, one line). Config field names and output keys are consistent with design §2/§4.

**Two things a reviewer might flag, both deliberate and left as-is:**
- `lib/config.ts:127` uses `sesDomain as string`. Safe: the `errors.length > 0` throw above it guarantees `sesDomain` is defined by that point. A non-null assertion or a narrowing refactor would add noise for no behaviour change.
- `scripts/generate-proxy-env.ts` exports more than the plan's two functions. Justified in the Phase 5 observations (the content↔lines split is what makes the byte-identical idempotency test possible).

**Files modified:** `.github/workflows/ci.yml`.

---

## Files Changed Summary

### New Files
| File | Phase | Purpose |
|------|-------|---------|
| `cdk/package.json` | 0 | Self-contained CDK package: deps + scripts |
| `cdk/package-lock.json` | 0 | Committed lockfile |
| `cdk/tsconfig.json` | 0 | Strict TS config (tsx/vitest, noEmit) |
| `cdk/cdk.json` | 0 | CDK app entry via tsx |
| `cdk/vitest.config.ts` | 0 | Test runner config |
| `cdk/.env.example` | 0 | Committed config template (design §2) |
| `cdk/bin/cdk-app.ts` | 0, 1 | App entry: dotenv → parseConfig → stack |
| `cdk/lib/ghost-ses-proxy-stack.ts` | 0, 2, 3, 4 | The stack (design §3, §4) |
| `cdk/lib/config.ts` | 1 | `CdkAppConfig` + `parseConfig` |
| `cdk/test/config.test.ts` | 1 | Config unit tests |
| `cdk/test/stack.test.ts` | 2, 3, 4 | Template assertion tests |
| `cdk/scripts/generate-proxy-env.ts` | 5 | Outputs/secret → proxy `.env` |
| `cdk/test/generate-proxy-env.test.ts` | 5 | Merge-logic unit tests |

### Modified Files
| File | Phases | Changes |
|------|--------|---------|
| `.gitignore` | 0 | Add `cdk/cdk.out/`, `cdk/cdk.context.json` (existing `.env` pattern already covers `cdk/.env`) |
| `README.md` | 6 | "AWS infrastructure setup" section: CDK walkthrough (Option A) + moved console guide (Option B), Quick start pointer |
| `.github/workflows/ci.yml` | 7 | Add PR-gating `cdk-test` job (design §9) |
