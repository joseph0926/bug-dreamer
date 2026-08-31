# Rerun verdict sheet — 2026-08-31

These 13 scenarios were candidate failures on the unmodified target revision in the phase 4 re-measurement (`benchmark/rerun-2026-08-31/`), each with the same failure signature in 3 of 3 isolated clean-image runs. Each needs one human verdict before the rerun's false-oracle rate is computed. Check exactly one box per row. `wrong-expectation` marks a false oracle; either `real-bug` verdict counts the scenario as a valid finding. Evidence: `evidence/2026-08-31/rerun/<arm>/clean-<module>.json`.

Known-bug linkage is an annotation, not a verdict: rows marked "matches nightmare N" observe the same failure mechanism as an already-judged nightmare in `nightmares/2026-08-31.md`.

| # | Arm | Scenario | Claim | Note |
|---|-----|----------|-------|------|
| 1 | baseline | tx/baseline-01 | A failing step without retry config surfaces the original error; implementation wraps it in `RetryExhaustedError` | same mechanism as rows 5, 11, 12 |
| 2 | baseline | tx/baseline-03 | A committed transaction is later rolled back by an in-flight step failure | matches nightmare 3 (judged worth fixing) |
| 3 | baseline | local-first/baseline-03 | `broadcast()` after `close()` throws `InvalidStateError` despite the declared graceful degradation | same as row 8 |
| 4 | baseline | local-first/baseline-04 | `setHistory` replaces the combined snapshot without notifying subscribers | same as row 10 |
| 5 | control | tx/control-02 | README "Re-throw original error" versus `RetryExhaustedError` wrapping | same as row 1 |
| 6 | control | tx/control-01 | The failed step's own `compensate` never runs | matches nightmare 1 (judged worth fixing) |
| 7 | control | tx/control-03 | Compensation runs after a successful `commit()` while a step was in flight | matches nightmare 3 (judged worth fixing) |
| 8 | control | tx/control-04 | `maxAttempts: 0` leaks an internal invariant `Error` instead of the documented `RetryExhaustedError` | boundary-input contract |
| 9 | control | local-first/control-03 | `broadcast()` after `close()` throws | same as row 3 |
| 10 | control | local-first/control-04 | `isStale` at `age === ttl` is true while docs say `age > ttl` | doc/impl boundary mismatch |
| 11 | control | local-first/control-06 | `setHistory` skips subscriber notification | same as row 4 |
| 12 | separated | tx/separated-01 | INV-TX-02: rethrown error is `Retry exhausted for step-2` instead of the original `boom` | same mechanism as rows 1, 5 |
| 13 | separated | tx/separated-03 | INV-TX-04: after rollback the recorded first-failure message is wrapped, not the original | same mechanism as rows 1, 5 |

Verdicts (check one per row):

| # | real-bug-worth-fixing | real-bug-not-worth-fixing | wrong-expectation | undecided |
|---|---|---|---|---|
| 1 | [v] | [ ] | [ ] | [ ] |
| 2 | [v] | [ ] | [ ] | [ ] |
| 3 | [v] | [ ] | [ ] | [ ] |
| 4 | [v] | [ ] | [ ] | [ ] |
| 5 | [v] | [ ] | [ ] | [ ] |
| 6 | [v] | [ ] | [ ] | [ ] |
| 7 | [v] | [ ] | [ ] | [ ] |
| 8 | [ ] | [v] | [ ] | [ ] |
| 9 | [v] | [ ] | [ ] | [ ] |
| 10 | [ ] | [v] | [ ] | [ ] |
| 11 | [v] | [ ] | [ ] | [ ] |
| 12 | [v] | [ ] | [ ] | [ ] |
| 13 | [v] | [ ] | [ ] | [ ] |

Recorded 2026-08-31: the user judged all 13 rows real bugs (0 wrong-expectation). The worth-fixing split for rows 8 and 10 (real-bug-not-worth-fixing: boundary-input error leak, 1ms staleness doc mismatch) was delegated to the assistant and can be flipped without changing any pre-registered metric.
