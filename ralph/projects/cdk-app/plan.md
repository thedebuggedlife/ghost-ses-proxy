# CDK Infrastructure App — Execution Plan

> **Design document:** [design.md](./design.md)
> **Status:** In progress
> **Current phase:** Phase 1 (Phase 0 complete)

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

- [ ] **1.1** Implement `CdkAppConfig` and `parseConfig`
  - File: `cdk/lib/config.ts`
  - Pure function `parseConfig(env: NodeJS.ProcessEnv): CdkAppConfig`. Fields and defaults exactly per design §2 table (camelCase: `sesDomain`, `awsRegion`, `awsAccountId`, `hostedZoneName`, `stackName`, `sesConfigurationSet`, `snsTopicName`, `sqsQueueName`, `iamUserName`, `credentialsSecretName`, `accessKeySerial`, `sqsRetentionDays`, `sqsVisibilityTimeoutSeconds`, `dlqMaxReceiveCount`, `sesMailFromSubdomain`).
  - Collect **all** validation errors and throw one `Error` listing them (design §2). Validation rules verbatim from design §2: domain shape; hosted-zone containment (`sesDomain === hostedZoneName || sesDomain.endsWith('.' + hostedZoneName)`); integer ranges (`SQS_RETENTION_DAYS` 1–14, `SQS_VISIBILITY_TIMEOUT_SECONDS` 0–43200, `DLQ_MAX_RECEIVE_COUNT` ≥ 0, `ACCESS_KEY_SERIAL` ≥ 1).
  - **No account requirement in `parseConfig`** — account resolution is enforced in `bin/cdk-app.ts` (task 1.2) because `CDK_DEFAULT_ACCOUNT` exists only under the CDK CLI and `generate-proxy-env.ts` (Phase 5) reuses `parseConfig` (design §2).
  - **Name derivation** (design §2): validate `STACK_NAME` against `/^[A-Za-z][A-Za-z0-9-]*$/` and ≤ 50 chars; compute `namePrefix = kebabCase(stackName)` (split on case boundaries, lowercase, join with `-`: `GhostSesProxy` → `ghost-ses-proxy`). Defaults: `sesConfigurationSet` and `iamUserName` = `<prefix>`; `snsTopicName` and `sqsQueueName` = `<prefix>-events`; `credentialsSecretName` = `<prefix>/credentials`. Explicit env vars override the derived defaults.

- [ ] **1.2** Wire `parseConfig` into the app entry
  - File: `cdk/bin/cdk-app.ts`
  - Replace the Phase 0 ad-hoc env reads: `dotenv.config()` → `const config = parseConfig(process.env)` → `new GhostSesProxyStack(app, config.stackName, { config, env: { account: config.awsAccountId ?? process.env.CDK_DEFAULT_ACCOUNT, region: config.awsRegion } })`. Stack props type moves to `{ config: CdkAppConfig } & StackProps`.
  - When `config.hostedZoneName` is set and the resolved account is undefined, exit with an actionable error ("Route53 lookup needs an account: set AWS_ACCOUNT_ID in cdk/.env or configure AWS credentials"). This check lives here, **not** in `parseConfig` (design §2).

- [ ] **1.3** Unit tests for `parseConfig`
  - File: `cdk/test/config.test.ts`
  - Cases from design Test Plan: minimal env → all defaults; every var set → reflected; missing `SES_DOMAIN` throws naming it; multiple invalid vars → single error listing all; hosted-zone containment (outside → throw; equal and subdomain → pass); hosted zone set with no `AWS_ACCOUNT_ID`/`CDK_DEFAULT_ACCOUNT` → parses successfully (guards `generate-env` for Route53 users, design §2); numeric edges (non-numeric, negative, `SQS_RETENTION_DAYS=15` throw; `DLQ_MAX_RECEIVE_COUNT=0` valid); name derivation (default stack → `ghost-ses-proxy` / `ghost-ses-proxy-events` / `ghost-ses-proxy/credentials`; `STACK_NAME=MyBlog` → `my-blog`-based names; explicit `*_NAME` vars override; invalid stack name — bad chars or > 50 chars — throws).
  - Use plain object env fixtures — never mutate `process.env`.

- [ ] **1.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 2: Messaging resources — SNS topic, SQS queue, DLQ, subscription

**Goal:** The event-transport half of the stack, with Template-assertion tests.

### Tasks

