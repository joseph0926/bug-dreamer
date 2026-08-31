import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'failed compensations produce CompensationFailedError in reverse order and a failed terminal state',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "CompensationFailedError" fields: "failures: Error[] - All compensation errors (in reverse order)", "completedSteps"; FAQ: "The transaction is marked as \'failed\'"; TransactionStateError fields currentState/attemptedAction',
  },
  inputs: {
    steps:
      'step-0 and step-1 succeed with compensations that throw undo1-boom and undo2-boom, step-2 throws, then commit is attempted',
  },
  expected:
    'run rejects with CompensationFailedError (failures [undo2-boom, undo1-boom], completedSteps 2, not recoverable) and the subsequent commit rejects with TransactionStateError in state failed',
  act: async () => {
    const tx = new Transaction({ timeout: 5000 });
    await tx.run(async () => 1, {
      compensate: async () => {
        throw new Error('undo1-boom');
      },
    });
    await tx.run(async () => 2, {
      compensate: async () => {
        throw new Error('undo2-boom');
      },
    });
    let caught: {
      name?: string;
      failures?: Error[];
      completedSteps?: number;
      isRecoverable?: () => boolean;
    } | null = null;
    try {
      await tx.run(async () => {
        throw new Error('step3-boom');
      });
    } catch (error) {
      caught = error as typeof caught;
    }
    let commitErrorName = 'no-error';
    let commitState = '';
    try {
      await tx.commit();
    } catch (error) {
      const e = error as { name?: string; currentState?: string };
      commitErrorName = e.name ?? 'unknown';
      commitState = e.currentState ?? '';
    }
    return {
      name: caught?.name ?? 'no-error',
      failures: (caught?.failures ?? []).map((f) => f.message),
      completedSteps: caught?.completedSteps ?? -1,
      recoverable: caught?.isRecoverable ? caught.isRecoverable() : null,
      commitErrorName,
      commitState,
    };
  },
  assert: (actual, expect) => {
    expect(actual.name).toBe('CompensationFailedError');
    expect(actual.failures).toEqual(['undo2-boom', 'undo1-boom']);
    expect(actual.completedSteps).toBe(2);
    expect(actual.recoverable).toBe(false);
    expect(actual.commitErrorName).toBe('TransactionStateError');
    expect(actual.commitState).toBe('failed');
  },
});
