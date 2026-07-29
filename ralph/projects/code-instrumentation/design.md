# Code Instrumentation — Design Specification

> **Status:** Final (all open questions resolved)
> **Date:** 2026-07-28

## Goal

Convert `ghost-ses-proxy` from untyped, unobservable JavaScript into a TypeScript service that emits structured JSON logs and Prometheus metrics, backed by a high-coverage unit test suite. The outcome is that a failed or partially-failed newsletter — and a silently-wedged SQS poller — become alertable in Grafana within minutes instead of being invisible until someone notices subscribers didn't receive an email.

## Current State

**What exists:**

- 1,010 lines of ES5-style CommonJS JavaScript across `server.js` (51) and `lib/*.js` (10 files). `var` everywhere, `function`-style callbacks, no types, no build step — `node server.js` runs the source directly.
- **Logging:** 19 bare `console.log/warn/error` call sites. Unstructured English prose built by string concatenation, no timestamps, no level field, no request IDs. `console.log` → stdout; `console.warn`/`console.error` → stderr (Node aliases `warn` to `error`).
- **`LOG_LEVEL`** is read in `lib/config.js:10` but gates exactly one statement in the entire codebase (`lib/send-email.js:248`). It cannot quiet anything.
- **No HTTP access logging.** No `morgan`, no middleware. A request that 401s in `lib/auth.js` produces zero log output.
- **No metrics.** No `prom-client`, no `/metrics` route. The full route table is `GET /health`, `POST /v3/:domain/messages`, `GET /v3/:domain/events[/:pageToken]`, `DELETE /v3/:domain/:type/:email`.
- **No tests, no test framework, no coverage tooling, no lockfile.** `package.json` has one script (`start`). CI (`.github/workflows/ci.yml`, added 2026-07-27) builds the image and runs two smoke checks; it proves nothing about behavior.
- **Module-scope side effects everywhere:** `lib/db.js:3` opens `/data/ses-proxy.db` at import; `lib/config.js:26` calls `process.exit(1)` at import; `lib/ses-client.js:4` and `lib/sqs-poller.js:7` construct AWS clients at import; `lib/db.js:107` registers a `setInterval`; `server.js:44` calls `app.listen()`.

**Problems:**

1. A newsletter send that fails or partly fails is invisible to monitoring. The only trace is an unstructured stderr line that nothing alerts on.
2. The SQS poller can die or wedge and nothing notices — events stop flowing, Ghost's analytics silently freeze. This is the same failure class already observed on the Mailgun side (Ghost logging `Opened events processing is 159373.6 minutes behind`).
3. SES reputation risk (bounce/complaint rates) is unmeasurable, despite the data existing in the `events` table.
4. Nothing can be unit tested. Importing any module opens a database at an absolute path, constructs AWS clients, or exits the process.
5. No type safety across a codebase whose core job is reshaping loosely-typed JSON between two third-party API contracts (Mailgun ⇄ SES).

### Defects discovered while designing

| # | Defect | Severity | Resolution |
|---|--------|----------|------------|
| D1 | **Semaphore slot leak → permanent wedge.** `lib/send-email.js:204` acquires a slot, but `release()` only runs in a `.finally()` chained onto `sendRawEmail(...)`. Anything that throws *before* that call (`substituteVars`, `buildRawMime`, `JSON.stringify`, a `Buffer.from` OOM) rejects the `.then` callback without releasing. After `SEND_CONCURRENCY` such failures the semaphore has zero slots and every subsequent send hangs forever — no response to Ghost, no error logged, `/health` still returns 200. | **High** — silent unrecoverable wedge | **Fixed by construction** (§5.1). The rewrite uses `try/finally`; a new `send_in_flight` gauge makes the condition alertable. |
| D2 | **Suppressions expire after 90 days.** `lib/db.js:102` includes `suppressions` in the 90-day cleanup. Permanent bounces and spam complaints must never expire — letting them lapse means re-mailing addresses that hard-bounced, which is precisely what degrades SES sending reputation. | **High** — data loss with reputational consequence | **Fix in scope** (§5.2) |
| D3 | **Duplicate events on SQS redelivery.** `lib/sqs-poller.js:54` assigns each event row a fresh `uuidv4()` primary key, so the `INSERT OR IGNORE` in `lib/db.js:78` can never dedupe. If `DeleteMessageCommand` fails after processing (network blip, expired receipt handle), SQS redelivers and the same delivery/open is inserted again, inflating Ghost's analytics. | **Medium** | **Fix in scope** (§5.3) — deterministic content-derived event ID |
| D4 | **Repeated query parameter 500s the events API.** `lib/events-api.js:17` calls `.split(' OR ')` on `req.query.event`. Express parses `?event=a&event=b` into an array, so `.split` is undefined → `TypeError` → 500. Same for `tags` at line 23. `limit` is also unclamped (`?limit=99999999` is honored). | **Low** — only Ghost calls this endpoint | **Fix in scope** (§5.4) |
| D5 | **`/health` runs four unindexed `COUNT(*)` scans per call**, and the Dockerfile sets `HEALTHCHECK --interval=30s` — 2,880 full-table scan sets per day. Harmless at current volume; grows with the `events` table. | Cosmetic | **Fixed incidentally** (§4.6) — shared TTL-cached stats module serves both `/health` and metrics |
| D6 | `lib/db.js:107` registers `setInterval(cleanup, 86400000)` but never runs cleanup at startup, so a container restarted more often than daily never cleans up. | Cosmetic | Pin as-is; out of scope. Noted so the agent does not "fix" it silently. |
| D7 | **Malformed SES payload poisons the poller permanently.** `lib/event-mapper.js:18-26` dereferences `sesEvent.delivery.recipients`, `sesEvent.bounce.bouncedRecipients`, and `sesEvent.complaint.complainedRecipients` with no guard — while `mapSesEvent:79` *does* guard `sesEvent.bounce &&` for `bounceType`. A payload missing its event block therefore throws a `TypeError`, which rejects the chain in `lib/sqs-poller.js:120-124` and escapes `pollOnce` **without ever calling `deleteMessage`**. The message returns to the queue on visibility timeout, throws again, and repeats forever: events stop flowing and Ghost's analytics silently freeze — the exact failure this project exists to detect. Not reachable from anything SES actually emits; requires a malformed or truncated message. | **Medium** — silent unrecoverable stall | **Fix in scope** (§5.5) — discovered during planning review |

## Design Sections

### 1. TypeScript migration

