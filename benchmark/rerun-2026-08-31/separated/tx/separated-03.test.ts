import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'after a rollback both run() and commit() throw TransactionStateError',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-TX-04 — separated invariant catalog, sourced from tx/tests/transaction.test.ts "should not allow adding steps after rollback" and "should throw TransactionStateError when committing rolled-back tx"',
  },
  inputs: {
    steps: [
      'step-0 succeeds with a no-op compensate',
      'step-1 throws Error("fail-step"), rolling the transaction back',
      'then run() and commit() are attempted on the rolled-back transaction',
    ],
  },
  expected:
    'Once the transaction is rolled-back, run() throws TransactionStateError and commit() throws TransactionStateError.',
  act: async () => {
    const tx = new Transaction();
    await tx.run(async () => 'first', { compensate: async () => {} });
    let stepError = 'did-not-throw';
    try {
      await tx.run(async () => {
        throw new Error('fail-step');
      });
    } catch (error) {
      stepError = (error as Error).message;
    }
    let runAfter = 'did-not-throw';
    try {
      await tx.run(async () => 'late');
    } catch (error) {
      runAfter = (error as Error).name;
    }
    let commitAfter = 'did-not-throw';
    try {
      await tx.commit();
    } catch (error) {
      commitAfter = (error as Error).name;
    }
    return { stepError, runAfter, commitAfter };
  },
  assert: (actual, expect) => {
    expect(actual.stepError).toBe('fail-step');
    expect(actual.runAfter).toBe('TransactionStateError');
    expect(actual.commitAfter).toBe('TransactionStateError');
  },
});
