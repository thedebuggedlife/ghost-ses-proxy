# Code Instrumentation — Execution Plan

> **Design document:** [design.md](./design.md)
> **Critique:** [plan-critique.md](./plan-critique.md)
> **Status:** In progress — Phase 3 complete
> **Current phase:** Phase 4

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

*Baseline (Phase 3 onward):* ```npm run typecheck && npm run build && npm run test:coverage```

Phases 0–2 pre-date the TypeScript toolchain and state their own gates inline.

Phases that add or modify integration/E2E tests must also run them. Include any prerequisites (deployment, environment setup) as tasks before the gate, and add the integration test run command to the gate itself. The gate command may differ between phases — it must cover all tests that validate the phase's work.

A phase is **not complete** until the gate succeeds and **all** tests written or modified in that phase have been executed. Fix failures before marking the phase done.

**Coverage gate discipline.** `test:coverage` enforces 90/90/90/85 (lines/statements/functions/branches). Every phase pairs new `src/` code with its tests, so the thresholds should hold at every phase boundary. If coverage fails, **write the missing tests** — never lower a threshold, never add a `src/` file to the coverage `exclude` list, and never skip or delete a failing test. The only permitted exclusions are `src/index.ts` (construction and wiring only, per design) and `src/types.ts` (emits no runtime code).

---

## Summary

Rewrites `ghost-ses-proxy` from 1,010 lines of untyped CommonJS into a strict-TypeScript service with pino structured logging, a `prom-client` metrics catalog, and a Vitest suite gated at 90% coverage — fixing five defects (D1 semaphore leak, D2 suppression expiry, D3 duplicate events, D4 query-param 500, D7 malformed-payload poison message) along the way. The Ghost-facing wire contract is unchanged apart from the D1 response-shape change recorded in design §5.1, and is protected by golden fixtures captured from the current implementation **before** any TypeScript is written.

## Design Decisions

Decisions made during planning that are not in `design.md`, or that refine it. P1–P7 predate the critique; P8–P13 come from resolving it.

| # | Decision | Rationale |
|---|---|---|
| P1 | The capture harness is `scripts/capture-golden.cjs` (CommonJS), driven by `scripts/Dockerfile.capture`. | Backfilled into design §8.3. An `.mjs` harness resolves `@aws-sdk/client-ses`'s ESM build while `lib/ses-client.js` requires the CJS build — different class objects, so `mockClient` would silently fail to intercept and the capture would attempt real SES calls. |
| P2 | The capture's `ReceiveMessageCommand` mock resolves on a `setTimeout`, not immediately. | Backfilled into design §8.3. `lib/sqs-poller.js`'s `loop()` recurses from a `.then()`; a synchronously-resolving mock produces unbounded microtask recursion that starves the event loop, so the harness's own HTTP requests would never be answered. |
| P3 | `createDb(path, logger, metrics)` takes a third parameter, extending design §2's `createDb(path, logger)`. | Design §4.5 specifies `ghost_ses_proxy_db_errors_total{operation}`; the only place that can observe a failing statement is inside `db.ts`. |
| P4 | `tsconfig.build.json` sets `rootDir: "src"` explicitly, and `getVersion()` reads `package.json` through an untyped `require`, not a typed `import` with `resolveJsonModule`. | A typed JSON import widens the inferred `rootDir` to the repo root, which silently relocates the build output to `dist/src/index.js` and breaks the design's `CMD ["node", "dist/index.js"]`. |
| P5 | HTTP **metrics** count every request including `/health` and `/metrics`; only **access logging** suppresses them. | Design §3 excludes both paths from `autoLogging` (a Loki volume concern) but says nothing about metrics. Both are fixed-cardinality route templates, so counting them is free and makes scrape/healthcheck traffic visible. |
| P6 | The legacy `server.js` and `lib/*.js` are deleted in Phase 17 together with the Dockerfile/CI cutover, not earlier. | The Dockerfile `COPY server.js` / `COPY lib/` and the CI smoke check both reference them. Deleting them in an earlier phase would leave `docker-build` red at a phase boundary. |
| P7 | Event rows used for the events-API capture are seeded from a harness-generated fixture (`test/golden/captured/events-seed.json`) with fixed, non-UUID `id` values. | Design §8.4 normalizes `events.id` away but keeps `paging.next` as a genuine contract assertion — and that cursor embeds an `id`. Seeding fixed ids makes the cursor reproducible without capturing any implementation-generated id. Poller-generated ids remain a rejected capture candidate (D3), recorded in `REJECTED.md`. |
| P8 | The contract test sets `Host: localhost:3003` on every supertest request. | `lib/events-api.js:129` builds `paging.next` from `req.headers.host`. The capture runs on a real socket (`localhost:3003`); supertest binds an ephemeral port. Without a pinned Host the captured URL can never reproduce — and design §8.4 forbids normalizing `paging.next`. |
| P9 | The capture harness writes the **inputs** it used (`ses-event-inputs.json`, `send-scenarios.json`, `events-seed.json`, `suppressions-seed.json`) as committed artifacts, and the normalizers live in one file (`scripts/normalize.cjs`) required by both the harness and the test helper. | Two hand-maintained copies of a fixture or a normalizer drift, and the natural repair — editing the fixture until the test passes — silently voids the contract assertion. |
| P10 | `severity: null` maps to the label value `"none"`; `event_correlation_total` counts an event with no `ses_message_id` as `result="unmatched"`; `events_skipped_total` collapses unrecognized SES types to `other`. | Design §4.3 enumerates the `severity` combinations as `delivered/none`, `failed/permanent`, … and pins `result ∈ matched\|unmatched`, so both choices stay inside the design's stated label sets. The `other` collapse applies §4.2's cardinality discipline to a label fed by untrusted third-party JSON. |
| P11 | The 500 returned when multipart parsing fails is **not** a `send_batches_total` outcome; it is covered by `http_requests_total{status_code="500"}`. | Design §4.2 pins the outcome set to `success\|partial\|failure\|rejected`. A parse failure is a malformed client request, not a newsletter outcome, and adding a fifth value would change the design's enum and the §4.7 alert denominators. |
| P12 | `@types/express` is pinned to `^4`. | `@types/express@latest` is the 5.x line (verified: 5.0.6) while design §1 pins `express@4` as an explicit decision. Unpinned typings would describe Express 5 semantics over an Express 4 runtime, most visibly around `req.query` — exactly the surface the D4 fix touches. |
| P13 | The cleanup scheduler lives in `src/cleanup.ts` (`scheduleCleanup`) and the shutdown sequence in `src/shutdown.ts`, leaving `src/index.ts` as construction and wiring only. | Design's Test Plan says the `index.ts` coverage exclusion "stays honest only if no logic lands there". Graceful shutdown is new behavior and the cleanup scheduler is a closure that is trivially easy to get wrong; neither should sit in the one file no test can reach. |

---

## Phase 0: Capture harness and non-HTTP fixtures

**Goal:** The containerised capture harness runs end to end and records the artifacts that need no HTTP request — pure-function output, the database schema, and the seed data every later fixture depends on.

**Hard ordering constraint (design §8):** no file under `src/` may be created until Phase 2 has landed. Phases 0–2 are the entire safety net for a rewrite that deletes the implementation being captured.

### Tasks

- [x] **0.1** Confirm the runtime assumptions this phase depends on, and record the results in Observations
  - Run `docker info --format '{{.ServerVersion}}'` — the capture must run in a container because `lib/db.js` hardcodes `/data/ses-proxy.db`, which macOS will not provide.
  - Run `git rev-parse HEAD` and record the SHA — it is the provenance stamp written into `MANIFEST.json` in Phase 2.