| Choice | Selection | Rationale / rejected alternatives |
|--------|-----------|-----------------------------------|
| Compiler | **`tsc` only**, no bundler | This is a server, not a distributed library. `tsc` is the reference implementation and keeps stack traces honest via source maps. Rejected: `tsup`/`esbuild` (bundling adds a layer for zero deployment benefit). |
| Module system | **CommonJS** output, `target: ES2022` | `better-sqlite3` is a CJS-only native addon; `express@4` and `busboy` are CJS. ESM would require `createRequire` shims for no gain. Rejected: ESM. |
| Strictness | `strict: true`, `noUncheckedIndexedAccess: true` | The codebase's job is parsing untrusted third-party JSON; indexed-access checking is where the value is. |
| Layout | `src/**/*.ts` → `dist/`, tests in `test/**/*.test.ts` | `test/` outside `rootDir` keeps `dist/` clean without extra build config. Rejected: co-located `*.test.ts` (needs build-time exclusion config). |
| Config split | `tsconfig.json` (dev, includes `test/`) + `tsconfig.build.json` (`extends`, includes only `src/`, emits `dist/`) | Editor/test tooling sees tests; the Docker build does not. |
| Lockfile | **Add `package-lock.json`** (currently absent) | Required for `npm ci` in CI and Docker — reproducible builds and dependency caching. |
| Express version | **Stay on `express@4`** | Upgrading to 5 is a separate concern with its own breaking changes. Explicitly out of scope. |
| Linting | **None** | ESLint/Prettier are out of scope. `tsc --noEmit` in CI is the static gate. |

New dev dependencies: `typescript`, `@types/node`, `@types/express`, `@types/better-sqlite3`, `tsx` (watch-mode dev server), `vitest`, `@vitest/coverage-v8`, `supertest`, `@types/supertest`, `aws-sdk-client-mock`.

New runtime dependencies: `pino`, `pino-http`, `prom-client`.

`busboy`, `uuid`, and both `@aws-sdk/*` packages ship their own types — no `@types/*` needed.

npm scripts:

```json
"build":         "tsc -p tsconfig.build.json",
"start":         "node dist/index.js",
"dev":           "tsx watch src/index.ts",
"typecheck":     "tsc --noEmit",
"test":          "vitest run",
"test:watch":    "vitest",
"test:coverage": "vitest run --coverage"
```

### 2. Dependency-injection seams (the enabling change)

Nothing in the current codebase is testable because importing it has side effects. Every module becomes a factory that receives its collaborators. This is the prerequisite for §7, not a stylistic preference.

```ts
// src/types.ts
export interface Deps {
  config: Config;
  logger: Logger;      // pino.Logger
  metrics: Metrics;
  db: Db;
  ses: SesClient;
}
```

| Module | Before | After |
|--------|--------|-------|
| `config.ts` | Module-level object; `process.exit(1)` on missing vars | `loadConfig(env: NodeJS.ProcessEnv = process.env): Config`, **throws `ConfigError`**. Only `index.ts` catches it and exits 1. |
| `db.ts` | Opens `/data/ses-proxy.db` at import | `createDb(path: string, logger: Logger): Db` returning `{ raw, insertMessageMap, …, close() }`. Tests pass `':memory:'`. |
| `ses-client.ts` | Constructs `SESClient` at import | `createSesClient(config, deps): SesClient` — the underlying `SESClient` is injectable so `aws-sdk-client-mock` can intercept. |
| `sqs-poller.ts` | `startPolling()` with an unstoppable recursive loop | `class SqsPoller` with `pollOnce()`, `start()`, `stop()`. Tests drive `pollOnce()` directly. |
| `app.ts` | `server.js` calls `app.listen()` at import | `createApp(deps): express.Express` — returns the app, never listens. |
| `index.ts` | — | **New.** Loads config, builds deps, creates app, `listen()`s, starts the poller, installs signal handlers. The only file with side effects. |

`index.ts` gains graceful shutdown (new behavior): on `SIGTERM`/`SIGINT` it stops accepting connections, stops the poller, closes the database, and exits. Today the container is SIGKILLed mid-send.

### 3. Structured logging

**Library: `pino` + `pino-http`.** Rejected: `winston` (heavier, slower, larger config surface for no feature we need), `bunyan` (effectively unmaintained), hand-rolled `JSON.stringify` (reinvents levels, serializers, and redaction — badly).

```ts
// src/logger.ts
export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'ghost-ses-proxy', version: getVersion() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),   // string, not pino's numeric default
    },
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  });
}
```

Three decisions that matter operationally:

1. **String level labels, not pino's numeric default.** Alloy's `normalize` stage derives level from a greedy keyword regex and Loki's `detected_level` fires on the substring `error`. An explicit string `level` field overrides both, so a line reading `stored 3 event(s) [Bounce]` stops being classified as an error.
2. **ISO-8601 timestamps** rather than epoch millis — readable in Loki without a transform.
3. **Everything to stdout**, including errors. This is a deliberate change from today's stdout/stderr split: a single stream preserves ordering, and the `level` field carries the severity that the stream used to imply. Writes are synchronous — at ~30 log lines per newsletter, sync costs nothing and removes the lost-logs-on-crash failure mode.

**Field schema.** Every line carries `time`, `level`, `service`, `version`, `msg`. Beyond that:

| Field | Type | Where | Meaning |
|-------|------|-------|---------|
| `component` | string | all | Child-logger binding: `http` \| `send` \| `ses` \| `sqs` \| `events` \| `suppression` \| `db` \| `config` |
| `reqId` | string | http | Per-request UUID, propagated into send/SES lines |
| `batchId` | string | send, ses | `batch_message_id` without angle brackets |
| `ghostEmailId` | string | send, sqs | Ghost's `v:email-id` |
| `recipient` | string | send, ses, sqs | Full email address (resolved: log in full) |
| `sesMessageId` | string | ses, sqs | SES `MessageId` |
| `eventType` | string | sqs | Normalized event (`delivered`, `failed`, …) |
| `sesEventType` | string | sqs | Raw SES type (`Delivery`, `Bounce`, …) |
| `recipientCount`, `succeeded`, `failed` | number | send | Batch outcome |
| `durationMs` | number | http, ses | Elapsed time |
| `err` | object | any | pino's standard error serializer |

**HTTP access logs** come from `pino-http` with `genReqId: () => randomUUID()`, `customLogLevel` mapping 4xx→`warn` / 5xx→`error`, and trimmed serializers (method, url, route, statusCode, responseTime only). `autoLogging.ignore` **excludes `/health` and `/metrics`** — otherwise the 30-second healthcheck alone writes 2,880 lines/day into Loki.

`LOG_LEVEL` becomes real: pino gates every call site, so `LOG_LEVEL=warn` genuinely quiets the service. Local pretty-printing is `npm start | npx pino-pretty` — `pino-pretty` is deliberately **not** a dependency of the image.

### 4. Prometheus metrics

**Library: `prom-client`.** The de-facto standard; nothing else is seriously considered.

`GET /metrics` is served **unauthenticated**, matching `/health`. The container is reachable only on the internal Docker network — Traefik never routes it — and requiring the `PROXY_API_KEY` would force the credential into Prometheus scrape config for no gain.

**Registry is injected, never global.** `createMetrics(register: Registry): Metrics`. prom-client's default global registry throws `A metric with the name … has already been registered` when a second test file constructs the same metric; per-test registries eliminate that entire class of flake.

Default Node/process metrics come from `collectDefaultMetrics({ register })` with **no prefix**, so `process_cpu_seconds_total` and `nodejs_eventloop_lag_seconds` keep their conventional names. Only application metrics carry the `ghost_ses_proxy_` prefix.

#### 4.1 HTTP

