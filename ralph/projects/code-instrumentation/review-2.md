# Code Instrumentation — Follow-up Code Review (post-review commits)

> **Design document:** [design.md](./design.md)
> **Plan document:** [plan.md](./plan.md)
> **Prior review:** [review.md](./review.md) (commits `248f24c..1239a62`, verdict: Approved with Minor Findings)
> **Reviewer:** Claude Fable 5 (independent adversarial review)
> **Date:** 2026-07-28
> **Scope:** The two commits after `1239a62`: `fdcf8c6` ("fix: Address post-review findings") and `5b379dc` ("feat: Move runtime to Node 22 and count real suppression removals") — reviewed via `git diff 1239a62..HEAD`
> **Verdict:** Approved

---

## Summary

The two commits do exactly what the prior review's Resolution section committed to, plus the two decisions it explicitly deferred to the user. `fdcf8c6` restored two byte-level legacy-parity divergences (findings 2 and 3 of the prior review), pinned `@types/node` to the runtime (finding 1), and added `ENV NODE_ENV=production` to the Dockerfile's runtime stage (finding 5's hardening). `5b379dc` then took the two raised-for-the-user decisions: the whole runtime moved to Node 22 as a single coupled change (both `FROM` lines, `engines.node`, CI `node-version`, `@types/node` major, lockfile), and `suppressions_removed_total` now counts rows actually deleted rather than delete requests (finding 4/1b of the prior review). Both decisions were backfilled into design.md §4.4 and §7, including the rationale for the one deliberate exception — `scripts/Dockerfile.capture` stays on `node:20-alpine`.

I verified everything independently rather than trusting the commit messages: both parity restorations were checked line-by-line against `git show 36845e9:lib/event-mapper.js` and `lib/sqs-poller.js` and are genuinely faithful (truth-table-checked, not just visually compared); the gate is green (typecheck, build, **547/547 tests, 100 % on all four coverage axes** — one net new test over the prior review's 546); the Docker image was rebuilt and smoke-run — it reports node v22.23.1 with `NODE_ENV=production`, `better-sqlite3` 11.10.0's native binding executes real statements, `/health` serves the exact legacy body, a no-op suppression delete still returns the unchanged 200 body while creating **no** metric series, an unhandled route throw returns a plain `Internal Server Error` page with no stack trace, and SIGTERM produces a clean ordered shutdown with exit code 0. The metric-semantics change was mutation-tested: reverting to the unconditional increment fails exactly the two tests that pin the new behaviour. Nothing in these commits touches the D1/D2/D3/D4/D7 defect fixes, the golden fixtures (no file under `test/golden/` changed), or any wire-contract path — the prior review's conclusions all stand.

No critical or important findings. The five findings below are trivia recorded for future readers; none requires action before merging.

---

## Findings

### Critical

None.

### Important

None.

### Trivial

#### 1. The four-way Node version coupling is documented but not machine-enforced

**Where:** `Dockerfile:1,12`, `package.json` (`engines`, `@types/node`), `.github/workflows/ci.yml:18`; design.md §7 ("Four things are a single coupled decision and must never drift apart").

All four pins currently agree (verified: image runs v22.23.1, `engines: >=22`, CI `'22'`, `@types/node` 22.20.1 installed, lockfile's `undici-types` correctly *downgraded* 8.3→6.21 with the types major). But nothing in CI asserts the coupling: reverting one `FROM` to `node:20-alpine`, or bumping `engines` to `>=24` while the image stays on 22, would pass every check — the docker-build job's `node --check` and require-probe are version-agnostic, and no test reads `NODE_ENV` or the image's node major. This exact drift class is what the prior review caught by hand. A one-line CI assertion (run `node --version` in the built image and compare its major against `engines.node`) would make the design's "must never drift apart" self-enforcing. Suggestion only; the residual risk direction is now safe (types older than any runtime that could sneak in, so a post-22 API fails typecheck rather than at container startup — the reverse of the original defect).

#### 2. The two parity restorations are pinned by no test and would revert silently

**Where:** `src/event-mapper.ts:188` (`sesEvent.mail?.messageId || null`), `src/sqs-poller.ts:245` (`stripAngleBrackets(row.batch_message_id)`).

I reverted both restorations simultaneously (`|| null` → `?? null`; dropped the correlated-row strip) and the full suite stayed green at 547/547 with coverage still 100 %. This is expected — the prior review established both divergent inputs as unreachable (SES always sets `mail.messageId` to a non-empty string; stored batch ids are always single-bracketed `<uuid@domain>` per `src/routes/send-email.ts`), and a test would pin dead behaviour against impossible input. Recorded so a future reader knows these two lines are protected by review and the design's "logic preserved exactly" rule, not by CI. The restorations themselves are exact: legacy `lib/event-mapper.js:93` is `sesEvent.mail && sesEvent.mail.messageId || null`, which parses as `(mail && mail.messageId) || null` and agrees with `mail?.messageId || null` on every case (mail absent → null, `''` → null, non-empty → value); legacy `lib/sqs-poller.js:45` strips the correlated row value and line 52 strips again unconditionally — the port now has the same two strips at `src/sqs-poller.ts:245` and `:261`, with a byte-identical `stripAngleBrackets` implementation (single leading `<`, single trailing `>`, falsy passthrough).

#### 3. The `removed` multiplier in `inc({ type }, removed)` is unfalsifiable

**Where:** `src/routes/suppression.ts:36-38`, `src/schema.ts:33-40`.

`suppressions` has `UNIQUE(email, type)` and the delete is keyed on exactly that pair, so `deleteSuppression` can only ever return 0 or 1 — inside the `removed > 0` guard, `inc({ type }, removed)` is indistinguishable from `inc({ type })`, and no test can tell them apart. Harmless, arguably future-proof if the uniqueness constraint ever changed, and the guarded shape is what both new tests actually pin (verified by mutation: the unconditional legacy-semantics increment fails both `counts rows actually removed, not delete requests` and `does not create a series when nothing was removed` — 2 failures, 545 pass). The metric's help string, `'Suppression rows removed, by type.'` (`src/metrics.ts:184`), was previously slightly inaccurate and is now literally true — a small bonus of this change.

#### 4. An unhandled route throw still prints an unstructured stack to stderr in production

**Where:** Express's default error path (`logerror` in `express/lib/application.js`), observed via `docker logs` during the smoke run.

`NODE_ENV=production` fixes the *response*: a double-encoded malformed address (`DELETE /v3/…/bounces/%25ZZ`, which makes the route's own `decodeURIComponent` throw) now returns a plain `<pre>Internal Server Error</pre>` with **no stack trace** — verified live against the built image, and the 500 is correctly counted under the `/v3/:domain/:type/:email` route template. But Express still `console.error`s the stack to stderr (it suppresses that only under `env === 'test'`), so this one path emits a non-pino, non-JSON block into the container's log stream. A pre-existing consequence of the correctly-closed "no error handler" decision (prior review finding 5); auth-gated, internal-network-only, and the design's structured-log schema governs stdout. Informational.

#### 5. The historical documents now trail the two decisions — deliberately

**Where:** `review.md` Resolution table ("pinned `@types/node@^20.19.43`, matching `node:20-alpine`" — superseded hours later by `5b379dc`'s move to `^22`; raised-items 1b and 4 were subsequently both actioned); `plan.md:1028,1071` (still describes the original request-counting semantics of `suppressions_removed_total`).

Both files are execution/review records and correctly left untouched; design.md — the living spec — was updated for both decisions. This document closes the loop: review.md's two "raised for the user rather than actioned" items were decided by the user and implemented in `5b379dc` exactly as raised. No action.

---

## Design Compliance Checklist

Scope: the design deltas introduced by these two commits, plus the standing design rules they touch.

| Design requirement | Status | Notes |
|---|---|---|
| §4.4: `suppressions_removed_total` counts rows actually deleted, not delete requests | Correct | `src/routes/suppression.ts:33-38`; mutation-verified (unconditional inc → 2 test failures) |
| §4.4: a no-op delete increments nothing and **creates no series** | Correct | Guard skips `inc` entirely; pinned by the new test; confirmed live — after a real no-op delete, `/metrics` shows HELP/TYPE but zero series |
| §4.4 (standing, plan): `type` label bounded — incremented only after the `VALID_TYPES` guard | Correct | Statement order preserved; unknown-type 404 path unchanged and still creates no series |
| Wire contract: no-op delete still returns 200 with the unchanged Mailgun body | Correct | Verified live in-container and by the untouched fixture `captured/http-suppression-plus-literal.json`; no file under `test/golden/` changed |
| §7: both Dockerfile stages `node:22-alpine` | Correct | Image runs v22.23.1; native `better-sqlite3` binding compiled in the builder executes real statements in the runtime stage (ABI match) |
| §7: `engines.node >=22`, CI test job `'22'`, `@types/node` major 22 — coupled | Correct | All four verified; lockfile coherent (`@types/node` 22.20.1, `undici-types` 6.21.0). See finding 1 for the missing machine enforcement |
| §7: `ENV NODE_ENV=production` in the runtime stage **only** | Correct | Builder stage has no `ENV`; build succeeded (so `npm ci` installed the devDependencies the build needs); image env verified `production` |
| §7: `NODE_ENV=production` suppresses the stack-bearing error page | Correct | Verified live: `%25ZZ` double-encoded address → 500 with plain body, no stack (see finding 4 for the stderr nuance) |
| §7/§8.5: `scripts/Dockerfile.capture` stays on `node:20-alpine` | Correct | Required, not merely acceptable: `MANIFEST.json` records node v20.20.2 as the capture environment, and the capture image `COPY`s `server.js`/`lib/` — files that exist only in the pre-rewrite checkout, so it cannot even build against HEAD; current `engines: >=22` never applies to it (it installs the legacy tree's own `package.json`) |
| "Logic preserved exactly" for `lib/event-mapper.js` → `src/event-mapper.ts` | Correct | `|| null` restored at `src/event-mapper.ts:188`; truth-table-equivalent to legacy line 93 in all cases including `''` |
| "Preserve the correlation logic" for `lib/sqs-poller.js` → `src/sqs-poller.ts` | Correct | Correlated `batch_message_id` stripped at `:245` and again unconditionally at `:261` — matching legacy lines 45 and 52; `stripAngleBrackets` byte-identical |
| Prior review's conclusions (D1, D2, D3, D4, D7; contract suite; fixtures) | Unaffected | The diff touches none of those code paths; contract tests pass within the 547; golden fixtures untouched |
| Graceful shutdown still intact on the new runtime | Correct | Verified live: SIGTERM → poller stopped → "shutdown complete" → exit code 0, with the AWS-error backoff loop active at the time |

## Test Coverage Assessment

| Feature | Tests | Notes |
|---|---|---|
| Rows-not-requests counting | `counts rows actually removed, not delete requests` (`test/routes/suppression.test.ts:140`) | Genuinely pins the new semantics — the interleaved no-op delete makes the old behaviour assert `bounces: 2`, the new `bounces: 1`; mutation-killed. The update reflects a recorded user decision (prior review finding 4 / design §4.4), not a test bent to fit code |
| No series on no-op delete | `does not create a series when nothing was removed` (`test/routes/suppression.test.ts:160`) | New test; mutation-killed; also confirmed against the production image via `/metrics` |
| Unknown type creates no series | `does not count an unknown type in suppressions_removed_total` (pre-existing) | Unchanged; still passes — the guard did not disturb the 404 path |
| No-op delete wire contract | `returns 200 when the address was never suppressed` (pre-existing) + golden fixture | Body unchanged; verified live |
| Parity restorations (`|| null`, double strip) | — | Deliberately untestable: divergent inputs unreachable with real SES data (finding 2); protected by review + design rule, not CI |
| Node 22 runtime | CI test job on Node 22; docker-build job's `node --check` + 9-dependency require-probe; this review's in-container checks | `better-sqlite3` verified functionally (real DDL/DML in-image), not just requireable; local gate ran on host Node 24, CI pins 22 — both satisfy `engines` |
| `NODE_ENV=production` in the image | — (manual verification only) | Nothing in CI asserts it (finding 1); verified live here and in `5b379dc`'s recorded verification |
| Suite totals | 547/547, coverage 100 % / 100 % / 100 % / 100 % (684 statements, 332 branches) | Net +1 test and +1 covered statement vs the prior review's 546/683 — the new guard branch is exercised on both sides |

---

## Verification performed by this review (not taken from the commit messages)

- **Legacy parity, line by line:** `git show 36845e9:lib/event-mapper.js` line 93 and `lib/sqs-poller.js` lines 15-18, 36-52 compared against `src/event-mapper.ts:188` and `src/sqs-poller.ts:68-71,244-261`, including operator-precedence/truth-table analysis of `&& … || null` vs `?.… || null` and confirmation that the port keeps *both* strips (conditional on correlation, then unconditional before insert).
- **Full gate re-run:** `npm run typecheck && npm run build && npm run test:coverage` — clean, 547/547, 100 % on all four axes.
- **Mutation testing:** reverting the counter to the unconditional `inc({ type })` fails exactly the 2 new-semantics tests (545 pass); reverting *both* parity restorations keeps all 547 green (expected — see finding 2). Working tree restored and re-verified identical to HEAD after each mutation.
- **Docker:** image rebuilt from HEAD; in-container checks: `process.version` = v22.23.1, `NODE_ENV` = production, `better-sqlite3` create/insert/select executes; full app smoke with dummy AWS credentials: `/health` exact legacy body, events route with `limit=abc ` → 200 empty page, no-op suppression delete → 200 Mailgun body + zero metric series, Express-level bad percent-encoding → 400, route-level `decodeURIComponent` throw (`%25ZZ`) → 500 plain body with no stack trace, HTTP metrics labelled by route template throughout; `docker stop` (SIGTERM) → ordered shutdown log, exit code 0.
- **Node-20 residue hunt:** repo-wide sweep found exactly three remaining node-20 references, all correct to keep — `scripts/Dockerfile.capture` (required: reproduces fixtures, unbuildable against HEAD anyway), `captured/MANIFEST.json` (`"node": "v20.20.2"`, historical capture record), and `.claude/worktrees/` (out of tree). `release-please.yml` pins no node version (it builds the Dockerfile); README makes no node-version claim; no `.nvmrc`.
- **Fixture integrity:** `git diff 1239a62..HEAD` touches nothing under `test/golden/`; no fixture, contract test, or README table references `suppressions_removed_total`, so the semantics change invalidates nothing downstream.
