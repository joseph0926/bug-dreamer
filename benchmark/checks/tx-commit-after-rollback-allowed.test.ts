import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'rejects commit after rollback',
  oracle: {
    basis: 'existing-test',
    ref: 'packages/tx/tests/transaction.test.ts state transition expectations',
  },
  inputs: {
    rolledBackBeforeCommit: true,
  },
  expected: 'Committing a rolled-back transaction throws TransactionStateError.',
  act: async () => {
    const tx = startTransaction({ id: 'commit-after-rollback-check' });

    await tx
      .run(async () => {
        throw new Error('step failure');
      })
      .catch(() => undefined);

    try {
      await tx.commit();
      return 'committed';
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('TransactionStateError');
  },
});
