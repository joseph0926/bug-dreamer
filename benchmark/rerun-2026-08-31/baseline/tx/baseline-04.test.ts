import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'transaction timeout budget is shared across steps instead of resetting per step',
  oracle: {
    basis: 'public-type',
    ref: 'types.ts TxOptions.timeout jsdoc: overall transaction timeout in milliseconds, measured from the first step',
  },
  inputs: {
    timeout: 200,
    step1: 'resolves after 120ms',
    step2: 'would resolve after 2000ms',
  },
  expected:
    'The second step rejects with TransactionTimeoutError after roughly the remaining 80ms of the overall budget, not after a fresh 200ms of its own.',
  act: async () => {
    const tx = new Transaction({ timeout: 200 });
    await tx.run(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('slow-but-ok'), 120);
        }),
    );
    const secondStart = Date.now();
    try {
      await tx.run(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('never'), 2000);
          }),
      );
      return { name: 'no-error', budgetShared: false };
    } catch (error) {
      const elapsed = Date.now() - secondStart;
      return { name: (error as Error).name, budgetShared: elapsed < 150 };
    }
  },
  assert: (actual, expect) => {
    expect(actual.name).toBe('TransactionTimeoutError');
    expect(actual.budgetShared).toBe(true);
  },
});
