import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';
import { CompensationFailedError, TransactionStateError } from '@target/errors';

defineScenario({
  id: 'compensation failure during rollback surfaces CompensationFailedError and leaves the transaction unusable',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/src/errors.ts CompensationFailedError: failures list, completedSteps, isRecoverable() === false; transaction.ts sets status failed after rollback error',
  },
  inputs: { compensationError: 'undo-broken', stepError: 'original-failure' },
  expected:
    'When rollback compensation throws, the caller receives CompensationFailedError listing the failed compensation, it is not recoverable, and a later commit is rejected with a state error.',
  act: async () => {
    const tx = new Transaction();
    await tx.run(async () => 'ok', {
      compensate: async () => {
        throw new Error('undo-broken');
      },
    });

    let caught: unknown = 'no-error';
    try {
      await tx.run(async () => {
        throw new Error('original-failure');
      });
    } catch (error) {
      if (error instanceof CompensationFailedError) {
        caught = {
          name: error.name,
          failureMessages: error.failures.map((e) => e.message),
          completedSteps: error.completedSteps,
          recoverable: error.isRecoverable(),
        };
      } else {
        caught = error instanceof Error ? error.name : 'unknown';
      }
    }

    let commitAfter = 'no-error';
    try {
      await tx.commit();
    } catch (error) {
      commitAfter = error instanceof TransactionStateError ? error.currentState : 'unexpected-error';
    }

    return { caught, commitAfter };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      caught: {
        name: 'CompensationFailedError',
        failureMessages: ['undo-broken'],
        completedSteps: 1,
        recoverable: false,
      },
      commitAfter: 'failed',
    });
  },
});
