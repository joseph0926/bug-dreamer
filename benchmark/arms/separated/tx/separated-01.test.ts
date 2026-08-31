import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'compensations of completed steps run in reverse completion order when a later step fails',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-TX-02 — test "should handle mixed success/failure with partial rollback" in packages/tx/tests/transaction.test.ts; packages/tx/README.md:136 "Automatic Rollback"',
  },
  inputs: { steps: 3, failingStep: 3, compensationDelayMs: 20 },
  expected:
    'When the third step fails, the compensations of steps 1 and 2 run in reverse completion order (comp2 then comp1) before the error propagates to the caller.',
  act: async () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
    await tx.run(
      async () => {
        calls.push('run2');
      },
      {
        compensate: async () => {
          await sleep(20);
          calls.push('comp2');
        },
      },
    );
    let propagated = false;
    try {
      await tx.run(async () => {
        calls.push('run3');
        throw new Error('step3 boom');
      });
    } catch {
      propagated = true;
    }
    return { calls, propagated };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      calls: ['run1', 'run2', 'run3', 'comp2', 'comp1'],
      propagated: true,
    });
  },
});
