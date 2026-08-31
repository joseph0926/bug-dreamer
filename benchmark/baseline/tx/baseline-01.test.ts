import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'rollback runs the failed step compensation before earlier compensations',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "Automatic Rollback": "If step3 fails: 1. Execute undo3 (if step3 started) 2. Execute undo2 3. Execute undo1"',
  },
  inputs: {
    step1: { result: 'succeeds', compensate: 'undo1' },
    step2: { result: 'starts then throws', compensate: 'undo2' },
  },
  expected:
    'When a started step fails, its own compensation runs first, followed by earlier compensations in reverse order, so the order is undo2 then undo1.',
  act: async () => {
    const order: string[] = [];
    const tx = new Transaction();
    await tx.run(async () => 'ok', {
      compensate: async () => {
        order.push('undo1');
      },
    });
    let caught = 'none';
    try {
      await tx.run(
        async () => {
          throw new Error('step2 failed after starting');
        },
        {
          compensate: async () => {
            order.push('undo2');
          },
        },
      );
    } catch (error) {
      caught = error instanceof Error ? error.name : String(error);
    }
    return { order, caught };
  },
  assert: (actual, expect) => {
    expect(actual.caught).not.toBe('none');
    expect(actual.order).toEqual(['undo2', 'undo1']);
  },
});
