import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'rejects new steps after rollback',
  oracle: {
    basis: 'existing-test',
    ref: 'packages/tx/tests/transaction.test.ts state transition expectations',
  },
  inputs: {
    firstStepFails: true,
    reuseAttempted: true,
  },
  expected: 'A rolled-back transaction throws TransactionStateError when a new step is added.',
  act: async () => {
    const tx = startTransaction({ id: 'reuse-after-rollback-check' });

    await tx
      .run(async () => {
        throw new Error('first step failure');
      })
      .catch(() => undefined);

    try {
      await tx.run(async () => 'again');
      return 'step-accepted';
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('TransactionStateError');
  },
});
