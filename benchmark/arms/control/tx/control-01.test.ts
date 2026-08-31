import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';
import { TransactionStateError } from '@target/errors';

defineScenario({
  id: 'transaction reused after rolled-back step rejects new steps with state error',
  oracle: {
    basis: 'public-type',
    ref: 'packages/tx/src/types.ts TxStatus lifecycle and TransactionStateError contract in packages/tx/src/errors.ts',
  },
  inputs: { firstStepError: 'boom', secondStepValue: 'second' },
  expected:
    'After a step fails and the transaction rolls back, calling run again throws TransactionStateError whose currentState is rolled-back instead of executing the new step.',
  act: async () => {
    const tx = new Transaction();
    let firstOutcome = 'no-error';
    try {
      await tx.run(async () => {
        throw new Error('boom');
      });
    } catch (error) {
      firstOutcome = error instanceof Error ? error.message : 'unknown';
    }

    let secondStepExecuted = false;
    try {
      await tx.run(async () => {
        secondStepExecuted = true;
        return 'second';
      });
      return { firstOutcome, secondStepExecuted, reuse: 'no-error' };
    } catch (error) {
      if (error instanceof TransactionStateError) {
        return {
          firstOutcome,
          secondStepExecuted,
          reuse: { name: error.name, currentState: error.currentState, recoverable: error.isRecoverable() },
        };
      }
      return { firstOutcome, secondStepExecuted, reuse: 'unexpected-error' };
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      firstOutcome: 'boom',
      secondStepExecuted: false,
      reuse: { name: 'TransactionStateError', currentState: 'rolled-back', recoverable: false },
    });
  },
});
