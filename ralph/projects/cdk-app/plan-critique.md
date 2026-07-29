# CDK Infrastructure App — Pre-Execution Critique

> **Documents reviewed:** design.md, plan.md
> **Reviewer:** Claude Fable 5
> **Date:** 2026-07-28

---

## Summary

The proposal adds a self-contained CDK package under `cdk/` that provisions the SES/SNS/SQS/IAM resources the proxy consumes, plus a `generate-env` bridge script, README rewrite, and CI job. The design's claims about the existing codebase are accurate (verified against `lib/sqs-poller.js`, `lib/ses-client.js`, `lib/event-mapper.js`, `lib/config.js`, `README.md`, `.env.example`, `.gitignore`, `.github/workflows/ci.yml`), the phase structure is well-scoped and correctly ordered, and the deliberately deferred CDK API-surface check (task 3.1) covers the sketch-level API uncertainties. One critical logic gap in the `generate-env` flow and two design-consistency issues should be fixed before execution; otherwise the plan is ready.

---

## Findings

### Critical

#### 1. `generate-env` reuses `parseConfig` and will hard-fail for Route53 users — the headline happy path

**Where:** design §2 (validation rules) + §5 step 1 ("same config parsing as bin/"); plan task 5.2 ("`dotenv.config()` + `parseConfig`").

**What the documents say:** `parseConfig` throws when `HOSTED_ZONE_NAME` is set and `AWS_ACCOUNT_ID` is not "resolvable (explicit or `CDK_DEFAULT_ACCOUNT`)" (design §2, plan 1.1). The `generate-proxy-env.ts` script runs that same `parseConfig` to obtain `stackName`/`awsRegion` (design §5, plan 5.2). The README walkthrough (design §8, step 1) tells Route53 users to set only `SES_DOMAIN` and `HOSTED_ZONE_NAME`.

**Why it's wrong:** `CDK_DEFAULT_ACCOUNT` is an environment variable the CDK CLI injects when it spawns the app process — it exists during `cdk deploy`/`cdk synth`, but not when `npm run generate-env` invokes `tsx scripts/generate-proxy-env.ts` directly. A Route53 user following the documented flow (never setting `AWS_ACCOUNT_ID` explicitly, relying on CLI credentials) will deploy successfully in step 2 and then fail validation in step 4 with a spurious "AWS_ACCOUNT_ID required" error. The design's own test plan makes this invisible pre-merge: `main()`'s AWS/config flow is deliberately not unit-tested (design Test Plan; plan 5.3), so the bug ships and surfaces only at first real use of the primary advertised path.

**Suggested fix:** Don't apply the hosted-zone/account validation in the script's context. Options: (a) give `parseConfig` a mode/flag (e.g. `parseConfig(env, { forSynth: boolean })`) that skips the account-resolvable check outside synth; (b) have the script parse only the keys it needs (`STACK_NAME`, `AWS_REGION`) with the same defaults; or (c) drop the account-resolvable rule from `parseConfig` entirely and let `HostedZone.fromLookup` produce its own (already clear) "Cannot determine account" error at synth time. Whichever is chosen, add a config unit test asserting `generate-env`-style parsing succeeds with `HOSTED_ZONE_NAME` set and no account variable present.

### Important

#### 2. Hosted zone + subdomain identity + MAIL FROM: the MX/TXT records are neither created nor output

**Where:** design §3 ("Route53 identity edge case" note), §4 outputs table (`MailFromMxRecord`/`MailFromSpfRecord` condition: "only when `SES_MAIL_FROM_SUBDOMAIN` set **and no hosted zone**"); plan tasks 3.3–3.5.

**What the documents say:** When `HOSTED_ZONE_NAME` is set and `SES_DOMAIN` is a subdomain of the zone, the stack uses `Identity.domain(cfg.sesDomain)` plus three manually built DKIM `CnameRecord`s. The MAIL FROM MX/SPF outputs are emitted only in the *no-hosted-zone* case, on the assumption that with a zone "records are created automatically" (design §3 sketch comment — true, if at all, only for the `Identity.publicHostedZone` branch, since only that branch gives the construct a zone to write into).

**Why it's a gap:** In the combination *hosted zone + subdomain + `SES_MAIL_FROM_SUBDOMAIN`*, the `Identity.domain` branch has no zone reference for the construct to create MAIL FROM records in, the design's manual-records list covers only the 3 DKIM CNAMEs, and the outputs are suppressed by the "no hosted zone" condition. Result: the custom MAIL FROM domain never gets its MX/TXT records anywhere, and the user is never told to add them — SES MAIL FROM setup silently stays "pending" (behavior then depends on `BehaviorOnMxFailure`). Plan 3.5's test matrix has zone+apex and zone+subdomain cases but no zone+subdomain+MAIL FROM case, so tests won't catch it either.

