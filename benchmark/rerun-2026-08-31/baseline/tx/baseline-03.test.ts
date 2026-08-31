import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'committed transaction stays committed when an in-flight step later fails',
  oracle: {
    basis: 'declared-invariant',
    ref: 'transaction.ts commit(): committed is a terminal status and repeated commit() returns silently (early return on status committed); TxStatus in types.ts',
  },
  inputs: {
    sequence:
      'step 1 succeeds with a compensation, step 2 started and still running, commit() awaited while step 2 runs (allowed for running status), step 2 rejects 50ms later, then commit() called again',
  },
  expected:
    'Once commit() has resolved the transaction is terminal: the late step failure must not trigger rollback of the committed step and the second commit() resolves silently.',
  act: async () => {
    const events: string[] = [];
    const tx = new Transaction();
    await tx.run(async () => 'setup', {
      compensate: async () => {
        events.push('compensated-after-commit');
      },
    });
    const failing = tx.run(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('late-failure')), 50);
        }),
    );
    await tx.commit();
    try {
      await failing;
      events.push('step-resolved');
    } catch {
      events.push('step-failed');
    }
    try {
      await tx.commit();
      events.push('second-commit-ok');
    } catch (error) {
      events.push(`second-commit-threw:${(error as Error).name}`);
    }
    return events;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['step-failed', 'second-commit-ok']);
  },
});
