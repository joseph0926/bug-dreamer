# Re-measurement registration — 2026-08-31

This document pins the full configuration of the phase 4 re-measurement before any rerun generation or execution starts. It exists because the 2026-08-31 external review found the original registration unverifiable: the manifest and the phase 4 results landed in one commit, the baseline model configuration was unrecorded, and the planned clean-control count (5) did not match the 3 clean images actually used. This file, the manifest correction, and the baseline model configuration must be committed before the first rerun generation session is spawned. The original results under `benchmark/results/` are retained as evidence but no longer support the phase 5 verdict.

## Fixed configuration

- Target: `joseph0926/firsttx` @ `f624b09f148c3368a51807f48d3237db20cef9c6`, modules `packages/tx`, `packages/local-first`, `packages/prepaint`
- Clean control group: the three registered clean module images (see `benchmark/manifest.json` control block)
- Defect set: the 20 defects in `benchmark/manifest.json`, unchanged
- Model: `claude-fable-5`, one fresh general-purpose agent session per arm (three sessions total), no conversation history, harness-default reasoning effort
- Contamination rule: a generation session receives only clean module sources at the pinned revision and the prompt below; it must never read `benchmark/manifest.json`, `benchmark/checks/`, `benchmark/results/`, `benchmark/arms/`, `benchmark/baseline/*/`, `scenarios/`, `evidence/`, `digests/`, or `nightmares/`
- Budget: 6 scenarios per module per arm (54 files), 3 generation sessions (bringing the benchmark total to 8 of 30), 30-second isolated execution limit per run
- Output layout: `benchmark/rerun-2026-08-31/<arm>/<tx|local-first|prepaint>/<arm>-01.test.ts` … `-06.test.ts` where `<arm>` is `baseline`, `control`, or `separated`
- Scoring (unchanged from phase 3): a defect counts as caught by an arm when at least one of that arm's scenarios is a candidate failure on the defect's image and a pass on the clean module image. Execution protocol: 3 consecutive runs per scenario on the clean module image (signature aggregation), then 1 run per same-module defect image
- Metrics: the phase 3 formulas in `docs/ROADMAP.md` apply unchanged; clean-image candidate failures go to a fresh verdict sheet for human review

## Arm prompts

### Baseline

The fixed prompt in `benchmark/baseline/PROMPT.md`, with every output path `benchmark/baseline/<module>/baseline-NN.test.ts` replaced by `benchmark/rerun-2026-08-31/baseline/<module>/baseline-NN.test.ts`. No other change.

### Control (Bug Dreamer same-context design)

The baseline prompt with its final constraint block extended by exactly this methodology section:

```text
You are Bug Dreamer. Do not merely test what the code obviously does. For each module:

1. Read the module source and its README, and list the states a user can put the system into, including rare but reachable ones: mid-flight operations, reordered events, delayed completions, repeated calls, boundary values, competing actors.
2. For each scenario, first write the expectation from a contract source that exists independently of your scenario: the README, an existing test, a public type, or an invariant the module explicitly maintains. Cite it precisely in oracle.ref. If you cannot cite one, discard the scenario.
3. Prefer sequences over single calls: put the system into a state, let an event intervene, then observe. Reachability matters; a state no caller can reach is worthless.
4. Write the test you believe the implementation might fail, never a test that restates the implementation.
```

### Separated (invariant-first design)

Two stages inside one session, in order:

1. The session first reads only `benchmark/arms/separated/INVARIANTS.md` plus each module's README, existing tests, and public types, and extends nothing: it uses the committed invariant catalog as the complete expectation source.
2. It then generates scenarios whose oracles each cite one catalog invariant by its identifier, with the goal of breaking the invariant. A scenario whose expectation is not one of the catalog invariants is discarded.

The output format, file counts, hard runtime constraints, and read prohibitions are identical to the baseline prompt.

## Order of operations

1. This registration, the manifest correction, and the baseline model configuration are committed by the user.
2. Three fresh generation sessions produce the 54 scenario files.
3. Execution and scoring run under the recorded protocol; results are written to `benchmark/results/rerun-2026-08-31-*.json`.
4. Clean-image candidate failures receive human verdicts on a fresh verdict sheet before the false-oracle rate is computed.
5. The phase 5 verdict is re-judged from the rerun numbers only.
