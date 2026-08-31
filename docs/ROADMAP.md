# Roadmap

## v0.1

### Scope

The first version targets one selected module in one project and runs manually. Its goal is to deliver one failing test that a human judges worth fixing.

The selected target is [`joseph0926/firsttx`](https://github.com/joseph0926/firsttx) at revision `f624b09f148c3368a51807f48d3237db20cef9c6`, limited to `packages/tx`.

The scenario target includes the imperative transaction lifecycle, retries, total timeout handling, external aborts, and reverse-order compensation. React hooks, DevTools behavior, and View Transition presentation are not scenario targets in v0.1.

Each report is written to `nightmares/YYYY-MM-DD.md` and contains:

- a future-dated incident timeline
- the reproduction command
- the failing test
- the relevant code path
- a short impact note

The execution model, evidence fields, reproduction rules, and report template are defined in [V0.1-CONTRACT.md](V0.1-CONTRACT.md).

Nightly automation, multi-repository support, a web interface, and automatic fixes are outside the v0.1 scope.

### Validation rules

A nightmare appears in the report only when:

- the test runs in isolation
- the target code is reached and the test observes an oracle violation or an unexpected target failure
- the oracle cites a product contract source independent of the generated scenario
- the author observes the same failure signature in three consecutive runs
- another person observes the same failure signature with the recorded isolation command

When more than one nightmare meets these rules, rank them by reachability and impact.

Passing tests and tests that cannot run are excluded from the report. Infrastructure errors, test-definition errors, and harness-enforced time or resource limits are recorded as unrunnable rather than product failures. A human makes the final call on whether the behavior is a real bug and worth fixing.

### Status

v0.1 is under development.