- [ ] **2.1** Add topic, queue, DLQ, and subscription to the stack
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3 sketch: `sns.Topic` (name `config.snsTopicName`); DLQ `sqs.Queue` named `` `${config.sqsQueueName}-dlq` `` with 14-day retention, created only when `config.dlqMaxReceiveCount > 0`; main `sqs.Queue` with configured name, retention, visibility timeout, and `deadLetterQueue` when DLQ exists; `topic.addSubscription(new subscriptions.SqsSubscription(queue, { rawMessageDelivery: false }))`.
  - Add `CfnOutput` `SqsQueueUrl` (design §4). Keep the queue/topic as stack fields (`public readonly`) for later phases.

- [ ] **2.2** Test scaffolding + messaging assertions
  - File: `cdk/test/stack.test.ts`
  - Create the `makeTemplate(envOverrides?: Record<string,string>)` helper: builds env from a minimal base (`SES_DOMAIN=example.com`) + overrides → `parseConfig` → `new App()` → stack → `Template.fromStack`. (Route53 context seeding comes in Phase 3 — design Test Plan.)
  - Assertions per design Test Plan: queue name (`ghost-ses-proxy-events` under the default env — names derive from `STACK_NAME`, design §2)/retention (14 days = 1209600 s)/redrive to `<name>-dlq` with `maxReceiveCount: 5`; DLQ absent when `DLQ_MAX_RECEIVE_COUNT=0`; queue policy allows `sqs:SendMessage` from `sns.amazonaws.com` conditioned on the topic ARN; subscription `RawMessageDelivery` false or absent; `SqsQueueUrl` output present.

- [ ] **2.3** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 3: SES resources — configuration set, event destination, email identity, DNS

**Goal:** The SES half of the stack including the Route53/manual-DNS branch and DKIM/MAIL FROM outputs, with tests for both branches.

### Tasks

- [ ] **3.1** Verify CDK API surface against installed typings (record in Observations)
  - Files to inspect: `cdk/node_modules/aws-cdk-lib/aws-ses/lib/*.d.ts`
  - Confirm exact names/signatures for: `ses.ConfigurationSet`, `configurationSet.addEventDestination` + `ses.EventDestination.snsTopic(topic)`, `ses.EmailSendingEvent` enum members (SEND, DELIVERY, OPEN, CLICK, BOUNCE, COMPLAINT, REJECT), `ses.EmailIdentity` props (`identity`, `configurationSet`, `mailFromDomain`), `ses.Identity.domain` / `Identity.publicHostedZone`, and the DKIM token attributes (`dkimDnsTokenName1..3`, `dkimDnsTokenValue1..3`), `emailIdentityArn`, `configurationSetArn`. Also check whether `Identity.publicHostedZone` handles a subdomain identity (design §3 "Route53 identity edge case"), and whether `EmailIdentity` auto-creates the MAIL FROM MX/TXT records when a hosted-zone identity is used (design §3 MAIL FROM note). Record findings — deviations from the design sketch are fine; note them.

- [ ] **3.2** Add configuration set + SNS event destination
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3: `ses.ConfigurationSet` named `config.sesConfigurationSet`; event destination publishing the exact 7 event types to the Phase 2 topic. Event types are hardcoded — not configurable (design §3 decision).

- [ ] **3.3** Add email identity with Route53/manual branch
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3: when `config.hostedZoneName` set → `route53.HostedZone.fromLookup`; identity via `Identity.publicHostedZone(zone)` when `sesDomain === hostedZoneName`, else `Identity.domain(sesDomain)` + three explicit `route53.CnameRecord`s from the DKIM token attributes (subdomain case). No hosted zone → `Identity.domain` only. Attach `configurationSet` as the identity default; set `mailFromDomain` when `sesMailFromSubdomain` configured.
  - When a hosted zone is used and `sesMailFromSubdomain` is set, ensure the MAIL FROM MX/TXT records exist in the zone: rely on the construct where task 3.1 confirmed auto-creation, otherwise add explicit `route53.MxRecord` (`10 feedback-smtp.<region>.amazonses.com`) and `route53.TxtRecord` (`"v=spf1 include:amazonses.com ~all"`) for the MAIL FROM domain (design §3).

- [ ] **3.4** Add conditional DNS outputs
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §4: no hosted zone → `DkimCnameName1..3`/`DkimCnameValue1..3` outputs; additionally when MAIL FROM configured → `MailFromMxRecord` (`10 feedback-smtp.<region>.amazonses.com`) and `MailFromSpfRecord` (`"v=spf1 include:amazonses.com ~all"`). With a hosted zone: none of these outputs.
  - Also add the always-present outputs `SesConfigurationSet`, `SendingDomain`, `AwsRegion` (design §4); `CredentialsSecretArn` comes in Phase 4.

