# Code Instrumentation — Pre-Execution Critique

> **Documents reviewed:** design.md, plan.md
> **Reviewer:** Claude Opus 5 (1M context)
> **Date:** 2026-07-27

---

## Summary

The plan rewrites 1,010 lines of CommonJS into strict TypeScript with pino, prom-client, and a 90%-gated Vitest suite, fixing four defects, protected by golden fixtures captured before any `src/` file exists. The design's factual claims about the existing code are **accurate** — every file/line reference I checked (`send-email.js:204`, `db.js:102`, `sqs-poller.js:54`, `events-api.js:17`/`:23`, `config.js:26`, the 5 indexes, the 4 tables, the route table) holds, and I empirically confirmed the D4 `TypeError`, the `req.baseUrl + req.route.path` template shape, the `aws-sdk-client-mock` prototype interception the Phase 0 harness depends on, `require('../package.json')` working under Vitest with `pool: 'forks'`, and `better-sqlite3@11.10.0` loading on the host's Node v24.13.1. The structural weakness is concentrated in the golden-fixture contract loop: **three of the five Critical findings are assertions in Phase 14 that cannot pass as written**, because the capture mechanism and the assertion mechanism were specified independently.

---

## Findings

### Critical

#### 1. The D1 intent fixture asserts an outcome the specified implementation cannot produce

**Where:** Plan Phase 12.1, 12.3; Phase 1.4 (`intent/d1-semaphore-release.json`); Phase 14.2; design §5.1 and §8.2.

**What the documents say:** Phase 1.4 pins `intent/d1-semaphore-release.json` as "a throw inside the per-recipient path releases its slot; **the batch completes as `partial` (200, `{id, message:'Queued. Thank you.'}`)**". Phase 12.3's regression test repeats it. Phase 12.1 specifies the fix as: everything that can throw "must sit **inside** the callback" of `semaphore.runExclusive(...)`, and separately "Preserve the response contract" from `lib/send-email.js`.

**What the code actually does:** In `lib/send-email.js:238-257` only the `sendRawEmail(...)` promise has a `.catch` that does `failed++; errors.push(...)`. A throw from `substituteVars`, the `List-Unsubscribe` stripping, or `buildRawMime` (lines 205-236) escapes that `.catch` entirely, rejects the mapped promise, rejects `Promise.all` at line 261, and lands in the outer `.catch` at line 282 → **`500 {message: 'Internal server error: <msg>'}`**. The plan's `runExclusive` (`try { return await fn(); } finally { this.release(); }`) *re-throws* after releasing. So the specified implementation fixes the slot leak but still produces a 500 `Internal server error`, not a 200 `partial`. Phase 12.3 and Phase 14.2 will both fail.

**Fix:** Phase 12.1 must state explicitly that the per-recipient callback body is wrapped in its own `try/catch` that converts *any* throw (not just a `sendRawEmail` rejection) into `failed++` + `errors.push({recipient, error})`. And note that this **is a wire-contract change** — a class of request that returns 500 `Internal server error` today returns 200 `Queued. Thank you.` (or 500 `Failed to send to all recipients`) after the rewrite. Design §5.1 and the "Interaction with Existing Code" behavior-change column should record it, since design currently claims "a rewrite of form, not of behavior". Alternatively, weaken the intent fixture to assert only slot release + a working subsequent send — but the `partial` claim as written is the more useful contract and should be made real, not deleted.

---

#### 2. `paging.next` cannot match between capture and contract test — and the design forbids normalizing it

**Where:** Plan Phase 0.3 (normalizers), 0.5 step 4, 14.1; Design Decision P7; design §8.4.

**What the documents say:** Design §8.4: "`paging.next` is **not** normalized: its base64 cursor derives deterministically from seeded row data, so it is a genuine contract assertion." P7 goes further, introducing fixed `evt-NNNN` seed ids specifically so the cursor is reproducible.

**What the code actually does:** `lib/events-api.js:128-129` builds the whole URL, not just the cursor:

