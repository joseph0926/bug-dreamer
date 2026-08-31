# firsttx Invariants (separated arm)

Extracted from existing tests, READMEs, public types, and explicit code contracts of the firsttx project at `/Users/kimyounghoon/dev/p/firsttx`. Entries marked `conflicted` record both statements where documentation contradicts the tests or itself. `implementation-only` entries are inferred solely from implementation bodies and are second-class.

Path shorthand: `tx/` = `packages/tx/`, `lf/` = `packages/local-first/`, `pp/` = `packages/prepaint/`.

---

## Module 1: packages/tx (transaction.ts, retry.ts, errors.ts)

### Documented or test-asserted

- `INV-TX-01`: Steps added via `tx.run()` execute sequentially in the order they were added.
  source: test "should execute multiple steps in order" in `tx/tests/transaction.test.ts`
- `INV-TX-02`: When a step fails, the compensations of previously completed steps run in reverse completion order before the error propagates to the caller.
  source: test "should handle mixed success/failure with partial rollback" in `tx/tests/transaction.test.ts`; `tx/README.md` "Automatic Rollback" section
- `INV-TX-03`: `commit()` is idempotent — calling it again on a committed transaction resolves without error and without side effects.
  source: test "should be idempotent on multiple commits" in `tx/tests/transaction.test.ts`; explicit code contract `tx/src/transaction.ts:134-136`
- `INV-TX-04`: After a transaction is `rolled-back`, `failed`, or `committed`, `tx.run()` always throws `TransactionStateError`; after `rolled-back` or `failed`, `commit()` also throws `TransactionStateError`.
  source: tests "should not allow adding steps after rollback", "should not allow adding steps after compensation fails", "should not allow commit after compensation fails", "should throw TransactionStateError when committing rolled-back tx" in `tx/tests/transaction.test.ts`
- `INV-TX-05`: A step is attempted at most `retry.maxAttempts` times; the default retry config is exactly one attempt (no retry).
  source: tests "should throw RetryExhaustedError after all attempts fail" and "should use default retry config (1 attempt)" in `tx/tests/transaction.test.ts`; `DEFAULT_RETRY_CONFIG` in `tx/src/types.ts:10-14`; `tx/README.md` API reference (`maxAttempts` default `1`)
- `INV-TX-06`: When every attempt of a step fails, `tx.run()` rejects with `RetryExhaustedError` carrying `stepId`, `attempts === maxAttempts`, and all per-attempt errors in chronological order.
  source: tests "should include all attempt errors in RetryExhaustedError" in `tx/tests/transaction.test.ts` and "should include all errors in RetryExhaustedError" in `tx/tests/retry.test.ts`
- `INV-TX-07`: Retry delay grows as `delayMs * attempt` for linear backoff and `delayMs * 2^(attempt-1)` for exponential backoff (first delay equals `delayMs` in both).
  source: tests "should use linear backoff correctly" and "should use exponential backoff correctly" in `tx/tests/retry.test.ts` — `conflicted`: `tx/README.md` FAQ states exponential is "delay × 2^attempt" while its own example sequence ("100ms → 200ms → 400ms") and the tests match `2^(attempt-1)`.
- `INV-TX-08`: When the transaction timeout elapses, the running step's promise rejects with `TransactionTimeoutError` (carrying `timeoutMs` and `elapsedMs`), and completed steps are rolled back in reverse order.
  source: tests "should timeout during execution", "should include elapsed time in timeout error", "should rollback completed steps when timeout occurs" in `tx/tests/transaction.test.ts`
- `INV-TX-09`: The timeout budget spans the whole transaction (default 30000 ms), not each step: elapsed time across earlier steps counts against later steps.
  source: test "should handle timeout with multiple steps" in `tx/tests/transaction.test.ts`; `tx/README.md` `startTransaction` reference (`timeout` default 30000); explicit code contract `tx/src/transaction.ts:158-159`
- `INV-TX-10`: A successful `commit()` clears the timeout timer; no timeout fires after commit.
  source: test "should clear timeout on successful commit" in `tx/tests/transaction.test.ts`; code contract `tx/src/transaction.ts:142`
- `INV-TX-11`: Each `tx.run()` invocation receives an `AbortSignal`; on timeout that signal is aborted, so abort-aware step functions (and their retry sleeps) stop instead of continuing in the background, and no further retry attempts start after abort.
  source: tests "should provide AbortSignal to the step function", "should abort signal on timeout", "should cancel ongoing function after timeout when step supports abort", "should abort signal even with retry" in `tx/tests/transaction.test.ts`; "should reject immediately if signal is already aborted", "should abort during retry delay" in `tx/tests/retry.test.ts`