| Metric | Type | Labels |
|--------|------|--------|
| `ghost_ses_proxy_http_requests_total` | counter | `method`, `route`, `status_code` |
| `ghost_ses_proxy_http_request_duration_seconds` | histogram | `method`, `route`, `status_code` |

Buckets: `[0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30]` — a fan-out send legitimately takes seconds.

**Cardinality safety is critical here.** The `route` label uses the Express *template* (`req.baseUrl + req.route.path` → `/v3/:domain/messages`), captured on `res.on('finish')`. When no route matched — 404s, and 401s rejected by the `/v3` auth middleware before routing — the label is the literal string `unmatched`. The raw path must **never** be used: `DELETE /v3/:domain/:type/:email` embeds a subscriber's email address, which would make cardinality unbounded and leak PII into Prometheus. The accepted cost is that a 401's originating route is not distinguishable; the status-code count still is.

#### 4.2 Send path

| Metric | Type | Labels | Notes |
|--------|------|--------|-------|
| `ghost_ses_proxy_send_batches_total` | counter | `outcome` ∈ `success`\|`partial`\|`failure`\|`rejected` | `rejected` = 400 validation failure |
| `ghost_ses_proxy_send_recipients_total` | counter | `outcome` ∈ `sent`\|`failed` | |
| `ghost_ses_proxy_send_batch_recipients` | histogram | — | Buckets `[1,5,10,25,50,100,250,500,1000]` |
| `ghost_ses_proxy_ses_send_duration_seconds` | histogram | `outcome` ∈ `success`\|`error` | Per-recipient `SendRawEmail` latency |
| `ghost_ses_proxy_ses_errors_total` | counter | `error_type` | |
| `ghost_ses_proxy_send_in_flight` | gauge | — | Semaphore slots held — the **D1 canary** |
| `ghost_ses_proxy_send_queue_depth` | gauge | — | Senders waiting on a slot |

`error_type` is mapped through a fixed allowlist to bound cardinality — `Throttling`, `MessageRejected`, `MailFromDomainNotVerifiedException`, `ConfigurationSetDoesNotExistException`, `AccountSendingPausedException`, `LimitExceededException`, `TimeoutError` — with everything else collapsing to `other`. Raw `err.name` values from the AWS SDK are not a bounded set.

#### 4.3 SQS poller and events

| Metric | Type | Labels |
|--------|------|--------|
| `ghost_ses_proxy_sqs_polls_total` | counter | `outcome` ∈ `success`\|`error` |
| `ghost_ses_proxy_sqs_poll_duration_seconds` | histogram | — |
| `ghost_ses_proxy_sqs_messages_received_total` | counter | — |
| `ghost_ses_proxy_sqs_messages_deleted_total` | counter | `outcome` ∈ `success`\|`error` |
| `ghost_ses_proxy_sqs_parse_errors_total` | counter | `reason` ∈ `invalid_json`\|`unrecognized_format`\|`malformed_payload` |
| `ghost_ses_proxy_sqs_last_poll_timestamp_seconds` | gauge | — |
| `ghost_ses_proxy_events_stored_total` | counter | `event_type`, `severity` |
| `ghost_ses_proxy_events_skipped_total` | counter | `ses_event_type` |
| `ghost_ses_proxy_event_correlation_total` | counter | `result` ∈ `matched`\|`unmatched` |
| `ghost_ses_proxy_event_lag_seconds` | histogram | — |

Three of these deserve justification:

- **`sqs_last_poll_timestamp_seconds`** is the single most valuable metric in this design. It is the only way to distinguish "no events because no email was sent" from "no events because the poller is dead" — the silent-analytics-death failure mode. It follows the same shape as the existing `media_backup_last_success_timestamp_seconds` convention.
- **`event_correlation_total{result="unmatched"}`** counts events whose `ses_message_id` found no row in `recipient_emails`. A rising unmatched rate means events are being stored without batch/Ghost correlation, so Ghost's per-newsletter analytics quietly degrade while everything else looks healthy.
- **`event_lag_seconds`** (`now − event.timestamp` at insert) measures how far behind SES/SNS delivery is, distinguishing a slow pipeline from a stopped one.

`event_type` × `severity` yields ~7 real combinations (`delivered`/`none`, `opened`/`none`, `clicked`/`none`, `complained`/`none`, `failed`/`permanent`, `failed`/`temporary`) — bounded.

#### 4.4 Suppressions

| Metric | Type | Labels |
|--------|------|--------|
| `ghost_ses_proxy_suppressions_recorded_total` | counter | `type` ∈ `bounces`\|`complaints`\|`unsubscribes` |
| `ghost_ses_proxy_suppressions_removed_total` | counter | `type` |

`suppressions_removed_total` counts **rows actually deleted**, not delete requests. Ghost issues `DELETE /v3/:domain/:type/:email` for addresses that were never suppressed and the endpoint answers 200 either way, so counting requests would let the series report removals that did not happen. A no-op delete increments nothing and creates no series.

#### 4.5 Database and build

| Metric | Type | Labels |
|--------|------|--------|
| `ghost_ses_proxy_db_rows` | gauge | `table` |
| `ghost_ses_proxy_db_size_bytes` | gauge | — |
| `ghost_ses_proxy_db_errors_total` | counter | `operation` |
| `ghost_ses_proxy_db_cleanup_runs_total` | counter | `outcome` |
| `ghost_ses_proxy_db_cleanup_deleted_rows_total` | counter | `table` |
| `ghost_ses_proxy_build_info` | gauge (=1) | `version`, `node_version` |

`build_info` ties the running container to a release-please version, so Grafana can show which build is live.

#### 4.6 Shared stats collector (also fixes D5)

`db_rows` and `/health` need the same four `COUNT(*)` results. A single TTL-cached module serves both:

```ts
// src/stats.ts
export function createStats(db: Db, ttlMs = 15_000) {
  let cache: { at: number; counts: TableCounts } | null = null;
  return {
    getCounts(now: number = Date.now()): TableCounts {
      if (cache && now - cache.at < ttlMs) return cache.counts;
      const counts = { /* four COUNT(*) queries */ };
      cache = { at: now, counts };
      return counts;
    },
  };
}
```

The `now` parameter is injected so tests control expiry without fake timers. `db_rows` is populated via a prom-client `Gauge` `collect()` callback that calls `getCounts()`. Net effect: the healthcheck and the Prometheus scrape share one set of scans per 15 seconds instead of each running their own.

#### 4.7 Alerting intent

**No dashboard is produced** — per the project brief, dashboard JSON cannot be validated here. The expressions below are *intent*, recorded so metric shapes are chosen deliberately; authoring the actual rules belongs to the `grafana-alerting-as-code` project and is out of scope.

