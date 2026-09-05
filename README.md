# Bug Dreamer

> Dream the edge case. Prove the bug.

Bug Dreamer imagines unlikely but reachable states in your code, turns them into executable tests, and reports only the tests that fail in isolation.

The workflow below describes the completed v0.1 and v0.2 system. v0.3 is in progress and replaces generated test code with validated data, a trusted interpreter, and a separate result channel.

## How it works

1. Extract the module's contracts first: documentation, existing tests, public types, and declared invariants. They are the only source of expectations.
2. Imagine unusual but reachable combinations of state, time, and user actions that could break those contracts, and turn each into an executable test.
3. Run every test in an isolated environment: Docker, network blocked, command allow-list, time and resource limits.
4. Discard tests that pass or cannot run. Infrastructure and test-definition failures are never product bugs.
5. Keep only failures that show the same signature in three consecutive runs, then reproduce them once more in an independent session.
6. Rank the survivors by reachability and impact, write them to a future-dated postmortem, and let a human make the final call.

For v0.1 and v0.2, the execution gate is the trust boundary. A plausible story is not enough. Every reported nightmare must include a command that reproduces the failure, and its expectation must cite a contract source that exists independently of the generated scenario.

v0.2 reachability was verified against fixed repository-internal execution contracts. Consumer-level reachability through declared package exports and stronger oracle requirements are under audit in v0.3. Its independent reproduction gate requires a separate session and a newly built evaluator image on the same host; reproduction on another physical host remains follow-up validation. A malicious target package deliberately impersonating the trusted result channel is outside the v0.3 threat model. The v0.3 operator spike closed as `adopt`, and Phase 3 reduction verified that its three-action spec is already 1-minimal under the registered deletion rules, with a fresh clean pass and five matching defect runs. The complete benchmark, real-module application, and reporting phases remain outstanding.

## What exists today

- An isolated Docker runner (`scripts/run-scenario.mjs`), a batch runner with signature aggregation (`scripts/run-batch.mjs`), and a once-a-day candidate digest (`scripts/run-digest.mjs`) that never publishes a nightmare on its own.
- Execution contracts for three modules of the pinned target, [`joseph0926/firsttx`](https://github.com/joseph0926/firsttx): `packages/tx`, `packages/local-first`, and `packages/prepaint`.
- A fixture benchmark of 20 planted defects with pre-registered success criteria; the invariant-first generation design passed them and is the default.
- An incident-seeded mode: start from a fixed public bugfix PR, abstract the cause into a state-transition sequence, mutate the sequence (reorder, delay, swap actors), and search sibling feature surfaces by user state and event order rather than by code similarity.
- Seven published nightmares in [nightmares/2026-08-31.md](nightmares/2026-08-31.md), each with recorded evidence, an independent reproduction, and a human verdict.
- A v0.3 dependency-closure reducer (`node scripts/prepare-v03-reduction.mjs`) that records every removal attempt and isolated execution in `evidence/v0.3/phase3-reduction.json`. `replay` validates the complete reduction trace and blocks Phase 3 completion when the evidence is missing or incomplete. Minimality is relative to the registered deletion rules; it does not claim the shortest possible reproducer.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for version scope, validation rules, and project status. v0.1 and v0.2 are complete, while v0.3 is in progress.

See [docs/V0.1-CONTRACT.md](docs/V0.1-CONTRACT.md) for outcome semantics, evidence fields, reproduction rules, and the report template; v0.2 reuses them unchanged.

See [docs/V0.3-CONTRACT.md](docs/V0.3-CONTRACT.md) for the v0.3 data contracts, trust boundary, result axes, reproduction rules, and publication gate.