- [x] **0.2** Create the capture image definition
  - File: `scripts/Dockerfile.capture`
  - Builds `better-sqlite3` for Alpine (the host's darwin-arm64 binding cannot be reused) and installs the mock library without touching `package.json`:
    ```dockerfile
    FROM node:20-alpine
    RUN apk add --no-cache python3 make g++
    WORKDIR /app
    COPY package.json ./
    RUN npm install --omit=dev && npm install --no-save aws-sdk-client-mock
    COPY server.js ./
    COPY lib/ lib/
    COPY scripts/ scripts/
    RUN mkdir -p /app/test/golden/captured /data
    CMD ["node", "scripts/capture-golden.cjs"]
    ```
  - `--no-save` keeps `aws-sdk-client-mock` out of `package.json` at this stage; Phase 3 adds it as a real devDependency for the test suite.
  - Note that `test/` is **never** copied into the image. Everything under `test/golden/captured/` is produced by the harness and reaches the host through the bind mount in task 0.6 — no fixture may be hand-authored on the host and read by the harness.

- [x] **0.3** Write the shared normalizers
  - File: `scripts/normalize.cjs` (design §8.4)
  - A single implementation, `require`d by the harness now and by `test/helpers/normalize.ts` in Phase 15 (Design Decision P9) — two copies would drift, and a drifting normalizer is a silently passing contract test.
    ```js
    const normalize = (s) => s
      .replace(/----=_Part_[0-9a-f]{32}/g, '----=_Part_<BOUNDARY>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<BATCH_UUID>')
      .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<TIMESTAMP>');
    const normalizeJson = (v) => JSON.parse(normalize(JSON.stringify(v)));
    module.exports = { normalize, normalizeJson };
    ```
  - The `<EVENT_ID>` normalizer from §8.4 is deliberately **not** implemented: per Design Decision P7 every event row in this capture is seeded with a fixed `evt-NNNN` id, so no implementation-generated id is ever recorded. Poller-generated ids are a rejected candidate, not a normalized one.

- [x] **0.4** Write the harness scaffold — env, mocks, and app import
  - File: `scripts/capture-golden.cjs` (**CommonJS — Design Decision P1; do not use `.mjs`**)
  - Set every required env var **before** requiring anything, because `lib/config.js` calls `process.exit(1)` at import:
    ```js
    Object.assign(process.env, {
      AWS_ACCESS_KEY_ID: 'AKIAFAKE', AWS_SECRET_ACCESS_KEY: 'fake',
      AWS_REGION: 'us-east-1', SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/fake',
      PROXY_API_KEY: 'test-key', MAILGUN_DOMAIN: 'example.com',
      SES_CONFIGURATION_SET: 'ghost-ses-proxy', PORT: '3003', SEND_CONCURRENCY: '10',
    });
    ```
  - Install the AWS mocks next. `mockClient` stubs `Client.prototype.send`, so it intercepts the clients `lib/ses-client.js` and `lib/sqs-poller.js` construct at import time.
    ```js
    const { mockClient } = require('aws-sdk-client-mock');
    const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
    const { SQSClient, ReceiveMessageCommand } = require('@aws-sdk/client-sqs');

    const SES_MESSAGE_ID = '0100000000000000-11111111-2222-3333-4444-555555555555-000000';
    const capturedMime = [];
    let sesBehaviour = 'ok';                       // flipped per scenario in Phase 1
    mockClient(SESClient).on(SendRawEmailCommand).callsFake((input) => {
      capturedMime.push(input.RawMessage.Data.toString('utf8'));
      if (sesBehaviour === 'fail') return Promise.reject(new Error('SES unavailable'));
      return Promise.resolve({ MessageId: SES_MESSAGE_ID });
    });

    // MUST resolve on a macrotask — Design Decision P2.
    mockClient(SQSClient).on(ReceiveMessageCommand)
      .callsFake(() => new Promise((r) => setTimeout(() => r({}), 20000)));
    ```
  - Only after the mocks are installed: `require('../server.js')`, which calls `app.listen(3003)`. Requiring the real entrypoint (rather than re-wiring routes in the harness) is deliberate — it removes any chance of harness/`server.js` drift.
  - End the script with an explicit `process.exit(0)` — the express listener and the poller timer both keep the loop alive otherwise.

- [x] **0.5** Generate and capture the seed data
  - File: `scripts/capture-golden.cjs`; artifacts `test/golden/captured/events-seed.json` and `test/golden/captured/suppressions-seed.json`
  - Define the seed rows **inline in the harness** and write them out as artifacts (Design Decision P7 and finding 12 — the harness owns them; nothing is hand-authored on the host).
  - `events-seed.json`: ~7 rows with fixed `id`s (`evt-0001`…), fixed numeric `timestamp`s, a mix of `event_type` (`delivered`, `opened`, `failed`), `severity` (`null`, `permanent`, `temporary`), non-null and null `delivery_status_*` columns, and `tags` JSON arrays — enough rows that `limit=3` produces a `paging.next` cursor and a working second page.
  - `suppressions-seed.json`: 2 rows, one `bounces` and one `complaints`, including one address containing a `+`.
  - Insert both via `require('../lib/db.js')` so the real schema and prepared statements are exercised.

- [x] **0.6** Capture the artifacts that need no HTTP request
  - File: `scripts/capture-golden.cjs`
  - **`captured/schema.json`** — `PRAGMA table_info(<t>)` and `PRAGMA index_list(<t>)` for all four tables, from the same handle `server.js` uses. Anchored by the existing `/data` volume: the new build must read it unchanged.
  - **`captured/ses-event-inputs.json`** — the SES payloads the harness feeds to `mapSesEvent`, written out as a committed artifact so `test/helpers/fixtures.ts` (Phase 7) can import them instead of restating them (Design Decision P9). Cover: `Delivery`, `Bounce` Permanent, `Bounce` Transient, `Complaint`, `Open`, `Click`, `Reject`, `Send`, `DeliveryDelay`, an unknown type, and a multi-recipient `Delivery` — each with a `mail` block carrying `messageId`, `destination`, an explicit `timestamp`, and `headers` including `Message-ID` and `X-Ghost-Email-Id`.
  - **`captured/event-map-<name>.json`** — `require('../lib/event-mapper.js')` output for each of those inputs. Anchored by the internal contract feeding the events API.
  - **`captured/template-vars.json`** — `require('../lib/template-vars.js')` output covering substitution, unknown vars left verbatim, empty string, null vars, repeated occurrences, and regex-special characters in values. Anchored by Mailgun recipient-variable semantics.
  - Apply `normalize` from task 0.3 before writing every artifact.

- [x] **0.7** Run the capture and land the fixtures
  - `docker build -f scripts/Dockerfile.capture -t ghost-ses-proxy:capture .`
  - `docker run --rm -v "$PWD/test/golden/captured:/app/test/golden/captured" ghost-ses-proxy:capture`
  - Confirm all four artifact families landed and are non-empty.

- [x] **0.8** Gate (this phase has no TypeScript and no test runner yet)
  - `docker run --rm --entrypoint sh ghost-ses-proxy:capture -c 'for f in server.js lib/*.js; do node --check "$f" || exit 1; done'` — the legacy tree is still the running implementation and must stay syntactically valid.
  - Every file under `test/golden/captured/` parses via `JSON.parse`.
  - The harness exits 0 and leaves no running container.

### Observations

**Completed 2026-07-27.** All eight tasks done; the gate is green.

**Runtime assumptions (task 0.1).**
- Docker server version **29.6.1**.
- Provenance SHA for `MANIFEST.json` in Phase 2.2: **`36845e99ea56e150f7a7d2d09dd7536b9b6bf3bb`** (branch `dev`, clean apart from the untracked `ralph/` tree).

**Files added.**
- `scripts/Dockerfile.capture` — verbatim from the plan; builds clean, `better-sqlite3` compiles for Alpine.
- `scripts/normalize.cjs` — verbatim from the plan (no `<EVENT_ID>` normalizer, per P7).
- `scripts/capture-golden.cjs` — env → AWS mocks → `require('../server.js')` → seed → capture → `process.exit(0)`, as specified. `capturedMime` / `sesBehaviour` are declared but unused until Phase 1.4 wires the send scenarios.
- `test/golden/captured/` — 16 artifacts: `events-seed.json`, `suppressions-seed.json`, `schema.json`, `ses-event-inputs.json`, 11 × `event-map-<name>.json`, `template-vars.json`.

**Deviation 1 — input artifacts are written RAW, not normalized.** The plan's task 0.6 says "apply `normalize` before writing every artifact", but that is wrong for the three *input* artifacts (`ses-event-inputs.json`, `events-seed.json`, `suppressions-seed.json`) and would have silently broken Phase 7 and Phase 15:
- The timestamp normalizer rewrites `2026-07-20T12:00:05.000Z` → `<TIMESTAMP>`. Phase 7.3 imports `ses-event-inputs.json` as the live fixture set for the new `mapSesEvent`; `new Date('<TIMESTAMP>')` is `NaN`, so the numeric timestamps recorded in `event-map-*.json` could never reproduce.
- Same class of problem for the seeds: the fixed `evt-NNNN` ids and numeric timestamps are exactly what makes `paging.next` reproducible (P7/P8).

The rule that actually holds is: **inputs raw, derived outputs normalized.** It is still symmetric, because Phase 15 normalizes the value it *computes* from the raw input before comparing it to the captured output. Verified end to end: `ses-event-inputs.json` carries `Message-ID: <44444444-4444-4444-8444-444444444444@example.com>` raw, and `event-map-delivery.json` records `batch_message_id: "<BATCH_UUID>@example.com"` — so replaying the raw input through the mapper and normalizing the result reproduces the fixture exactly.

**Deviation 2 — `mail.messageId` values in `ses-event-inputs.json` are shaped `<16hex>-<16hex>-000000`.** A realistic SES message id (`0100…-8hex-4hex-4hex-4hex-12hex-000000`) contains a substring matching the UUID normalizer, so every fixture's `ses_message_id` would collapse to the same `<BATCH_UUID>` token in the output artifacts and stop discriminating between them. The chosen shape has only three dash-separated segments, so it survives normalization verbatim (confirmed: `010001912a3b4c5d-0000000000000001-000000`).

**Known interaction for Phase 1 / Phase 15 — the mock's `SES_MESSAGE_ID` self-normalizes.** The plan-pinned constant `0100000000000000-11111111-2222-3333-4444-555555555555-000000` *does* match the UUID regex, so anywhere it reaches a captured artifact it is recorded as `0100000000000000-<BATCH_UUID>-000000`. Left as the plan specifies: capture and replay both apply the same normalizer, so it stays symmetric and no assertion breaks. It only means a captured artifact cannot distinguish that id from a batch UUID — no Phase 15 assertion listed against `captured/` depends on that distinction. Do **not** "fix" it by changing the constant without re-capturing every artifact.

**Seed content (task 0.5).** 7 event rows `evt-0001`…`evt-0007`, timestamps `1750000001`…`1750000007`, covering `delivered` / `opened` / `failed` / `clicked` / `complained`, `severity` ∈ {null, permanent, temporary}, both null and non-null `delivery_status_*` triples, and `tags` arrays including an empty one. `limit=3` therefore returns `evt-0001..0003` and a cursor over `evt-0003`, with a full second page available. `erin+news@example.com` gives Phase 1 a `+` address in the events set. Suppressions: `bounced+tag@example.com` (`bounces`, contains the `+` Phase 1.3 needs) and `complainer@example.com` (`complaints`).

**Gate results (task 0.8).**
- `node --check` over `server.js` and all ten `lib/*.js` inside the image: clean.
- All 16 files under `test/golden/captured/` parse via `JSON.parse` and are non-empty.
- Harness exits 0; `docker ps --filter ancestor=ghost-ses-proxy:capture` is empty.

**Notes for later phases.**
- The image tag `ghost-ses-proxy:capture` already exists locally; Phase 1.5 and Phase 2.1 must **rebuild** it after editing `scripts/capture-golden.cjs` — `scripts/` is baked in with `COPY`, not mounted.
- Only `test/golden/captured` is bind-mounted; `/data/ses-proxy.db` lives inside the throwaway container, so every run starts from an empty database. That is what makes the Phase 1.2 `/health` precondition (`message_map: 0`, `recipient_emails: 0`) hold and what makes the Phase 2.1 determinism diff meaningful.
- `server.js`'s startup `console.log`s never appear: `main()` runs synchronously after `require`, and `process.exit(0)` fires before the `listen` callback. Phase 1.1 must wait for the listener to be ready before issuing its first `fetch`.

---

## Phase 1: HTTP capture scenarios

**Goal:** The harness drives the running app over HTTP and records every Ghost-facing response body, status code, and raw MIME message.

Split from Phase 0 deliberately (critique finding 10): each debugging cycle here costs a `docker build` + `docker run`, and there is still no test runner to fall back on.

### Tasks

- [x] **1.1** Add the HTTP driver
  - File: `scripts/capture-golden.cjs`
  - Drive the app with Node 20's global `fetch` + `FormData` against `http://localhost:3003`. `form.append('to', …)` twice yields the repeated field busboy accumulates into an array.
  - Auth header on every `/v3` request: `Basic ` + `Buffer.from('api:test-key').toString('base64')`.
  - **Capture order is load-bearing** — `/health` counts change as later scenarios insert rows. Run the scenarios in exactly the order of tasks 1.2 → 1.4.

- [x] **1.2** Capture `/health` immediately after seeding
  - Artifact: `captured/http-health.json`
  - Runs **before any send scenario**, so the recorded counts are exactly the Phase 0 seed: `message_map: 0`, `recipient_emails: 0`, `events: <event seed count>`, `suppressions: 2`.
  - Record that precondition in the artifact itself (a `_precondition` key naming the two seed files) so Phase 15's contract test cannot assert it against the wrong database state (critique finding 7).

- [x] **1.3** Capture the events and suppression scenarios
  - Artifacts: `captured/http-events-*.json`, `captured/http-suppression-*.json`
  - Events: unfiltered; `?event=delivered OR failed`; `?tags=<one> AND <two>`; a `?begin=&end=` range; `?limit=3` (first page — this is what pins `paging.next`); the second page fetched via the returned cursor path `/v3/example.com/events/<cursor>`; an invalid page token → 400.
  - Suppression: a valid `bounces` delete of a `%40`-encoded address; a delete of the `+`-containing seeded address; an unknown type → 404.
  - `paging.next` is **not** normalized (design §8.4) — it reproduces because the harness always sends `Host: localhost:3003` and the seed ids are fixed. Phase 15's contract test pins the same Host (Design Decision P8).

- [x] **1.4** Capture the send scenarios and raw MIME
  - Artifacts: `captured/http-send-*.json`, `captured/mime-*.txt`, `captured/send-scenarios.json`
  - Scenarios, each flipping `sesBehaviour` as needed: canonical (html + text, 2 recipients, `recipient-variables`, `o:tag`, `v:email-id`, `h:List-Unsubscribe` containing the `<%tag_unsubscribe_email%>` placeholder); no-text; no-html; custom `h:X-Foo` headers; UTF-8 subject and body; missing `from` → 400; malformed `recipient-variables` → 400; all-recipients-fail → 500 with `errors[]`.
  - **Write the request field maps to `captured/send-scenarios.json`** — the exact form fields for each scenario, keyed by scenario name (Design Decision P9). Phase 15 replays these same requests; without them the MIME assertion cannot be reproduced (critique finding 3).
  - MIME is captured from the SES mock's `input.RawMessage.Data`, not by calling `buildRawMime` — that function is **not exported** by `lib/send-email.js`. Each `mime-*.txt` is therefore the output of the *whole* pipeline (busboy parse → `substituteVars` → placeholder stripping → `h:*` collection → `X-Ghost-Email-Id` injection → `buildRawMime`), and Phase 15 must assert it the same way.
  - Apply `normalize` before writing.

- [x] **1.5** Re-run the full capture and confirm all artifacts land
  - Rebuild the image and re-run with the bind mount from task 0.7.
  - Spot-check one `mime-*.txt` against `lib/send-email.js`'s `buildRawMime` header order by eye — this is the file the whole contract suite hangs on.

- [x] **1.6** Gate
  - Every `.json` under `test/golden/captured/` parses; every `mime-*.txt` is non-empty and contains `----=_Part_<BOUNDARY>`.
  - Every artifact listed in design §8.3 now exists.
  - Re-run the legacy syntax check from task 0.8.

### Observations

**Completed 2026-07-27.** All six tasks done; the gate is green. Only `scripts/capture-golden.cjs` changed; `Dockerfile.capture` and `normalize.cjs` were untouched.

**Artifact inventory after this phase** — 37 JSON + 8 MIME under `test/golden/captured/`:
- `http-health.json`, `http-events-{unfiltered,filter-event,filter-tags,range,limit-3,page-2,invalid-token}.json`, `http-suppression-{bounces-encoded,plus-literal,complaints,unknown-type}.json`, `http-send-{canonical,no-text,no-html,custom-headers,utf8,missing-from,malformed-recipient-variables,all-recipients-fail}.json`, `send-scenarios.json`
- `mime-canonical-{0,1}.txt`, `mime-no-text-0.txt`, `mime-no-html-0.txt`, `mime-custom-headers-0.txt`, `mime-utf8-0.txt`, `mime-all-recipients-fail-{0,1}.txt`

**Artifact shape.** Every `http-*.json` is `{ _request: {method, path, auth, …}, status, body }`. `http-health.json` additionally carries `_precondition` (task 1.2) naming both seed files and the expected counts. `http-send-*.json`'s `_request` carries `scenario` + `fieldsFrom: "send-scenarios.json"` rather than restating the form fields (P9). `http-events-page-2.json`'s `_request.derivedFrom` records that its path came from the limit-3 response's `paging.next`. Phase 15's contract test can drive every request straight off `_request` — no scenario table needs restating on the host.

**MIME file naming.** `mime-<scenario>-<i>.txt`, indexed even when a scenario produces one message. The index is the position in `toList`: `mime-canonical-0.txt` is alice, `-1` is bob, and the two genuinely differ (per-recipient `recipient-variables` substitution reaches both the base64 bodies and the `List-Unsubscribe` header). Ordering is deterministic: `semaphore.acquire()` resolves synchronously while `current < max` (10 here), so the per-recipient `.then` callbacks run as microtasks in `toList.map` order, and `aws-sdk-client-mock` invokes `callsFake` synchronously inside `send()`.

**Spot-check of `mime-canonical-0.txt` against `buildRawMime` (task 1.5).** Header order matches `lib/send-email.js:46-76` exactly: `From, To, Subject, [Reply-To], [Sender], [Message-ID], [List-Unsubscribe], [List-Unsubscribe-Post], <customHeaders…>, MIME-Version, Content-Type`. `mime-custom-headers-0.txt` confirms the excluded-key rule — `h:Reply-To`/`h:Sender` render as real `Reply-To:`/`Sender:` headers while `h:X-Foo`/`h:X-Bar` pass through as `X-Foo:`/`X-Bar:`, and `X-Ghost-Email-Id` is appended last. The `<%tag_unsubscribe_email%>` placeholder strips cleanly: `<%recipient.unsubscribe_url%>, <%tag_unsubscribe_email%>` → `List-Unsubscribe: <https://example.com/unsubscribe/alice>`. Text part precedes HTML part; both base64 with a blank line after the headers; closing delimiter `------=_Part_<BOUNDARY>--`.

**Deviation 1 — suppression scenarios are four, not three.** The plan asked for "a valid `bounces` delete of a `%40`-encoded address; a delete of the `+`-containing seeded address; an unknown type → 404". The only seeded `bounces` row is `bounced+tag@example.com`, so the first two collapse onto the same address. Captured instead:
- `suppression-bounces-encoded` — `/bounces/bounced%2Btag%40example.com` (fully encoded; this is the delete that actually removes the seeded row)
- `suppression-plus-literal` — `/bounces/bounced+tag%40example.com` (literal `+` in the path; proves Express does *not* decode it to a space outside a query string — both artifacts decode to `bounced+tag@example.com`)
- `suppression-complaints` — `/complaints/complainer%40example.com`, the second seeded row, so both valid types are covered
- `suppression-unknown-type` — `/unsubscribed/…` → 404

Note the handler echoes the address and returns 200 regardless of whether a row was deleted, so `suppression-plus-literal` (running second, after the row is gone) is still a valid 200 assertion — it pins decoding, not deletion.

**Deviation 2 — invalid page token uses `invalid-page-token`, and it 400s for a non-obvious reason.** `Buffer.from(s, 'base64')` never throws; it silently drops invalid characters. The 400 comes from `JSON.parse` failing on the resulting garbage bytes, not from the base64 decode. A future "improvement" that pre-validates base64 would still need to 400 here.

**Deviation 3 — the second page has no `limit`.** `paging.next` is built without carrying the query string forward (`lib/events-api.js:129`), so following the cursor from `?limit=3` lands on `limit=300` and returns the remaining four rows with an empty `paging.next`. That is the real Ghost-facing behavior and is captured as such; do not "fix" the cursor to preserve `limit` without re-capturing.

**Known normalizer collapse — seed `message_id` values.** The three distinct seeded `message_id`s (`11111111-…`, `22222222-…`, `33333333-…`) all match the UUID normalizer, so every events-API item records `"message-id": "<BATCH_UUID>@example.com"`. This is symmetric (Phase 15 normalizes the computed value the same way) and no assertion depends on telling the three apart, but it means the captured events fixtures assert the *presence and shape* of `message-id`, not its value. Same class as the `SES_MESSAGE_ID` note in Phase 0. Do not change the seed ids without re-capturing.

**Harness changes.**
- `main()` is now `async` with a `.catch` that logs the stack and `process.exit(1)` — a rejected capture used to look like a successful one.
- `waitForServer()` polls `GET /health` every 50 ms up to 200 times before the first real request. Phase 0's observation that `server.js`'s startup `console.log`s never appear no longer holds: `process.exit(0)` now happens well after `listen()`, so the banner and `SQS poller started` both show in the run log.
- `request(method, path, init)` returns `{status, body}` with `body` falling back to the raw text when the response is not JSON.
- Node 20's global `FormData` + `fetch` drive the sends; `form.append('to', …)` twice produces the repeated field `busboy` accumulates into an array, and fetch supplies the multipart boundary. Field append order is preserved end to end, which is what makes the `h:*` → `customHeaders` header order deterministic.
- `sesBehaviour` is set per scenario and reset to `'ok'` after the loop.

**Gate results (task 1.6).** All 37 `.json` parse; all 8 `mime-*.txt` are non-empty and contain `----=_Part_<BOUNDARY>`; no unexpected files in `captured/`; every design §8.3 artifact family present (`mime-*.txt` 8, `event-map-*.json` 11, `template-vars.json` 1, `http-*.json` 20, `schema.json` 1). `node --check` over `server.js` + all ten `lib/*.js` inside the image: clean. Harness exits 0, no container left running.

**Notes for Phase 2.**
- Rebuild `ghost-ses-proxy:capture` before the 2.1 determinism run — the image already carries the new harness from this phase, but `scripts/` is baked in with `COPY`, so any further edit needs a rebuild.
- The AWS SDK now prints a `NodeVersionSupportWarning` on stderr under node 20. It does not reach any artifact; ignore it.
- Determinism risk to watch in 2.1: batch UUIDs, MIME boundaries, and `created_at` are all normalized, and every id/timestamp that feeds a response is seeded. Nothing observed in this phase varies run to run.

---

## Phase 2: Fixture provenance, determinism, and intent fixtures

**Goal:** Prove the captured fixtures are reproducible, stamp them with provenance, and hand-author the `intent/` fixtures that encode the *fixed* behavior for all five defects (D1–D4 and D7).

### Tasks

- [x] **2.1** Prove determinism (design §8.1 gate 3)
  - Run the capture a second time into a scratch directory: `docker run --rm -v "$PWD/.capture-verify:/app/test/golden/captured" ghost-ses-proxy:capture`
  - `diff -r test/golden/captured .capture-verify` must be empty.
  - Any variance means a missing normalizer — add it to `scripts/normalize.cjs` and re-capture **both** directories. Do not paper over variance by deleting the fixture.
  - Delete `.capture-verify` when green.

- [x] **2.2** Write provenance
  - File: `test/golden/captured/MANIFEST.json`
  - `{ "capturedFromSha": "<sha from task 0.1>", "capturedAt": "<ISO date>", "harness": "scripts/capture-golden.cjs", "dependencyVersions": { … }, "reproducibilityCaveat": "…", "files": { "<name>": { "anchoredBy": "<consumer>" } } }`
  - `anchoredBy` is design §8.1 gate 2 — every file names the external consumer that requires its shape (`Ghost mailgun.js`, `Mailgun API contract`, `SES raw message format`, `internal event-mapper contract`, `existing /data volume`). A file with no nameable consumer does not belong in `captured/`; move it to `REJECTED.md`.
  - `dependencyVersions` records the resolved versions the harness actually ran against (read them from the installed `node_modules/*/package.json` inside the container). `scripts/Dockerfile.capture` installs from semver ranges with no lockfile — the lockfile only arrives in Phase 3 — so recording the resolved set is what keeps design §8.5's "`git checkout <sha>` regenerates the fixtures" claim honest (critique finding 19). State that caveat in `reproducibilityCaveat`.

- [x] **2.3** Record rejected capture candidates
  - File: `test/golden/REJECTED.md`
  - One row per candidate with the reason, covering at minimum the design §8.2 exclusion table: post-throw semaphore state (D1), `cleanup()`'s effect on `suppressions` (D2), poller-generated `events.id` values and redelivery behavior (D3), repeated-query-parameter and unclamped-`limit` responses (D4), and `mapSesEvent`'s output for a payload missing its event block plus the poller's handling of one (D7).
  - Add anything else that failed determinism in task 2.1, with the reason.

- [x] **2.4** Hand-author the intent fixtures
  - Files under `test/golden/intent/`. These pin behavior the current implementation gets **wrong**, so Phase 15's contract test fails if the rewrite accidentally preserves the bug.
  - **Format:** each file is valid JSON carrying a top-level `"_meta": { "defect": "D2", "designSection": "§5.2", "note": "…" }` key — JSON has no comment syntax, so a prepended header would break `JSON.parse` and the task 2.5 gate (critique finding 13). The contract test ignores `_meta`.
  - `intent/d1-semaphore-release.json` — a throw inside the per-recipient path releases its slot and the batch completes as `partial`: 200 `{id, message:'Queued. Thank you.'}`, `send_in_flight` back to 0, and a subsequent send still succeeds. **This is a deliberate wire-contract change** — the same request returns 500 `Internal server error` today. See design §5.1 and Phase 13.1.
  - `intent/d2-suppression-retention.json` — after cleanup: a 200-day-old `suppressions` row **survives**; 200-day-old `message_map`, `recipient_emails`, and `events` rows are deleted; 30-day-old rows survive in all four tables. (design §5.2)
  - `intent/d3-redelivery-dedupe.json` — the same SQS message processed twice yields exactly one `events` row, and the row `id` is the 32-char sha256 prefix of `[ses_message_id, event_type, recipient, timestamp].join(' ')`. **The fixture payload must carry an explicit timestamp** — design §5.3's known limitation is that a timestamp-less event falls back to `Date.now()` and still duplicates, so a fixture without one would silently assert the un-fixed path (critique finding 14).
  - `intent/d4-repeated-query-param.json` — `?event=delivered&event=opened` returns 200 honoring `delivered` (the first value), not 500. Same shape for `?tags=`. (design §5.4)
  - `intent/d4-limit-clamp.json` — `?limit=99999999` clamps to 1000; `?limit=0` and `?limit=-5` clamp to 1. (design §5.4)
  - `intent/d7-malformed-payload.json` — a `Delivery` payload with no `delivery` block (and a `Bounce` with no `bounce`, a `Complaint` with no `complaint`) maps to `[]` instead of throwing; the poller **deletes** the message, increments `sqs_parse_errors_total{reason="malformed_payload"}`, and does **not** increment `events_skipped_total`. Today this throws a `TypeError` and the message is never deleted, stalling the poller indefinitely. (design §5.5)

- [x] **2.5** Gate
  - Every file under `test/golden/intent/` parses via `JSON.parse` and has a `_meta.defect` and `_meta.designSection`.
  - `test/golden/REJECTED.md` covers all four §8.2 rows; `MANIFEST.json` has an `anchoredBy` entry for every file in `captured/`.
  - Re-run the legacy syntax check from task 0.8 — the implementation is still `server.js`.

### Observations

**Completed 2026-07-27.** All five tasks done; the gate is green. No file under `src/` exists — the Phase 0–2 safety net is now complete and Phase 3 may begin.

**Determinism (task 2.1) — clean on the first attempt.** Rebuilt `ghost-ses-proxy:capture`, ran into `.capture-verify`, and `diff -r test/golden/captured .capture-verify` was empty. No normalizer had to be added, nothing was rejected for variance. `.capture-verify` deleted.

**Files added.**
- `test/golden/captured/MANIFEST.json` — provenance, 45 `files` entries.
- `test/golden/REJECTED.md`
- `test/golden/intent/{d1-semaphore-release,d2-suppression-retention,d3-redelivery-dedupe,d4-repeated-query-param,d4-limit-clamp,d7-malformed-payload}.json`

**MANIFEST notes (task 2.2).**
- `dependencyVersions` was read from `/app/node_modules/*/package.json` **inside** the image: node `v20.20.2`, `express` 4.22.2, `busboy` 1.6.0, `uuid` 11.1.1, `better-sqlite3` 11.10.0, `@aws-sdk/client-ses` 3.1096.0, `@aws-sdk/client-sqs` 3.1096.0, `aws-sdk-client-mock` 4.1.0.
- Each entry carries `anchoredBy` **and** a `role` of `input` or `output`, with the two roles explained in a top-level `roles` key. This makes Phase 0's "inputs raw, derived outputs normalized" rule machine-readable rather than folklore — Phase 15 must not run the normalizer over an `input` file before replaying it.
- **`MANIFEST.json` is hand-written and is not produced by the harness.** A future `diff -r` determinism run will therefore report it as the one file present only on the left. That is expected and is stated in `reproducibilityCaveat`; do not "fix" it by teaching the harness to emit it (the harness would then have to know its own git SHA, which it cannot).

**REJECTED.md notes (task 2.3).** Covers all five §8.2 rows (D1, D2, D3, D4 ×2 — repeated param and unclamped `limit` are separate rows — and D7), plus three further sections: gate-2 failures with no nameable consumer (startup `console.log` prose, unexported `buildRawMime` internals, `better-sqlite3` handles), the gate-3 values that are normalized rather than dropped, and surfaces the harness structurally cannot reach (poll-loop timing/backoff/`stop()`, the real SES error taxonomy). It also records why `paging.next` and `events.id` deliberately have **no** normalizer, so a future reader does not add the `<EVENT_ID>` normalizer design §8.4 lists and thereby destroy the `paging.next` assertion.

**Intent fixture notes (task 2.4).**
- Format is as the plan specifies: top-level `_meta` with `defect`, `designSection`, `kind`, `note`, `currentBehavior`, and `assertedBy`. `currentBehavior` is not in the plan's required key list; it was added because every one of these files exists to assert a *divergence*, and the divergence is unreadable without the thing being diverged from. The contract test ignores `_meta` entirely.
- **Every expectation involving the seeded events was verified against a real `better-sqlite3` run** of the exact SQL `lib/events-api.js` builds, seeded from `captured/events-seed.json`, rather than reasoned about by eye. Confirmed: `event=delivered` → `evt-0001, evt-0005`; `event=delivered OR opened` → `evt-0001, evt-0002, evt-0005`; `tags=bulk-email` → `evt-0001, evt-0002, evt-0003, evt-0005, evt-0007` (note `evt-0003` is in this set — its tags array contains `bulk-email` despite being a `failed` event); unfiltered → all seven.
- `d3`'s `expected.eventId` is `48331fd09573841d97dc2c60a1081f22`, computed with the design §5.3 algorithm from the joined string `010001912a3b4c5d-0000000000000003-000000 delivered dana@example.com 1784548805`. The fixture records the parts, the joined input, and the derivation, so Phase 11 can be checked against it without re-deriving. Its `delivery.timestamp` is explicit, per critique finding 14.
- `d4-limit-clamp` pins a fifth case the plan did not list — `?limit=abc` still falls back to **300**. The clamp is easy to implement in a way that also collapses the default to 1 or 1000; this case blocks that.
- `d4-repeated-query-param` pins two cases beyond the plan's two: the first value keeps its normal `' OR '` splitting (`firstString` collapses the repeat, it does not change filter semantics), and `?event=&event=opened` applies **no** filter because `String(v[0] ?? '')` is `''`, which is falsy.
- `d1-semaphore-release` states explicitly that a *rejected SES promise* does not exercise D1 — the current code already handles that path correctly. The test must force a synchronous throw inside `runExclusive`'s callback (stub `buildRawMime` or `substituteVars`). It also asks for the follow-up send to be repeated `sendConcurrency` times, so a single leaked slot cannot hide behind spare capacity. The all-recipients-throw variant is included because §5.1's contract change has two halves, not one.
- `d2-suppression-retention` asserts a **negative metric series**: `db_cleanup_deleted_rows_total{table="suppressions"}` must never exist. That is a stronger assertion than "the row survives" and catches a cleanup that deletes zero suppression rows only by accident.
- `d7-malformed-payload` carries a `contrastWithTheSkipPath` section pinning that `Send`/`DeliveryDelay`/unknown types keep incrementing `events_skipped_total` and must **not** touch `sqs_parse_errors_total`. Design §5.5's whole point is that the two never share a denominator, so asserting the malformed path alone would be half a test. The unknown-type case records P10's `other` collapse.

**Gate results (task 2.5).** 6 intent files parse and all carry `_meta.defect` + `_meta.designSection`; 45 captured files ↔ 45 MANIFEST entries with no gaps and no orphans; every captured `.json` parses; REJECTED.md covers D1/D2/D3/D4/D7; `node --check` over `server.js` + all ten `lib/*.js` inside the image is clean; no container left running.

**Notes for Phase 3.**
- The host runs Docker 29.6.1; task 3.2 must still record the **host** Node version, which is not the container's `v20.20.2`.
- Nothing in Phases 0–2 wrote to `package.json`, so Phase 3.1 starts from the untouched dependency list. `aws-sdk-client-mock@4.1.0` is the version the capture ran against; installing it as a real devDependency at that version keeps the Phase 15 replay closest to the capture.
- `.gitignore` currently contains only `node_modules/`, `data/`, `.env` — task 3.6 adds `dist/`, `coverage/`, `*.tsbuildinfo`. `.capture-verify` is not ignored; it was deleted rather than ignored, and any future determinism run should do the same.

---

## Phase 3: TypeScript and test tooling, config module

**Goal:** The toolchain exists and the first typed module — `config.ts` — is implemented and tested, so the baseline gate becomes meaningful from here on.

### Tasks

- [x] **3.1** Install dependencies and create the lockfile
  - Runtime: `npm install pino pino-http prom-client`
  - Dev: `npm install -D typescript @types/node '@types/express@^4' @types/better-sqlite3 tsx vitest @vitest/coverage-v8 supertest @types/supertest aws-sdk-client-mock`
  - **`@types/express` must be pinned to `^4`** (Design Decision P12). Its `latest` tag is the 5.x line while `package.json` pins `express: ^4.21.2`; unpinned typings describe Express 5's `req.query` and handler return types over an Express 4 runtime, and the resulting errors surface far from their cause.
  - This creates `package-lock.json` (design §1 — required for `npm ci` in CI and Docker). Commit it.
  - `busboy`, `uuid`, and both `@aws-sdk/*` packages ship their own types — do not add `@types/*` for them.

- [x] **3.2** Confirm `better-sqlite3` loads under the host's Node before writing any test that depends on it
  - `node -e "const D=require('better-sqlite3'); new D(':memory:').exec('create table t(a)'); console.log('ok', process.version)"`
  - Record the host Node version in Observations. The container is pinned to `node:20-alpine`; the host may be newer, and the whole unit suite runs on the host.

- [x] **3.3** Add npm scripts
  - File: `package.json`
  - Add exactly the design §1 script block, **except** leave `"start": "node server.js"` and `"main": "server.js"` untouched — Phase 16 flips them at cutover, so the repo stays runnable at every phase boundary.
    ```json
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
    ```

- [x] **3.4** Add the TypeScript configs
  - Files: `tsconfig.json`, `tsconfig.build.json`
  - `tsconfig.json`: `target: ES2022`, `module: commonjs`, `moduleResolution: node`, `strict: true`, `noUncheckedIndexedAccess: true`, `esModuleInterop: true`, `resolveJsonModule: true`, `sourceMap: true`, `declaration: false`, `skipLibCheck: true`, `include: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]`.
  - `tsconfig.build.json`: `extends: "./tsconfig.json"`, `compilerOptions: { rootDir: "src", outDir: "dist", resolveJsonModule: false }`, `include: ["src/**/*.ts"]`.
  - **`rootDir: "src"` is load-bearing** (Design Decision P4). Tests may import golden JSON fixtures, which is why `resolveJsonModule` is on for the dev config — but it is **off** for the build config, and Phase 4's `getVersion()` reaches `package.json` through an untyped `require`. A typed JSON import from `src/` widens the inferred root and silently emits `dist/src/index.js`, breaking `CMD ["node", "dist/index.js"]`.

- [x] **3.5** Add the Vitest config
  - File: `vitest.config.ts`
    ```ts
    import { defineConfig } from 'vitest/config';
    export default defineConfig({
      test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        pool: 'forks',                       // better-sqlite3 is a native addon
        coverage: {
          provider: 'v8',
          include: ['src/**/*.ts'],
          exclude: ['src/index.ts', 'src/types.ts'],
          thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
        },
      },
    });
    ```

- [x] **3.6** Update `.gitignore`
  - Add `dist/`, `coverage/`, `*.tsbuildinfo`.

- [x] **3.7** Define the shared type surface
  - File: `src/types.ts`
  - Interfaces only, no runtime code: `Config`, `Deps` (`{ config, logger, metrics, db, ses }`), `Db`, `SesClient`, `Metrics`, `Stats`, `TableCounts`, `SesEvent`, `NormalizedEvent`, `LogLevel`.
  - `NormalizedEvent` mirrors `lib/event-mapper.js`'s return shape exactly: `event_type`, `severity`, `recipient`, `timestamp`, `ses_message_id`, `ghost_email_id`, `batch_message_id`, `delivery_status_code`, `delivery_status_message`, `delivery_status_enhanced`, `is_suppression`, `suppression_type`, `suppression_reason`.

- [x] **3.8** Implement config loading
  - File: `src/config.ts`
  - `export class ConfigError extends Error` and `export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config`.
  - Throws `ConfigError` naming **all** missing required vars in one message — never `process.exit`. Only `index.ts` catches it (Phase 16).
  - Required: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_QUEUE_URL`, `PROXY_API_KEY`, `MAILGUN_DOMAIN`.
  - Defaults unchanged from `lib/config.js`: `AWS_REGION=us-east-1`, `SES_CONFIGURATION_SET=ghost-ses-proxy`, `PORT=3003`, `SEND_CONCURRENCY=10`, `LOG_LEVEL=info`.
  - New: `DB_PATH`, default `/data/ses-proxy.db` (design §6).
  - `LOG_LEVEL` is now validated against `trace|debug|info|warn|error|fatal` and throws `ConfigError` on anything else — this is the behavior change that makes the variable real.
  - `PORT` and `SEND_CONCURRENCY` parse as integers and throw `ConfigError` on non-numeric input.

- [x] **3.9** Test config loading
  - File: `test/config.test.ts`
  - Per design Test Plan: missing required vars throw `ConfigError` naming **all** of them; defaults applied; `LOG_LEVEL` validation rejects garbage and accepts each valid level; `PORT`/`SEND_CONCURRENCY` parse ints and reject non-numeric; `DB_PATH` default and override. Inject an env object — never mutate `process.env`.

- [x] **3.10** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

**Completed 2026-07-27.** All ten tasks done; the gate is green — `typecheck` clean, `build` emits `dist/config.js` + `dist/types.js`, `test:coverage` runs 28 tests with **100% statements / branches / functions / lines** on `src/config.ts`.

**Files added.** `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `package-lock.json`, `src/types.ts`, `src/config.ts`, `test/config.test.ts`. **Modified:** `package.json` (deps + scripts), `.gitignore`.

**Deviation 1 — `typescript` is pinned to `^5`, not `latest`.** `npm install -D typescript` resolved **7.0.2** (the native port is now the `latest` tag), and TS 7 has **removed `moduleResolution: node10`**:

```
tsconfig.json(6,25): error TS5108: Option 'moduleResolution=node10' has been removed. Please remove it from your configuration.
```

Design §1 and plan task 3.4 both pin `module: commonjs` + `moduleResolution: node`. Rather than change the module-resolution strategy — which is exactly the surface that keeps `esModuleInterop` honest against the CJS-only `better-sqlite3`/`express@4`/`busboy` chain — `typescript` was pinned to `^5` (resolved **5.9.3**). Treat this as a companion pin to P12 (`@types/express@^4`): **do not let a future `npm update` pull TypeScript 7** without re-deciding `moduleResolution` for the whole project, including the Phase 17 Docker builder stage.

**Task 3.2 — host Node is `v24.13.1`** (npm 11.8.0), not the container's `v20.20.2`. `better-sqlite3@11.10.0` loads and executes DDL on `:memory:` under it without a rebuild, so the host unit suite is unblocked. Note the ABI gap for later phases: **the unit suite runs on Node 24 while the image is `node:20-alpine`.** Nothing in Phase 3 depends on that, but any behavior that differs between the two (SQLite version compiled into the binding, `Intl`/`Date` formatting) would show up as a test that passes locally and fails in the image.

**Resolved versions installed** (recorded so a later `npm ci` regression is diagnosable): `pino` 10.3.1, `pino-http` 11.0.0, `prom-client` 15.1.3, `typescript` 5.9.3, `@types/node` 26.1.2, `@types/express` 4.17.25, `@types/better-sqlite3` 7.6.13, `vitest` 4.1.10, `@vitest/coverage-v8` 4.1.10, `supertest` 7.2.2, `@types/supertest` 7.2.1, `tsx` 4.23.1, `aws-sdk-client-mock` 4.1.0 (the same major/minor the Phase 0–1 capture ran against, per the Phase 2 note).

**Deviation 2 — `loadConfig` aggregates *all* problems, not just missing vars.** The plan only requires the missing-variable list to be collected into one message. The implementation extends that to `PORT`, `SEND_CONCURRENCY`, and `LOG_LEVEL`: every problem is pushed onto one list and thrown as a single `ConfigError` with the parts joined by `'; '`. A container that is misconfigured in three ways should say so once, not three restarts in a row. `test/config.test.ts` pins this ("reports every problem in one error").

**Deviation 3 — `PORT`/`SEND_CONCURRENCY` require a *positive* integer.** The plan says "parse as integers and throw `ConfigError` on non-numeric input". The implementation validates `/^\d+$/` after trimming **and** rejects `0`. Rationale: the legacy `parseInt(x, 10) || 3003` silently mapped `0` to the default, and a `SEND_CONCURRENCY` of 0 would deadlock the Phase 12 semaphore permanently — the exact D1 failure class this project exists to detect. Rejected values are `abc`, `12abc`, `1.5`, `-1`, `0`, `NaN`; all are tested. An unset or all-whitespace value still falls back to the default rather than throwing.

**Blank optional vars fall back to defaults.** `AWS_REGION=''`, `SES_CONFIGURATION_SET=''`, `PORT=''`, `LOG_LEVEL=''`, `DB_PATH=''` all yield the default, matching the legacy `||` semantics. An empty **required** var is still treated as missing (legacy `!pair[1]`).

**`src/types.ts` — notes for the phases that must conform to it.**
- It is types-only (`import type` throughout), so it emits no runtime code, which is what keeps its coverage exclusion honest. `tsc` still writes a stub `dist/types.js`; that is expected.
- `Db.insertEvent` takes a **single `EventRow` object**, not 11 positional arguments. The other inserts stay positional, mirroring `lib/db.js`'s prepared statements. Phase 5 must implement this shape.
- `Db.deleteSuppression` returns `number` (rows changed) so Phase 14's suppression route can decide whether to increment `suppressions_removed_total` — the legacy handler returns 200 regardless, and that response behavior is unchanged (pinned by `captured/http-suppression-plus-literal.json`).
- `DbOperation` is the **bounded** union backing `db_errors_total{operation}` required by P3. Phase 5 must draw the label from this type, never from a free-form string.
- `Metrics` names every metric from design §4.1–§4.5 as a camelCase property (26 entries + `register`). Phase 4.3 must register exactly these; Phase 4.4's literal-list assertion is the guard.
- `SesClient.sendRawEmail` keeps the legacy `{ messageId }` return shape (lowercase), not the SDK's `MessageId`.
- `SesEvent` models every optional SES block as genuinely optional (`delivery?`, `bounce?`, `complaint?`), which is what makes the D7 fix a type-checked requirement in Phase 7 rather than a remembered one.

**`rootDir: "src"` verified (P4).** `npm run build` emits `dist/config.js`, not `dist/src/config.js`. Nothing under `src/` imports `package.json` yet — Phase 4.1's `getVersion()` is the first place that matters, and it must use the untyped `require`.

**Notes for Phase 4.**
- `pino` is on the **10.x** line. The design's §3 sketch (`pino.stdTimeFunctions.isoTime`, `formatters.level`, `redact`) is unchanged in v10, but the second argument to `pino(opts, destination)` is how `createLogger`'s optional `destination` must be passed.
- `prom-client` 15.1.3: `collectDefaultMetrics({ register })` and `register.getMetricsAsJSON()` are both present as the plan assumes.
- `vitest` is on the **4.x** line, not 3.x. `pool: 'forks'` is still valid. Coverage printed an empty per-file table but a correct summary; do not chase that.
- The coverage gate currently sees only `src/config.ts` (`src/types.ts` is excluded). Every phase from here adds `src/` files that must arrive with their tests in the same phase, or the gate goes red at the phase boundary.

---

## Phase 4: Logger and metrics registry

**Goal:** The two observability primitives every later module depends on exist, with the full metric catalog registered on an injected registry.

### Tasks

- [x] **4.1** Implement the logger factory
  - File: `src/logger.ts`
  - `createLogger(config: Config, destination?: pino.DestinationStream): Logger` exactly as design §3 sketches it: level from `config.logLevel`, `base: { service: 'ghost-ses-proxy', version: getVersion() }`, `timestamp: pino.stdTimeFunctions.isoTime`, `formatters.level: (label) => ({ level: label })`, `redact: ['req.headers.authorization', 'req.headers.cookie']`.
  - The optional `destination` lets tests capture output; production passes nothing (stdout).
  - `getVersion()` reads the version through an **untyped require** so `package.json` never enters the build program (Design Decision P4):
    ```ts
    function getVersion(): string {
      try { return (require('../package.json') as { version: string }).version; }
      catch { return 'unknown'; }
    }
    ```
    From `dist/logger.js` this resolves `/app/package.json`, which the Dockerfile copies.
  - Everything goes to stdout, including errors — a deliberate change from today's stdout/stderr split (design §3).

- [x] **4.2** Test the logger
  - File: `test/logger.test.ts`
  - Write to an in-memory stream and assert parsed JSON: `level` is a **string** not pino's numeric default; `time` is ISO-8601; `service` and `version` on every line; `LOG_LEVEL=warn` suppresses `info` and below; an `authorization` header under `req.headers` is redacted; `logger.child({ component: 'send' })` bindings appear on child lines.

- [ ] **4.3** Implement the metrics catalog
  - File: `src/metrics.ts`
  - `createMetrics(register: Registry): Metrics` — **never** touch prom-client's default global registry (design §4: per-test registries eliminate the "already registered" flake class).
  - Call `collectDefaultMetrics({ register })` with **no prefix**, so `process_cpu_seconds_total` and `nodejs_eventloop_lag_seconds` keep conventional names. Only application metrics carry `ghost_ses_proxy_`.
  - Register every metric from design §4.1–§4.5 with the exact names, types, and label sets given there: HTTP (2), send path (7), SQS/events (10), suppressions (2), database/build (6).
  - HTTP histogram buckets `[0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30]`; `send_batch_recipients` buckets `[1,5,10,25,50,100,250,500,1000]`.
  - Export the SES `error_type` allowlist here so `ses-client.ts` (Phase 9) and the tests share one source: `Throttling`, `MessageRejected`, `MailFromDomainNotVerifiedException`, `ConfigurationSetDoesNotExistException`, `AccountSendingPausedException`, `LimitExceededException`, `TimeoutError`, everything else → `other`.
  - Set `build_info` to 1 with `version` and `node_version` labels at construction.

- [ ] **4.4** Test the metrics catalog
  - File: `test/metrics.test.ts`
  - Every metric registers with the expected name, type, and label names (assert via `register.getMetricsAsJSON()`); default metrics are present and **unprefixed**; `build_info` is 1 and carries the version label; two `createMetrics` calls on two separate `new Registry()` instances do not collide.
  - Assert the full catalog by name against a literal list — this test is the guard that a later phase does not quietly drop a metric.

- [ ] **4.5** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

- **PARTIAL RECOVERY (iterations 5–6, coordinator):** Two consecutive execution agents died on transient API faults (iteration 5: "Response stalled mid-stream", before any edit; iteration 6: "Connection closed mid-response", after writing source but before finishing tests). Neither ticked a checkbox.
- Iteration 6 left `src/logger.ts`, `src/metrics.ts`, and `test/logger.test.ts` on disk, uncommitted. The coordinator verified this partial work rather than discarding it: `npx tsc --noEmit` exits 0, and `npx vitest run test/logger.test.ts` passes **13/13**. On that evidence **4.1 and 4.2 are ticked** and the work committed as a restore point.
- **4.3 is deliberately left unchecked even though `src/metrics.ts` exists and typechecks.** Nothing has yet proven it registers the full 26-metric catalog with the right names, types, and label sets — that is exactly what 4.4's test establishes. The next iteration must **read the existing `src/metrics.ts` and verify it against design §4.1–§4.5 before trusting it**, correcting any gaps, then write `test/metrics.test.ts` and run the 4.5 gate.
- No work was lost and no reset was needed; `git reset --hard` would not have removed these files anyway, since they were untracked.

---

## Phase 5: Schema and database factory

**Goal:** `createDb` replaces the import-time singleton, so every later module can be tested against `:memory:`.

### Tasks

- [ ] **5.1** Extract the DDL
  - File: `src/schema.ts`
  - Port the four `CREATE TABLE IF NOT EXISTS` statements and the five `CREATE INDEX IF NOT EXISTS` statements from `lib/db.js` **verbatim** — same table names, column names, types, defaults, and the `UNIQUE(email, type)` constraint on `suppressions`. The new build must open the existing `/data` volume unchanged; Phase 15's contract test asserts this against `captured/schema.json`.
  - Export `applySchema(raw: Database.Database): void`.

- [ ] **5.2** Implement the database factory
  - File: `src/db.ts`
  - `createDb(path: string, logger: Logger, metrics: Metrics): Db` — the third parameter extends design §2's signature so `db_errors_total{operation}` has a home (Design Decision P3).
  - Opens the database, applies `journal_mode = WAL` and `busy_timeout = 5000` as `lib/db.js` does, calls `applySchema`, prepares the statements, returns `{ raw, insertMessageMap, insertRecipientEmail, insertEvent, insertSuppression, deleteSuppression, lookupRecipientEmail, close() }`.
  - Wrap statement execution so a throwing statement increments `db_errors_total` with an `operation` label drawn from a **fixed set** of statement names (not free-form strings — the label must stay bounded), logs at `error` with `component: 'db'`, and rethrows.
  - `INSERT OR IGNORE` semantics are preserved on all inserts.
  - Do **not** register the cleanup interval here — that is `scheduleCleanup` in Phase 6, wired by `index.ts` in Phase 16.

- [ ] **5.3** Test the database factory
  - File: `test/db.test.ts`
  - Schema creates all four tables and all five indexes; `INSERT OR IGNORE` dedupes on each unique constraint (`message_map.batch_message_id`, `recipient_emails.ses_message_id`, `events.id`, `suppressions(email, type)`); `lookupRecipientEmail` round-trips a row; `close()` releases the handle; a failing statement increments `db_errors_total` with a bounded `operation` label and rethrows. All against `':memory:'`.

- [ ] **5.4** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 6: Cleanup (D2 fix), scheduler, and cached stats (D5 fix)

**Goal:** Retention no longer destroys suppressions, the daily schedule is testable code rather than a closure in the untested entrypoint, and `/health` plus `db_rows` share one set of table scans.

### Tasks

- [ ] **6.1** Implement retention cleanup with the D2 fix
  - File: `src/cleanup.ts`
  - `runCleanup(db: Db, logger: Logger, metrics: Metrics): void`
  - Deletes rows older than 90 days from **exactly three** tables: `message_map`, `recipient_emails`, `events`. **`suppressions` is removed from the list** (design §5.2) — permanent bounces and spam complaints must never expire, and the only supported removal path stays `DELETE /v3/:domain/:type/:email`.
  - Use prepared statements with `changes` to count deleted rows per table, feeding `db_cleanup_deleted_rows_total{table}`; record `db_cleanup_runs_total{outcome}` as `success` or `error`; wrap in try/catch and log with `component: 'db'`.

- [ ] **6.2** Implement the cleanup scheduler
  - File: `src/cleanup.ts`
  - `scheduleCleanup(db: Db, logger: Logger, metrics: Metrics, intervalMs = 86_400_000): NodeJS.Timeout`
  - Returns the timer handle so the shutdown path can clear it. The interval callback **must close over the three arguments** — `setInterval(runCleanup, ms)` would invoke `runCleanup(undefined, undefined, undefined)`, and because `runCleanup` swallows its own errors, retention would silently stop with nothing but a `db_cleanup_runs_total{outcome="error"}` tick to show for it (critique finding 4). This function lives here rather than in `index.ts` precisely so a test can catch that (Design Decision P13).
  - Do **not** call `runCleanup` at startup — D6 stays pinned as-is (design §Defects). Do not `unref()` the timer.

- [ ] **6.3** Test cleanup and the scheduler, including the D2 regression
  - File: `test/cleanup.test.ts`
  - Backdate `created_at` on seeded rows. Assert: 200-day-old rows are deleted from `message_map`/`recipient_emails`/`events`; **a 200-day-old `suppressions` row survives** (D2 regression — this test is the reason the defect cannot come back); 30-day-old rows survive everywhere; `db_cleanup_deleted_rows_total` records per-table counts; a forced failure records `outcome="error"` and does not throw out of `runCleanup`.
  - With fake timers: `scheduleCleanup` does **not** run cleanup at startup (D6); it runs it after the interval elapses; the run actually deletes rows, which is what proves the arguments were passed; `clearInterval` on the returned handle stops further runs.

- [ ] **6.4** Implement the TTL-cached stats collector
  - File: `src/stats.ts`
  - `createStats(db: Db, ttlMs = 15_000): Stats` returning `{ getCounts(now: number = Date.now()): TableCounts }`, exactly as design §4.6 sketches. The injected `now` lets tests control expiry without fake timers.
  - One set of four `COUNT(*)` queries serves both `/health` and the `db_rows` gauge, replacing today's four scans per healthcheck every 30 seconds.

- [ ] **6.5** Wire the database gauges
  - File: `src/stats.ts`
  - `attachDbGauges(metrics: Metrics, stats: Stats, db: Db): void` — registers `collect()` callbacks so `db_rows{table}` is populated from `stats.getCounts()` and `db_size_bytes` from `PRAGMA page_count * PRAGMA page_size`. Using `collect()` rather than push-updating keeps the gauges correct without a background timer.

- [ ] **6.6** Test stats and gauges
  - File: `test/stats.test.ts`
  - Returns live counts; serves the cached value within the TTL (insert a row, assert the count is unchanged); recomputes after the TTL via the injected `now`; `attachDbGauges` makes `db_rows` and `db_size_bytes` appear in `register.getMetricsAsJSON()` with correct values.

- [ ] **6.7** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 7: Pure logic ports — template variables and event mapping

**Goal:** The two pure functions are ported with types, the D7 guard is added, and the shared SES fixture set is derived from the captured inputs rather than restated.

### Tasks

- [ ] **7.1** Port template variable substitution
  - File: `src/template-vars.ts`
  - `substituteVars(str: string, vars: Record<string, string>): string` — a direct port of `lib/template-vars.js`. Preserve the exact regex `/%recipient\.([^%]+)%/g` and the "unmatched patterns left as-is" behavior, including the `!str || !vars` early return.

- [ ] **7.2** Test template variable substitution
  - File: `test/template-vars.test.ts`
  - Substitutes `%recipient.x%`; leaves unknown vars verbatim; handles empty string, null/undefined vars, multiple occurrences of the same variable, and regex-special characters in **values** (a value containing `$&` must not be interpreted as a replacement pattern).

- [ ] **7.3** Derive the shared SES fixture set from the captured inputs
  - File: `test/helpers/fixtures.ts`
  - **Import `test/golden/captured/ses-event-inputs.json`** (written by the harness in task 0.6) and re-export it as typed fixtures — do **not** restate the payloads by hand. Two hand-maintained copies drift, and Phase 15 compares the new `mapSesEvent` over these fixtures against JSON produced from the captured ones; a one-character divergence makes the contract test red for a reason unrelated to the rewrite, and the natural repair silently voids the assertion (critique finding 8, Design Decision P9).
  - Add the SNS-enveloped variants (`{ Type: 'Notification', Message: JSON.stringify(event) }`) for Phase 14 by wrapping the imported payloads programmatically.

- [ ] **7.4** Port event mapping
  - File: `src/event-mapper.ts`
  - `mapSesEvent(sesEvent: SesEvent): NormalizedEvent[]` — types only, logic preserved **exactly** (design "what stays the same"): the `EVENT_MAP` table, the `Send`/`DeliveryDelay` skip list, the Permanent→607/Transient→450 bounce split, per-event-type recipient extraction, the timestamp fallback chain (`delivery`/`bounce`/`complaint`/`open`/`click` → `mail.timestamp` → `Date.now()`, all `/1000`), `Message-ID` and `X-Ghost-Email-Id` header extraction, angle-bracket stripping, the suppression flags for Bounce-permanent/Complaint/Reject, and the `diagnosticCode` enhanced code taken from the first bounced recipient.
  - **D7 fix** (design §5.5). `getRecipients` (`lib/event-mapper.js:18-26`) dereferences `sesEvent.delivery`, `.bounce`, and `.complaint` without guarding — while `mapSesEvent:79` *does* guard `sesEvent.bounce &&` for `bounceType`. Guard every optional block so a payload missing its event block yields **no recipients rather than a `TypeError`**, and `mapSesEvent` returns `[]`. This is the only intentional logic change in this file; everything above is preserved exactly.
  - The poller half of D7 lands in Phase 14.1: an empty result from a *recognized* `eventType` means delete the message and count `sqs_parse_errors_total{reason="malformed_payload"}` — distinct from the `Send`/`DeliveryDelay` skip path, so the two never share a denominator.
  - `noUncheckedIndexedAccess` will additionally force explicit guards on array indexing (e.g. `bouncedRecipients[0]`). Add the guard; do not add a non-null assertion that changes behavior on an empty array.

- [ ] **7.5** Test event mapping
  - File: `test/event-mapper.test.ts`
  - Per design Test Plan: each SES type maps to the right event/severity/code; the Permanent vs Transient severity split; `Send`/`DeliveryDelay` return `[]`; unknown type returns `[]`; a payload with no `eventType` returns `[]`; recipient extraction per type; timestamp fallback to `mail.timestamp` and then to `Date.now()`; header extraction and angle-bracket stripping; suppression flags for Bounce-permanent, Complaint, and Reject; multi-recipient fan-out produces one entry per recipient.
  - **D7 regression:** a `Delivery` with no `delivery` block, a `Bounce` with no `bounce`, and a `Complaint` with no `complaint` each return `[]` rather than throwing. Assert this explicitly — under the current implementation each throws a `TypeError`, and the whole point of the fix is that the poller can no longer be wedged by one.

- [ ] **7.6** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 8: Semaphore (D1 fix), MIME builder, multipart parser

**Goal:** The three pieces the send path decomposes into exist and are independently tested — including the regression test for the wedge defect.

### Tasks

- [ ] **8.1** Implement the typed semaphore with `runExclusive`
  - File: `src/semaphore.ts`
  - `class Semaphore` with `acquire()`, `release()`, readonly `inFlight`, readonly `queueDepth`, and:
    ```ts
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      await this.acquire();
      try { return await fn(); } finally { this.release(); }
    }
    ```
  - The `try/finally` is the D1 fix (design §5.1): the current code releases only in a `.finally()` chained onto `sendRawEmail(...)`, so anything throwing *before* that call leaks a slot permanently. Phase 13's send path must call **only** `runExclusive` — never `acquire`/`release` directly.
  - Note that `runExclusive` **re-throws** after releasing. Releasing the slot is all this class is responsible for; converting a throw into a failed-recipient outcome is Phase 13.1's job, and design §5.1 records why both halves are required.
  - Preserve the existing queueing semantics from `lib/send-email.js`: FIFO, and `release()` hands the slot straight to the next waiter without decrementing below the queued count.

- [ ] **8.2** Test the semaphore
  - File: `test/semaphore.test.ts`
  - Caps concurrency at `max`; queues beyond it; **`runExclusive` releases the slot when the callback throws** (the D1 regression — assert `inFlight` returns to 0, the rejection propagates, and a subsequent `runExclusive` still resolves); releases on resolve; `inFlight` and `queueDepth` track correctly through a queued burst; FIFO ordering.

- [ ] **8.3** Port the MIME builder
  - File: `src/mime.ts`
  - `buildRawMime(opts: MimeOptions, genBoundary = defaultBoundary): string` — the boundary factory is injectable so tests can pin it; production uses `'----=_Part_' + randomBytes(16).toString('hex')`.
  - Output must match **byte-for-byte** (design "what stays the same"): header order (`From`, `To`, `Subject`, then optional `Reply-To`, `Sender`, `Message-ID`, `List-Unsubscribe`, `List-Unsubscribe-Post`, then custom headers, then `MIME-Version`, then `Content-Type`), `\r\n` joins, base64 `Content-Transfer-Encoding` for both parts, `multipart/alternative` boundary format, and the closing `--<boundary>--` plus trailing empty line.

- [ ] **8.4** Test the MIME builder
  - File: `test/mime.test.ts`
  - Header order and presence; optional headers omitted when absent; base64 encoding of text and html parts; the boundary appears in `Content-Type` and in both delimiters; custom `h:*` headers included; UTF-8 subject and body round-trip through base64.

- [ ] **8.5** Port multipart form parsing
  - File: `src/multipart.ts`
  - `parseFormData(req: Request): Promise<Record<string, string | string[]>>` — port of `lib/send-email.js`'s `parseFormData`. Preserve the array accumulation for exactly `to` and `o:tag`, the `Invalid multipart form-data: <msg>` rejection when busboy construction throws, and the `error` event rejection.

- [ ] **8.6** Test multipart form parsing
  - File: `test/multipart.test.ts`
  - Drive a real multipart body (build the request with `supertest` against a throwaway express app, or feed a `Readable` with the right `content-type` header). Assert: single fields land as strings; repeated `to` and `o:tag` accumulate as arrays; a single `to` still yields an array-capable shape the send path can normalize; a missing/invalid `content-type` rejects with the `Invalid multipart form-data` message.

- [ ] **8.7** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 9: SES client, auth middleware, and the shared test deps helper

**Goal:** The last two leaf modules exist, and `makeDeps()` gives every later test a complete injected dependency set.

### Tasks

- [ ] **9.1** Implement the instrumented SES client
  - File: `src/ses-client.ts`
  - `createSesClient(config: Config, deps: { logger; metrics }, client?: SESClient): SesClient` — the underlying `SESClient` is injectable so `aws-sdk-client-mock` can intercept it in tests.
  - `sendRawEmail(rawMessage, configurationSetName)` returns `{ messageId }` exactly as `lib/ses-client.js` does, and additionally: times the call and records `ses_send_duration_seconds{outcome}` (`success`/`error`), increments `ses_errors_total{error_type}` on failure, and logs at `debug` on success / `error` on failure with `component: 'ses'` plus `recipient`, `sesMessageId`, `durationMs`.
  - Map `err.name` through the allowlist exported by `src/metrics.ts` (Phase 4) — raw SDK error names are not a bounded set, so anything unlisted collapses to `other`.
  - Rejections propagate to the caller unchanged; the send path is what decides partial vs total failure.

- [ ] **9.2** Test the SES client
  - File: `test/ses-client.test.ts`
  - With `aws-sdk-client-mock`: `sendRawEmail` returns the `MessageId`; the duration histogram records with `outcome="success"` and with `outcome="error"`; each allowlisted error name maps to its own `error_type`; an unknown name collapses to `other`; rejections propagate.

- [ ] **9.3** Port the auth middleware
  - File: `src/middleware/auth.ts`
  - `createAuthMiddleware(config: Config)` returning an express middleware — a direct port of `lib/auth.js` with **no behavior change**, including the three distinct 401 bodies (`missing credentials`, `invalid credentials`, `invalid API key`) that Ghost may surface.
  - Keep the `indexOf(':')` + `slice(colonIndex + 1)` parse so an API key containing a colon still works.

- [ ] **9.4** Test the auth middleware
  - File: `test/middleware/auth.test.ts`
  - Valid `Basic base64("api:" + key)` passes; missing header → 401; non-`Basic` scheme → 401; malformed base64 → 401; no colon in the decoded value → 401; wrong key → 401; a key containing a colon parses correctly. Assert the exact 401 body for each case.

- [ ] **9.5** Build the shared test deps helper
  - File: `test/helpers/deps.ts`
  - `makeDeps(overrides?: Partial<AppDeps>): AppDeps & { logs: () => object[]; register: Registry }` where `AppDeps = Deps & { stats: Stats }`.
  - Builds: `loadConfig` over a canned env object; a pino logger writing to an in-memory stream with a `logs()` accessor returning parsed lines; `createMetrics(new Registry())`; `createDb(':memory:', …)`; a mocked `ses`; **and `createStats(db)` plus the `attachDbGauges` call**.
  - `stats` is not optional. `createApp` takes `Deps & { stats: Stats }` (Phase 11.3), and every later phase calls `createApp(makeDeps())`; omitting `stats` is a compile error under `strict`, and Phase 11.5 asserts `db_rows` appears in the exposition output, which requires the gauges to be attached (critique finding 6).
  - A fresh `Registry` per call is what prevents prom-client's "already registered" flake across test files (design §4).

- [ ] **9.6** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 10: Observability middleware

**Goal:** HTTP access logging and HTTP metrics work, with a route label that can never carry a subscriber's email address.

### Tasks

- [ ] **10.1** Implement the observability middleware
  - File: `src/middleware/observability.ts`
  - Two exports wired together by `createApp` in Phase 11:
    - `createHttpLogger(deps)` — `pino-http` with `genReqId: () => randomUUID()`, the deps logger bound to `component: 'http'`, `customLogLevel` mapping 4xx→`warn` and 5xx→`error`, trimmed serializers emitting only `method`, `url`, `route`, `statusCode`, `responseTime`, and `autoLogging.ignore` returning true for `/health` and `/metrics` (design §3 — otherwise the 30-second healthcheck alone writes 2,880 lines/day into Loki).
    - `createHttpMetrics(deps)` — records `http_requests_total` and `http_request_duration_seconds` on `res.on('finish')`.
  - **Route label safety is the critical part of this phase** (design §4.1). The label is the Express *template*, captured on `finish` when routing has completed:
    ```ts
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    ```
    Never use `req.path` or `req.originalUrl`: `DELETE /v3/:domain/:type/:email` embeds a subscriber's address, which would make cardinality unbounded and leak PII into Prometheus. Requests rejected by the `/v3` auth middleware before routing, and 404s, both label `unmatched` — losing per-route attribution on 401s is the accepted cost.
  - Per Design Decision P5, metrics count `/health` and `/metrics` too; only access logging suppresses them.

- [ ] **10.2** Test the observability middleware
  - File: `test/middleware/observability.test.ts`
  - Mount both middlewares on a throwaway express app with representative routes and drive it with supertest. Assert: the counter and histogram record `method`/`route`/`status_code`; **the `route` label is the template, not the raw path**; unmatched routes and pre-routing 401s label `unmatched`; **an email address in the request path never appears in any label value** (walk `register.getMetricsAsJSON()` and assert no label value contains `@`) — this is the cardinality/PII regression test; `/health` and `/metrics` produce no access-log line while other paths do; the `authorization` header never appears unredacted in a log line.

- [ ] **10.3** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 11: Application factory, health and metrics endpoints

**Goal:** `createApp(deps)` exists and serves the two unauthenticated endpoints end-to-end under supertest.

### Tasks

- [ ] **11.1** Implement the health route
  - File: `src/routes/health.ts`
  - `createHealthRoute(stats: Stats)` returning a handler that responds with the **exact current shape** — `{ status: 'ok', tables: { message_map, recipient_emails, events, suppressions } }` — backed by `stats.getCounts()` rather than four fresh `COUNT(*)` scans (D5). Ghost does not consume this, but the Docker `HEALTHCHECK` and Phase 15's contract test do.

- [ ] **11.2** Implement the metrics route
  - File: `src/routes/metrics.ts`
  - `createMetricsRoute(register: Registry)` returning a handler that sets `Content-Type` from `register.contentType` and responds with `await register.metrics()`. Served **unauthenticated**, matching `/health` (design §4 — the container is reachable only on the internal Docker network, and requiring `PROXY_API_KEY` would push the credential into Prometheus scrape config for no gain).

- [ ] **11.3** Implement the application factory
  - File: `src/app.ts`
  - `createApp(deps: Deps & { stats: Stats }): express.Express` — builds the app, **never** calls `listen()`.
  - Middleware and route order matters:
    1. `createHttpLogger(deps)` and `createHttpMetrics(deps)` — first, so they observe everything.
    2. `GET /health` and `GET /metrics` — before the auth middleware, so both stay unauthenticated.
    3. `app.use('/v3', createAuthMiddleware(deps.config))`.
    4. `/v3` routes — added by Phases 12 and 13; leave a marked insertion point.

- [ ] **11.4** Test the health route
  - File: `test/routes/health.test.ts`
  - Via supertest against `createApp(makeDeps())`: returns 200 with the exact `{ status, tables: {…} }` shape; counts reflect seeded `:memory:` rows; served without an `Authorization` header.

- [ ] **11.5** Test the metrics route
  - File: `test/routes/metrics.test.ts`
  - Returns 200 with prom-client's `Content-Type`; the body parses as Prometheus exposition format; contains `ghost_ses_proxy_`-prefixed application metrics (including `db_rows`, which proves `attachDbGauges` ran) **and** unprefixed `process_*`/`nodejs_*` defaults; served without an `Authorization` header.

- [ ] **11.6** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 12: Suppression and events routes (D4 fix)

**Goal:** The two read/delete endpoints are ported, with the repeated-query-parameter and unclamped-limit defects fixed.

### Tasks

- [ ] **12.1** Port the suppression route
  - File: `src/routes/suppression.ts`
  - `createSuppressionRoute(deps)` — direct port of `lib/suppression-api.js`. Preserve the `VALID_TYPES` set (`bounces`, `complaints`, `unsubscribes`), the 404 body `{ message: 'Unknown suppression type: <type>' }`, the 200 body `{ message: 'Address has been removed', value: '', address: <email> }`, and the fact that deleting a non-existent address still returns 200.
  - Keep the `decodeURIComponent(req.params.email)` call exactly as-is even though Express has already decoded the param — preserving it preserves current behavior for edge cases like `%2540`. Do not add a try/catch that Express did not have.
  - Increment `suppressions_removed_total{type}` and log at `info` with `component: 'suppression'` and `recipient`.

- [ ] **12.2** Test the suppression route
  - File: `test/routes/suppression.test.ts`
  - A valid type deletes the row and returns the Mailgun body; an unknown type → 404 with the exact message; URL-encoded `+` and `%40` in the address resolve to the right stored address; deleting a non-existent address still returns 200; `suppressions_removed_total{type}` increments.

- [ ] **12.3** Port the events route with the D4 fix
  - File: `src/routes/events.ts`
  - Direct port of `lib/events-api.js` — same dynamic SQL, same keyset pagination, same base64 `{t, id}` cursor format, same Mailgun item shape (`severity` and `delivery-status` present only when non-null), same `paging` object with `next` built from `x-forwarded-proto` and `host`.
  - **D4 fix** (design §5.4). Express parses `?event=a&event=b` into an **array**, so today's `.split(' OR ')` is `undefined` → `TypeError` → 500. Add:
    ```ts
    function firstString(v: unknown): string {
      return Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '';
    }
    ```
  - **Apply `firstString` to every query parameter**, not just `event` and `tags` (critique finding 17). Under `strict`, `req.query.begin` is `string | string[] | ParsedQs | ParsedQs[] | undefined`, so `parseFloat(req.query.begin)` and `parseInt(req.query.limit, 10)` are compile errors too; an `as string` cast would silently behave differently from `firstString`. `firstString` also matches current behavior on repeated params — today `?limit=5&limit=9` yields `parseInt("5,9")` → `5` and `?begin=1&begin=2` yields `parseFloat("1,2")` → `1`, both of which are the first value.
  - Clamp `limit` to `[1, 1000]` (it is currently honored unbounded).
  - Everything else in the response — item shape, `paging` structure, cursor encoding, filter semantics for well-formed input — is golden-eligible and must not change.

- [ ] **12.4** Test the events route
  - File: `test/routes/events.test.ts`
  - Against a seeded `:memory:` database: returns Mailgun-shaped `items` and `paging`; `event=a OR b` filters; `tags=x AND y` filters; `begin`/`end` bound the range; keyset pagination produces a working `next` cursor and the second page continues correctly with no duplicates; an invalid page token → 400; **`?event=a&event=b` returns 200 honoring the first value rather than 500** (D4 regression); **`limit=99999999` clamps to 1000** and `limit=0` clamps to 1 (D4 regression); repeated `?begin=`/`?limit=` take the first value; `severity` and `delivery-status` appear only when the underlying columns are non-null.

- [ ] **12.5** Wire both routes into the app
  - File: `src/app.ts`
  - `app.get('/v3/:domain/events', …)`, `app.get('/v3/:domain/events/:pageToken', …)`, `app.delete('/v3/:domain/:type/:email', …)` — same paths and same registration order as `server.js`.

- [ ] **12.6** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 13: Send route (D1 fix)

**Goal:** The newsletter send path is ported onto `runExclusive`, fully instrumented, and covered by the integration test that proves a throw cannot wedge the service.

This phase deliberately carries one source file so there is context room to debug the supertest + `aws-sdk-client-mock` integration.

### Tasks

- [ ] **13.1** Implement the send route
  - File: `src/routes/send-email.ts`
  - `createSendEmailRoute(deps: Deps): RequestHandler` — constructs **one** `Semaphore(config.sendConcurrency)` per app (not per request) and registers `collect()` callbacks so `send_in_flight` and `send_queue_depth` read the semaphore's `inFlight` and `queueDepth`. `send_in_flight` is the D1 canary from design §4.2.
  - Flow, preserving `lib/send-email.js` behavior: parse the form with `parseFormData` (Phase 8); normalize `to`/`o:tag` to arrays; 400 `{ message: 'Missing required fields: from, subject, to' }` when `from`, `subject`, or a non-empty `to` is absent; 400 `{ message: 'Invalid recipient-variables JSON' }` on a parse failure; build `batchMessageId` as `<uuid@domain>`; insert into `message_map`; collect `h:*` headers excluding the four reserved keys (`h:Reply-To`, `h:Sender`, `h:List-Unsubscribe`, `h:List-Unsubscribe-Post`); add `X-Ghost-Email-Id` when `v:email-id` is present.
  - **Per recipient, call only `semaphore.runExclusive(...)`** — never `acquire`/`release` directly. Everything that can throw (`substituteVars`, the `List-Unsubscribe` placeholder stripping, `buildRawMime`, `JSON.stringify`, the SES call, the `recipient_emails` insert) must sit **inside** the callback.
  - **The callback body must additionally carry its own `try/catch` converting *any* throw — not just a `sendRawEmail` rejection — into `failed++` plus an `errors.push({ recipient, error })` entry.** `runExclusive` releases the slot but re-throws; without this catch the rejection propagates through `Promise.all` to the handler's outer catch and returns 500 `Internal server error`, so the D1 intent fixture and the Phase 13.3 regression test would both fail (critique finding 1). Today only the `sendRawEmail` promise has such a catch — that asymmetry is the reporting half of D1.
  - **This is a deliberate wire-contract change**, recorded in design §5.1 and the design's "Interaction with Existing Code" table: a batch in which some recipients throw before their SES call returns 200 `Queued. Thank you.` instead of today's 500 `Internal server error`, and 500 `Failed to send to all recipients` with a populated `errors[]` when every recipient throws.
  - Preserve the rest of the response contract: all recipients failed → 500 `{ message: 'Failed to send to all recipients', errors: [{ recipient, error }] }`; otherwise 200 `{ id: batchMessageId, message: 'Queued. Thank you.' }` for both full and partial success.
  - Metrics: `send_batches_total{outcome}` as `success`/`partial`/`failure`/`rejected` (`rejected` = the two 400 validation failures), `send_recipients_total{outcome}` as `sent`/`failed`, `send_batch_recipients` observed once per batch. The 500 returned when **multipart parsing itself** fails is deliberately not a `send_batches_total` outcome — it is a malformed client request, covered by `http_requests_total{status_code="500"}` (Design Decision P11).
  - Logs use `component: 'send'` and carry `reqId`, `batchId` (the id **without** angle brackets), `ghostEmailId`, `recipient`, `recipientCount`, `succeeded`, `failed` per design §3's field schema. Replace the `config.logLevel === 'debug'` check at `lib/send-email.js:248` with a plain `logger.debug(...)` — pino gates it now.

- [ ] **13.2** Wire the route into the app
  - File: `src/app.ts`
  - `app.post('/v3/:domain/messages', createSendEmailRoute(deps))`, registered in the same position as `server.js`.

- [ ] **13.3** Test the send route end-to-end
  - File: `test/routes/send-email.test.ts`
  - Supertest + `aws-sdk-client-mock` + `:memory:`. Per design Test Plan: happy path returns `{ id, message: 'Queued. Thank you.' }` and inserts one `message_map` row plus one `recipient_emails` row per recipient; per-recipient variable substitution differs per message (assert against the captured raw MIME); missing `from`/`subject`/`to` → 400 with `send_batches_total{outcome="rejected"}`; malformed `recipient-variables` → 400; **all recipients failing → 500 with `errors[]` and `outcome="failure"`**; **partial failure → 200 with `outcome="partial"`**; observed concurrency never exceeds `SEND_CONCURRENCY`; the `<%tag_unsubscribe_email%>` placeholder is stripped and stray commas cleaned; `X-Ghost-Email-Id` is added when `v:email-id` is present; the specified log fields and metrics are emitted.
  - **The D1 regression test:** force a throw *before* the SES call inside the per-recipient path for one of two recipients (e.g. stub `buildRawMime` to throw for one recipient only). Assert the batch completes as **`partial` with a 200** — not 500 — that the failing recipient appears in neither `recipient_emails` nor the success count, that `send_in_flight` returns to 0, and that a **subsequent** send request still succeeds. Under the old implementation the response would be a 500 and the second request would hang forever.

- [ ] **13.4** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 14: SQS poller (D3 fix)

**Goal:** The poller becomes a stoppable class with deterministic event IDs and the metrics that make a silent stall alertable.

### Tasks

- [ ] **14.1** Implement the poller class
  - File: `src/sqs-poller.ts`
  - `class SqsPoller` with `pollOnce(): Promise<void>`, `start(): void`, `stop(): void`, constructed from `(deps, client?: SQSClient)` so tests can inject a mocked client. `stop()` sets a flag the loop checks and clears any pending backoff timer, so `index.ts` can shut down cleanly and tests do not leak timers.
  - Preserve the parsing behavior of `lib/sqs-poller.js`: SNS envelope (`{ Type: 'Notification', Message }`) unwrapping, raw SES events, `null` for anything unrecognized, and **delete the message** for invalid JSON, unrecognized shape, and successful processing alike, so a poison message cannot block the queue.
  - **D7 fix, poller half** (design §5.5). Phase 7.4 made `mapSesEvent` return `[]` for a payload missing its event block instead of throwing. Handle that here explicitly: when a **recognized** `eventType` (one not in the `Send`/`DeliveryDelay` skip list and present in the mapping table) produces zero normalized events, delete the message, increment `sqs_parse_errors_total{reason="malformed_payload"}`, and log at `warn` with `sesEventType` and `sesMessageId`. Do **not** increment `events_skipped_total` — that counter means "expected to produce nothing", and mixing the two would put a defect signal and a normal signal in the same denominator.
  - Preserve the correlation logic: look up `recipient_emails` by `ses_message_id`, prefer the stored `batch_message_id`/`ghost_email_id`/`tags`, strip angle brackets, default `tags` to `'[]'`.
  - **D3 fix** (design §5.3). Replace the `uuidv4()` primary key — which makes the existing `INSERT OR IGNORE` incapable of ever deduping — with a content hash:
    ```ts
    function eventId(n: NormalizedEvent): string {
      return createHash('sha256')
        .update([n.ses_message_id ?? '', n.event_type, n.recipient, String(n.timestamp)].join(' '))
        .digest('hex')
        .slice(0, 32);
    }
    ```
    Accepted trade-offs, both recorded in design §5.3: two genuinely distinct same-type events for the same recipient in the same millisecond collapse into one row; and an event carrying **no** timestamp falls back to `Date.now()` and therefore still duplicates on redelivery. No migration is needed — existing UUID-keyed rows coexist and age out under the 90-day cleanup.
  - Metrics from design §4.3: `sqs_polls_total{outcome}`, `sqs_poll_duration_seconds`, `sqs_messages_received_total`, `sqs_messages_deleted_total{outcome}`, `sqs_parse_errors_total{reason}` (`invalid_json`/`unrecognized_format`), `sqs_last_poll_timestamp_seconds` (set on every successful poll — the single most valuable metric in this design, and the only way to tell "no events" from "poller dead"), `events_stored_total{event_type,severity}`, `events_skipped_total{ses_event_type}`, `event_correlation_total{result}`, `event_lag_seconds` (`now − event.timestamp` at insert). Also `suppressions_recorded_total{type}` when a suppression is written.
  - **Label values for states the design leaves implicit** (Design Decision P10, critique finding 16): a `null` `severity` becomes `"none"` — prom-client would otherwise emit the string `"null"` and break the §4.3 combination bound and the §4.7 bounce/complaint-rate expressions. An event with **no** `ses_message_id` gets no correlation lookup at all, so count it as `result="unmatched"` rather than skipping it, keeping the §4.7 correlation-decay ratio over a consistent denominator. `events_skipped_total` collapses SES types outside the known set to `other`, applying §4.2's cardinality discipline to a label fed by untrusted third-party JSON.
  - Logs use `component: 'sqs'` with `ghostEmailId`, `recipient`, `sesMessageId`, `eventType`, `sesEventType`.
  - Keep the 5-second backoff on a poll error and keep the loop alive — a poll failure must never exit the loop.

- [ ] **14.2** Test the poller
  - File: `test/sqs-poller.test.ts`
  - `aws-sdk-client-mock` + `:memory:`, driving `pollOnce()` directly rather than `start()`. Per design Test Plan: processes an SNS-enveloped event and a raw SES event; stores normalized rows; deletes the message; **a redelivered identical message inserts no second row** (D3 regression — the fixture must carry an explicit timestamp, per design §5.3's known limitation); invalid JSON increments `sqs_parse_errors_total{reason="invalid_json"}` and the message is still deleted; an unrecognized shape increments `unrecognized_format` and is still deleted; **a `Delivery` payload with no `delivery` block increments `sqs_parse_errors_total{reason="malformed_payload"}`, is deleted, stores no rows, and does not increment `events_skipped_total`** (D7 regression — today it throws and the message is never deleted); `sqs_last_poll_timestamp_seconds` advances on success; a poll error increments `sqs_polls_total{outcome="error"}`, backs off, and does not exit the loop; correlation records `matched` when a `recipient_emails` row exists, `unmatched` when it does not, and `unmatched` when the event carries no `ses_message_id`; a `delivered` event records `severity="none"`; a `Send`/`DeliveryDelay` event increments `events_skipped_total`; `stop()` halts the loop and leaves no pending timer.
  - Use fake timers for the backoff and `start()`/`stop()` assertions.

- [ ] **14.3** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 15: Backward-compatibility contract tests

**Goal:** Prove the rewrite reproduces the captured Ghost-facing contract exactly, and diverges from the old implementation in exactly the intended ways.

All behavior under test now exists; the legacy implementation is still present as a reference, which is why this phase runs before the cutover.

### Tasks

- [ ] **15.1** Set up the contract harness
  - File: `test/helpers/normalize.ts`
  - `require` the single normalizer implementation from `scripts/normalize.cjs` rather than reimplementing it (Design Decision P9): `const { normalize, normalizeJson } = require('../../scripts/normalize.cjs') as { … };` One implementation means a drifting normalizer is impossible.
  - **Every supertest request in this file sets `Host: localhost:3003`** — `.set('Host', 'localhost:3003')` (Design Decision P8). `lib/events-api.js:129` builds `paging.next` from `req.headers.host`, and supertest binds an ephemeral port; without a pinned Host the captured URL can never reproduce, and design §8.4 forbids normalizing it.

- [ ] **15.2** Assert the non-HTTP captures
  - File: `test/contract.test.ts`
  - `mapSesEvent` output matches `captured/event-map-*.json` for every input in `captured/ses-event-inputs.json`.
  - `substituteVars` matches `captured/template-vars.json`.
  - `PRAGMA table_info` and `PRAGMA index_list` for all four tables match `captured/schema.json` — this is what guarantees the new build reads the existing `/data` volume unchanged.

- [ ] **15.3** Assert the HTTP captures
  - File: `test/contract.test.ts`
  - Seed the database from `captured/events-seed.json` and `captured/suppressions-seed.json` — the same fixed-id rows the capture used — so the `paging.next` cursor is a genuine reproducible assertion (Design Decision P7).
  - **The `/health` assertion runs against that seed and nothing else** — no `message_map` or `recipient_emails` rows, because the capture recorded `/health` before any send scenario ran (critique finding 7). The `_precondition` key in `captured/http-health.json` names the two seed files; honor it by running this assertion in a fresh database before the send assertions, not after.
  - Events, suppression, and send response bodies and status codes match `captured/http-*.json`, driven through supertest against `createApp(makeDeps())`.
  - **MIME:** replay the request field maps from `captured/send-scenarios.json` through supertest with `aws-sdk-client-mock` intercepting `SendRawEmailCommand`, and compare `input.RawMessage.Data.toString('utf8')` against `captured/mime-*.txt` under the normalizers. **Do not call `buildRawMime` directly** — the fixtures are the output of the whole pipeline (busboy parse → substitution → placeholder stripping → header collection → `buildRawMime`), so a direct unit call would require hand-reconstructing the computed options and would converge on "whatever makes it pass" (critique finding 3). The mock must return the same fixed `MessageId` the capture used.

- [ ] **15.4** Assert against `test/golden/intent/`
  - File: `test/contract.test.ts`
  - Ignore each fixture's `_meta` key. Each of these **fails if the rewrite accidentally preserved the defect**: a 200-day-old suppression survives cleanup while the other three tables purge at 90 days (D2); a redelivered SQS message inserts no duplicate event row and the id is the specified sha256 prefix (D3); `?event=a&event=b` returns 200 honoring the first value rather than 500 (D4); `limit=99999999` clamps to 1000 (D4); a throw inside the per-recipient send path releases its semaphore slot and the batch completes as `partial` with a 200 (D1); a `Delivery` payload with no `delivery` block maps to `[]` and the poller deletes the message and counts `malformed_payload` rather than throwing and leaving it queued (D7).
  - These overlap with the per-module regression tests by design — the module tests catch a local regression, these catch the contract-level one.

- [ ] **15.5** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 16: Shutdown, entrypoint, and package cutover

**Goal:** Graceful shutdown is tested code, `src/index.ts` is construction only, and `dist/index.js` replaces `server.js` as the entrypoint.

### Tasks

- [ ] **16.1** Implement the shutdown sequence as testable code
  - File: `src/shutdown.ts`
  - `createShutdownHandler({ server, poller, cleanupTimer, db, logger }): (signal: string) => Promise<void>`
  - Order: stop accepting connections (`server.close()`), `poller.stop()`, `clearInterval(cleanupTimer)`, `db.close()`, log one structured line, then exit. Guard against a second signal re-entering the sequence.
  - This lives outside `index.ts` because `index.ts` is excluded from coverage, and graceful shutdown is **new** behavior the design calls out as a feature — untested-by-construction is not acceptable for it (Design Decision P13, critique finding 11). Today the container is SIGKILLed mid-send.

- [ ] **16.2** Test the shutdown sequence
  - File: `test/shutdown.test.ts`
  - With stubbed collaborators: each of `server.close`, `poller.stop`, `clearInterval`, and `db.close` is called, **in that order**; a second signal does not run the sequence twice; a throwing collaborator does not prevent the remaining steps.

- [ ] **16.3** Implement the entrypoint
  - File: `src/index.ts`
  - The **only** file with side effects, and it must contain construction and wiring only: `loadConfig()` inside a try/catch that logs the `ConfigError` message and `process.exit(1)` (the one place the old `lib/config.js` exit behavior survives); `createLogger`; `new Registry()` + `createMetrics`; `createDb(config.dbPath, logger, metrics)`; `createStats` + `attachDbGauges`; `createSesClient`; `createApp`; `app.listen(config.port)`; `new SqsPoller(deps).start()`; `const cleanupTimer = scheduleCleanup(db, logger, metrics)`; and `process.on('SIGTERM'|'SIGINT', createShutdownHandler({…}))`.
  - **D6 stays pinned as-is** — `scheduleCleanup` does not run cleanup at startup (design §Defects, D6). A well-meaning "fix" here is out of scope.
  - Replace `server.js`'s five startup `console.log` lines with a single structured `info` line carrying `port`, `domain`, `region`, `configurationSet`, and `sendConcurrency`.

- [ ] **16.4** Flip the package entrypoint
  - File: `package.json`
  - `"main": "dist/index.js"` and `"start": "node dist/index.js"` (design §1).

- [ ] **16.5** Smoke-test the built entrypoint by hand
  - `npm run build`, then run `node dist/index.js` with a temporary `DB_PATH` (e.g. `/tmp/ses-proxy-smoke.db`) and placeholder AWS credentials.
  - Verify: the process starts and logs one JSON startup line with `level: "info"` as a **string**; `curl localhost:3003/health` returns the expected shape; `curl localhost:3003/metrics` returns exposition-format output including `ghost_ses_proxy_build_info`; sending `SIGTERM` exits cleanly with no dangling handles.
  - SES/SQS calls will fail against placeholder credentials — that is expected. Confirm the poller logs the error and backs off rather than exiting.
  - Record the observed startup log line in Observations.

- [ ] **16.6** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage` — all tests pass

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 17: Container, CI, and legacy removal

**Goal:** The image builds from `dist/`, CI runs the test suite, and the JavaScript implementation is deleted.

Deletion happens here rather than earlier because the Dockerfile's `COPY server.js` / `COPY lib/` and the CI smoke check both reference those files; splitting the two would leave `docker-build` red at a phase boundary (Design Decision P6).

### Tasks

- [ ] **17.1** Convert the Dockerfile to a multi-stage build
  - File: `Dockerfile`
  - Use the design §7 layout verbatim. Both stages are `node:20-alpine` so the `better-sqlite3` binding compiled in the builder is ABI-compatible with the runtime; `python3`, `make`, and `g++` stay in the builder and disappear from the final image.
  - Preserve `mkdir -p /data`, the `HEALTHCHECK`, `EXPOSE 3003`, and the container user (root) — design explicitly pins the user and `/data` volume layout, because changing either risks breaking the existing volume's permissions.
  - `COPY package.json ./` into the runtime stage is required — `getVersion()` resolves `../package.json` from `dist/`.

- [ ] **17.2** Update `.dockerignore`
  - Add `test/`, `coverage/`, `dist/`, `.github/`, `ralph/`.
  - It must **not** ignore `src/` or `tsconfig*.json` — the builder stage needs both.

- [ ] **17.3** Delete the JavaScript implementation
  - Delete `server.js` and all 10 files under `lib/`.
  - Keep `scripts/capture-golden.cjs`, `scripts/normalize.cjs`, and `scripts/Dockerfile.capture` — they are the reproducibility record (design §8.5), regenerable with `git checkout <sha> && docker build -f scripts/Dockerfile.capture …`, and never run in CI. `scripts/normalize.cjs` is additionally a runtime dependency of the contract test.

- [ ] **17.4** Add the CI test job
  - File: `.github/workflows/ci.yml`
  - New `test` job: `actions/setup-node@v4` with `node-version: '20'` and `cache: 'npm'`, then `npm ci`, `npm run typecheck`, `npm run test:coverage`. Coverage thresholds are enforced by `vitest.config.ts`, so a regression fails the job.
  - Update the `docker-build` job's smoke checks:
    - Replace the `server.js`/`lib/*.js` syntax check with **`node --check dist/index.js`**. Do **not** use a check that *loads* `dist/index.js`: per Phase 16.3 it calls `loadConfig()` and `process.exit(1)`, and the existing `docker run` passes no environment variables, so requiring it would turn `docker-build` red on every PR (critique finding 5). `node --check` is syntax-only, matching exactly what the current check proves.
    - Keep the dependency-resolution check and **add `pino`, `pino-http`, and `prom-client`** — the three new runtime dependencies, and the ones most likely to be lost to a misconfigured `npm prune --omit=dev` in the new multi-stage build. `uuid` is still used for batch message IDs; keep it.

- [ ] **17.5** Verify the image end-to-end
  - `docker build -t ghost-ses-proxy:verify .`
  - Confirm the runtime image no longer contains the build toolchain: `docker run --rm --entrypoint sh ghost-ses-proxy:verify -c 'which g++ make python3 || echo "toolchain absent"'`.
  - Run the container with placeholder credentials and a writable `/data`, and confirm `/health` and `/metrics` respond and the `HEALTHCHECK` passes.
  - Record the image size before/after the multi-stage change in Observations.

- [ ] **17.6** Build + test gate: `npm run typecheck && npm run build && npm run test:coverage && docker build -t ghost-ses-proxy:verify .` — all tests pass and the image builds

### Observations

<!-- Agent: write notes here during execution -->

---

## Phase 18: Documentation and final verification

**Goal:** Operator-facing docs match the new reality, and a full review pass confirms the implementation matches the design.

### Tasks

- [ ] **18.1** Update the environment examples
  - Files: `.env.example`, `docker-compose.example.yml`
  - Add `DB_PATH` (default `/data/ses-proxy.db`) to both.
  - Correct the `LOG_LEVEL` documentation: it was decorative and gated exactly one statement; it now gates every log call, accepts `trace|debug|info|warn|error|fatal`, and **rejects invalid values at startup**.

- [ ] **18.2** Update the README
  - File: `README.md`
  - Document: the `GET /metrics` endpoint and that it is unauthenticated on the internal network; the structured JSON log format and the `component`/`reqId` field schema; `npm start | npx pino-pretty` for local pretty-printing (and that `pino-pretty` is deliberately not an image dependency); `DB_PATH`; the corrected `LOG_LEVEL` semantics; the dev/test workflow (`npm run dev`, `npm test`, `npm run test:coverage`); and that the image is a drop-in replacement — same port, same env vars, same volume, same database file, rollback by re-pinning the previous tag.
  - Document the **one intentional response-shape change** (design §5.1): a send in which some recipients fail before their SES call now returns 200 with the successful recipients queued, rather than 500.

- [ ] **18.3** Design compliance review — metrics
  - Cross-check `src/metrics.ts` against design §4.1–§4.5 metric by metric: every name, type, and label set present, no extras, `ghost_ses_proxy_` prefix on application metrics only, defaults unprefixed. Confirm no label value can be unbounded or carry PII. Record any deviation and its justification in Observations.

- [ ] **18.4** Design compliance review — logging
  - Cross-check emitted log lines against design §3's field schema: `time`, `level` (string), `service`, `version`, `msg` on every line; `component` correct per module (`http`/`send`/`ses`/`sqs`/`events`/`suppression`/`db`/`config`); `reqId` propagated from HTTP into send and SES lines; `authorization` redacted; nothing written to stderr.
  - Confirm no `console.log`/`warn`/`error` survives anywhere in `src/`.

- [ ] **18.5** Design compliance review — pinned behavior
  - Confirm the "what stays the same — do not refactor" list from the design holds: every HTTP response body and status code except the §5.1 change, the SQLite schema, `buildRawMime` output byte-for-byte, `mapSesEvent`'s mapping table and fallback chain (the D7 guard changes only what happens on a malformed block), the base64 `{t, id}` cursor format, the container user and `/data` layout, and D6 left as-is.
  - Confirm all five defect fixes (D1, D2, D3, D4, D7) are present and each has both a unit regression test and a contract-level `intent/` assertion.

- [ ] **18.6** Coverage review
  - Confirm `npm run test:coverage` meets 90/90/90/85 with the only exclusions being `src/index.ts` and `src/types.ts`. If any `src/` file sits far below the threshold while the aggregate passes, add tests for it — the aggregate can hide an untested module.

- [ ] **18.7** Final build + test gate: `npm run typecheck && npm run build && npm run test:coverage && docker build -t ghost-ses-proxy:verify .` — all tests pass and the image builds

### Observations

<!-- Agent: write notes here during execution -->

---

## Files Changed Summary

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `scripts/Dockerfile.capture` | 0 | Throwaway image that runs the capture against the pre-rewrite tree |
| `scripts/normalize.cjs` | 0 | Single normalizer implementation shared by the harness and the contract test |
| `scripts/capture-golden.cjs` | 0, 1 | Golden capture harness (CommonJS); kept after the rewrite as the reproducibility record |
| `test/golden/captured/schema.json`, `event-map-*.json`, `template-vars.json`, `ses-event-inputs.json`, `events-seed.json`, `suppressions-seed.json` | 0 | Non-HTTP captures plus the seed and input artifacts later phases import |
| `test/golden/captured/http-*.json`, `mime-*.txt`, `send-scenarios.json` | 1 | HTTP response captures, raw MIME, and the request maps that reproduce them |
| `test/golden/captured/MANIFEST.json` | 2 | Git SHA, capture date, resolved dependency versions, per-file `anchoredBy` |
| `test/golden/REJECTED.md` | 2 | Candidates that failed the §8.1 eligibility gate, with reasons |
| `test/golden/intent/**` | 2 | Hand-authored fixtures encoding the *fixed* behavior for D1–D4 and D7 |
| `package-lock.json` | 3 | Required for `npm ci` in CI and Docker |
| `tsconfig.json`, `tsconfig.build.json` | 3 | Dev (incl. `test/`) and build (`src/` → `dist/`) configs |
| `vitest.config.ts` | 3 | Coverage thresholds and exclusions |
| `src/types.ts` | 3 | `Config`, `Deps`, `Db`, `SesClient`, `Metrics`, `Stats`, `SesEvent`, `NormalizedEvent` |
| `src/config.ts` | 3 | `loadConfig(env)`, `ConfigError`; `LOG_LEVEL` validation; `DB_PATH` |
| `test/config.test.ts` | 3 | Config loading and validation |
| `src/logger.ts` | 4 | pino factory, `getVersion()` |
| `src/metrics.ts` | 4 | `createMetrics(register)` — full §4 catalog + SES error allowlist |
| `test/logger.test.ts`, `test/metrics.test.ts` | 4 | Logger and metric catalog |
| `src/schema.ts` | 5 | DDL extracted verbatim from `lib/db.js` |
| `src/db.ts` | 5 | `createDb(path, logger, metrics)` |
| `test/db.test.ts` | 5 | Schema, dedupe semantics, error counting |
| `src/cleanup.ts` | 6 | 90-day cleanup (D2 fix), `scheduleCleanup`, metrics |
| `src/stats.ts` | 6 | TTL-cached table counts (D5) + `attachDbGauges` |
| `test/cleanup.test.ts`, `test/stats.test.ts` | 6 | D2 regression; scheduler argument binding; cache expiry |
| `src/template-vars.ts`, `src/event-mapper.ts` | 7 | Typed ports; D7 guard in the event mapper, logic otherwise preserved |
| `test/helpers/fixtures.ts` | 7 | Typed re-export of `captured/ses-event-inputs.json` + SNS variants |
| `test/template-vars.test.ts`, `test/event-mapper.test.ts` | 7 | Pure-function coverage |
| `src/semaphore.ts` | 8 | Typed semaphore with `runExclusive` (D1) |
| `src/mime.ts` | 8 | `buildRawMime` extracted, behavior preserved |
| `src/multipart.ts` | 8 | busboy form parsing extracted |
| `test/semaphore.test.ts`, `test/mime.test.ts`, `test/multipart.test.ts` | 8 | Incl. the D1 release-on-throw regression |
| `src/ses-client.ts` | 9 | `createSesClient`, timing + bounded error-type metrics |
| `src/middleware/auth.ts` | 9 | Port of `lib/auth.js` |
| `test/helpers/deps.ts` | 9 | `makeDeps(overrides?)` — full injected deps incl. `stats` |
| `test/ses-client.test.ts`, `test/middleware/auth.test.ts` | 9 | SES mocking; all six 401 paths |
| `src/middleware/observability.ts` | 10 | pino-http + HTTP metrics, route-template labeling |
| `test/middleware/observability.test.ts` | 10 | Route-template and PII/cardinality regression |
| `src/routes/health.ts`, `src/routes/metrics.ts` | 11 | Unauthenticated endpoints |
| `src/app.ts` | 11 | `createApp(deps)` — routes and middleware, never listens |
| `test/routes/health.test.ts`, `test/routes/metrics.test.ts` | 11 | Exact `/health` shape; exposition format |
| `src/routes/suppression.ts`, `src/routes/events.ts` | 12 | Ports; D4 fix in events |
| `test/routes/suppression.test.ts`, `test/routes/events.test.ts` | 12 | Incl. D4 regressions |
| `src/routes/send-email.ts` | 13 | Handler, D1 fix (release **and** report), instrumented |
| `test/routes/send-email.test.ts` | 13 | Full send path incl. the D1 wedge regression |
| `src/sqs-poller.ts` | 14 | `SqsPoller` class, D3 fix, instrumented |
| `test/sqs-poller.test.ts` | 14 | Incl. the D3 redelivery regression |
| `test/helpers/normalize.ts` | 15 | Thin typed wrapper over `scripts/normalize.cjs` |
| `test/contract.test.ts` | 15 | Asserts both fixture sets |
| `src/shutdown.ts` | 16 | `createShutdownHandler` — graceful shutdown as testable code |
| `test/shutdown.test.ts` | 16 | Shutdown ordering and re-entrancy |
| `src/index.ts` | 16 | Entrypoint: construction and wiring only |

### Modified Files

| File | Phases | Changes |
|------|--------|---------|
| `ralph/projects/code-instrumentation/design.md` | — | Backfilled during planning and after the critique: §8.3 harness constraints (CommonJS, macrotask SQS mock) and `.mjs` → `.cjs`; §5.1 the D1 `try/catch` requirement and its wire-contract change; §5.3 the timestamp-fallback limitation; **D7 added to the defect table with fix §5.5, the `sqs_parse_errors_total` reason enum, the §8.2 exclusion row, the test-plan rows, and resolved Open Question 10**; the `lib/event-mapper.js` and `lib/send-email.js` rows and the "Interaction with Existing Code" preamble |
| `package.json` | 3, 16 | Phase 3 adds deps, devDeps, and scripts; Phase 16 flips `main` and `start` to `dist/index.js` |
| `.gitignore` | 3 | Add `dist/`, `coverage/`, `*.tsbuildinfo` |
| `src/types.ts` | 3, 7 | Created in 3; `NormalizedEvent`/`SesEvent` refined alongside the event mapper |
| `src/app.ts` | 11, 12, 13 | Created in 11; `/v3` routes wired in as 12 and 13 add them |
| `Dockerfile` | 17 | Multi-stage; runtime image loses python3/make/g++ |
| `.dockerignore` | 17 | Add `test/`, `coverage/`, `dist/`, `.github/`, `ralph/` |
| `server.js`, `lib/*.js` (11 files) | 17 | **Deleted** — replaced by `src/` |
| `.github/workflows/ci.yml` | 17 | Add the `test` job; `node --check dist/index.js`; extend the dependency check |
| `.env.example` | 18 | Add `DB_PATH`; correct `LOG_LEVEL` docs |
| `docker-compose.example.yml` | 18 | Add `DB_PATH` |
| `README.md` | 18 | Document `/metrics`, log format, `DB_PATH`, dev/test workflow, the §5.1 response change |

---

## Open Questions

None. The one question raised by the planning review — how a malformed SES payload should be handled, given that strict TypeScript forces the choice — was resolved as **discard and count it**, and is now recorded in `design.md` as defect **D7** with its fix in §5.5 and its rationale in resolved Open Question 10. It is treated as a fifth in-scope defect fix, with a unit regression in Phase 7.5, a poller regression in Phase 14.2, and an `intent/` fixture asserted by the contract suite in Phase 15.4.
