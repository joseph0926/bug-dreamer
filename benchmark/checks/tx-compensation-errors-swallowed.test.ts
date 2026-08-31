import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'surfaces compensation failures during rollback',
  oracle: {
    basis: 'public-type',
    ref: 'packages/tx CompensationFailedError is the declared contract for failed compensations',
  },
  inputs: {
    completedSteps: 1,
    compensationThrows: true,
  },
  expected: 'A rollback whose compensation throws rejects with CompensationFailedError.',
  act: async () => {
    const tx = startTransaction({ id: 'compensation-error-check' });

    await tx.run(
      async () => 'step1',
      {
        compensate: async () => {
          throw new Error('compensation failure');
        },
      },
    );

    try {
      await tx.run(async () => {
        throw new Error('step2 failure');
      });
      return 'completed';
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('CompensationFailedError');
  },
});