| Condition | Expression sketch | Why it matters |
|---|---|---|
| Proxy down | `up{job="ghost-ses-proxy"} == 0` for 5m | Newsletters fail outright |
| **Poller stalled** | `time() - ghost_ses_proxy_sqs_last_poll_timestamp_seconds > 300` | Analytics silently freeze |
| **Newsletter failed** | `increase(ghost_ses_proxy_send_batches_total{outcome="failure"}[15m]) > 0` | The original 2026-07-27 incident |
| Partial delivery | `increase(ghost_ses_proxy_send_batches_total{outcome="partial"}[15m]) > 0` | Some subscribers silently missed |
| **Bounce rate** | `failed/permanent ÷ delivered > 0.05` over 24h | SES suspends accounts above 5% |
| **Complaint rate** | `complained ÷ delivered > 0.001` over 24h | SES threshold is 0.1% |
| Semaphore wedge (D1) | `send_in_flight >= SEND_CONCURRENCY` for 10m while `rate(send_recipients_total[10m]) == 0` | Detects the leak class directly |
| SES throttling | `increase(ses_errors_total{error_type="Throttling"}[5m]) > 0` | Sending-rate cap hit |
| Correlation decay | `rate(event_correlation_total{result="unmatched"}[1h]) / rate(event_correlation_total[1h]) > 0.1` | Ghost analytics degrading |

### 5. Defect fixes

#### 5.1 D1 — semaphore leak (fixed by construction)

`Semaphore` moves to `src/semaphore.ts` as a typed class with an added `runExclusive<T>(fn: () => Promise<T>): Promise<T>` helper that wraps `acquire`/`release` in `try/finally`. The send path calls only `runExclusive`, so no code path can hold a slot past its callback. `inFlight` and `queueDepth` are exposed as readonly properties feeding the gauges in §4.2.

**`runExclusive` alone is not sufficient, and it carries a wire-contract change.** `try/finally` releases the slot but re-throws, so a throw before the SES call would still reject `Promise.all` and land in the handler's outer catch — today's `500 {message: 'Internal server error: …'}`. To reach the outcome §8.2 pins for D1 (the slot is released *and* the batch completes as `partial`), the per-recipient callback body must additionally carry its own `try/catch` that converts **any** throw — not just a `sendRawEmail` rejection — into `failed++` plus an `errors[]` entry, exactly as the current code already does for SES rejections alone.

This is the one place the rewrite deliberately changes the Ghost-facing contract. A batch in which some recipients throw before their SES call currently returns `500 Internal server error` and loses the successful sends from the response; afterwards it returns `200 Queued. Thank you.` (or `500 Failed to send to all recipients` with a populated `errors[]` when every recipient throws). The change is intended: reporting a partly-successful newsletter as a total server error is the reporting defect that made the original incident hard to read.

#### 5.2 D2 — suppressions must not expire

Remove `suppressions` from the cleanup statement list in `cleanup.ts`. The three ephemeral correlation tables (`message_map`, `recipient_emails`, `events`) keep the 90-day window; `suppressions` becomes permanent. Deletion remains possible only through the explicit `DELETE /v3/:domain/:type/:email` endpoint, which is the documented Mailgun-compatible way for Ghost to un-suppress an address.

#### 5.3 D3 — deterministic event IDs

Replace `uuidv4()` for the event primary key with a content hash, so the existing `INSERT OR IGNORE` actually dedupes SQS redeliveries:

```ts
function eventId(n: NormalizedEvent): string {
  return createHash('sha256')
    .update([n.ses_message_id ?? '', n.event_type, n.recipient, String(n.timestamp)].join(' '))
    .digest('hex')
    .slice(0, 32);
}
```

Trade-off, accepted: two genuinely distinct events of the same type for the same recipient at the identical timestamp collapse into one row. `getTimestamp()` preserves millisecond resolution (`new Date(iso).getTime() / 1000` yields a float), so a real collision requires two same-type events in the same millisecond — far less likely than the redelivery duplication it prevents.

**Known limitation.** `getTimestamp()` ends its fallback chain at `Date.now() / 1000` when neither the per-event block nor `mail.timestamp` supplies a timestamp. An event arriving with no timestamp at all therefore hashes differently on every redelivery and still duplicates, exactly as today. The fix covers every event SES actually emits — all of which carry a timestamp — but it is not unconditional, and the regression test must use a fixture with an explicit timestamp so it is not accidentally asserting the un-fixed path.

Note this changes the `id` values returned by the events API. Ghost treats them as opaque cursors, and the table is ephemeral (90-day cleanup), so no migration is required — existing UUID-keyed rows coexist and age out.

#### 5.4 D4 — query-parameter hardening

A `firstString(v: unknown): string` helper coerces possibly-array query params (`Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : ''`) and is applied to `event` and `tags`. `limit` is clamped to `[1, 1000]`.

#### 5.5 D7 — malformed payloads must not poison the poller

`getRecipients` guards every optional event block, so a payload missing `delivery`, `bounce`, or `complaint` yields **no recipients rather than a `TypeError`**, and `mapSesEvent` returns `[]`. The poller treats an empty result from a *recognized* `eventType` the same way it treats an unrecognized envelope: nothing is stored, the message **is deleted**, and `sqs_parse_errors_total{reason="malformed_payload"}` is incremented alongside a `warn` line carrying `sesEventType` and `sesMessageId`.

This is deliberately distinct from the existing skip path. `Send` and `DeliveryDelay` are *expected* to produce no events and increment `events_skipped_total`; a `Delivery` with no `delivery` block is a defect in the input and must be counted as a parse error so the two never share a denominator.

Trade-off, accepted: a message that would previously have been retried is now discarded. Since the failure is deterministic — the same payload throws identically on every redelivery — retrying could only ever re-throw, so nothing recoverable is lost. Discarding converts an unbounded stall into a single counted event, which is the whole point. The distinction matters operationally: `malformed_payload` rising is a signal that SES or SNS changed a payload shape, and it is the one parse-error reason that warrants investigation rather than a shrug.

### 6. Configuration changes

