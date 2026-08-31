import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'committed transaction never rolls back when an in-flight step later fails',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/tx/src/types.ts TxStatus state machine ("committed" is terminal) and packages/tx/src/errors.ts TransactionStateError: "The transaction has already completed or failed"',
  },
  inputs: {
    step1: { result: 'succeeds', compensate: 'undo1' },
    step2: { result: 'rejects after 100ms', awaited: false },
    commit: 'called while step2 is still in flight',
  },
  expected:
    'Either commit() while a step is in flight throws TransactionStateError, or the commit stands and the later step failure must not trigger compensation of committed work; in no case may a committed transaction run compensations.',
  act: async () => {
    const compensations: string[] = [];
    const tx = new Transaction();
    await tx.run(async () => 'ok', {
      compensate: async () => {
        compensations.push('undo1');
      },
    });
    const inFlight = tx.run(
      () =>
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('late failure')), 100);
        }),
    );
    let commitOutcome = 'committed';
    try {
      await tx.commit();
    } catch (error) {
      commitOutcome = error instanceof Error ? error.name : String(error);
    }
    let stepOutcome = 'resolved';
    try {
      await inFlight;
    } catch (error) {
      stepOutcome = error instanceof Error ? error.name : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rolledBackAfterCommit = commitOutcome === 'committed' && compensations.length > 0;
    return { commitOutcome, stepOutcome, compensations, rolledBackAfterCommit };
  },
  assert: (actual, expect) => {
    expect(actual.rolledBackAfterCommit).toBe(false);
  },
});
