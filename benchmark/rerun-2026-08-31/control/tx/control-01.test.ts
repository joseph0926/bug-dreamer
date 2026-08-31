import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'rollback compensates the failed step itself before earlier steps',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "Automatic Rollback": "If step3 fails: 1. Execute undo3 (if step3 started) 2. Execute undo2 3. Execute undo1"',
  },
  inputs: {
    step0: 'succeeds, compensate pushes undo1',
    step1: 'starts and throws, compensate pushes undo2',
  },
  expected:
    'The failed step that had started is compensated first, then completed steps in reverse order, so the compensation order is [undo2, undo1]',
  act: async () => {
    const order: string[] = [];
    const tx = new Transaction({ timeout: 5000 });
    await tx.run(async () => 'ok', {
      compensate: async () => {
        order.push('undo1');
      },
    });
    try {
      await tx.run(
        async () => {
          throw new Error('step2-boom');
        },
        {
          compensate: async () => {
            order.push('undo2');
          },
        },
      );
    } catch {
      void 0;
    }
    return order;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['undo2', 'undo1']);
  },
});