| Variable | Status | Notes |
|----------|--------|-------|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_QUEUE_URL`, `PROXY_API_KEY`, `MAILGUN_DOMAIN` | unchanged, still required | `loadConfig` throws `ConfigError` listing all missing vars instead of `process.exit(1)` |
| `AWS_REGION`, `SES_CONFIGURATION_SET`, `PORT`, `SEND_CONCURRENCY` | unchanged, same defaults | |
| `LOG_LEVEL` | **behavior change** | Was decorative; now gates every log call. Valid: `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`. Invalid values throw at startup. Default `info`. |
| `DB_PATH` | **new** | Default `/data/ses-proxy.db`. Exists so tests can pass `:memory:`; also makes the path configurable in compose. |

`.env.example`, `docker-compose.example.yml`, and `README.md` are updated for `DB_PATH`, the corrected `LOG_LEVEL` semantics, and the new `/metrics` endpoint.

### 7. Docker and CI

**Dockerfile becomes multi-stage.** The current single stage ships `python3`, `make`, and `g++` in the runtime image because `better-sqlite3` needs them to compile. Building in a separate stage and copying the already-compiled `node_modules` drops all three from the final image:

```dockerfile
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/dist dist/
COPY package.json ./
RUN mkdir -p /data
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --spider -q http://localhost:${PORT:-3003}/health || exit 1
EXPOSE 3003
CMD ["node", "dist/index.js"]
```

Both stages use `node:22-alpine`, so the native binding compiled in the builder is ABI-compatible with the runtime.

**Runtime version and the pins that must move with it.** The image was originally specified as `node:20-alpine`; it moved to 22 after the post-execution review, because the AWS SDK now warns that releases published after January 2027 require Node ≥22, and this is the cheap moment to move. Four things are a single coupled decision and must never drift apart: the two `FROM` lines, `engines.node`, the CI `test` job's `node-version`, and the `@types/node` major. Typings describing a newer runtime than the image ships is precisely the defect the review caught — a post-runtime API would typecheck, pass the suite on a developer's newer Node, and first fail at container startup, most likely inside the coverage-excluded `src/index.ts`.

`scripts/Dockerfile.capture` is the deliberate exception and **stays on `node:20-alpine`**. It reproduces the golden fixtures against the pre-rewrite tree, and `captured/MANIFEST.json` records node v20.20.2 as the environment those fixtures came from; bumping it would silently invalidate the reproducibility claim in §8.5.

`ENV NODE_ENV=production` is set in the runtime stage only. Express uses it to suppress the stack-trace-bearing HTML error page on an unhandled throw. It must not be set in the builder, where it would make `npm ci` skip the devDependencies `npm run build` needs.

**`.dockerignore`** adds `test/`, `coverage/`, `dist/`, `.github/`, `ralph/` — and must **not** ignore `src/` or `tsconfig*.json`, which the builder needs.

**`.gitignore`** adds `dist/`, `coverage/`, `*.tsbuildinfo`.

**CI (`.github/workflows/ci.yml`)** gains a `test` job running before/alongside `docker-build`:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: '20', cache: 'npm' }
- run: npm ci
- run: npm run typecheck
- run: npm run test:coverage
```

Coverage thresholds are enforced by Vitest config (below), so a regression fails the job. The existing `docker-build` job's smoke checks are updated from `server.js`/`lib/*.js` to `dist/`. Codecov upload is optional — the org already exposes `CODECOV_TOKEN` to all repos — and is not required by this design.

### 8. Golden fixture capture (mandatory execution phase 1)

The rewrite deletes every source file, so the only defensible safety net is a set of fixtures captured from the **current implementation before any TypeScript is written**. This is a hard ordering constraint: phase 1 captures and commits fixtures; no `src/` file may be created until it has landed.

The difficulty is that current behavior is not uniformly correct — D1–D4 are defects. Capturing indiscriminately would pin them as contract. Every candidate therefore passes an explicit gate.

#### 8.1 Eligibility gate

A behavior is **golden-eligible** only if all four hold:

| # | Gate | How the agent checks it |
|---|------|------------------------|
| 1 | **Not defect-tainted** | Not listed in the Defect Exclusion Table (§8.2). |
| 2 | **Contract-anchored** | Its shape is required by a nameable external consumer — Ghost's `mailgun.js` client, the Mailgun API contract, or SES's raw-message requirements. "That is what the code does" is not a justification; each captured file records which consumer requires it. |
| 3 | **Deterministic** | Two consecutive capture runs produce identical output after the §8.4 normalizers. Any remaining variance means normalize or exclude. |
| 4 | **Recorded** | Anything failing 1–3 is written to `test/golden/REJECTED.md` with the reason, never silently dropped. |

Fixtures are split so a later reader can always tell what a file asserts:

- **`test/golden/captured/`** — recorded from the current implementation. These pin *observed* behavior.
- **`test/golden/intent/`** — hand-authored expected values for defect-tainted surfaces. These pin *fixed* behavior and must each carry a header naming the defect (`D2`, `D3`, …) and the design section specifying the fix.

#### 8.2 Defect Exclusion Table — never capture these

| Surface | Why excluded | What to write instead |
|---|---|---|
| Semaphore/concurrency state after a per-recipient throw (**D1**) | Current behavior is an unrecoverable hang. There is no correct output to capture. | `intent/`: the slot is released and the batch completes as `partial`. |
| `cleanup()` effect on the `suppressions` table (**D2**) | Current behavior deletes rows that must be permanent. | `intent/`: a 200-day-old suppression survives; the other three tables still purge at 90 days. |
| `events.id` **values**, and the result of re-processing a redelivered SQS message (**D3**) | Current IDs are random UUIDs; the new implementation emits deterministic hashes, and current behavior duplicates rows. | Normalize `id` out of captured comparisons (§8.4); `intent/`: a redelivered message inserts no second row. |
| Response to a repeated query parameter (`?event=a&event=b`) and to `limit` above 1000 (**D4**) | Current behavior is a 500 / an unclamped query. | `intent/`: 200 with the first value honored; `limit` clamped to 1000. |
| `mapSesEvent` output for a payload missing its event block, and the poller's handling of one (**D7**) | Current behavior is an uncaught `TypeError` and a message that is never deleted. There is no correct output to capture. | `intent/`: `mapSesEvent` returns `[]`; the message is deleted and counted as `malformed_payload`. |

Everything else in the events-API response — item shape, `paging` structure, cursor encoding, filter semantics for well-formed input — remains golden-eligible.

#### 8.3 Capture mechanism

`scripts/capture-golden.cjs` runs **inside a container** (`node:20-alpine` with the repo mounted, or the built image), because `lib/db.js` hardcodes `/data/ses-proxy.db` and macOS will not provide `/data`.

The script mocks AWS **before** requiring the app — `aws-sdk-client-mock` patches `Client.prototype.send`, so it intercepts the clients that `lib/ses-client.js` and `lib/sqs-poller.js` construct at import time — then requires `server.js` unmodified and drives it over HTTP on the real port. Requiring the actual entrypoint rather than re-wiring routes in the harness is deliberate: it eliminates any chance of the harness and `server.js` drifting. `SendRawEmailCommand` resolves a fixed `MessageId`. The script exits explicitly when capture completes.

Two constraints on the harness are non-obvious and load-bearing:

- **It must be CommonJS (`.cjs`), not ESM.** `@aws-sdk/client-ses` and `aws-sdk-client-mock` are dual-package: an ESM `import` resolves `dist-es`, a CJS `require` resolves `dist-cjs`. An `.mjs` harness would stub the `SESClient` class from `dist-es` while `lib/ses-client.js` instantiates the one from `dist-cjs` — different class objects, so the mock would silently not intercept and the capture would attempt real SES calls.
- **`ReceiveMessageCommand` must resolve on a macrotask, not immediately.** `lib/sqs-poller.js`'s `loop()` re-invokes itself from a `.then()` callback. A mock that resolves synchronously turns that into unbounded microtask recursion, which starves the event loop and prevents the HTTP server from ever answering the harness's own requests. The mock resolves `{}` via `setTimeout(..., 20000)`, mirroring the real `WaitTimeSeconds: 20` long poll, so the poller idles harmlessly.

Captured artifacts:

