import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';
import { TransactionStateError } from '@target/errors';

defineScenario({
  id: 'second run started while a step is still in flight is rejected without corrupting the first step',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/tx/src/transaction.ts isStepRunning guard: steps of one transaction execute sequentially, never overlapped',
  },
  inputs: { firstStepValue: 'first', overlappingStepValue: 'second' },
  expected:
    'Calling run while a previous step is still awaiting throws TransactionStateError, and the in-flight first step still completes successfully afterwards.',
  act: async () => {
    const tx = new Transaction();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = tx.run(async () => {
      await gate;
      return 'first';
    });

    let overlapped: unknown;
    let overlappedStepExecuted = false;
    try {
      await tx.run(async () => {
        overlappedStepExecuted = true;
        return 'second';
      });
      overlapped = 'no-error';
    } catch (error) {
      overlapped = error instanceof TransactionStateError ? error.name : 'unexpected-error';
    }

    release();
    const firstResult = await first;
    await tx.commit();

    return { overlapped, overlappedStepExecuted, firstResult };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      overlapped: 'TransactionStateError',
      overlappedStepExecuted: false,
      firstResult: 'first',
    });
  },
});
