import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'single failing step without retry config surfaces the original step error',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/src/types.ts RetryConfig jsdoc: maxAttempts default is 1 (no retry), so a plain step failure should reach the caller as the error the step threw',
  },
  inputs: {
    step: 'async function that throws PaymentDeclinedError("original-failure") once',
    retry: 'not configured',
  },
  expected:
    'run() rejects with the exact error the step threw, not a retry wrapper, when no retry was requested.',
  act: async () => {
    const tx = new Transaction();
    try {
      await tx.run(async () => {
        const err = new Error('original-failure');
        err.name = 'PaymentDeclinedError';
        throw err;
      });
      return { name: 'no-error', message: '' };
    } catch (error) {
      const err = error as Error;
      return { name: err.name, message: err.message };
    }
  },
  assert: (actual, expect) => {
    expect(actual.name).toBe('PaymentDeclinedError');
    expect(actual.message).toBe('original-failure');
  },
});
