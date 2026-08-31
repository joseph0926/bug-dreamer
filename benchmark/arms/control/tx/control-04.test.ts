import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'rollback compensates completed steps in reverse order and skips the failed step itself',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/tx/src/transaction.ts rollback(): compensations run from completedSteps-1 down to 0; the failing step never completed so it is not compensated',
  },
  inputs: { completedSteps: ['a', 'b'], failingStep: 'c', failureMessage: 'boom' },
  expected:
    'When the third step fails, only the two completed steps are compensated, in reverse order undo-b then undo-a, and the failing step own compensate never runs.',
  act: async () => {
    const tx = new Transaction();
    const order: string[] = [];

    await tx.run(async () => 'a', {
      compensate: async () => {
        order.push('undo-a');
      },
    });
    await tx.run(async () => 'b', {
      compensate: async () => {
        order.push('undo-b');
      },
    });

    let caught = 'no-error';
    try {
      await tx.run(
        async () => {
          throw new Error('boom');
        },
        {
          compensate: async () => {
            order.push('undo-c');
          },
        },
      );
    } catch (error) {
      caught = error instanceof Error ? error.message : 'unknown';
    }

    return { caught, order };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ caught: 'boom', order: ['undo-b', 'undo-a'] });
  },
});