```js
var proto = req.headers['x-forwarded-proto'] || 'http';
paging.next = proto + '://' + req.headers.host + '/v3/' + domain + '/events/' + nextCursor;
```

The capture (Phase 0.5) drives the app over a real socket on port 3003 inside the container, so `Host: localhost:3003`. Phase 14.1 drives `createApp(makeDeps())` through **supertest**, which binds an ephemeral port and sends `Host: 127.0.0.1:<random>`. The captured and reproduced `paging.next` strings differ in the host component on every run. The cursor *suffix* is reproducible; the string the fixture pins is not.

**Fix:** Either (a) have Phase 14.1's supertest calls set `.set('Host', 'localhost:3003')` so the full URL reproduces — this preserves the assertion at full strength and is one line; or (b) add a host normalizer and amend design §8.4 to say only the cursor suffix is asserted. Option (a) is better and should be written into Phase 14.1 as an explicit task, not left for the agent to discover as a red test.

---

#### 3. Phase 14.1's MIME assertion is specified against a function that never produced the fixtures

**Where:** Plan Phase 0.4, 14.1; design Test Plan → "Backward-compatibility tests".

**What the documents say:** Phase 14.1: "`buildRawMime` output matches every `mime-*.txt` variant under the normalizers." Design's Test Plan says the same.

**What the code actually does:** Phase 0.4 states plainly that "`buildRawMime` is **not exported** by `lib/send-email.js`, so MIME output is captured through the SES mock above rather than by calling the function directly. This has the side benefit of exercising multipart parsing and template substitution end-to-end." Confirmed — `lib/send-email.js:288` exports only the handler. So `captured/mime-*.txt` is the output of the *full pipeline*: busboy parse → `substituteVars(html, vars)` → `<%tag_unsubscribe_email%>` stripping → `h:*` header collection → `X-Ghost-Email-Id` injection → `buildRawMime`. Calling the new `buildRawMime(opts)` directly in Phase 14 requires the test author to reconstruct, by hand, the exact `MimeOptions` the send path computed for each of the ~5 captured variants — which is guesswork that will silently converge on "whatever makes it pass", destroying the assertion's value.

**Fix:** Rewrite Phase 14.1's MIME task to replay the **same HTTP requests** the capture made, through supertest against `createApp(makeDeps())` with `aws-sdk-client-mock` intercepting `SendRawEmailCommand`, and compare `input.RawMessage.Data.toString('utf8')` against `captured/mime-*.txt` under the normalizers. This also requires Phase 14.1 to state that the contract test's SES mock must return the same fixed `MessageId` the capture used, and that the request bodies used by the capture must be recoverable — see finding 8.

---

#### 4. `setInterval(runCleanup, 86_400_000)` passes no arguments to a three-argument function

**Where:** Plan Phase 15.1; Phase 5.1.

**What the documents say:** Phase 5.1 specifies `runCleanup(db: Db, logger: Logger, metrics: Metrics): void`. Phase 15.1 wires it verbatim as `setInterval(runCleanup, 86_400_000)`.

**Why it matters:** `setInterval` invokes `runCleanup(undefined, undefined, undefined)`. Phase 5.1 also specifies `runCleanup` is wrapped in try/catch recording `db_cleanup_runs_total{outcome:"error"}` — so it will not even crash loudly; retention just silently stops. And `src/index.ts` is **excluded from coverage** (Phase 2.5), so no test can catch it. The only thing standing between this and production is Phase 15.3's manual smoke test, which does not wait 24 hours.

**Fix:** Phase 15.1 should read `setInterval(() => runCleanup(db, logger, metrics), 86_400_000)` and capture the handle so the shutdown path can `clearInterval` it (which 15.1 already requires). This is a one-token fix but it is exactly the class of bug the coverage exclusion is blind to — see finding 11.

---

#### 5. The Phase 16 CI smoke check "dist/index.js exists and loads" will fail the job

**Where:** Plan Phase 16.4.

**What the documents say:** "the syntax check no longer has `server.js`/`lib/*.js` to check — replace it with a check that `dist/index.js` exists and **loads**".

