# Code Instrumentation — Code Review

> **Design document:** [design.md](./design.md)
> **Plan document:** [plan.md](./plan.md)
> **Reviewer:** Claude Opus 4.6 (adversarial post-execution review)
> **Date:** 2026-07-28
> **Scope:** All changes from commits `248f24c` (Phase 0) through `1239a62` (Phase 18) — 21 commits
> **Verdict:** Approved with Minor Findings

---

## Summary

The rewrite delivers what the design specified: 1,010 lines of untyped CommonJS (`server.js` + `lib/*.js`, deleted in Phase 17) replaced by 25 strict-TypeScript files under `src/`, with pino structured logging, the full 27-metric prom-client catalog (independently re-counted against design §4.1–§4.5: 2+7+10+2+6 = 27, exact names/types/label sets match), graceful shutdown as tested code, a multi-stage Docker image, and a 546-test Vitest suite at 100% coverage on all four axes with only the two sanctioned exclusions (`src/index.ts`, `src/types.ts`). I re-ran the full gate myself: `typecheck` clean, `build` emits `dist/index.js` (no `dist/src/`), 546/546 pass, and `docker build` succeeds.

The review's central question was whether the golden-fixture contract suite (`test/contract.test.ts`, 67 tests) genuinely protects the wire contract or can pass vacuously. I verified this **by independent mutation, not by trusting the plan's mutation table**: re-adding `suppressions` to the cleanup list (D2) failed 8 tests including the contract-level one; reverting `firstString` to an unsafe cast (D4) failed 4 contract tests; making the send route's per-recipient catch rethrow (D1 reporting half) failed 10 tests across contract and route suites; swapping the D7 `malformed_payload` counter for the skip counter failed 9 tests in both layers. I also re-derived the D3 fixture hash from scratch (`sha256('010001912a3b4c5d-0000000000000003-000000 delivered dana@example.com 1784548805')[:32]` = `48331fd09573841d97dc2c60a1081f22` — matches `intent/d3-redelivery-dedupe.json` and the code in `src/sqs-poller.ts:23-35`). The one mutation the contract suite did *not* catch — removing `runExclusive`'s `try/finally` alone — is correctly caught by the unit layer and is unobservable end-to-end by construction (finding 6); the wedge behavior itself cannot recur while either layer is green. The suite's anti-vacuity mechanics are sound: fixtures are enumerated from the directory rather than a hand list, the single normalizer implementation (`scripts/normalize.cjs`) is shared between capture and replay, `paging.next` is asserted un-normalized against seeded fixed ids with a pinned `Host` header, and the `/health` fixture's `_precondition` is re-checked before the body comparison.

All five defect fixes are real and complete, each verified against the legacy source recovered from `git show 36845e9`: D1 has both halves (`src/semaphore.ts:48-55` releases on throw; `src/routes/send-email.ts:151-215` converts any per-recipient throw into `failed++`); D2 excludes `suppressions` both structurally (compile-time `Exclude<>` type predicate, `src/cleanup.ts:9-14`) and behaviorally; D3's content hash makes the pre-existing `INSERT OR IGNORE` dedupe effective, with the known no-timestamp limitation recorded and the fixture deliberately carrying an explicit timestamp; D4 applies `firstString` to every query parameter plus a correct NaN-before-clamp `clampLimit` (`src/routes/events.ts:15-23`); D7 guards every optional block in `src/event-mapper.ts:73-87` and splits malformed-vs-skip on `isRecognizedSesEventType` before sharing any denominator (`src/sqs-poller.ts:200-220`). Every other legacy code path I diffed is a faithful port; the two divergences I found that are *not* in the deviation record are byte-level nuances unreachable with real SES input (findings 2 and 3). The findings below are one Important version-pin incoherence and a handful of trivia; nothing blocks merging.

---

## Findings

### Critical

None.

### Important

#### 1. `@types/node@^26` describes a runtime the project never runs — and the one file it could hurt is coverage-excluded

**Where:** `package.json` (`"@types/node": "^26.1.2"`, `"engines": { "node": ">=20" }`), `Dockerfile` (`node:20-alpine` both stages), `vitest.config.ts` (`exclude: ['src/index.ts', …]`).

