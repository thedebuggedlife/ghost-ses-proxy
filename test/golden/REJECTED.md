# Rejected capture candidates

Behaviors of the pre-rewrite implementation that were **deliberately not** recorded into
`test/golden/captured/`. Each row failed at least one gate in design §8.1 (not
defect-tainted / contract-anchored / deterministic / recorded).

Nothing here is an oversight. A behavior that is absent from `captured/` and absent from
this file is a gap in the safety net — add it to one or the other.

## Failed gate 1 — defect-tainted (design §8.2)

These surfaces have no correct output to capture, because the current output *is* the
defect. Each is pinned instead by a hand-authored fixture under `test/golden/intent/`.

| # | Surface | Current behavior | Why it must not be captured | Pinned instead by |
|---|---------|------------------|-----------------------------|-------------------|
| D1 | Semaphore/concurrency state after a per-recipient throw — `lib/send-email.js:204` | `release()` is chained onto `sendRawEmail(...).finally()`, so anything throwing *before* that call (`substituteVars`, `buildRawMime`, `JSON.stringify`, `Buffer.from`) leaks the slot. After `SEND_CONCURRENCY` such failures every subsequent send hangs forever with no response and no log. | An unrecoverable hang is not an observable value. Capturing the accompanying `500 Internal server error` body would additionally pin the response-shape defect that design §5.1 deliberately changes. | `intent/d1-semaphore-release.json` |
| D2 | `cleanup()`'s effect on the `suppressions` table — `lib/db.js:102` | `suppressions` is in the 90-day cleanup list, so permanent bounces and spam complaints silently expire. | Capturing "the row is gone" would pin data loss with a direct SES-reputation consequence as contract. | `intent/d2-suppression-retention.json` |
| D3 | `events.id` **values**, and the result of re-processing a redelivered SQS message — `lib/sqs-poller.js:54` | Each event row gets a fresh `uuidv4()` primary key, so the `INSERT OR IGNORE` at `lib/db.js:78` can never dedupe. A redelivered message inserts a second row. | The id is random, so it fails gate 3 outright; the duplicate row is the defect. Values reaching a captured artifact are normalized away (§8.4) — see the note below on why no poller-generated id ever reaches one. | `intent/d3-redelivery-dedupe.json` |
| D4 | Response to a repeated query parameter (`?event=a&event=b`, `?tags=x&tags=y`) — `lib/events-api.js:17,23` | Express parses the repeat into an array; `.split(' OR ')` is undefined on an array → `TypeError` → 500. | A 500 from a well-formed client request is not a Mailgun contract. | `intent/d4-repeated-query-param.json` |
| D4 | Response to an out-of-range `limit` (`?limit=99999999`, `?limit=0`, `?limit=-5`) — `lib/events-api.js` | `limit` is unclamped and honored verbatim. | Capturing an unbounded scan as contract would block the clamp design §5.4 requires. | `intent/d4-limit-clamp.json` |
| D7 | `mapSesEvent` output for a payload missing its event block, and the poller's handling of one — `lib/event-mapper.js:18-26`, `lib/sqs-poller.js:120-124` | `sesEvent.delivery.recipients` / `.bounce.bouncedRecipients` / `.complaint.complainedRecipients` are dereferenced unguarded. A missing block throws a `TypeError` that escapes `pollOnce` **before** `deleteMessage`, so the message returns on visibility timeout and stalls the poller forever. | An uncaught `TypeError` and an unbounded stall have no correct output to capture. | `intent/d7-malformed-payload.json` |

## Failed gate 2 — no nameable external consumer

| Surface | Why rejected |
|---------|--------------|
| `server.js` startup banner and the `SQS poller started` line | Unstructured `console.log` prose that no consumer parses, and design §3 replaces all 19 call sites with pino JSON. Capturing it would pin the exact thing this project removes. |
| Internal shapes of `lib/send-email.js` helpers (`buildRawMime`, `substituteVars` call sequencing) | `buildRawMime` is not exported, so it has no consumer outside its own module. Its *output* is captured — through the whole pipeline, as `mime-*.txt` — anchored by the SES raw-message format. The intermediate steps are not. |
| Prepared-statement objects and the `better-sqlite3` handle returned by `lib/db.js` | Implementation detail. The consumer-anchored surface is the on-disk schema, captured as `schema.json`. |

## Failed gate 3 — non-deterministic

The `diff -r` determinism run (plan task 2.1) was **clean**: two consecutive captures of
`test/golden/captured/` were byte-identical. Nothing was rejected as a result of it. The
values below would have failed gate 3 and are handled by `scripts/normalize.cjs` instead
of being dropped, per design §8.4.

| Value | Handling |
|-------|----------|
| MIME boundary `----=_Part_<32 hex>` | Normalized to `----=_Part_<BOUNDARY>` |
| Batch message-id UUID (`uuidv4()` per send) | Normalized to `<BATCH_UUID>` |
| `created_at` and other wall-clock timestamps | Normalized to `<TIMESTAMP>` |
| SES `MessageId` | Fixed by the harness mock; no normalizer needed |

Two values that *look* like they need a normalizer and deliberately do not:

- **`paging.next`.** Design §8.4 exempts it, and it is a genuine contract assertion: the
  base64 `{t, id}` cursor derives entirely from seeded row data. It reproduces because
  every seeded `events.id` is a fixed `evt-NNNN` and the harness pins `Host: localhost:3003`
  (`lib/events-api.js:129` builds the URL from `req.headers.host`). Phase 15's contract
  test must pin the same Host — see plan Design Decision P8.
- **`events.id` in captured responses.** Design §8.4 lists an `<EVENT_ID>` normalizer; it
  is intentionally not implemented. Every event row in this capture is seeded by the
  harness with a fixed id (Design Decision P7), so no poller-generated id ever reaches a
  captured artifact and there is nothing to normalize. Implementing it would instead
  destroy the `paging.next` assertion above.

## Failed gate 1 by omission — surfaces the harness cannot reach

| Surface | Why rejected |
|---------|--------------|
| SQS poll loop timing, backoff, and `stop()` behavior | The harness mocks `ReceiveMessageCommand` to resolve `{}` on a 20-second `setTimeout` (Design Decision P2) precisely so the poller idles and does not starve the event loop. No poll-loop behavior is exercised, so none is captured. `lib/sqs-poller.js` also has no `stop()` — the loop is unstoppable, which is one of the things design §2 changes. |
| Real SES error taxonomy (`Throttling`, `MessageRejected`, …) | The harness mock rejects with a generic `Error('SES unavailable')`. Real SDK error names are not observable here, and design §4.2 defines the allowlist mapping as new behavior rather than a port. |
| D6 — no cleanup run at startup (`lib/db.js:107`) | Not rejected as a candidate; explicitly **pinned as-is** by design (§Defects, D6). Recorded here only so a future reader does not "fix" it while looking for missing coverage. |