| Artifact | File | Anchored by |
|---|---|---|
| MIME output for a canonical option set, plus variants (no text part, no html part, custom `h:*` headers, UTF-8 subject) | `captured/mime-*.txt` | SES raw-message format |
| `mapSesEvent` output per SES fixture | `captured/event-map-*.json` | Internal contract feeding the events API |
| `substituteVars` output | `captured/template-vars.json` | Mailgun recipient-variable semantics |
| Send / events / suppression / health response bodies and status codes | `captured/http-*.json` | Ghost's `mailgun.js` |
| `PRAGMA table_info` for all four tables + `PRAGMA index_list` | `captured/schema.json` | The existing `/data` volume — the new build must read it unchanged |

#### 8.4 Normalizers

Applied before writing and before comparison, so determinism (gate 3) is achievable:

| Value | Normalized to |
|---|---|
| MIME boundary `----=_Part_<32 hex>` | `----=_Part_<BOUNDARY>` |
| Batch message ID UUID | `<BATCH_UUID>` |
| `events.id` | `<EVENT_ID>` (D3 — value is not contract) |
| `created_at` / wall-clock timestamps | `<TIMESTAMP>` |
| SES `MessageId` | fixed by the mock, no normalizer needed |

`paging.next` is **not** normalized: its base64 cursor derives deterministically from seeded row data, so it is a genuine contract assertion.

#### 8.5 Provenance and reuse

Every captured file carries a header (or sidecar entry in `captured/MANIFEST.json`) recording the git SHA of the JavaScript implementation it came from and the capture date. `scripts/capture-golden.cjs` is **kept in the repo after the rewrite**, not deleted — it is the reproducibility record, and `git checkout <sha> && node scripts/capture-golden.cjs` regenerates the fixtures. It is never run in CI.

## Interaction with Existing Code

**What changes:** every `.js` file is deleted and reimplemented as TypeScript. This is a rewrite of form, not of behavior, with two deliberate exceptions: the four defect fixes in §5, and the D1 response-shape change recorded in §5.1. Every other part of the wire contract with Ghost is unchanged.

| Existing file | Becomes | Behavior change |
|---|---|---|
| `server.js` | `src/app.ts` + `src/index.ts` | Split; adds `/metrics`, observability middleware, graceful shutdown |
| `lib/config.js` | `src/config.ts` | Throws instead of `process.exit`; validates `LOG_LEVEL`; adds `DB_PATH` |
| `lib/db.js` | `src/db.ts` + `src/schema.ts` + `src/cleanup.ts` + `src/stats.ts` | Factory not singleton; D2 fix; cached stats |
| `lib/auth.js` | `src/middleware/auth.ts` | None |
| `lib/ses-client.js` | `src/ses-client.ts` | Factory; timing + error metrics |
| `lib/send-email.js` | `src/routes/send-email.ts` + `src/mime.ts` + `src/semaphore.ts` + `src/multipart.ts` | D1 fix; decomposed for testability. **Behavior change:** a per-recipient throw before the SES call now counts as a failed recipient rather than 500-ing the whole batch — see §5.1 |
| `lib/sqs-poller.js` | `src/sqs-poller.ts` | Class with `stop()`; D3 fix; metrics |
| `lib/event-mapper.js` | `src/event-mapper.ts` | Types, plus the D7 fix — optional event blocks are guarded so a malformed payload yields `[]` instead of throwing. All mapping logic otherwise preserved exactly |
| `lib/events-api.js` | `src/routes/events.ts` | D4 fix |
| `lib/suppression-api.js` | `src/routes/suppression.ts` | None |
| `lib/template-vars.js` | `src/template-vars.ts` | Types only |

**What stays the same — do not refactor:**

- Every HTTP response body and status code. Ghost's `mailgun.js` client depends on the exact shapes: `{ id, message: 'Queued. Thank you.' }` from send, `{ items, paging }` from events, `{ message, value, address }` from suppression delete. The `/health` body keeps its current `{ status, tables: {…} }` shape.
- The SQLite schema — table names, column names, indexes, `INSERT OR IGNORE` semantics. Only the *value* of `events.id` changes (§5.3).
- `buildRawMime` output byte-for-byte: header order, base64 `Content-Transfer-Encoding`, `multipart/alternative` boundary format, the `<%tag_unsubscribe_email%>` stripping, and the `h:*` header passthrough with its four excluded keys.
- `mapSesEvent`'s mapping table, skip list, bounce severity logic, recipient extraction per event type, and timestamp fallback chain.
- The keyset pagination cursor format (base64 `{t, id}`).
- Container user (root) and `/data` volume layout — changing either risks breaking the existing volume's permissions.
- D6 (no cleanup at startup) — pinned as-is.

**Migration path:** none required at runtime. The image is a drop-in replacement: same port, same env vars (plus optional `DB_PATH`), same volume, same database file. Rollback is re-pinning the previous image tag.

## Test Plan

**Existing infrastructure: none.** No framework, no test directory, no coverage tooling, no lockfile. This section defines the setup from scratch.

| Choice | Selection |
|--------|-----------|
| Runner | **Vitest** — native TS, no transform config, built-in v8 coverage |
| HTTP assertions | **supertest** against `createApp(deps)` — never binds a port |
| AWS mocking | **aws-sdk-client-mock** — intercepts at the SDK client layer |
| Database | **Real `better-sqlite3` on `:memory:`** — no mocking; fast and exercises actual SQL |
| Log assertions | pino writing to an in-memory stream; assert parsed JSON objects |
| Metric assertions | Per-test `new Registry()`; assert via `register.getMetricsAsJSON()` |
| Layout | `test/` mirroring `src/`, `*.test.ts` |
| Gate | `lines 90 / statements 90 / functions 90 / branches 85`, blocking in CI |

`test/helpers/deps.ts` provides `makeDeps(overrides?)` building a full `Deps` with an in-memory DB, a fresh registry, and a capturing logger. `test/helpers/fixtures.ts` holds canned SES event payloads (Delivery, Bounce permanent/transient, Complaint, Open, Click, Reject, Send, DeliveryDelay) and SNS-enveloped variants.

`src/index.ts` is excluded from coverage — it contains only wiring, `listen()`, and signal handlers. The exclusion stays honest only if no logic lands there; the plan must keep it thin.

### Unit tests