**What the code will do:** Per Phase 15.1, `src/index.ts` is the only file with side effects: it calls `loadConfig()` in a try/catch that logs and `process.exit(1)`, then `app.listen()`, then starts the SQS poller. The existing CI job (`.github/workflows/ci.yml`) runs the smoke checks with `docker run --rm ... ghost-ses-proxy:ci` and passes **no environment variables** — the current check works only because `node --check` never executes the file. Requiring `dist/index.js` will hit the missing-`AWS_ACCESS_KEY_ID`/`PROXY_API_KEY`/etc. path and exit 1, turning `docker-build` red on every PR.

**Fix:** Use `node --check dist/index.js` (syntax-only, matching what the current check actually proves), or load a side-effect-free module such as `dist/app.js`. If a genuine "it boots" check is wanted, pass placeholder env vars plus `DB_PATH=/tmp/ci.db` and assert `/health` responds — but that is a different, heavier check and should be stated as such.

---

### Important

#### 6. `createApp(makeDeps())` does not typecheck — `makeDeps` never builds `stats`

**Where:** Plan Phase 8.5 (`makeDeps`), 10.3 (`createApp`), 10.4, 10.5, 14.1.

Phase 10.3 specifies `createApp(deps: Deps & { stats: Stats })`. Phase 8.5 specifies `makeDeps(overrides?): Deps & { logs(); register }` built from `config`, `logger`, `metrics`, `db`, and a mocked `ses` — no `stats`. Phases 10.4, 10.5 and 14.1 all say "supertest against `createApp(makeDeps())`", which is a compile error under `strict`. Add `stats: createStats(db)` (and the `attachDbGauges` call, since Phase 10.5 asserts `db_rows` appears in the exposition output) to Phase 8.5's helper spec — noting `createStats` lands in Phase 5, before Phase 8, so the ordering is fine.

---

#### 7. The `/health` contract assertion has an unstated seeding precondition

**Where:** Plan Phase 0.5 step 2, 14.1.

The capture records `/health` **after** seeding ~7 events and 2 suppressions but **before** any send scenario runs, so `captured/http-health.json` is `{message_map: 0, recipient_emails: 0, events: 7, suppressions: 2}`. Phase 14.1 says only "health response bodies and status codes match `http-*.json`" and separately that "the events-API assertions must seed from `events-seed.json`". Nothing tells the contract test that the health assertion needs the *same* database state — the exact seed, and no `message_map`/`recipient_emails` rows. Without that, the assertion either fails or gets quietly rewritten to a shape-only check. Make the precondition explicit in 14.1: the health assertion runs against a database seeded from `events-seed.json` plus the two suppression rows and nothing else. The suppression seed rows should also be committed as a fixture rather than living only inside `capture-golden.cjs`.

---

#### 8. Two hand-maintained copies of the SES fixtures, and two of the normalizers, with no sync mechanism

**Where:** Plan Phase 0.5 (last bullet), 6.3, 14.1.

Phase 0.5 embeds SES event payloads inside `scripts/capture-golden.cjs` to produce `captured/event-map-*.json`. Phase 6.3 hand-writes `test/helpers/fixtures.ts` and says only "Keep these consistent with the fixtures used in `scripts/capture-golden.cjs` task 0.5". Phase 14.1 then compares the new `mapSesEvent` over the *TypeScript* fixtures against JSON produced from the *CommonJS* fixtures. A one-character divergence — a different `mail.timestamp`, a different `diagnosticCode` — makes the contract test red for a reason that has nothing to do with the rewrite, and the natural repair is to edit the fixture until it passes, which silently voids the assertion. The same hazard applies to the normalizers; Phase 14.1 names it ("a drifting normalizer is a silently passing contract test") but offers no mechanism.

**Fix:** Have `capture-golden.cjs` write the *inputs* it used to `test/golden/captured/ses-event-inputs.json` (and the send-scenario request field maps for finding 3), and have `test/helpers/fixtures.ts` import that JSON rather than restate it. For the normalizers, put the single implementation in `scripts/normalize.cjs` and have `test/helpers/normalize.ts` `require` it — one file, no drift possible.

