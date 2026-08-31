import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';
import { RetryExhaustedError } from '@target/errors';

defineScenario({
  id: 'retry exhaustion after persistent failures reports every attempt in RetryExhaustedError',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/src/errors.ts RetryExhaustedError: stepId, attempts, per-attempt errors, isRecoverable() === true',
  },
  inputs: { maxAttempts: 3, delayMs: 10, backoff: 'linear', stepId: 'flaky-step' },
  expected:
    'A step that fails on all three attempts throws RetryExhaustedError carrying attempts=3 and all three underlying errors in order, and the error reports itself as recoverable.',
  act: async () => {
    let calls = 0;
    try {
      await executeWithRetry(
        async () => {
          calls += 1;
          throw new Error(`fail-${calls}`);
        },
        'flaky-step',
        { maxAttempts: 3, delayMs: 10, backoff: 'linear' },
      );
      return 'no-error';
    } catch (error) {
      if (error instanceof RetryExhaustedError) {
        return {
          name: error.name,
          stepId: error.stepId,
          attempts: error.attempts,
          calls,
          messages: error.errors.map((e) => e.message),
          recoverable: error.isRecoverable(),
        };
      }
      return 'unexpected-error';
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      name: 'RetryExhaustedError',
      stepId: 'flaky-step',
      attempts: 3,
      calls: 3,
      messages: ['fail-1', 'fail-2', 'fail-3'],
      recoverable: true,
    });
  },
});