- `INV-TX-12`: If any compensation throws during rollback, remaining compensations still run, all compensation errors are collected, and `tx.run()` rejects with `CompensationFailedError` carrying every failure (reverse order) and `completedSteps`; the transaction status becomes `failed`.
  source: tests "should collect all compensate errors", "should include completedSteps in CompensationFailedError", "should collect all compensation errors and mark as failed" in `tx/tests/transaction.test.ts`; `tx/README.md` FAQ "What happens if compensation fails?"
- `INV-TX-13`: Error recoverability is fixed per class: `RetryExhaustedError.isRecoverable() === true`, `TransactionTimeoutError.isRecoverable() === true`, `CompensationFailedError.isRecoverable() === false`, `TransactionStateError.isRecoverable() === false`.
  source: `isRecoverable()` assertions across `tx/tests/transaction.test.ts` ("should provide user-friendly message", "should include elapsed time in timeout error", "should include completedSteps in CompensationFailedError", "should throw TransactionStateError when adding step after commit"); `tx/README.md` "Recoverability" table; `tx/src/errors.ts:40-42,73-75,97-99,133-135`
- `INV-TX-14`: When `transition: true` and `document.startViewTransition` exists, rollback compensations run inside a ViewTransition; with `transition: false` compensations run directly. `transition` defaults to `false`.
  source: tests "should use ViewTransition when enabled" and "should work without ViewTransition when disabled" in `tx/tests/transaction.test.ts`; `TxOptions` doc in `tx/src/types.ts:58-59`
- `INV-TX-15`: The failed step itself is not compensated — only steps counted as completed before the failure are.
  source: rollback loop bound `tx/src/transaction.ts:218` (`i = completedSteps - 1`), consistent with test "should rollback completed steps when timeout occurs" (only steps 1 and 2 compensated) — `conflicted`: `tx/README.md` "Automatic Rollback" says "If step3 fails: 1. Execute undo3 (if step3 started)", implying the failed step's own compensate runs; no test asserts that and the implementation never runs it.
- `INV-TX-16`: `TxStatus` transitions only along `pending → running → (committed | rolled-back)` and `rolled-back`-path-with-failed-compensation → `failed`; `committed`, `rolled-back`, and `failed` are terminal.
  source: public type `TxStatus` in `tx/src/types.ts:54`; state checks in `tx/src/transaction.ts:35-43,134-143,212,254`; terminality asserted by the `TransactionStateError` tests in `tx/tests/transaction.test.ts`
- `INV-TX-17`: Compensation functions must be idempotent and async — the library may invoke a compensate more than once in edge cases, and only `() => Promise<void>` signatures are supported.
  source: `tx/README.md` Constraints 2 and 3; `StepOptions.compensate` type in `tx/src/types.ts:35-36`

### Implementation-only (second-class)

- `INV-TX-18`: Concurrent `tx.run()` calls are rejected — while one step is running, a second `run()` on the same transaction throws `TransactionStateError`.
  source: implementation-only (`tx/src/transaction.ts:39-41,44,125`; no test or README statement covers overlapping runs)
- `INV-TX-19`: Step ids are assigned deterministically as `step-<index>` in insertion order.
  source: implementation-only (`tx/src/transaction.ts:67-69`; tests only pattern-match `/^step-\d+$/`)
- `INV-TX-20`: If `signal.aborted` is observed, `executeWithRetry` rethrows the abort reason (or the in-flight error) immediately without wrapping it in `RetryExhaustedError` and without further attempts.
  source: implementation-only (`tx/src/retry.ts:43-45`; abort tests assert the message but not the non-wrapping guarantee)

---

## Module 2: packages/local-first (broadcast.ts, cache-manager.ts)

### Documented or test-asserted

- `INV-LF-01`: Every successful `patch()` on a model broadcasts `{ type: 'model-patched', key: <model key> }` to other tabs, and every successful `replace()` broadcasts `{ type: 'model-replaced', key: <model key> }`.
  source: tests "should broadcast on patch" and "should broadcast on replace" in `lf/tests/broadcast.test.ts`; `lf/README.md` "Every `patch()` or `replace()` broadcasts to other tabs"
