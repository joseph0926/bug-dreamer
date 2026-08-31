import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'rollback compensates completed steps in reverse order and never runs the failed step compensation',
  oracle: {
    basis: 'declared-invariant',
    ref: 'transaction.ts rollback(): saga compensation contract, only completed steps are compensated starting from the last completed one',
  },
  inputs: {
    steps:
      'two successful steps with compensations, then a third step that fails and also declares a compensation',
  },
  expected:
    'Only the two completed compensations run, last completed first, and the failed step compensation never runs.',
  act: async () => {
    const order: string[] = [];
    const tx = new Transaction();
    await tx.run(async () => 'first', {
      compensate: async () => {
        order.push('undo-first');
      },
    });
    await tx.run(async () => 'second', {
      compensate: async () => {
        order.push('undo-second');
      },
    });
    try {
      await tx.run(
        async () => {
          throw new Error('third-fails');
        },
        {
          compensate: async () => {
            order.push('undo-third');
          },
        },
      );
    } catch {
      order.push('run-rejected');
    }
    return order;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['undo-second', 'undo-first', 'run-rejected']);
  },
});