| File | Asserts | Setup |
|---|---|---|
| `test/template-vars.test.ts` | Substitutes `%recipient.x%`; leaves unknown vars verbatim; handles empty string, null vars, multiple occurrences, regex-special characters in values | none |
| `test/event-mapper.test.ts` | Each SES type maps to the right event/severity/code; `Bounce` Permanent vs Transient severity split; `Send`/`DeliveryDelay` return `[]`; unknown type returns `[]`; recipient extraction per type; timestamp fallback to `mail.timestamp` then `Date.now()`; `Message-ID`/`X-Ghost-Email-Id` header extraction; angle-bracket stripping; suppression flags for Bounce-permanent/Complaint/Reject; multi-recipient fan-out; **a `Delivery`/`Bounce`/`Complaint` payload missing its event block returns `[]` instead of throwing** (D7) | fixtures |
| `test/mime.test.ts` | Header order and presence; optional headers omitted when absent; base64 encoding of text and html parts; boundary appears in Content-Type and both delimiters; custom `h:*` headers included and the four reserved keys excluded; UTF-8 subject/body round-trip | none |
| `test/semaphore.test.ts` | Caps concurrency at `max`; queues beyond it; **`runExclusive` releases when the callback throws** (D1 regression); releases on resolve; `inFlight`/`queueDepth` track correctly; FIFO ordering | fake timers |
| `test/config.test.ts` | Missing required vars throw `ConfigError` naming **all** of them; defaults applied; `LOG_LEVEL` validation rejects garbage; `SEND_CONCURRENCY`/`PORT` parse ints and reject non-numeric; `DB_PATH` default | env object injection |
| `test/db.test.ts` | Schema creates all four tables and indexes; `INSERT OR IGNORE` dedupes on each unique constraint; `lookupRecipientEmail` round-trip; `close()` releases the handle | `:memory:` |
| `test/cleanup.test.ts` | Rows older than 90 days are deleted from `message_map`/`recipient_emails`/`events`; **a 200-day-old suppression survives** (D2 regression); metrics record deleted counts per table; `outcome="error"` on failure | `:memory:`, backdated `created_at` |
| `test/stats.test.ts` | Returns live counts; serves cached within TTL; recomputes after TTL via injected `now`; counts reflect inserts after expiry | `:memory:` |
| `test/logger.test.ts` | Emits `level` as a **string**; ISO-8601 `time`; `service`/`version` in every line; `LOG_LEVEL` suppresses lower levels; `authorization` header redacted; child bindings appear | capture stream |
| `test/metrics.test.ts` | Every metric registers with expected name/type/labels; default metrics present and **unprefixed**; `build_info` = 1 with version label; two `createMetrics` calls on separate registries do not collide | fresh `Registry` |
| `test/ses-client.test.ts` | `sendRawEmail` returns `MessageId`; records duration histogram with `outcome`; maps known SES error names to allowlisted `error_type`; unknown names collapse to `other`; rejects propagate | `aws-sdk-client-mock` |
| `test/middleware/auth.test.ts` | Valid `Basic api:<key>` passes; missing header → 401; non-Basic scheme → 401; malformed base64 → 401; no colon → 401; wrong key → 401; key containing a colon parses correctly | none |
| `test/middleware/observability.test.ts` | Counter and histogram record `method`/`route`/`status_code`; **route label uses the template, not the raw path**; unmatched routes label `unmatched`; **an email in the path never reaches a label** (cardinality/PII regression); `/health` and `/metrics` produce no access-log line | supertest |

### Integration tests

| File | Asserts | Setup |
|---|---|---|
| `test/routes/send-email.test.ts` | Happy path returns `{id, message:'Queued. Thank you.'}` and inserts `message_map` + one `recipient_emails` row per recipient; per-recipient variable substitution differs per message; missing `from`/`subject`/`to` → 400 and `outcome="rejected"`; malformed `recipient-variables` JSON → 400; **all recipients failing → 500 with `errors[]` and `outcome="failure"`**; **partial failure → 200 with `outcome="partial"`**; concurrency never exceeds `SEND_CONCURRENCY`; `List-Unsubscribe` placeholder stripping; `X-Ghost-Email-Id` added when `v:email-id` present; **a throw inside the per-recipient path does not leak a semaphore slot** (D1); metrics and log fields emitted as specified | supertest + `aws-sdk-client-mock` + `:memory:` |
| `test/routes/events.test.ts` | Returns Mailgun-shaped `items` and `paging`; `event=a OR b` filter; `tags=x AND y` filter; `begin`/`end` range; keyset pagination produces a working `next` cursor and the second page continues correctly; invalid page token → 400; **repeated `?event=` array param does not 500** (D4); `limit` clamped to 1000; `severity` and `delivery-status` included only when non-null | `:memory:` seeded |
| `test/routes/suppression.test.ts` | Valid type deletes the row and returns the Mailgun body; unknown type → 404; URL-encoded `+` and `%40` in the address decode correctly; deleting a non-existent address still returns 200; `suppressions_removed_total` incremented | `:memory:` |
| `test/routes/health.test.ts` | Returns `{status:'ok', tables:{…}}` with the **exact current shape**; counts reflect the database; served without auth | `:memory:` |
| `test/routes/metrics.test.ts` | Returns 200 with prom-client's `Content-Type`; body parses as exposition format; contains app metrics and unprefixed `process_*`; served without auth | fresh registry |
| `test/sqs-poller.test.ts` | `pollOnce` processes an SNS-enveloped event and a raw SES event; stores normalized rows; deletes the message; **a redelivered identical message inserts no duplicate row** (D3); invalid JSON → `parse_errors_total{reason="invalid_json"}` and the message is deleted; unrecognized shape → `unrecognized_format` and deleted; **a recognized `eventType` whose event block is missing → `malformed_payload`, deleted, and not counted as a skip** (D7); `last_poll_timestamp_seconds` advances on success; poll error increments `outcome="error"` and backs off without exiting the loop; correlation `matched` vs `unmatched` recorded; `stop()` halts the loop | `aws-sdk-client-mock` + fake timers + `:memory:` |

### Backward-compatibility tests

Grouped in `test/contract.test.ts`, asserting against the §8 fixtures. These exist specifically to catch the rewrite silently changing the Ghost-facing contract, and they are the reason phase 1 must land before any `src/` file:

**Against `test/golden/captured/`** — the new implementation must reproduce observed behavior:

- Send, events, suppression, and health response bodies and status codes match `http-*.json`.
- `buildRawMime` output matches `mime-*.txt` under the §8.4 normalizers, across all captured variants.
- `mapSesEvent` output matches `event-map-*.json` for every SES fixture.
- `substituteVars` matches `template-vars.json`.
- `PRAGMA table_info` and `PRAGMA index_list` match `schema.json` for all four tables — the new build must read the existing `/data` volume unchanged.

**Against `test/golden/intent/`** — the new implementation must *diverge* from observed behavior, in exactly the four specified ways. Each of these fails if the rewrite accidentally preserves the defect:

- A 200-day-old suppression survives cleanup while the other three tables purge at 90 days (D2).
- A redelivered SQS message inserts no duplicate event row (D3).
- `?event=a&event=b` returns 200 honoring the first value rather than 500 (D4).
- `limit=99999999` is clamped to 1000 (D4).
- A throw inside the per-recipient send path releases its semaphore slot and the batch completes as `partial` (D1).
- A `Delivery` payload with no `delivery` block maps to `[]`, and the poller deletes the message and counts `malformed_payload` rather than throwing and leaving it queued (D7).

## Files Changed

