import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';

defineScenario({
  id: 'succeeds on the final configured retry attempt',
  oracle: {
    basis: 'existing-test',
    ref: 'packages/tx/tests/retry.test.ts retry-until-maxAttempts expectations',
  },
  inputs: {
    maxAttempts: 3,
    failuresBeforeSuccess: 2,
  },
  expected: 'A step that succeeds on its final allowed attempt returns its value.',
  act: async () => {
    let attempts = 0;
    try {
      return await executeWithRetry(
        async () => {
          attempts += 1;
          if (attempts <= 2) throw new Error(`attempt ${attempts} failure`);
          return 'success';
        },
        'final-attempt-check',
        { maxAttempts: 3, delayMs: 1 },
      );
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('success');
  },
});