---

#### 9. "Logic preserved exactly" and strict TypeScript conflict in `event-mapper.ts`, and the plan's guidance points at the wrong hazard

**Where:** Plan Phase 6.4; design "what stays the same".

Phase 6.4 says logic is preserved "exactly" and warns that "`noUncheckedIndexedAccess` will force explicit guards on every array index — add the guard, do not add a non-null assertion". But the actual strictness collision in `lib/event-mapper.js` is not array indexing, it is unguarded property access on optional blocks:

```js
if (eventType === 'Delivery') { return sesEvent.delivery.recipients || []; }
if (eventType === 'Bounce')   { return (sesEvent.bounce.bouncedRecipients || []).map(...); }
if (eventType === 'Complaint'){ return (sesEvent.complaint.complainedRecipients || []).map(...); }
```

`mapSesEvent` guards `sesEvent.bounce &&` for `bounceType` (line 79) but `getRecipients` (lines 18-26) does not. Today, a `Delivery` payload with no `delivery` block **throws a TypeError**, which rejects the `chain` in `lib/sqs-poller.js:120-124`, rejects `pollOnce`, and — critically — reaches `startPolling`'s `.catch` **without ever calling `deleteMessage`**. The message returns to the queue and poisons the poller forever. Adding `?.` (which strict TS will push the agent toward) changes this to "returns `[]`, message deleted" — a silent, unreviewed behavior change to a poison-message path.

Make it a stated decision rather than an accident: either preserve the throw (typed guard that rethrows) or adopt `[]` and record it as an intentional divergence with a `sqs_parse_errors_total`-style counter. Phase 13.1's list of "delete the message in all three cases" should then be four cases, or the malformed-payload path should be named.

---

#### 10. Phase 0 is materially larger than any other phase and is the riskiest to run first

**Where:** Plan Phase 0, tasks 0.2–0.6.

Task 0.5 alone specifies ~20 capture scenarios across five artifact families, written into a single `.cjs` file, driven over real HTTP with `fetch`+`FormData` against a real Express listener inside a Docker image, with two AWS clients mocked and a `setTimeout`-gated SQS long-poll — and with **no test runner, no types, and no fixtures to fall back on**, since that is precisely what the phase produces. Every debugging cycle costs a `docker build` + `docker run`. The plan's own preamble says each phase "is scoped so one phase fits comfortably in a single loop iteration"; this one will not, and it is the phase where context exhaustion is most damaging because everything downstream depends on its output.

Split it: **0a** — image, harness scaffold, mocks, `process.exit(0)`, plus the three easy artifact families that need no HTTP (`event-map-*.json`, `template-vars.json`, `schema.json`) and `http-health.json`; **0b** — the events, suppression, and send HTTP scenarios and `mime-*.txt`. Each half has a runnable gate.

---

#### 11. `src/index.ts` is excluded from coverage but the plan puts real logic in it

**Where:** Plan Phase 2.5 (`exclude: ['src/index.ts', 'src/types.ts']`), 15.1; design Test Plan ("The exclusion stays honest only if no logic lands there; the plan must keep it thin").

Phase 15.1 puts in `index.ts`: the `ConfigError` catch + `process.exit(1)`, the cleanup `setInterval`, and the entire graceful-shutdown sequence (`server.close()` → `poller.stop()` → `clearInterval` → `db.close()` → exit) — which is new, untested-by-construction behavior that the design explicitly calls out as a new feature. Finding 4 is a live demonstration of what that blind spot costs. The plan's only verification is Phase 15.3's manual `SIGTERM` check.

Extract the two testable pieces — `createShutdownHandler({ server, poller, cleanupTimer, db, logger })` and the cleanup scheduler — into `src/shutdown.ts` with a unit test, leaving `index.ts` as literally construction + wiring. That also lets Phase 15 keep its coverage gate meaningful.

---

