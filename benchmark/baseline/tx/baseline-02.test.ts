import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'step failure without retry config rethrows the original error',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "Automatic Rollback" step 4: "Re-throw original error"; packages/tx/src/types.ts RetryConfig maxAttempts "(default: 1)" means no retries by default',
  },
  inputs: {
    step: { throws: 'Error("boom-original")', retry: 'not configured' },
  },
  expected:
    'A step that fails once with no retry configured rejects run() with the original Error instance carrying name Error and message boom-original, not a wrapper error.',
  act: async () => {
    const tx = new Transaction();
    try {
      await tx.run(async () => {
        throw new Error('boom-original');
      });
      return { name: 'none', message: 'none' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { name: err.name, message: err.message };
    }
  },
  assert: (actual, expect) => {
    expect(actual.name).toBe('Error');
    expect(actual.message).toBe('boom-original');
  },
});
