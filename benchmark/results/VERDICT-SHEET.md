# Clean-revision failure verdicts

These 20 scenarios were candidate failures on the unmodified target revision. Each needs one human verdict before the false-oracle rate is computed. Check exactly one box per row. `wrong-expectation` marks a false oracle; either `real-bug` verdict counts the scenario as a valid finding.

Verdict keys: RW = real bug worth fixing, RN = real bug not worth fixing, WE = wrong expectation, U = undecided.

## baseline (14)

| Scenario | RW | RN | WE | U |
| --- | --- | --- | --- | --- |
| [tx/baseline-01](../baseline/tx/baseline-01.test.ts) — failed step compensation ordering (known v0.1 finding) | [ ] | [ ] | [ ] | [ ] |
| [tx/baseline-02](../baseline/tx/baseline-02.test.ts) — original error rethrow vs RetryExhaustedError wrapping | [ ] | [ ] | [ ] | [ ] |
| [tx/baseline-03](../baseline/tx/baseline-03.test.ts) — maxAttempts zero still executes once | [ ] | [ ] | [ ] | [ ] |
| [tx/baseline-04](../baseline/tx/baseline-04.test.ts) — committed transaction never rolls back afterwards | [ ] | [ ] | [ ] | [ ] |
| [local-first/baseline-01](../baseline/local-first/baseline-01.test.ts) — broadcast after close degrades gracefully | [ ] | [ ] | [ ] | [ ] |
| [local-first/baseline-02](../baseline/local-first/baseline-02.test.ts) — unsubscribe during dispatch does not skip delivery | [ ] | [ ] | [ ] | [ ] |
| [local-first/baseline-03](../baseline/local-first/baseline-03.test.ts) — duplicate subscribe survives one unsubscribe | [ ] | [ ] | [ ] | [ ] |
| [local-first/baseline-04](../baseline/local-first/baseline-04.test.ts) — snapshot history sync after direct updateHistory | [ ] | [ ] | [ ] | [ ] |
| [local-first/baseline-05](../baseline/local-first/baseline-05.test.ts) — isStale false when age equals ttl (doc says age > ttl) | [ ] | [ ] | [ ] | [ ] |
| [local-first/baseline-06](../baseline/local-first/baseline-06.test.ts) — throwing subscriber does not block others | [ ] | [ ] | [ ] | [ ] |
| [prepaint/baseline-01](../baseline/prepaint/baseline-01.test.ts) — NaN timestamp snapshot pruned | [ ] | [ ] | [ ] | [ ] |
| [prepaint/baseline-02](../baseline/prepaint/baseline-02.test.ts) — far-future timestamp snapshot pruned | [ ] | [ ] | [ ] | [ ] |
| [prepaint/baseline-03](../baseline/prepaint/baseline-03.test.ts) — invalid policy update keeps previous global policy | [ ] | [ ] | [ ] | [ ] |
| [prepaint/baseline-04](../baseline/prepaint/baseline-04.test.ts) — whitespace-only external href normalizes to null | [ ] | [ ] | [ ] | [ ] |

## control (4)

| Scenario | RW | RN | WE | U |
| --- | --- | --- | --- | --- |
| [tx/control-01](../arms/control/tx/control-01.test.ts) — reuse after rollback rejected (also asserts failed-step compensation) | [ ] | [ ] | [ ] | [ ] |
| [tx/control-04](../arms/control/tx/control-04.test.ts) — rollback order and failed-step skip combined assertion | [ ] | [ ] | [ ] | [ ] |
| [local-first/control-02](../arms/control/local-first/control-02.test.ts) — subscribe during in-flight notification not invoked | [ ] | [ ] | [ ] | [ ] |
| [prepaint/control-01](../arms/control/prepaint/control-01.test.ts) — mutating resolved policy must not widen global policy | [ ] | [ ] | [ ] | [ ] |

## separated (2)

| Scenario | RW | RN | WE | U |
| --- | --- | --- | --- | --- |
| [tx/separated-03](../arms/separated/tx/separated-03.test.ts) — INV-TX-15: README says the failed step's own compensate runs; implementation skips it (matches the delivered v0.1 nightmare) | [ ] | [ ] | [ ] | [ ] |
| [local-first/separated-04](../arms/separated/local-first/separated-04.test.ts) — INV-LF-10: docs say stale means age > ttl; implementation uses age >= ttl | [ ] | [ ] | [ ] | [ ] |