The plan made exactly this class of mismatch a named decision twice — P12 pins `@types/express@^4` against `express@4`, and Phase 3 Deviation 1 pins `typescript@^5` to protect `moduleResolution: node` — but `@types/node` was installed at latest (26.x) with no decision recorded, while the production image is `node:20-alpine` and `engines` promises only `>=20`. Any API added between Node 20 and 26 (e.g. `fs.glob`, newer `util` helpers) typechecks cleanly, passes the whole suite on the host's Node 24, and passes CI's *test* job on Node 20 **only if a test exercises it** — and `src/index.ts` is the one file no test reaches (deliberately, and legitimately). CI's docker-build smoke check is `node --check`, syntax-only, so a Node-26-only call landing in `index.ts` would first fail at container startup in production. Pin `@types/node@^20` (matching the image) or move the image to `node:22-alpine` and pin types to match — the AWS SDK's January-2027 Node ≥22 deadline recorded in Phase 17's observations argues for the latter as the eventual resolution. One-line fix either way; the current suite passes with types pinned to the runtime because nothing currently uses post-20 APIs, which is exactly why now is the cheap moment to pin.

### Trivial

#### 2. `mapSesEvent` maps an empty-string `mail.messageId` to `''` where the legacy mapped it to `null`

**Where:** `src/event-mapper.ts:188` (`sesEvent.mail?.messageId ?? null`) vs `lib/event-mapper.js` (`sesEvent.mail && sesEvent.mail.messageId || null`).

`?? null` passes `''` through; the legacy `|| null` collapsed it to `null`. Downstream truthiness checks (`event.ses_message_id ?` in `src/sqs-poller.ts:240`, `?? ''` in `eventId`) treat the two identically, so the only observable difference is the stored `events.ses_message_id`-derived fields for a payload SES never emits (SES always sets `messageId`). Unrecorded in the deviation lists, which claim "logic preserved exactly" for this file — worth a line in the record, not a code change.

#### 3. A correlated `batch_message_id` is angle-stripped once, not twice

**Where:** `src/sqs-poller.ts:244-261` vs legacy `lib/sqs-poller.js` `processEvent`, which applied `stripAngleBrackets` to `row.batch_message_id` *and then again* unconditionally. `stripAngleBrackets` removes at most one leading `<` and one trailing `>` per call, so a stored `<<x>>` would produce `x` under the legacy and `<x>` now. Stored batch ids are always single-bracketed (`<uuid@domain>`, `src/routes/send-email.ts:117`), so the case is unreachable; noting it only because it is a divergence from "preserve the correlation logic" that no observation records.

#### 4. `suppressions_removed_total` counts delete *requests*, not removed rows