**Suggested fix:** In the subdomain branch, also create the `MxRecord` (`10 feedback-smtp.<region>.amazonses.com`) and `TxtRecord` (`"v=spf1 include:amazonses.com ~all"`) for `<subdomain>.<SES_DOMAIN>` in the looked-up zone when `sesMailFromSubdomain` is set (or, minimally, emit the MAIL FROM outputs whenever the records were not auto-created). Add the zone+subdomain+MAIL FROM case to plan 3.5. Also have task 3.1 explicitly confirm whether `EmailIdentity` auto-creates MAIL FROM records in the `publicHostedZone` (apex) branch — the design asserts it in a comment but flags the sketch as unverified; if it doesn't, the apex branch has the same hole.

#### 3. `STACK_NAME` "run multiple independent deployments" contradicts the fixed default physical names

**Where:** design §2 table (`STACK_NAME` row: "change it to run multiple independent deployments"); design §3 (every resource gets an explicit physical name); design §6 / §8 day-2 docs; plan Phase 6 would copy this claim into the README.

**What the documents say:** Changing `STACK_NAME` yields an independent deployment.

**Why it's wrong:** Every other resource keeps its default explicit physical name — `ghost-ses-proxy` (config set, IAM user), `ghost-ses-events` (topic, queue, `-dlq`), `ghost-ses-proxy/credentials` (secret). A second stack with only `STACK_NAME` changed collides on all of them and the deploy fails with CloudFormation "already exists" errors on the first named resource. The design's own §6 documents exactly this failure mode for *manually* pre-created resources but doesn't connect it to the `STACK_NAME` claim. As written, Phase 6 would publish a README instruction that reliably fails.

**Suggested fix:** Pick one: (a) reword the `STACK_NAME` row/README to "also override every `*_NAME` variable when running a second deployment"; (b) derive default physical names from `STACK_NAME` (e.g. prefix) so one variable really does isolate a deployment; or (c) leave physical names unset by default (CloudFormation-generated) and make explicit names opt-in — noting that (c) changes the "console matches the README vocabulary" decision, so (a) is the smallest fix.

### Suggestions

#### 4. Plan task 0.5 says "all 16 variables" but design §2 defines 15

**Where:** plan 0.5 vs. design §2 table.

The §2 table has exactly 15 rows (`SES_DOMAIN` through `SES_MAIL_FROM_SUBDOMAIN`). A memory-less executor told to include "all 16" may burn time hunting for a nonexistent 16th variable or invent one. Change 0.5 to "every variable in the design §2 table" without a count.

#### 5. The existing `.env` gitignore pattern already covers `cdk/.env`

**Where:** design "What changes" table and plan 0.6 (`.gitignore` additions).

`.gitignore` line 3 is the unanchored pattern `.env`, which matches at any depth — `cdk/.env` is already ignored today, just as the design notes `node_modules/` already covers `cdk/node_modules/`. The explicit `cdk/.env` entry is harmless (belt-and-suspenders is fine to keep), but `cdk/cdk.out/` and `cdk/cdk.context.json` are the only additions that change behavior. No action strictly needed; noting it so the executor doesn't puzzle over why `git status` was already clean before task 0.6.

---

## Verified claims (no findings)

Checked and confirmed accurate, for the record:

- `lib/sqs-poller.js` unwraps the SNS envelope and accepts raw SES JSON (lines 20–34) — `rawMessageDelivery: false` matches current behavior.
- `lib/ses-client.js` uses SES v1 `SendRawEmailCommand` with `ConfigurationSetName` per send; IAM `ses:SendRawEmail` resource-scoping to the identity ARN is valid for the v1 API (the config-set ARN in the resource list is inert for v1 but harmless and future-proofs a v2 migration). The From address is Ghost's `mailgun_domain` = `SES_DOMAIN`, so the identity ARN matches.
- `lib/event-mapper.js` skips exactly `Send` and `DeliveryDelay` and handles the other 7 types — hardcoding the 7 event types is correct.
- Root `.env.example` / `lib/config.js` required-variable contract is fully covered by the managed keys + generated `PROXY_API_KEY`.
- `ci.yml` has a single `docker-build` job on `pull_request` → `dev`; the new job slots in as described. The Dockerfile copies only `package.json`, `server.js`, `lib/` — `cdk/` cannot leak into the image.
- Root `package.json` has no test/build scripts; the no-test-framework claim holds; `cdk/` does not exist yet.
- Plan phase ordering is sound (topic before event destination, identity/config-set/queue before IAM policy, outputs before generate-env), and task 3.1's API-surface check appropriately covers the design's unresolved CDK API details (`EmailIdentity` prop names, `EventDestination.snsTopic`, DKIM token attributes).