- `INV-LF-02`: Receiving a broadcast for a key reloads that model's stored snapshot from IndexedDB, so the receiving tab's cached snapshot converges to the stored data.
  source: test "should reload cache when receiving broadcast" in `lf/tests/broadcast.test.ts`; `lf/README.md` cross-tab section ("Tab 2 receives a BroadcastChannel notification / React reloads the latest stored snapshot")
- `INV-LF-03`: A tab never reacts to its own broadcast messages: messages whose `senderId` equals the local sender id are ignored and trigger no subscriber callbacks.
  source: test "should not reload cache for own messages" in `lf/tests/broadcast.test.ts`; code contract `lf/src/broadcast.ts:139-141`
- `INV-LF-04`: Broadcast delivery is keyed — a message for one model key invokes only that key's subscribers, never subscribers of other models.
  source: tests "should only reload affected model" and "should broadcast different keys independently" in `lf/tests/broadcast.test.ts`
- `INV-LF-05`: A broadcast for a key with no stored data is handled without throwing, and the model's cached snapshot stays `null`.
  source: test "should handle missing data gracefully" in `lf/tests/broadcast.test.ts`
- `INV-LF-06`: When `BroadcastChannel` is unavailable, `ModelBroadcaster.getInstance()` does not crash, still exposes `broadcast`/`subscribe`/`close`, and model operations (`replace`, `patch`) keep working locally; cross-tab sync silently degrades to no-op.
  source: tests "should NOT crash when BroadcastChannel is undefined" and "should allow model operations in fallback mode" in `lf/tests/broadcast.test.ts`; fallback class doc comment `lf/src/broadcast.ts:33-36`. Note: the sibling test named "should crash when BroadcastChannel is undefined" also asserts `not.toThrow`, so its name contradicts its own assertions — the asserted behavior on both is "no crash".
- `INV-LF-07`: Every outgoing broadcast message carries the sender's `senderId` and a `timestamp`, and its `type` is one of `model-patched`, `model-replaced`, `model-deleted`.
  source: public type `BroadcastMessage` in `lf/src/broadcast.ts:16-21`; code contract `lf/src/broadcast.ts:117-124`
- `INV-LF-08`: `CacheManager` state is exactly one of `loading`, `success`, or `error`; `getCachedSnapshot()` returns data only in `success` (else `null`) and `getCachedError()` returns an error only in `error` (else `null`).
  source: public types `CacheState` in `lf/src/cache-manager.ts:4-5` and `CacheStatus` in `lf/src/types.ts:82`; tests "should return null when no data exists" (`lf/tests/model.test.ts:14`) and "should return null when no error" (`lf/tests/model.test.ts:407`)
- `INV-LF-09`: Before any data or error arrives, the history metadata is the default `{ updatedAt: 0, age: Infinity, isStale: true, isConflicted: false }`.
  source: test "should return default values when no data exists" in `lf/tests/model.test.ts:255`; `DEFAULT_HISTORY` in `lf/src/cache-manager.ts:14-19`
- `INV-LF-10`: Staleness is a pure function of age and TTL: data younger than the TTL reports `isStale === false` and data older reports `isStale === true`; TTL `0` means always stale and TTL `Infinity` means never stale.
  source: tests "should calculate isStale based on TTL", "should handle 0 TTL (always stale)", "should handle Infinity TTL (never expires)" in `lf/tests/model-ttl-optional.test.ts`; tests "should return isStale=false when data is fresh" and "should return isStale=true when data exceeds TTL" in `lf/tests/model.test.ts` — `conflicted` at the exact boundary: `lf/src/types.ts:76` and `lf/README.md` ("Whether `age > ttl`") document strict `age > ttl`, while the implementation computes `isStale: age >= this.ttl` (`lf/src/cache-manager.ts:84`); the "0 TTL always stale" test only passes under `>=`.
- `INV-LF-11`: The default TTL when none is specified is 5 minutes (`5 * 60 * 1000` ms).
  source: test "should use default TTL (5 minutes) when not specified" in `lf/tests/model-ttl-optional.test.ts`; `lf/README.md` (`options.ttl` default `5 * 60 * 1000`)
- `INV-LF-12`: Falsy stored values (`0`, `''`) are first-class `success` data: they are restored instead of `initialData`, count as a cache hit that skips the fetcher, and are never coerced to the "no data" path.
  source: tests "should restore stored 0 instead of falling back to initialData", "should resolve cached 0 without invoking the fetcher", "should not throw \"no initialData provided\" when initialData is 0" in `lf/tests/falsy-values.test.ts`
