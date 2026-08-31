import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'compensates completed steps when a later step fails',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md:138 completed steps are rolled back in reverse order',
  },
  inputs: {
    completedSteps: 1,
    laterStepFails: true,
  },
  expected: 'The completed first step is compensated after the second step fails.',
  act: async () => {
    const events: string[] = [];
    const tx = startTransaction({ id: 'completed-steps-tracking-check' });

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
        throw new Error('step2 failure');
      })
      .catch(() => undefined);

    return events;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['step1-run', 'step1-compensate']);
  },
});
