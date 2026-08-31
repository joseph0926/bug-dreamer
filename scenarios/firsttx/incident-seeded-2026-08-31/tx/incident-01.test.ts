import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';
import { TransactionStateError } from '@target/errors';

defineScenario({
  id: 'commit accepted while a step is in flight must leave the transaction committed and immutable',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "After commit": the transaction becomes immutable and no more steps can be added; packages/tx/src/types.ts TxStatus lifecycle where committed is a terminal state',
  },
  inputs: { steps: 2, commitTiming: 'while step 2 is still running', step2Outcome: 'rejects after commit resolves' },
  expected:
    'Either commit() called while a step is running throws TransactionStateError, or once commit() resolves the transaction stays committed: the later step failure does not execute compensations and a follow-up run() reports currentState "committed".',
  act: async () => {
    const tx = new Transaction();
    const compensated: string[] = [];

    await tx.run(async () => 'first', {
      compensate: async () => {
        compensated.push('step-1');
      },
    });

    let releaseFailure: () => void = () => {};
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const inFlight = tx.run(
      async () => {
        await failureGate;
        throw new Error('late failure');
      },
      {
        compensate: async () => {
          compensated.push('step-2');
        },
      },
    );

    let commitOutcome = 'resolved';
    try {
      await tx.commit();
    } catch (error) {
      commitOutcome = error instanceof TransactionStateError ? 'state-error' : 'other-error';
    }

    releaseFailure();
    let stepOutcome = 'no-error';
    try {
      await inFlight;
    } catch (error) {
      stepOutcome = error instanceof Error ? error.message : 'unknown';
    }

    let stateAfter = 'unknown';
    try {
      await tx.run(async () => 'probe');
      stateAfter = 'accepted-new-step';
    } catch (error) {
      stateAfter = error instanceof TransactionStateError ? error.currentState : 'other-error';
    }

    return { commitOutcome, stepOutcome, compensated, stateAfter };
  },
  assert: (actual, expect) => {
    const observed = actual as {
      commitOutcome: string;
      stepOutcome: string;
      compensated: string[];
      stateAfter: string;
    };
    if (observed.commitOutcome === 'state-error') {
      expect(observed.commitOutcome).toBe('state-error');
      return;
    }
    expect(observed.compensated).toEqual([]);
    expect(observed.stateAfter).toBe('committed');
  },
});
