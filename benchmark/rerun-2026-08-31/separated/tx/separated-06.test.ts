import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';
import { CompensationFailedError, TransactionStateError } from '@target/errors';

defineScenario({
  id: 'failing compensations are all executed, collected in reverse order into CompensationFailedError, and the transaction becomes failed',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-TX-12 — separated invariant catalog, sourced from tx/tests/transaction.test.ts "should collect all compensate errors", "should include completedSteps in CompensationFailedError", "should collect all compensation errors and mark as failed" and tx/README.md FAQ "What happens if compensation fails?"',
  },
  inputs: {
    steps: [
      'step-0 succeeds, compensate throws comp-0',
      'step-1 succeeds, compensate throws comp-1',
      'step-2 throws trigger',
    ],
  },
  expected:
    'run() rejects with CompensationFailedError carrying failures [comp-1, comp-0] and completedSteps 2, and a later run() throws TransactionStateError with currentState failed.',
  act: async () => {
    const tx = new Transaction();
    await tx.run(async () => 'first', {
      compensate: async () => {
        throw new Error('comp-0');
      },
    });
    await tx.run(async () => 'second', {
      compensate: async () => {
        throw new Error('comp-1');
      },
    });
    let caught: unknown = null;
    try {
      await tx.run(async () => {
        throw new Error('trigger');
      });
    } catch (error) {
      caught = error;
    }
    const err = caught as CompensationFailedError;
    let stateAfter = 'did-not-throw';
    try {
      await tx.run(async () => 'late');
    } catch (error) {
      stateAfter = (error as TransactionStateError).currentState;
    }
    return {
      isCompensationFailed: caught instanceof CompensationFailedError,
      name: err?.name,
      failureMessages: Array.isArray(err?.failures) ? err.failures.map((e) => e.message) : [],
      completedSteps: err?.completedSteps,
      stateAfter,
    };
  },
  assert: (actual, expect) => {
    expect(actual.isCompensationFailed).toBe(true);
    expect(actual.name).toBe('CompensationFailedError');
    expect(actual.failureMessages).toEqual(['comp-1', 'comp-0']);
    expect(actual.completedSteps).toBe(2);
    expect(actual.stateAfter).toBe('failed');
  },
});