- `INV-LF-13`: Every `updateWithData`, `updateWithError`, and `setLoading` transition synchronously notifies all currently subscribed callbacks, and unsubscribing removes a callback from future notifications.
  source: explicit code contract `lf/src/cache-manager.ts:60-77,94-107`; observable through subscriber assertions in "should not reload cache for own messages" and "should only reload affected model" in `lf/tests/broadcast.test.ts`
- `INV-LF-14`: `getCachedSnapshot()` and `getCachedHistory()` are synchronous reads usable during render (no async in the read path).
  source: `lf/README.md` ("Sync API: `getCachedSnapshot()` returns instantly (no async/await in render)", "getCachedHistory(): ModelHistory - Synchronous cached metadata")
- `INV-LF-15`: `isConflicted` is always `false` in the current version — conflict detection is an unimplemented TODO, so no state transition may set it.
  source: `lf/src/types.ts:78-79` (TODO comment on the public type); code contract `lf/src/cache-manager.ts:85` (constant `false`)

### Implementation-only (second-class)

- `INV-LF-16`: `getCombinedSnapshot()` returns a referentially identical object across calls until one of `data`, `status`, `error`, or the history object actually changes.
  source: implementation-only (identity guard in `lf/src/cache-manager.ts:109-129`)
- `INV-LF-17`: `ModelBroadcaster` is a process-wide singleton: all models in a tab share one channel named `firsttx:models` and one `senderId`.
  source: implementation-only (`lf/src/broadcast.ts:58,66,90-95`; tests reach the singleton only via the private `instance` field)
- `INV-LF-18`: `close()` on the broadcaster closes the channel and clears all key listeners, after which no callbacks fire.
  source: implementation-only (`lf/src/broadcast.ts:160-163`)
- `INV-LF-19`: `updateWithError` and `setLoading` leave the previously computed history unchanged (only `updateWithData`/`updateHistory`/`setHistory` replace it).
  source: implementation-only (`lf/src/cache-manager.ts:67-77` never touch `cachedHistory`)

---

## Module 3: packages/prepaint (policy.ts, style-utils.ts)

### Documented or test-asserted

- `INV-PP-01`: Prepaint is opt-in: a missing policy, a non-object policy, or an empty `routes` array normalizes to `null`, which disables capture and restore.
  source: test "disables capture and restore when policy or routes are missing" in `pp/tests/policy.test.ts`; `pp/README.md` ("Prepaint is disabled until `policy.routes` explicitly opts pathnames in", "Missing or empty routes disable both capture and restore")
- `INV-PP-02`: A resolved policy always has all four fields, with defaults `ttlMs = STORAGE_CONFIG.MAX_SNAPSHOT_AGE` (7 days), `maxSnapshotBytes = STORAGE_CONFIG.MAX_SNAPSHOT_BYTES` (1 MiB), `includeStyles = true`.
  source: test "applies the opt-in defaults" in `pp/tests/policy.test.ts`; `pp/README.md` policy reference (defaults 7 days, 1 MiB, true); `STORAGE_CONFIG` in `pp/src/types.ts:1-9`
- `INV-PP-03`: Route matching is exact pathname equality — never prefix matching — and duplicate routes are deduplicated in the resolved policy.
  source: test "deduplicates exact routes without enabling prefix matches" in `pp/tests/policy.test.ts`; `pp/README.md` ("Matching is exact")
- `INV-PP-04`: Every route in a valid policy must be an absolute pathname (string starting with `/`); `validatePrepaintPolicy` throws on any relative route.
  source: test "rejects invalid limits and relative routes" in `pp/tests/policy.test.ts`; code contract `pp/src/policy.ts:35-37`
- `INV-PP-05`: `ttlMs` must be a positive finite number and `maxSnapshotBytes` must be a positive safe integer; `validatePrepaintPolicy` throws on violations (e.g. `ttlMs: 0`, `maxSnapshotBytes: Number.MAX_VALUE`), while `normalizePrepaintPolicy` returns `null` instead of throwing for the same inputs.
  source: test "rejects invalid limits and relative routes" in `pp/tests/policy.test.ts`; code contract `pp/src/policy.ts:46-57,75-85`
- `INV-PP-06`: Snapshot size is measured as the UTF-8 byte length of the JSON payload `{ body, styles }` (styles default to `[]`), so multibyte characters and stored styles both increase the measured size.
  source: test "measures the UTF-8 payload including stored styles" in `pp/tests/policy.test.ts`; `pp/README.md` (`maxSnapshotBytes` — "UTF-8 JSON payload")
