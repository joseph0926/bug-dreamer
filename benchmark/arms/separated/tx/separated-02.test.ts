import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'rolled-back transaction rejects both further run and commit with TransactionStateError',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-TX-04 — tests "should not allow adding steps after rollback" and "should throw TransactionStateError when committing rolled-back tx" in packages/tx/tests/transaction.test.ts',
  },
  inputs: { failAtStep: 2, actionsAfterRollback: ['run', 'commit'] },
  expected:
    'After a step failure rolls the transaction back, tx.run() throws TransactionStateError and commit() also throws TransactionStateError.',
  act: async () => {
    const tx = new Transaction();
    await tx.run(async () => 'first', {
      compensate: async () => {},
    });
    try {
      await tx.run(async () => {
        throw new Error('trigger rollback');
      });
    } catch {
      void 0;
    }
    const outcomes: string[] = [];
    try {
      await tx.run(async () => 'late step');
      outcomes.push('run-succeeded');
    } catch (error) {
      outcomes.push((error as Error).name);
    }
    try {
      await tx.commit();
      outcomes.push('commit-succeeded');
    } catch (error) {
      outcomes.push((error as Error).name);
    }
    return outcomes;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['TransactionStateError', 'TransactionStateError']);
  },
});
