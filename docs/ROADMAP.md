# Roadmap

## v0.1

### Scope

The first version targets one selected module in one project and runs manually. Its goal is to deliver one failing test that a human judges worth fixing.

Each report is written to `nightmares/YYYY-MM-DD.md` and contains:

- a future-dated incident timeline
- the reproduction command
- the failing test
- the relevant code path
- a short impact note

Nightly automation, multi-repository support, a web interface, and automatic fixes are outside the v0.1 scope.

### Validation rules

A nightmare appears in the report only when:

- the test runs in isolation
- the test fails
- another person can reproduce the failure with the recorded command

When more than one nightmare meets these rules, rank them by reachability and impact.

Passing tests and tests that cannot run are excluded from the report. A human makes the final call on whether the behavior is a real bug and worth fixing.

### Status

v0.1 is under development.
