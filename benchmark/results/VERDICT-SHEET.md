# Clean-revision failure verdicts

These 20 scenarios were candidate failures on the unmodified target revision. Each needs one human verdict before the false-oracle rate is computed. Check exactly one box per row. `wrong-expectation` marks a false oracle; either `real-bug` verdict counts the scenario as a valid finding.

Verdict keys: RW = real bug worth fixing, RN = real bug not worth fixing, WE = wrong expectation, U = undecided.

Verdicts marked `[v]` were entered by the automated reviewer at the user's delegation (2026-08-31): rows whose mechanism was verified directly against the implementation and left no room for judgment. The three rows in "Open — user decision needed" were marked U (undecided) at the user's direction on 2026-08-31; undecided rows are excluded from the false-oracle denominator.

## baseline (14)

| Scenario | RW | RN | WE | U |
| --- | --- | --- | --- | --- |
| [tx/baseline-01](../baseline/tx/baseline-01.test.ts) — failed step compensation ordering (known v0.1 finding) | [v] | [ ] | [ ] | [ ] |
| [tx/baseline-02](../baseline/tx/baseline-02.test.ts) — original error rethrow vs RetryExhaustedError wrapping | [v] | [ ] | [ ] | [ ] |
| [tx/baseline-03](../baseline/tx/baseline-03.test.ts) — maxAttempts zero runs the step zero times and throws an internal error | [ ] | [v] | [ ] | [ ] |
| [tx/baseline-04](../baseline/tx/baseline-04.test.ts) — commit during an in-flight step stands, then the failure compensates committed work | [v] | [ ] | [ ] | [ ] |
| [local-first/baseline-01](../baseline/local-first/baseline-01.test.ts) — broadcast after close throws instead of degrading | [ ] | [v] | [ ] | [ ] |
| [local-first/baseline-02](../baseline/local-first/baseline-02.test.ts) — listener removed mid-dispatch loses a delivery it was subscribed for | [ ] | [v] | [ ] | [ ] |
| [local-first/baseline-03](../baseline/local-first/baseline-03.test.ts) — duplicate subscribe survives one unsubscribe | [ ] | [ ] | [ ] | [v] |
| [local-first/baseline-04](../baseline/local-first/baseline-04.test.ts) — updateHistory leaves the combined snapshot stale (setHistory does not) | [v] | [ ] | [ ] | [ ] |
| [local-first/baseline-05](../baseline/local-first/baseline-05.test.ts) — isStale boundary: docs say age > ttl, implementation uses age >= ttl | [ ] | [v] | [ ] | [ ] |
| [local-first/baseline-06](../baseline/local-first/baseline-06.test.ts) — one throwing subscriber breaks the write and starves later subscribers | [v] | [ ] | [ ] | [ ] |
| [prepaint/baseline-01](../baseline/prepaint/baseline-01.test.ts) — NaN timestamp snapshot is kept forever | [ ] | [v] | [ ] | [ ] |
| [prepaint/baseline-02](../baseline/prepaint/baseline-02.test.ts) — far-future timestamp snapshot pruned | [ ] | [ ] | [ ] | [v] |
| [prepaint/baseline-03](../baseline/prepaint/baseline-03.test.ts) — a malformed policy update silently wipes the valid global policy | [v] | [ ] | [ ] | [ ] |
| [prepaint/baseline-04](../baseline/prepaint/baseline-04.test.ts) — whitespace-only external href passes validation that blank inline content fails | [ ] | [v] | [ ] | [ ] |

## control (4)

| Scenario | RW | RN | WE | U |
| --- | --- | --- | --- | --- |
| [tx/control-01](../arms/control/tx/control-01.test.ts) — fails on the same RetryExhaustedError wrapping as tx/baseline-02 | [v] | [ ] | [ ] | [ ] |
| [tx/control-04](../arms/control/tx/control-04.test.ts) — fails on the same RetryExhaustedError wrapping as tx/baseline-02 | [v] | [ ] | [ ] | [ ] |
| [local-first/control-02](../arms/control/local-first/control-02.test.ts) — callback subscribed mid-dispatch fires for that same dispatch | [ ] | [v] | [ ] | [ ] |
| [prepaint/control-01](../arms/control/prepaint/control-01.test.ts) — mutating resolved policy must not widen global policy | [ ] | [ ] | [ ] | [v] |

## separated (2)

| Scenario | RW | RN | WE | U |
| --- | --- | --- | --- | --- |
| [tx/separated-03](../arms/separated/tx/separated-03.test.ts) — INV-TX-15: README says the failed step's own compensate runs; implementation skips it (matches the delivered v0.1 nightmare) | [v] | [ ] | [ ] | [ ] |
| [local-first/separated-04](../arms/separated/local-first/separated-04.test.ts) — INV-LF-10: docs say stale means age > ttl; implementation uses age >= ttl | [ ] | [v] | [ ] | [ ] |

## Open — user decision needed (3)

1. **local-first/baseline-03** — `subscribe`가 Set 기반이라 같은 콜백을 두 번 구독하면 하나로 합쳐지고, 해제 한 번에 전부 사라집니다. 이 dedup이 의도된 설계면 WE, 콜백별 독립 구독이 계약이면 RN입니다.
2. **prepaint/baseline-02** — 미래 timestamp(클럭 스큐 또는 손상) 스냅샷을 "정리해야 한다"는 문서 근거가 없습니다. 기대값 발명으로 보면 WE, 손상 레코드 방치도 결함으로 보면 RN입니다.
3. **prepaint/control-01** — `setGlobalPrepaintPolicy`가 내부 저장 객체와 같은 참조를 반환해 호출자 변조가 전역을 오염시킵니다. defensive copy가 계약이면 RN, 반환값 변조는 호출자 책임으로 보면 WE입니다.
