import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'compensates a started step when that step fails',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md:138 and 147-152 contain conflicting rollback statements',
  },
  controlRef: 'packages/tx/tests/transaction.test.ts:614-654',
  inputs: {
    completedSteps: 1,
    failedStepStarted: true,
    failedStepHasCompensation: true,
  },
  expected: 'The failed step compensation runs before compensation for completed steps.',
  control: async (expect) => {
    const events: string[] = [];
    const tx = startTransaction({ id: 'completed-step-control' });

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

    await tx
      .run(async () => {
        events.push('step2-start');
        throw new Error('control failure');
      })
      .catch(() => undefined);

    expect(events).toEqual(['step1-run', 'step2-start', 'step1-compensate']);
  },
  act: async () => {
    const events: string[] = [];
    const tx = startTransaction({ id: 'failed-step-compensation' });

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

    await tx
      .run(
        async () => {
          events.push('step2-start');
          throw new Error('step2 failure');
        },
        {
          compensate: async () => {
            events.push('step2-compensate');
          },
        },
      )
      .catch(() => undefined);

    return events;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual([
      'step1-run',
      'step2-start',
      'step2-compensate',
      'step1-compensate',
    ]);
  },
});
