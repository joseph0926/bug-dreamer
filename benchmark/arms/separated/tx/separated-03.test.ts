import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'failed step with its own compensate is compensated first during rollback as README documents',
  oracle: {
    basis: 'documentation',
    ref: 'INV-TX-15 — packages/tx/README.md:148 ("1. Execute undo3 (if step3 started)") (conflicts with packages/tx/src/transaction.ts:218 rollback loop bound `i = completedSteps - 1`)',
  },
  inputs: { completedSteps: 1, failingStepHasCompensate: true },
  expected:
    'Per the README Automatic Rollback section, the compensate of the failed step that started runs first, followed by the compensations of previously completed steps in reverse order.',
  act: async () => {
    const calls: string[] = [];
    const tx = new Transaction();
    await tx.run(
      async () => {
        calls.push('run1');
      },
      {
        compensate: async () => {
          calls.push('comp1');
        },
      },
    );
    try {
      await tx.run(
        async () => {
          calls.push('run2-started');
          throw new Error('step2 fails after starting');
        },
        {
          compensate: async () => {
            calls.push('comp2');
          },
        },
      );
    } catch {
      void 0;
    }
    return calls;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['run1', 'run2-started', 'comp2', 'comp1']);
  },
});
