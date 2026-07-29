# CDK Infrastructure App — Code Review

> **Design document:** [design.md](./design.md)
> **Plan document:** [plan.md](./plan.md)
> **Reviewer:** Claude Fable 5
> **Date:** 2026-07-28
> **Scope:** All changes from commits `4d94e09` (Phase 0) through `543e6a4` (Phase 7) (8 commits, on top of base `36845e9`)
> **Verdict:** Approved with Minor Findings

---

## Summary

The implementation delivers exactly what the design specifies: a self-contained CDK TypeScript package under `cdk/` (own `package.json`/lockfile, `tsx`-driven, no emit step) that provisions the SES email identity, configuration set with the seven hardcoded event types, SNS topic, SQS queue with optional DLQ, least-privilege IAM user, access key, and Secrets Manager secret; a `generate-proxy-env` script that merges stack outputs and credentials into the proxy's `.env` idempotently; a rewritten README "AWS infrastructure setup" section (Option A CDK walkthrough, Option B moved-not-rewritten console guide); and a PR-gating `cdk-test` CI job. The rest of the repo is untouched — `git diff --name-only 36845e9..543e6a4` shows only the 13 `cdk/` files, `README.md`, `.gitignore` (two lines), `.github/workflows/ci.yml`, and the ralph planning docs. `server.js`, `lib/*.js`, `Dockerfile`, and the root `package.json` are byte-identical, as required.

All three pre-execution critique findings were resolved in the shipped code: `parseConfig` imposes no account requirement (guarded by a dedicated unit test, so `generate-env` works for Route53 users outside the CDK CLI); the hosted-zone + subdomain + MAIL FROM combination creates the MX/TXT records explicitly and is covered by an `it.each` test for both apex and subdomain identities; and resource-name defaults derive from a kebab-cased `STACK_NAME`, making the "second deployment via `STACK_NAME`" claim true. The two justified deviations from the design sketch (`CfnRecordSet` instead of `CnameRecord` for token-valued DKIM names; `formatArn` because `configurationSetArn` does not exist in `aws-cdk-lib` 2.262.1) are documented in the plan observations and verified correct in the synthesized templates via tests.

I independently re-ran the full gate in the worktree: `npx tsc --noEmit` clean, `npx vitest run` 88/88 passing (3 files), and `SES_DOMAIN=example.com npx cdk synth --quiet` succeeds with all AWS credential/region env vars unset. The findings below are one Important gap in the CI job and a handful of trivia; nothing blocks merging.

---

## Findings

### Critical

None.

### Important

#### 1. The `cdk-test` CI job never typechecks — pure type errors can merge

**Where:** `.github/workflows/ci.yml` (`cdk-test` job, lines 42–65); contrast with the plan's per-phase gate.

The job runs `npm ci`, `npm test` (vitest), and `npx cdk synth --quiet` — but not `npx tsc --noEmit`. Neither of the two steps that execute TypeScript performs type-checking: vitest 4 does not typecheck by default, and `tsx` strips types without checking them. The local phase gate that kept the code honest during execution (`npx tsc --noEmit && npx vitest run && ... cdk synth`) is therefore stronger than the CI gate that will protect the branch going forward — a PR introducing a type error that happens not to change runtime behavior (wrong type annotation, dead branch, bad interface change with `skipLibCheck`) passes CI. The implementation matches the design §9 YAML verbatim, so this is a design gap faithfully propagated rather than an executor mistake, but it is a one-line fix: add a `run: npm run typecheck` (the script already exists in `cdk/package.json`) or `npx tsc --noEmit` step before `npm test`.

### Trivial

#### 2. `STACK_NAME ≤ 50` does not strictly guarantee derived names stay within AWS limits

