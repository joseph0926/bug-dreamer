import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'compensates completed steps in reverse order',
  oracle: {
    basis: 'existing-test',
    ref: 'packages/tx/tests/transaction.test.ts:614-654 rollback order expectations',
  },
  inputs: {
    completedSteps: 2,
    failedStepHasCompensation: false,
  },
  expected: 'Completed steps are compensated in reverse completion order.',
  act: async () => {
    const events: string[] = [];
    const tx = startTransaction({ id: 'rollback-order-check' });

    await tx.run(
      async () => {
        events.push('step1-run');
      },
      {
        compensate: async () => {
          events.push('step1-compensate');
        },
      },
    );

    await tx.run(
      async () => {
        events.push('step2-run');
      },
      {
        compensate: async () => {
          events.push('step2-compensate');
        },
      },
    );

    await tx
      .run(async () => {
        events.push('step3-start');
        throw new Error('step3 failure');
      })
      .catch(() => undefined);

    return events;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual([
      'step1-run',
      'step2-run',
      'step3-start',
      'step2-compensate',
      'step1-compensate',
    ]);
  },
});