- `INV-PP-07`: `shouldPruneSnapshot` prunes (returns `true` for) any record that is malformed, has no policy, is on a route outside `policy.routes`, is older than `ttlMs`, exceeds `maxSnapshotBytes`, or carries styles while `includeStyles` is `false`; a well-formed, allowed, fresh, in-budget record is kept.
  source: test "prunes disallowed, expired, oversized, and style-bearing records" in `pp/tests/policy.test.ts`; `pp/README.md` ("the same policy governs capture, restore, and stored-record pruning"; "every boot prunes records outside the current policy")
- `INV-PP-08`: A snapshot exactly at the TTL boundary is kept: pruning by age requires `now - timestamp > ttlMs` (strictly greater), as asserted by keeping age 500 and 1500 under `ttlMs: 1000` and pruning at 1501.
  source: test "prunes disallowed, expired, oversized, and style-bearing records" in `pp/tests/policy.test.ts:69-71`; code contract `pp/src/policy.ts:142`
- `INV-PP-09`: `serializePrepaintPolicy` output is safe to embed in a `<script>` element: the characters `&`, `<`, `>`, U+2028, and U+2029 never appear raw in the serialized string; each is replaced by its `\uXXXX` escape sequence (`\u0026`, `\u003c`, `\u003e`, `\u2028`, `\u2029`).
  source: test "escapes policy values before embedding them in a script" in `pp/tests/policy.test.ts`; code contract `pp/src/policy.ts:148-155`
- `INV-PP-10`: The same resolved policy governs capture, restore, and pruning — there is a single policy source of truth serialized into the boot asset and reused by `setupCapture()`.
  source: `pp/README.md` lines around "the same policy governs capture, restore, and stored-record pruning" and "The Vite policy is serialized into the boot asset and reused by `setupCapture()`"
- `INV-PP-11`: `isRouteAllowed(null, route)` is `false` for every route — no policy means nothing is allowed.
  source: code contract `pp/src/policy.ts:102-104` (`?? false`), consistent with README "Missing or empty routes disable both capture and restore" and INV-PP-01's test
- `INV-PP-12`: A style entry normalizes to a tagged `SnapshotStyle` union: plain strings become `{ type: 'inline', content }`, and blank or empty inline content normalizes to `null` (dropped) rather than producing an empty style.
  source: public type `SnapshotStyle` in `pp/src/types.ts:25-36`; code contract `pp/src/style-utils.ts:3-11`; consumption in `pp/src/overlay.ts:50` with overlay behavior asserted by test "injects inline and external styles into the overlay shadow root" in `pp/tests/overlay.test.ts`
- `INV-PP-13`: An external style entry without an `href` is invalid and normalizes to `null`; a valid external entry always keeps `type: 'external'` and `href`, and carries `content` only when non-empty content was captured.
  source: code contract `pp/src/style-utils.ts:12-17`; `ExternalSnapshotStyle` type (`href` required, `content` optional) in `pp/src/types.ts:32-36`

### Conflicted (README self-contradiction)

- `INV-PP-14`: `conflicted` — TTL configurability: the policy reference in `pp/README.md` documents `ttlMs?: number // Default: 7 days` as a configurable field (and `pp/src/policy.ts:45` honors it), but the README's limitations table states "Fixed 7-day TTL | Override in source (config planned)". Both statements are recorded; the tests exercise configurable `ttlMs` (test "prunes disallowed, expired, oversized, and style-bearing records" uses `ttlMs: 1000`), so the limitations row is the stale side.
  source: `pp/README.md` (policy reference vs limitations table); test in `pp/tests/policy.test.ts`

### Implementation-only (second-class)

- `INV-PP-15`: `setGlobalPrepaintPolicy` stores only the already-normalized policy (or `null`) in `globalThis.__FIRSTTX_PREPAINT_POLICY__`, and `resolvePrepaintPolicy()` with an explicit argument overwrites that global while an undefined argument reads it back.
  source: implementation-only (`pp/src/policy.ts:87-100`)
- `INV-PP-16`: UTF-8 byte measurement degrades gracefully: `TextEncoder` is preferred, then `Blob`, then an `encodeURIComponent`-based count, so `getSnapshotPayloadBytes` never throws for lack of platform APIs.
  source: implementation-only (`pp/src/policy.ts:106-114`)
