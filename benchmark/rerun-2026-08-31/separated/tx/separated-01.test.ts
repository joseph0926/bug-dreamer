import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'failing third step compensates the two completed steps in reverse completion order before rethrowing',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-TX-02 — separated invariant catalog, sourced from tx/tests/transaction.test.ts "should handle mixed success/failure with partial rollback" and tx/README.md "Automatic Rollback"',
  },
  inputs: {
    steps: [
      'step-0 succeeds, compensate records c0',
      'step-1 succeeds, compensate records c1',
      'step-2 throws Error("boom") with no compensate',
    ],
  },
  expected:
    'The failing step causes compensations to run as [c1, c0] (reverse completion order) and the original "boom" error propagates to the caller.',
  act: async () => {
    const order: string[] = [];
    const tx = new Transaction();
    await tx.run(async () => 'first', {
      compensate: async () => {
        order.push('c0');
      },
    });
    await tx.run(async () => 'second', {
      compensate: async () => {
        order.push('c1');
      },
    });
    let thrownMessage = 'did-not-throw';
    try {
      await tx.run(async () => {
        throw new Error('boom');
      });
    } catch (error) {
      thrownMessage = (error as Error).message;
    }
    return { order, thrownMessage };
  },
  assert: (actual, expect) => {
    expect(actual.thrownMessage).toBe('boom');
    expect(actual.order).toEqual(['c1', 'c0']);
  },
});