- [ ] **3.5** SES + DNS tests
  - File: `cdk/test/stack.test.ts`
  - Extend `makeTemplate` to support Route53 cases: accept an optional flag that pre-seeds `new App({ context })` with key `hosted-zone:account=123456789012:domainName=example.com:region=us-east-1` → `{ Id: '/hostedzone/Z123', Name: 'example.com.' }` and sets `AWS_ACCOUNT_ID=123456789012` (design Test Plan).
  - Assertions: config set name; event destination targets the topic with exactly the 7 types; EmailIdentity with DKIM, attached config set name, `MailFromDomain` when configured; no zone → six DKIM outputs (plus MAIL FROM outputs when configured); zone+apex → no DKIM outputs and no explicit RecordSets beyond what the construct emits (assert DKIM outputs absent); zone+subdomain (`SES_DOMAIN=mail.example.com`) → three `AWS::Route53::RecordSet` CNAMEs present; zone+subdomain+`SES_MAIL_FROM_SUBDOMAIN` → MX and TXT RecordSets for the MAIL FROM domain present (construct- or explicitly-created).

- [ ] **3.6** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 4: IAM user, access key, Secrets Manager secret

**Goal:** Proxy credentials provisioned with least-privilege policy and stored in Secrets Manager; all stack outputs complete.

### Tasks

- [ ] **4.1** Add IAM user with scoped inline policies
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - Per design §3: user named `config.iamUserName`; policy 1: `ses:SendRawEmail` on `[identity.emailIdentityArn, configurationSet.configurationSetArn]`; policy 2: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on `[queue.queueArn]`.

- [ ] **4.2** Add access key and secret
  - File: `cdk/lib/ghost-ses-proxy-stack.ts`
  - `iam.AccessKey` with `serial: config.accessKeySerial`; `secretsmanager.Secret` named `config.credentialsSecretName` with `secretObjectValue: { accessKeyId: SecretValue.unsafePlainText(accessKey.accessKeyId), secretAccessKey: accessKey.secretAccessKey }` and `removalPolicy: RemovalPolicy.DESTROY` (design §3 teardown note). Add `CredentialsSecretArn` output.

