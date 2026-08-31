import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'retry maxAttempts zero still executes the step at least once',
  oracle: {
    basis: 'public-type',
    ref: 'packages/tx/src/types.ts RetryConfig.maxAttempts "Maximum number of retry attempts (default: 1)" — every step gets at least one execution attempt',
  },
  inputs: {
    step: { behavior: 'increments a counter and resolves', retry: { maxAttempts: 0 } },
  },
  expected:
    'A degenerate retry config of maxAttempts 0 must not skip execution entirely; the step function runs at least once (clamped to the documented minimum of one attempt).',
  act: async () => {
    let calls = 0;
    const tx = new Transaction();
    let outcome = 'resolved';
    try {
      await tx.run(
        async () => {
          calls++;
          return 'ok';
        },
        { retry: { maxAttempts: 0 } },
      );
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    return { calls, outcome };
  },
  assert: (actual, expect) => {
    expect(actual.calls).toBeGreaterThanOrEqual(1);
  },
});
