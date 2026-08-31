import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';

defineScenario({
  id: 'retry runs the step exactly maxAttempts times and reports every attempt error in order',
  oracle: {
    basis: 'public-type',
    ref: 'types.ts RetryConfig.maxAttempts jsdoc plus errors.ts RetryExhaustedError fields attempts and errors',
  },
  inputs: {
    step: 'always throws Error("attempt-N") where N is the call count',
    retry: { maxAttempts: 3, delayMs: 1, backoff: 'linear' },
  },
  expected:
    'The step is invoked exactly 3 times and the rejection is a RetryExhaustedError carrying attempts=3 and the three attempt errors in order.',
  act: async () => {
    let calls = 0;
    try {
      await executeWithRetry(
        async () => {
          calls += 1;
          throw new Error(`attempt-${calls}`);
        },
        'step-under-test',
        { maxAttempts: 3, delayMs: 1, backoff: 'linear' },
      );
      return {
        calls,
        name: 'no-error',
        attempts: 0,
        errorCount: 0,
        firstMessage: '',
        lastMessage: '',
      };
    } catch (error) {
      const err = error as { name: string; attempts?: number; errors?: Error[] };
      return {
        calls,
        name: err.name,
        attempts: err.attempts ?? 0,
        errorCount: err.errors?.length ?? 0,
        firstMessage: err.errors?.[0]?.message ?? '',
        lastMessage: err.errors?.[2]?.message ?? '',
      };
    }
  },
  assert: (actual, expect) => {
    expect(actual.calls).toBe(3);
    expect(actual.name).toBe('RetryExhaustedError');
    expect(actual.attempts).toBe(3);
    expect(actual.errorCount).toBe(3);
    expect(actual.firstMessage).toBe('attempt-1');
    expect(actual.lastMessage).toBe('attempt-3');
  },
});
