import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';

defineScenario({
  id: 'keeps every attempt error in RetryExhaustedError',
  oracle: {
    basis: 'public-type',
    ref: 'packages/tx RetryExhaustedError.errors is the declared per-attempt error history',
  },
  inputs: {
    maxAttempts: 3,
    allAttemptsFail: true,
  },
  expected: 'RetryExhaustedError.errors contains one entry per failed attempt.',
  act: async () => {
    let attempts = 0;
    try {
      await executeWithRetry(
        async () => {
          attempts += 1;
          throw new Error(`attempt ${attempts} failure`);
        },
        'error-history-check',
        { maxAttempts: 3, delayMs: 1 },
      );
      return 'unexpected-success';
    } catch (error) {
      if (error instanceof Error && 'errors' in error && Array.isArray(error.errors)) {
        return error.errors.length;
      }
      return error instanceof Error ? error.name : String(error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe(3);
  },
});