#### 12. `events-seed.json` ownership is ambiguous, and `Dockerfile.capture` cannot see it

**Where:** Plan Phase 0.5 step 1; Phase 0.2; Design Decision P7.

Step 1 says "Write `events-seed.json`: ~7 event rows with fixed `id`s … Seed them via `require('../lib/db.js').db`" and lists the file under `test/golden/captured/`. But `scripts/Dockerfile.capture` (task 0.2) COPYs only `package.json`, `server.js`, `lib/`, and `scripts/` — `test/` is never copied. If the agent hand-authors `events-seed.json` on the host, the harness cannot read it (it is only reachable through the `-v .../test/golden/captured` bind mount from task 0.6, which is not stated as an input path). State explicitly which side owns the file: cleanest is the harness generating it from an inline definition and writing it into the mounted `captured/` directory as an artifact, exactly like the other captures.

---

#### 13. `intent/*.json` cannot both "parse as JSON" and "carry a header"

**Where:** Plan Phase 1.4, 1.5; design §8.1 gate 4 / §8.2.

Phase 1.4: "Each carries a header naming its defect and the design section specifying the fix." Phase 1.5 gate: "Every file under `test/golden/intent/` parses as JSON **and** carries its defect header." JSON has no comment syntax, so a prepended header breaks `JSON.parse`. Specify the shape — e.g. a top-level `"_meta": { "defect": "D2", "designSection": "§5.2" }` key — so the gate is checkable and the contract test knows to ignore it.

---

#### 14. The D3 hash does not dedupe events whose payload carries no timestamp

**Where:** Plan Phase 13.1; design §5.3.