- [ ] **4.3** IAM + secret tests
  - File: `cdk/test/stack.test.ts`
  - Assertions per design Test Plan: user policy scopes SES actions to identity + config set ARNs (not `*`) and SQS actions to the queue ARN; `AWS::IAM::AccessKey` with `Serial`; secret exists and the synthesized template JSON contains no literal secret-access-key material (assert the secret's `SecretString`/`GenerateSecretString` references the access key attribute via `Fn::GetAtt`, e.g. by matching the template JSON string for `SecretAccessKey`); all five always-present outputs now exist (`SqsQueueUrl`, `SesConfigurationSet`, `SendingDomain`, `AwsRegion`, `CredentialsSecretArn`) — this guards the generate-env contract.

- [ ] **4.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 5: `generate-proxy-env` script

**Goal:** `npm run generate-env` turns stack outputs + secret into the proxy's `.env`, idempotently.

### Tasks

- [ ] **5.1** Implement the merge logic as pure functions
  - File: `cdk/scripts/generate-proxy-env.ts`
  - Export `mergeEnvFile(existingLines: string[], managed: Record<string, string>): string[]` per design §5: managed keys replaced in place, missing ones appended; comments/blank/unknown lines passed through verbatim, order preserved. Export `ensureProxyApiKey(lines: string[]): string[]` (or fold into merge): preserve existing `PROXY_API_KEY`, else append one from `crypto.randomBytes(32).toString('hex')`.
  - Managed keys: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `SQS_QUEUE_URL`, `SES_CONFIGURATION_SET`, `MAILGUN_DOMAIN`.

- [ ] **5.2** Implement `main()`
  - File: `cdk/scripts/generate-proxy-env.ts`
  - Per design §5 flow: `dotenv.config()` + `parseConfig` (for `stackName`/`awsRegion`); CloudFormation `DescribeStacks` → outputs map, with the "run npx cdk deploy first" error when the stack is missing; `GetSecretValue` on the `CredentialsSecretArn` output → parse JSON `{ accessKeyId, secretAccessKey }`; managed values assembled from outputs (`MAILGUN_DOMAIN` ← `SendingDomain`, `SES_CONFIGURATION_SET` ← output, `SQS_QUEUE_URL` ← output, `AWS_REGION` ← config); read target file if present, merge, write with mode `0o600`. `--out <path>` flag, default `../.env` relative to `cdk/`. Print which keys were written/preserved — never secret values. Guard `main()` behind `if` so importing the module for tests doesn't execute it (e.g. only run when invoked directly). Note: `parseConfig` deliberately imposes no account requirement, so this script works for Route53 users outside the CDK CLI (design §2; guarded by a Phase 1 test).

- [ ] **5.3** Unit tests for merge logic
  - File: `cdk/test/generate-proxy-env.test.ts`
  - Per design Test Plan: empty input → all managed keys + generated `PROXY_API_KEY`; existing file → values replaced in place, comments/order/`PORT`/unknown keys verbatim, existing `PROXY_API_KEY` untouched; double-merge idempotency (second run byte-identical). AWS calls in `main()` are not unit-tested (design decision — keep `main()` thin).

- [ ] **5.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 6: README documentation

**Goal:** README walks users through the CDK deployment as Option A; existing console guide preserved as Option B.

### Tasks

- [ ] **6.1** Restructure the AWS setup section
  - File: `README.md`
  - Replace the `## AWS setup guide` heading/intro with `## AWS infrastructure setup` introducing Options A and B, per design §8 blueprint. **Move** the five existing console steps under `### Option B: Manual console setup` without rewording them (design §8: moved, not rewritten — avoids conflicts with the concurrent branch); add only the one-line note that the CDK IAM policy is scoped tighter than Option B's `"Resource": "*"`.

- [ ] **6.2** Write Option A walkthrough
  - File: `README.md`
  - Follow design §8 structure exactly: prerequisites; steps 1–6 (configure, deploy, DNS-if-not-Route53, generate-env, production access, start proxy); day-2 operations (redeploy, `ACCESS_KEY_SERIAL` rotation, second deployment via `STACK_NAME` — names derive from it, `cdk destroy`); troubleshooting (already-exists, sandbox, pending verification). Include the CDK configuration table from design §2 (or an abridged table + pointer to `cdk/.env.example` — pick one, record in Observations).

- [ ] **6.3** Add Quick start pointer
  - File: `README.md`
  - In `## Quick start` step 1, add one line pointing to "AWS infrastructure setup" so users find the CDK path first (design §8 rule).

- [ ] **6.4** Build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass (docs phase; baseline gate confirms nothing broke)

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 7: CI gating + final verification

**Goal:** CDK tests gate PR merges; whole feature verified against the design.

### Tasks

- [ ] **7.1** Add `cdk-test` job to CI
  - File: `.github/workflows/ci.yml`
  - Add the job exactly per design §9 YAML: `working-directory: cdk` default, checkout, `setup-node` (Node 20, npm cache keyed on `cdk/package-lock.json`), `npm ci`, `npm test`, `SES_DOMAIN=example.com npx cdk synth --quiet`. No `paths:` filter (design §9 — a sometimes-skipped required check blocks merges). Do not modify the existing `docker-build` job.

- [ ] **7.2** Sanity-check the workflow file
  - File: `.github/workflows/ci.yml`
  - Validate YAML parses (e.g. `node -e "..."` with a YAML parse via `npx js-yaml .github/workflows/ci.yml` or python `yaml.safe_load`). Confirm job names: `docker-build`, `cdk-test`.

- [ ] **7.3** Design compliance pass
  - Re-read `ralph/projects/cdk-app/design.md` end-to-end. Verify: every row of the design's Files Changed table exists with the described content; `.gitignore` has the three new entries; no changes outside the listed files (`git status` — in particular `server.js`, `lib/*.js`, `Dockerfile`, root `package.json` untouched); stack outputs match the §4 table keys exactly; `cdk/.env.example` covers every §2 variable.

- [ ] **7.4** Code review pass
  - Review `cdk/lib/*.ts`, `cdk/bin/*.ts`, `cdk/scripts/*.ts` for: no secrets or account IDs hardcoded; error messages actionable; comments follow repo convention (none unless a non-obvious why); consistent naming with the design (§2 config names, §4 output keys).

- [ ] **7.5** Record the maintainer note
  - In this phase's Observations, record: "Maintainer action required: add `cdk-test` to the required status checks for the `dev` branch (GitHub → Settings → Branch protection). Not enforceable from the codebase." (design §9)

- [ ] **7.6** Final build + test gate: `cd cdk && npx tsc --noEmit && npx vitest run && SES_DOMAIN=example.com npx cdk synth --quiet` — all pass

### Observations

<!-- Agent: write notes here during execution -->

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
| `.gitignore` | 0 | Add `cdk/.env`, `cdk/cdk.out/`, `cdk/cdk.context.json` |
| `README.md` | 6 | "AWS infrastructure setup" section: CDK walkthrough (Option A) + moved console guide (Option B), Quick start pointer |
| `.github/workflows/ci.yml` | 7 | Add PR-gating `cdk-test` job (design §9) |
