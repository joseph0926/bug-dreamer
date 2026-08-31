import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';
import { RetryExhaustedError } from '@target/errors';

defineScenario({
  id: 'retry exhaustion runs exactly maxAttempts attempts and records every error',
  oracle: {
    basis: 'public-type',
    ref: 'packages/tx/src/types.ts RetryConfig.maxAttempts and packages/tx/src/errors.ts RetryExhaustedError public fields attempts and errors',
  },
  inputs: {
    retry: { maxAttempts: 3, delayMs: 10, backoff: 'linear' },
    step: { behavior: 'always throws attempt-N' },
  },
  expected:
    'A step that always fails with maxAttempts 3 is invoked exactly 3 times and rejects with RetryExhaustedError whose attempts is 3 and whose errors array holds the 3 attempt errors in order.',
  act: async () => {
    let calls = 0;
    try {
      await executeWithRetry(
        async () => {
          calls++;
          throw new Error(`attempt-${calls}`);
        },
        'step-under-test',
        { maxAttempts: 3, delayMs: 10, backoff: 'linear' },
      );
      return { calls, outcome: 'resolved', attempts: -1, errorMessages: [] as string[] };
    } catch (error) {
      if (error instanceof RetryExhaustedError) {
        return {
          calls,
          outcome: 'retry-exhausted',
          attempts: error.attempts,
          errorMessages: error.errors.map((e) => e.message),
        };
      }
      return {
        calls,
        outcome: error instanceof Error ? error.name : String(error),
        attempts: -1,
        errorMessages: [] as string[],
      };
    }
  },
  assert: (actual, expect) => {
    expect(actual.calls).toBe(3);
    expect(actual.outcome).toBe('retry-exhausted');
    expect(actual.attempts).toBe(3);
    expect(actual.errorMessages).toEqual(['attempt-1', 'attempt-2', 'attempt-3']);
  },
});
