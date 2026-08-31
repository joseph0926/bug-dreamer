# Bug Dreamer

> Dream the edge case. Prove the bug.

Bug Dreamer imagines unlikely but reachable states in your code, turns them into executable tests, and reports only the tests that fail in isolation.

## How it works

1. Read a selected module and imagine unusual combinations of state, time, and user actions.
2. Turn each scenario into an executable test.
3. Run the test in an isolated environment.
4. Discard tests that pass or cannot run.
5. Rank reproducible failures by reachability and impact.
6. Write the remaining failures to a future postmortem.

The execution gate is the trust boundary. A plausible story is not enough. Every reported nightmare must include a command that reproduces the failure.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for version scope, validation rules, and project status.
