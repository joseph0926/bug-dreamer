import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'second commit on an already committed transaction resolves without error',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-TX-03 — separated invariant catalog, sourced from tx/tests/transaction.test.ts "should be idempotent on multiple commits" and code contract tx/src/transaction.ts:134-136',
  },
  inputs: {
    steps: ['one successful step returning "ok"', 'commit()', 'commit() again'],
  },
  expected:
    'Both commit() calls resolve; the second commit on a committed transaction neither throws nor rejects.',
  act: async () => {
    const tx = new Transaction();
    const stepValue = await tx.run(async () => 'ok');
    let firstCommit = 'resolved';
    try {
      await tx.commit();
    } catch (error) {
      firstCommit = (error as Error).name;
    }
    let secondCommit = 'resolved';
    try {
      await tx.commit();
    } catch (error) {
      secondCommit = (error as Error).name;
    }
    return { stepValue, firstCommit, secondCommit };
  },
  assert: (actual, expect) => {
    expect(actual.stepValue).toBe('ok');
    expect(actual.firstCommit).toBe('resolved');
    expect(actual.secondCommit).toBe('resolved');
  },
});