`cdk/lib/config.ts:22` caps `STACK_NAME` at 50 characters, and the design claims this keeps "every derived name within AWS limits." Kebab-casing can nearly 1.5x the length (a 50-char alternating-case name yields a 74-char prefix), so `<prefix>-events-dlq` can exceed SQS's 80-char queue-name limit and `<prefix>` alone can exceed IAM's 64-char user-name limit. Requires a pathological camelCase name, and the failure is a loud CloudFormation validation error at deploy time — not silent. Documenting or tightening the bound (e.g. validating the derived names' lengths in `parseConfig`) would make the design claim strictly true.

#### 3. `generate-proxy-env.ts`: dotenv load is cwd-dependent while the default `--out` is cwd-independent

`cdk/scripts/generate-proxy-env.ts:165` calls `loadDotenv()` (cwd-relative `.env`), while `defaultOutPath()` (line 93) deliberately resolves from `import.meta.url` so it works from any cwd. Running the script from the repo root instead of `cdk/` loads the proxy's root `.env` (which has no `SES_DOMAIN`) and fails with a confusing "SES_DOMAIN is required" error. Fail-safe, and the documented invocation (`npm run generate-env`) always runs from `cdk/`, but pointing dotenv at `cdk/.env` via `import.meta.url` too would make the script fully location-independent.

#### 4. Slightly inaccurate summary line in `generate-env` console output

`cdk/scripts/generate-proxy-env.ts:189` prints `set from stack "X": AWS_ACCESS_KEY_ID, ..., AWS_REGION, ...`, but `AWS_REGION` comes from `cdk/.env`/default via `parseConfig`, not from a stack output. Cosmetic; no secrets are printed anywhere.

#### 5. `makeTemplate` is exported from a test file

`cdk/test/stack.test.ts:15` exports the helper "for later phases," but all consumers ended up in the same file. Importing one vitest test file from another double-registers the importee's suites, so the export is a small footgun; move the helper to a non-test module (e.g. `test/helpers.ts`) or drop the `export`.

#### 6. Merge is not byte-verbatim for CRLF files

`parseEnvContent` splits on `\r?\n` and `formatEnvFile` joins with `\n` (`cdk/scripts/generate-proxy-env.ts:39-47`), so a CRLF `.env` is normalized to LF (and a missing trailing newline is added) on first run. Still idempotent from run two onward, and dotenv/Compose are indifferent, but it is a mild deviation from the design's "passed through verbatim" wording.

#### 7. plan.md Files Changed Summary lists a `.gitignore` entry that was (correctly) never added

The plan's summary table says `.gitignore` gained `cdk/.env`, `cdk/cdk.out/`, `cdk/cdk.context.json`; the actual change is the design-correct two entries (`cdk/.env` is already covered by the unanchored `.env` pattern, as the Phase 7 observations note). Doc-only inconsistency inside the plan file.

---

## Design Compliance Checklist

| Design requirement | Status | Notes |
|---|---|---|
| §1 Self-contained package: own `package.json`/lockfile, `tsx` app, no root `package.json` changes | Correct | `cdk/package.json` private, `"type": "module"`, lockfile committed; root untouched |
| §1 npm scripts `synth`/`deploy`/`destroy`/`generate-env`/`test` | Correct | Plus `typecheck` (used by the gate, not by CI — Finding 1) |
| §2 All 15 config variables with documented defaults | Correct | `cdk/lib/config.ts`; `.env.example` covers all 15, only `SES_DOMAIN` uncommented |
| §2 Single aggregated validation error listing all problems | Correct | Errors collected then thrown once; tested |
| §2 Domain shape, zone containment, integer-range rules | Correct | Incl. rejection of `1.5`, `notexample.com` suffix trap tested |
| §2 No account requirement in `parseConfig`; account check in `bin/` only | Correct | Critique finding #1 fix; dedicated test at `config.test.ts:123` |
| §2 `STACK_NAME` pattern/≤50 + kebab-cased name derivation, explicit overrides win | Correct | Length bound not strictly sufficient at the margin (Finding 2) |
| §3 SNS topic, SQS queue (retention/visibility), DLQ 14-day, `maxReceiveCount`, DLQ disabled at 0 | Correct | Tested incl. DLQ-absent case |
| §3 `rawMessageDelivery: false`, SNS→SQS queue policy conditioned on topic ARN | Correct | Template-asserted |
| §3 Config set + exactly 7 hardcoded event types → SNS | Correct | `Match.exact` on the 7 camelCase values |
| §3 Identity branches: apex `publicHostedZone` / subdomain manual DKIM / no-zone | Correct | `CfnRecordSet` instead of `CnameRecord` — required deviation, verified and commented |
| §3 MAIL FROM MX/TXT in zone for both apex and subdomain branches | Correct | Critique finding #2 fix; apex auto-created by construct, subdomain explicit; `it.each` test |
| §3 IAM scoped to identity + config-set ARNs and queue ARN, never `*` | Correct | `formatArn` replaces nonexistent `configurationSetArn`; wildcard-guard test |
| §3 AccessKey with `serial`; secret via `secretObjectValue`; no plaintext key in template | Correct | Test asserts the only literal strings in `SecretString` are the JSON scaffolding |
| §3 Secret `RemovalPolicy.DESTROY` | Correct | Both `DeletionPolicy` and `UpdateReplacePolicy: Delete` asserted |
| §4 Five always-present outputs with exact keys | Correct | Contract-guard test runs for both zone and no-zone cases |
| §4 Conditional `DkimCname*` and `MailFrom*` outputs | Correct | MAIL FROM outputs are human-readable one-liners — minor justified deviation |
| §5 `generate-env` flow: DescribeStacks, missing-stack message, GetSecretValue, merge, 0600 | Correct | `chmodSync` after write covers the overwrite case |
| §5 Merge semantics: managed keys in place, `PROXY_API_KEY` preserved/generated, rest verbatim | Correct | CRLF normalization is the only verbatim exception (Finding 6) |
| §5 Never prints secret values; idempotent | Correct | Key names only; byte-identical second run tested |
| §6 `STACK_NAME`-derived names make a second deployment collision-free | Correct | Critique finding #3 fix |
| §6 `cdk.context.json` gitignored | Correct | `.gitignore` gains exactly the two design-listed entries |
| §7/§8 README: Option A walkthrough, day-2 ops, troubleshooting, Option B moved not rewritten, Quick start pointer | Correct | Diff confirms Option B is heading-level-only churn; IAM-scoping note present |
| §9 `cdk-test` CI job, no path filter, credential-free synth | Partial | Matches design YAML verbatim, but no typecheck step (Finding 1); maintainer branch-protection note recorded in plan |
| No changes to proxy runtime code / root package.json / root .env.example | Correct | Verified via `git diff --name-only` against base |

## Test Coverage Assessment

| Feature | Tests | Notes |
|---|---|---|
| `parseConfig` defaults, full-env reflection | `config.test.ts` "applies every documented default", "reflects every variable" | Exact `toEqual` on the full object |
| Validation: missing/blank/invalid domain, aggregated errors | "throws naming SES_DOMAIN", "treats an empty string as unset", "rejects a domain with…", "collects every validation error" | Includes suffix-collision case `notexample.com` |
| Zone containment + no-account parsing | `hosted zone containment` block | Guards the `generate-env` Route53 path (critique #1) |
| Numeric ranges and integer strictness | `numeric validation` `it.each` (11 cases) + boundary accepts | `1.5` rejected; 0/43200 bounds accepted |
| Name derivation / overrides / stack-name limits | `name derivation` block | Default, custom, hyphenated, overrides, 5 invalid names, 50/51-char boundary |
| Topic/queue/DLQ/redrive/subscription/queue policy | `messaging resources` (9 tests) | Logical IDs resolved via `findResources`, never hardcoded |
| Config set + 7 event types | `SES configuration set` (3 tests) | `Match.exact` ordering |
| Identity, DKIM defaults, MAIL FROM attribute | `SES email identity` (3 tests) | — |
| No-zone DNS outputs (DKIM + MAIL FROM) | `DNS without a hosted zone` (4 tests) | Asserts `Fn::GetAtt` wiring to the identity |
| Zone apex / subdomain DKIM records; MAIL FROM MX+TXT both identities | `DNS with a hosted zone` (4 tests incl. `it.each`) | Covers critique finding #2's exact gap |
| IAM scoping + wildcard regression guard | `proxy IAM user` (5 tests) | Walks every statement |
| Access key serial, secret shape, no plaintext key, removal policy | `access key and credentials secret` (5 tests) | String-parts assertion proves no literal key material |
| Output contract for `generate-env` | `always-present outputs` (4 tests) | Runs both zone and no-zone |
| `mergeEnvFile` / `ensureProxyApiKey` / round-trip / idempotency | `generate-proxy-env.test.ts` (16 tests) | Duplicates rewritten, commented-out assignments ignored, injectable key generator |
| `main()` AWS flow (DescribeStacks/GetSecretValue/file write) | — | Deliberately untested per design ("keep `main()` thin, mock-free"); manually smoke-tested per Phase 5 observations |
| Credential-free synth from clean checkout | CI `cdk-test` synth step + per-phase gate | Re-verified in this review with AWS env vars unset |

---

Independently verified gate (this review, worktree `cdk-app`): `npx tsc --noEmit` OK, `npx vitest run` 88/88 OK, `SES_DOMAIN=example.com npx cdk synth --quiet` OK with no AWS credentials.