The hash input is `[ses_message_id, event_type, recipient, timestamp].join(' ')`. `lib/event-mapper.js:52` ends its fallback chain at `Date.now() / 1000` when neither the per-event block nor `mail.timestamp` supplies one. For such an event, an SQS redelivery computes a *different* timestamp and therefore a different id — the redelivery duplicates exactly as it does today. The design presents D3 as fixed without qualification. Record the limitation (design §5.3 and Phase 13.1's accepted-trade-off note), and make sure `intent/d3-redelivery-dedupe.json` and Phase 13.2's regression test use a fixture with an explicit timestamp so the test is not accidentally asserting the un-fixed path.

---

#### 15. `npm install -D @types/express` resolves to v5 types against `express@4`

**Where:** Plan Phase 2.1; design §1 (which pins "Stay on `express@4`" as an explicit decision).

`package.json` pins `express: ^4.21.2`, but `@types/express`'s `latest` tag is the 5.x line. Installing it unpinned gives Express 5 typings over an Express 4 runtime — most visibly around `req.query` and handler return types, which is precisely the surface Phase 11.3's `firstString` work touches. Pin `@types/express@^4` (and `@types/supertest` is fine unpinned). Worth stating in 2.1 because a mismatched type error at Phase 9/10 is an expensive thing for the agent to diagnose.

---

#### 16. Two metric label values are undefined for real, reachable states

**Where:** Plan Phase 13.1; design §4.3.

- `events_stored_total{event_type, severity}`: `mapSesEvent` returns `severity: null` for `delivered`/`opened`/`clicked`/`complained` (`EVENT_MAP`, lines 5-8). Design §4.3 anticipates the label value `none`; Phase 13.1 just names the metric. Say explicitly that `null` maps to `"none"`, or prom-client will emit the string `"null"` and the design's stated ~7-combination bound plus the §4.7 bounce/complaint-rate expressions will not line up.
- `event_correlation_total{result}`: `lib/sqs-poller.js:42` only performs the `lookupRecipientEmail` when `normalized.ses_message_id` is truthy. There is no lookup at all when it is absent, so neither `matched` nor `unmatched` is the honest answer. Define the third case (either count it as `unmatched`, or add `result="no_message_id"`), otherwise the §4.7 correlation-decay ratio is computed over an inconsistent denominator.

---

### Suggestions

#### 17. Phase 11.3 should say how `begin`, `end`, `limit`, and `pageToken` get typed

`firstString` is specified for `event` and `tags` only, but under `strict` every `req.query.*` access is `string | string[] | ParsedQs | ParsedQs[] | undefined`, so `parseFloat(req.query.begin)` and `parseInt(req.query.limit, 10)` are also compile errors. The agent will improvise — probably with `as string` casts, which is a different behavior from `firstString` and inconsistent across the file. (For the record, current behavior on a repeated `?limit=5&limit=9` is `parseInt("5,9")` → `5`, and `?begin=1&begin=2` → `parseFloat("1,2")` → `1`; `firstString` happens to match both, so it is the right choice — just say so.)

#### 18. The multipart-failure 500 has no `send_batches_total` outcome

`lib/send-email.js:282-285`'s outer catch returns 500 `Internal server error` for a busboy/parse failure. Design §4.2's outcome set is `success|partial|failure|rejected`, and Phase 12.1 maps `rejected` only to the two 400 validation paths. A malformed request storm would therefore be invisible to the §4.7 "Newsletter failed" alert. Consider `outcome="error"` for this path, or state that it is deliberately covered by `http_requests_total{status_code="500"}` alone.

#### 19. `scripts/Dockerfile.capture` installs without a lockfile, weakening the §8.5 reproducibility claim

`RUN npm install --omit=dev && npm install --no-save aws-sdk-client-mock` resolves fresh semver ranges at build time. Design §8.5 claims `git checkout <sha> && <rebuild>` regenerates the fixtures — but a future `busboy` or `@aws-sdk/*` release could change the captured bytes. Since the lockfile only arrives in Phase 2, either accept and note the caveat in `MANIFEST.json`, or pin exact versions in `Dockerfile.capture`.

#### 20. Extend the CI dependency-resolution smoke check to the new runtime deps

Phase 16.4 keeps the existing `require('express'); require('better-sqlite3'); …` check and correctly notes `uuid` is still used (`lib/send-email.js:174` → `src/routes/send-email.ts`). Add `pino`, `pino-http`, and `prom-client` — they are the three new runtime dependencies and the ones most likely to be lost by a `npm prune --omit=dev` misconfiguration in the new multi-stage build.

---

## Verified — not findings

Recorded so these are not re-litigated during execution. I checked each against the real code or by running it:

- **Design §8.3 / P1 / P2 (the capture harness's load-bearing constraints) are correct.** `mockClient(SESClient)` and `mockClient(SQSClient)` installed before construction do intercept subsequently-constructed clients, independently of each other, and a `callsFake` returning a `setTimeout`-backed promise correctly idles the poller (measured: 301 ms for a 300 ms stub).
- **P4 / `getVersion()` works under Vitest.** `require('../package.json')` inside a `.ts` file resolves correctly under `pool: 'forks'` (returned `1.0.0`); `__dirname` is defined too. The `rootDir: "src"` rationale stands on its own.
- **D4 is real and reproduces exactly as described.** `?event=a&event=b` yields `["a","b"]` and `.split` throws `TypeError`.
- **The route-template label works as specified.** `req.baseUrl + req.route.path` for `app.get('/v3/:domain/events')` yields `/v3/:domain/events` — no PII, bounded cardinality.
- **`better-sqlite3@^11.0.0` installs and loads on the host's Node v24.13.1** despite the container being pinned to `node:20-alpine`. Phase 2.2's guard is worth keeping but will pass.
- **Every code citation in design §"Current State" and the D1–D6 table is accurate**, including the 5 `CREATE INDEX` statements, the 4 tables, `LOG_LEVEL` gating exactly one statement, and the four unindexed `COUNT(*)` scans in `/health`.
- **Phase dependency ordering is sound.** Every module is built after its collaborators (config → logger/metrics → db → cleanup/stats → pure ports → semaphore/mime/multipart → ses/auth/deps-helper → observability → app → routes → poller → contract → index → docker/CI → docs), and Phase 16's deferral of the legacy deletion (P6) correctly avoids a red `docker-build` at a phase boundary.
