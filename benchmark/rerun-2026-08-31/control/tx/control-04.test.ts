import { defineScenario } from '@bug-dreamer/scenario';
import { executeWithRetry } from '@target/retry';

defineScenario({
  id: 'maxAttempts zero surfaces the documented RetryExhaustedError not an internal invariant error',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "tx.run" Throws: "RetryExhaustedError - When all retry attempts fail"; packages/tx/src/types.ts RetryConfig.maxAttempts "Maximum number of retry attempts"',
  },
  inputs: {
    retryConfig: { maxAttempts: 0 },
    fn: 'counts invocations and would resolve if ever called',
  },
  expected:
    'With zero permitted attempts the step function is never invoked and the failure is reported through the declared RetryExhaustedError channel',
  act: async () => {
    let calls = 0;
    try {
      await executeWithRetry(
        async () => {
          calls++;
          return 'ok';
        },
        'step-0',
        { maxAttempts: 0 },
      );
      return { outcome: 'resolved', calls };
    } catch (error) {
      return { outcome: (error as Error).name, calls };
    }
  },
  assert: (actual, expect) => {
    expect(actual.calls).toBe(0);
    expect(actual.outcome).toBe('RetryExhaustedError');
  },
});
