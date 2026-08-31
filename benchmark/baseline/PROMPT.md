# Baseline generation prompt (fixed, 2026-08-31)

The baseline arm is one fresh agent session per benchmark round. The session receives exactly the prompt below, plus the scenario format reference included in it. It must not read the defect manifest, the check scenarios, or any Bug Dreamer evidence.

## Model configuration (registered 2026-08-31, before the re-measurement)

- Model: `claude-fable-5`, one fresh general-purpose agent session per arm, spawned with no conversation history
- Reasoning effort: harness default (no override)
- The original 2026-08-31 measurement did not record this configuration; it is registered here before the rerun and applies to every generation arm of the rerun

## Prompt

Write tests that find real bugs in this module.

You are given three modules of the firsttx project at `/Users/kimyounghoon/dev/p/firsttx`:

1. `packages/tx` — read `src/transaction.ts`, `src/retry.ts`, `src/errors.ts`
2. `packages/local-first` — read only `src/broadcast.ts`, `src/cache-manager.ts`
3. `packages/prepaint` — read only `src/policy.ts`, `src/style-utils.ts`

Write exactly 6 test scenarios per module in the format below, one scenario per file:

- `packages/tx` scenarios → `/Users/kimyounghoon/dev/p/bug-dreamer/benchmark/baseline/tx/baseline-01.test.ts` … `baseline-06.test.ts`
- `packages/local-first` scenarios → `/Users/kimyounghoon/dev/p/bug-dreamer/benchmark/baseline/local-first/baseline-01.test.ts` …
- `packages/prepaint` scenarios → `/Users/kimyounghoon/dev/p/bug-dreamer/benchmark/baseline/prepaint/baseline-01.test.ts` …

Format (each file contains exactly one call):

```ts
import { defineScenario } from '@bug-dreamer/scenario';
import { something } from '@target/<file-under-src-without-extension>';

defineScenario({
  id: 'short unique description of the behavior under test',
  oracle: {
    basis: 'documentation' | 'existing-test' | 'public-type' | 'declared-invariant',
    ref: 'where the expectation comes from',
  },
  inputs: { anything: 'describing the inputs' },
  expected: 'one sentence stating the expected behavior',
  act: async () => {
    return someValue;
  },
  assert: (actual, expect) => {
    expect(actual).toBe(someValue);
  },
});
```

Hard constraints:

- Runtime is vitest in a plain Node environment: no network, no DOM, no IndexedDB, no React.
- Import application code only from `@target/...` (the module's `src`). Import nothing else except `@bug-dreamer/scenario`.
- If `act` may throw an expected error, catch it inside `act` and return a distinguishing value (for example the error name); a test that lets `act` throw is discarded as unrunnable.
- Each scenario must complete within 10 seconds.
- Do not read anything under `/Users/kimyounghoon/dev/p/bug-dreamer` except the output directories you write to. In particular never read `benchmark/manifest.json`, `benchmark/checks/`, `scenarios/`, `evidence/`, or `nightmares/`.
- Target realistic bugs: state transitions, ordering, timeouts, retries, subscriptions, validation boundaries. Passing tests that merely restate the code are worthless; write the test you believe the implementation might fail.

Report one line per file written.