| File | Change |
|------|--------|
| `src/index.ts` | **New.** Entrypoint: config load, dep wiring, listen, poller start, signal handlers |
| `src/app.ts` | **New.** `createApp(deps)` — routes and middleware, no listen |
| `src/types.ts` | **New.** `Config`, `Deps`, `Db`, `SesClient`, `SesEvent`, `NormalizedEvent`, `Metrics` |
| `src/config.ts` | **New.** `loadConfig(env)`, `ConfigError`; replaces `lib/config.js` |
| `src/logger.ts` | **New.** pino factory, `getVersion()` |
| `src/metrics.ts` | **New.** `createMetrics(register)` — full catalog from §4 |
| `src/db.ts` | **New.** `createDb(path, logger)`; replaces `lib/db.js` |
| `src/schema.ts` | **New.** DDL extracted from `lib/db.js` |
| `src/cleanup.ts` | **New.** 90-day cleanup, D2 fix, metrics |
| `src/stats.ts` | **New.** TTL-cached table counts (D5) |
| `src/semaphore.ts` | **New.** Typed semaphore with `runExclusive` (D1) |
| `src/multipart.ts` | **New.** busboy form parsing extracted from `lib/send-email.js` |
| `src/mime.ts` | **New.** `buildRawMime` extracted, behavior preserved |
| `src/template-vars.ts` | **New.** Port of `lib/template-vars.js` |
| `src/event-mapper.ts` | **New.** Port of `lib/event-mapper.js`, typed |
| `src/ses-client.ts` | **New.** `createSesClient`, instrumented |
| `src/sqs-poller.ts` | **New.** `SqsPoller` class, D3 fix, instrumented |
| `src/middleware/auth.ts` | **New.** Port of `lib/auth.js` |
| `src/middleware/observability.ts` | **New.** pino-http + HTTP metrics, route-template labeling |
| `src/routes/send-email.ts` | **New.** Handler, D1 fix, instrumented |
| `src/routes/events.ts` | **New.** Handler, D4 fix |
| `src/routes/suppression.ts` | **New.** Handler |
| `src/routes/health.ts` | **New.** Handler backed by `stats.ts` |
| `src/routes/metrics.ts` | **New.** `/metrics` exposition |
| `server.js`, `lib/*.js` (11 files) | **Deleted.** Replaced by `src/` |
| `test/**` (20 files) | **New.** Suite + `helpers/deps.ts`, `helpers/fixtures.ts` per Test Plan |
| `scripts/capture-golden.cjs` | **New, phase 1.** Golden capture harness (CommonJS — see §8.3); runs only against the pre-rewrite tree, kept afterwards for reproducibility, never run in CI |
| `scripts/Dockerfile.capture` | **New, phase 1.** Throwaway image that builds `better-sqlite3` for Alpine and runs the capture harness against the pre-rewrite tree |
| `test/golden/captured/**` | **New, phase 1.** Fixtures recorded from the current implementation + `MANIFEST.json` provenance |
| `test/golden/intent/**` | **New, phase 1.** Hand-authored fixtures encoding the D1–D4 fixed behavior |
| `test/golden/REJECTED.md` | **New, phase 1.** Candidates that failed the §8.1 eligibility gate, with reasons |
| `test/contract.test.ts` | **New.** Asserts both fixture sets per Test Plan |
| `package.json` | Add deps, devDeps, scripts; `main` → `dist/index.js` |
| `package-lock.json` | **New.** Required for `npm ci` |
| `tsconfig.json`, `tsconfig.build.json` | **New.** |
| `vitest.config.ts` | **New.** Coverage thresholds and exclusions |
| `Dockerfile` | Multi-stage build; runtime image loses python3/make/g++ |
| `.dockerignore` | Add `test/`, `coverage/`, `dist/`, `.github/`, `ralph/` |
| `.gitignore` | Add `dist/`, `coverage/`, `*.tsbuildinfo` |
| `.github/workflows/ci.yml` | Add `test` job; update smoke checks to `dist/` |
| `.env.example` | Add `DB_PATH`; correct `LOG_LEVEL` docs |
| `docker-compose.example.yml` | Add `DB_PATH` |
| `README.md` | Document `/metrics`, log format, `DB_PATH`, dev/test workflow |

## Open Questions

1. **Which test framework?**
   _Resolved:_ **Vitest** — native TS with no transform config, built-in v8 coverage. Jest+ts-jest rejected for the transform config and version-coupling maintenance; `node:test` rejected for its weak mocking and coverage story.

2. **Should recipient email addresses appear in JSON logs?**
   _Resolved:_ **Log in full**, matching current behavior. With ~29 subscribers and Loki self-hosted, per-subscriber delivery debugging is the main reason to read these logs. Hashing and omission were both rejected as removing the primary use case.

3. **Which discovered defects are in scope?**
   _Resolved:_ **All of them.** D1 (semaphore leak) is fixed by construction since the rewrite replaces that code. D2 (suppression expiry), D3 (duplicate events), D4 (query-param 500), and D7 (malformed-payload poison message) are explicit in-scope fixes with regression tests. D6 (no cleanup at startup) stays pinned as-is.

4. **How strict is the coverage gate?**
   _Resolved:_ **90% lines/statements/functions, 85% branches, blocking in CI.** Consistent with ArrStalledHandler's `--cov-fail-under` precedent. `src/index.ts` is excluded as pure wiring.

5. **Should `/metrics` require authentication?**
   _Resolved:_ **No.** It matches `/health` and is reachable only on the internal Docker network — Traefik never routes it. Requiring `PROXY_API_KEY` would push the credential into Prometheus scrape config for no security gain.

6. **CommonJS or ESM output?**
   _Resolved:_ **CommonJS.** `better-sqlite3` is a CJS-only native addon and express@4/busboy are CJS; ESM would need `createRequire` shims for no benefit.

7. **Does the metrics `route` label risk cardinality explosion or PII leakage?**
   _Resolved:_ Yes if built from raw paths — `DELETE /v3/:domain/:type/:email` embeds a subscriber address. Mitigated by using the Express route template only, with `unmatched` as the fallback. The accepted cost is losing per-route attribution on pre-routing 401s.

8. **Should the rewrite pin current behavior with golden fixtures, given four known defects?**
   _Resolved:_ **Yes, as mandatory execution phase 1** — captured before any `src/` file exists, since the rewrite deletes the implementation being captured. But capture is **gated, not indiscriminate** (§8.1): a behavior must be defect-free, contract-anchored to a nameable consumer, and deterministic under the §8.4 normalizers. The four defect-tainted surfaces (§8.2) get hand-authored `intent/` fixtures encoding the *fixed* behavior instead, so the contract suite fails if the rewrite accidentally preserves a bug. Rejected candidates are recorded in `REJECTED.md` rather than dropped silently.

9. **Is a Grafana dashboard part of this project?**
   _Resolved:_ **No** — dashboard JSON cannot be validated here. §4.7 records alerting *intent* so metric shapes are chosen deliberately; rule authoring belongs to the `grafana-alerting-as-code` project.

10. **When an SES payload is missing its event block, should the poller keep throwing or discard the message?**
    _Raised by the planning review, which found that strict TypeScript forces the question: `?.` is the path of least resistance and would silently convert today's `TypeError` into `[]`._
    _Resolved:_ **Discard and count it** (§5.5). `getRecipients` guards every optional block, `mapSesEvent` returns `[]`, and the poller deletes the message while incrementing `sqs_parse_errors_total{reason="malformed_payload"}`. Preserving the throw was rejected: the failure is deterministic, so redelivery can only re-throw, and the current behavior is an unbounded poller stall — the precise silent-analytics-death failure this project exists to detect. This makes D7 a fifth in-scope defect fix; the divergence is pinned by an `intent/` fixture rather than captured.
