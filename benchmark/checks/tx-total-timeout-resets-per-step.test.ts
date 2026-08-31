import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'enforces the transaction-wide timeout across steps',
  oracle: {
    basis: 'public-type',
    ref: 'packages/tx TxOptions.timeout is a transaction-wide budget measured from the first step',
  },
  inputs: {
    timeoutMs: 200,
    steps: 2,
    stepDurationMs: 150,
  },
  expected: 'A transaction whose steps together exceed the timeout rejects with TransactionTimeoutError.',
  act: async () => {
    const tx = startTransaction({ id: 'total-timeout-check', timeout: 200 });
    try {
      await tx.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      await tx.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      return 'completed';
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('TransactionTimeoutError');
  },
});