**Where:** `src/routes/suppression.ts:33-35`. `deps.db.deleteSuppression` returns the changed-row count (the `Db` interface was shaped for exactly this, per Phase 3's observations) and it is logged as `removed` — but the counter increments unconditionally on every valid-typed request, including deletes of addresses that were never suppressed. The metric name reads as "rows removed". Either `if (removed > 0)` the increment, or rename mentally to "removal requests" in the README's metric table. No consumer depends on it yet.

#### 5. The "does `createApp` need an error handler?" question was deferred three times and never explicitly closed

**Where:** plan Phase 11 observations ("Phase 13 or 16 should decide"), Phase 12 notes, Phase 13 notes ("Phase 16 should close this out explicitly"); `src/app.ts` installs none. The outcome — no handler — is almost certainly *correct*: the legacy app had none either, and design's "every HTTP response body stays the same" arguably pins it. But the consequence is inherited too: the one reachable throw path (`decodeURIComponent` on a malformed double-encoded email in `src/routes/suppression.ts:25`, behind auth) falls to Express's default handler, which returns an HTML 500 *including the stack trace* because the image sets no `NODE_ENV=production`. Pre-existing, internal-network-only, auth-gated — but the decision deserves one recorded sentence, and `ENV NODE_ENV=production` in the Dockerfile would be a free hardening.

#### 6. The contract-level D1 assertion protects the reporting half only; the release half is unit-layer-only

**Where:** `test/contract.test.ts:433-515`, `test/semaphore.test.ts`. My mutation removing `runExclusive`'s `try/finally` (leaking the slot on a callback throw) failed **only** the four semaphore unit tests — the contract suite stayed green, because the send route's inner `try/catch` (`src/routes/send-email.ts:207-215`) means nothing ever throws inside `runExclusive` on the production path, making the `finally` unobservable end-to-end. This is not a protection gap — the wedge requires both halves broken, and breaking the inner catch *is* caught at contract level (10 failures) — but `intent/d1-semaphore-release.json`'s framing ("the slot is released") is enforced at the contract level only indirectly, via the `sendConcurrency`-repeated follow-up sends. Informational; no action needed.

#### 7. HTTP metrics undercount client-aborted requests

**Where:** `src/middleware/observability.ts:98-115`. The counters record on `res.on('finish')`, which never fires when the client aborts mid-response (only `'close'` does); pino-http, by contrast, logs aborted requests. A shutdown-grace-severed or client-timed-out request appears in logs but not in `http_requests_total`. Standard trade-off, negligible at this service's volume; recording it so a future log/metric count discrepancy is not chased as a bug.

#### 8. `send_in_flight`/`send_queue_depth` `collect()` callbacks are last-writer-wins per registry

**Where:** `src/routes/send-email.ts:64-69`. Calling `createApp` twice against one registry silently rebinds the gauges to the second app's semaphore. Recorded in Phase 13's observations and harmless in both production (one app) and the tests (which deliberately reuse one app instance for the D1 assertions); repeated here only because it is the kind of latent constraint a future embedder would not expect.

---

## Design Compliance Checklist

| Design requirement | Status | Notes |
|---|---|---|
| §1 `tsc` only, CJS output, `target: ES2022`, `strict` + `noUncheckedIndexedAccess` | Correct | `tsconfig.json` / `tsconfig.build.json` verified; `rootDir: "src"` (P4) confirmed — no `dist/src/` |
| §1 `express@4` stays; typings match runtime | Correct | `@types/express@^4.17.25` (P12); `typescript@^5.9.3` (justified Phase 3 deviation — TS7 removed `moduleResolution: node`). But see finding 1 for `@types/node` |
| §1 "busboy ships its own types" | Incorrect in design, corrected in execution | Verified: `busboy@1.6.0` has no `types` field and no `.d.ts`; `@types/busboy@^1.5.4` added, recorded as Phase 8 Deviation 1 |
| §1 lockfile + npm scripts | Correct | `package-lock.json` present; all 7 scripts as specified |
| §2 DI seams — no module-scope side effects except `index.ts` | Correct | Every module is a factory; `src/index.ts` is the only file with side effects and contains wiring only (the `loadConfigOrExit` try/catch is the design-sanctioned exit path) |
| §2 graceful shutdown | Correct | `src/shutdown.ts`: order server→poller→timer→db verified, re-entrancy guard, per-step error tolerance; 10 s grace + `closeIdleConnections` is a recorded, sensible deviation |
| §3 pino: string `level`, ISO time, `service`/`version` base, redact, stdout-only | Correct | `src/logger.ts` matches the sketch; smoke evidence in Phase 16/18 observations |
| §3 field schema / `component` enum | Correct with recorded extension | `component: 'lifecycle'` is a deliberate ninth value, adopted in Phase 18.4 and documented in README; `events` is permitted-but-unused |
| §3 access logs exclude `/health` + `/metrics`; 4xx→warn, 5xx→error; `reqId` propagation | Correct | `src/middleware/observability.ts`; P5 (metrics still count both paths) implemented and tested |
| §4 27-metric catalog, exact names/types/labels, `ghost_ses_proxy_` prefix, unprefixed defaults | Correct | Independently re-counted against `src/metrics.ts`; `test/metrics.test.ts` pins the full list bidirectionally |
| §4 injected registry, never global | Correct | `createMetrics(register)`; a test asserts the global registry stays clean |
| §4.1 route label = Express template or `unmatched`, never raw path | Correct | `routeLabel()` verified; PII regression test walks every label value for `@` |
| §4.2 `error_type` allowlist | Correct | `SES_ERROR_TYPES` + `toSesErrorType` in `src/metrics.ts:34-49`, consumed by `src/ses-client.ts` |
| §4.6 / D5 TTL-cached stats serving `/health` + `db_rows` | Correct | `src/stats.ts`; `/health` shape byte-identical to `captured/http-health.json` |
| §5.1 D1 — release **and** report halves | Correct | `runExclusive` try/finally + inner catch; wire-contract change (partial→200) implemented and documented in README |
| §5.2 D2 — suppressions never expire | Correct | Compile-time exclusion + behavioral tests + negative metric-series assertion; mutation-verified |
| §5.3 D3 — deterministic event ids | Correct | Hash algorithm matches design verbatim; fixture hash independently re-derived; no-timestamp limitation recorded |
| §5.4 D4 — `firstString` everywhere + `limit` clamp `[1,1000]` | Correct | Includes the fixture's extra pins (`limit=abc`→300, empty-first-repeat→no filter); mutation-verified |
| §5.5 D7 — malformed payload discarded, counted, never a skip | Correct | Skip checked before `mapSesEvent`; recognized-empty → `malformed_payload`; mutation-verified; the `Map`-not-object `EVENT_MAP` closes the prototype-key hole |
| §6 config: `ConfigError` lists all problems, `LOG_LEVEL` validated, `DB_PATH` new | Correct | `src/config.ts`; positive-int rejection of `PORT`/`SEND_CONCURRENCY=0` is a justified recorded deviation (0 would deadlock the semaphore) |
| §7 multi-stage Dockerfile, root user, `/data`, HEALTHCHECK, CI test job, `node --check` | Correct | Dockerfile is design §7 verbatim; image rebuilt during this review; CI dependency check covers all nine runtime deps |
| §8 golden capture: gated, normalized, provenance, REJECTED.md | Correct | 45 captured files ↔ 45 MANIFEST entries with `anchoredBy` + `role`; REJECTED.md covers all five §8.2 rows plus gate-2/gate-3 rejections; inputs-raw/outputs-normalized rule is machine-readable |
| "What stays the same": HTTP bodies, schema, MIME bytes, mapping table, cursor format, root user, D6 | Correct | Diffed every ported file against `git show 36845e9:lib/*`; only findings 2–3 (unreachable byte nuances) are unrecorded; D6 pinned by `test/cleanup.test.ts:349` |
| Test Plan: coverage 90/90/90/85, exclusions only `index.ts`/`types.ts` | Correct | Actual: 100/100/100/100 (683/683 statements); re-run during this review |

## Test Coverage Assessment

| Feature | Tests | Notes |
|---|---|---|
| Wire contract (send/events/suppression/health bodies, MIME bytes, mapper, schema PRAGMAs) | `test/contract.test.ts` (67) | Fixture set enumerated from disk with coverage-completeness assertions; non-vacuity independently mutation-verified (4 of 5 mutations caught here) |
| D1 semaphore release + reporting | `test/semaphore.test.ts` (12), `test/routes/send-email.test.ts` (36), contract D1 block | Sync-throw shape (the real D1 path) covered; follow-up sends repeated `sendConcurrency` times; all-throw 500 shape covered |
| D2 retention | `test/cleanup.test.ts` (17), contract D2 block | Includes negative-series assertion and D6-stays-pinned |
| D3 dedupe | `test/db.test.ts`, `test/sqs-poller.test.ts` (55), contract D3 block | Fixture carries explicit timestamp per §5.3's known limitation |
| D4 query hardening | `test/routes/events.test.ts` (37), contract D4 blocks | `clampLimit` asserted directly because the 7-row seed cannot distinguish clamped bounds over HTTP — a genuine anti-vacuity catch from the Phase 15 mutation run |
| D7 malformed payloads | `test/event-mapper.test.ts` (61), `test/sqs-poller.test.ts`, contract D7 block | Both envelope shapes; contrast-with-skip cases assert the *other* counter is absent |
| Config validation | `test/config.test.ts` (28) | All-problems-in-one-error, positive-int, level validation |
| Logger / metrics catalog | `test/logger.test.ts` (13), `test/metrics.test.ts` (45) | Catalog pinned bidirectionally against a literal list |
| DB semantics | `test/db.test.ts` (18) | Dedupe per unique constraint; `INSERT OR IGNORE` swallowing NOT NULL pinned as discovered behavior |
| Observability | `test/middleware/observability.test.ts` (28) | Route-template label, `unmatched`, PII walk over every label value, access-log suppression |
| Auth | `test/middleware/auth.test.ts` (11) | All three 401 bodies; colon-bearing key; case-sensitivity pinned |
| SES client | `test/ses-client.test.ts` (24) | Full allowlist mapping, non-Error rejection reasons |
| Poller lifecycle | `test/sqs-poller.test.ts` | Backoff, stop(), timer-leak assertions via `vi.getTimerCount()` |
| Shutdown | `test/shutdown.test.ts` (10) | Ordering via recorded call log; re-entrancy; per-step error tolerance |
| Stats / health / metrics routes, mime, multipart, template-vars | respective `test/*.test.ts` | TTL semantics, exposition content-type byte-pinned, three multipart failure paths |
| `src/index.ts` | — (excluded by design) | Genuinely wiring-only; Phase 16/17 manual smoke runs recorded (container SIGTERM, `/health`, `/metrics`, ConfigError exit). Finding 1 notes the residual blind spot this exclusion creates for API-surface drift |

---

## Resolution (post-review, coordinator)

Applied immediately — the four findings whose remedy was unambiguous. Gate re-run after all four: typecheck clean, build emits flat `dist/`, **546/546 tests at 100% on all four axes**, `docker build` succeeds and the image reports `NODE_ENV=production`.

| # | Finding | Action |
|---|---|---|
| 1 | `@types/node@^26` vs Node 20 runtime | **Fixed** — pinned `@types/node@^20.19.43`, matching `node:20-alpine` and `engines: >=20`. Typecheck stays clean, confirming nothing currently depends on a post-20 API. Joins `typescript@^5` (Phase 3) and `@types/express@^4` (P12) as the third runtime-matching pin. *Whether to move the image to `node:22-alpine` instead is a separate scope decision — raised with the user, not taken here.* |
| 2 | `?? null` vs legacy `|| null` for an empty-string `mail.messageId` | **Fixed** — restored `\|\| null` (`src/event-mapper.ts:188`). The design's rule for this file is "logic preserved exactly", so restoring parity is more design-conforming than documenting the divergence. Unreachable with real SES input either way; no test pinned the divergent behavior. |
| 3 | Correlated `batch_message_id` angle-stripped once, not twice | **Fixed** — restored the legacy double strip (`src/sqs-poller.ts:245`). Same reasoning as finding 2; unreachable because stored ids are always single-bracketed. |
| 5 | Deferred error-handler decision + stack-trace leak | **Decision closed + hardened.** `createApp` installs **no** error handler — matching the legacy app and the design's "every HTTP response body and status code stays the same". The inherited consequence is fixed instead: `ENV NODE_ENV=production` in the Dockerfile's runtime stage suppresses Express's stack-trace-bearing HTML error page. Set in the runtime stage only — setting it in the builder would make `npm ci` skip the devDependencies `npm run build` needs. |

Raised for the user rather than actioned:

| # | Finding | Why it needs a decision |
|---|---|---|
| 1b | Move the base image to `node:22-alpine`? | Beyond the design, which specifies `node:20-alpine` in §7. The AWS SDK's January-2027 Node ≥22 deadline makes it inevitable, but it is a runtime change, not a review fix. |
| 4 | `suppressions_removed_total` counts requests, not rows | Changing it means changing a **passing test that deliberately pins the current semantics** (`test/routes/suppression.test.ts:140-157` asserts `bounces: 2` for one real removal plus one no-op). That makes it a metric-semantics decision, not a defect. |

No action — informational, as the reviewer stated:

- **6** — the release half of D1 is unit-layer-only by construction; the wedge cannot recur while either layer is green.
- **7** — `finish`-based metrics undercount client-aborted requests; recorded so a future log/metric discrepancy is not chased as a bug.
- **8** — the D1 gauges' `collect()` is last-writer-wins per registry; already recorded in Phase 13's observations, harmless for one app per registry.

---

## Verification performed by this review (not taken from the plan)

- Full gate re-run: `npm run typecheck && npm run build && npm run test:coverage` — clean, 546/546, 100% on all axes; `docker build` — succeeds.
- Legacy diff: every `src/` port compared against `git show 36845e9:lib/*.js` and `server.js` line by line.
- Independent mutations (each restored and the suite confirmed green afterward): D2 re-inclusion (8 failures), D4 `firstString` revert (4), D1 inner-catch rethrow (10), D1 `try/finally` removal (4, unit layer only — finding 6), D7 counter swap (9).
- D3 fixture hash re-derived from the raw algorithm and payload: matches.
- `busboy@1.6.0` types absence re-verified against the installed package (design §1's claim was wrong; execution's correction was right).
- Version pins re-verified against installed `node_modules`: `typescript` 5.9.3, `@types/express` 4.17.25, `@types/node` 26.1.2 (finding 1).
