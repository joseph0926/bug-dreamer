import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'timeout budget is cumulative across steps and triggers rollback',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "Timeout Protection" and packages/tx/src/types.ts TxOptions.timeout "Overall transaction timeout in milliseconds"',
  },
  inputs: {
    timeoutMs: 250,
    step1: { durationMs: 150, result: 'succeeds', compensate: 'undo1' },
    step2: { durationMs: 400, result: 'would succeed but exceeds remaining budget' },
  },
  expected:
    'With a 250ms overall timeout, a 150ms first step succeeds and the second step is cut off after roughly the remaining 100ms with TransactionTimeoutError, rolling back the completed first step.',
  act: async () => {
    const undo: string[] = [];
    const tx = new Transaction({ timeout: 250 });
    await tx.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('one'), 150);
        }),
      {
        compensate: async () => {
          undo.push('undo1');
        },
      },
    );
    const started = Date.now();
    let errorName = 'none';
    try {
      await tx.run(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('two'), 400);
          }),
      );
    } catch (error) {
      errorName = error instanceof Error ? error.name : String(error);
    }
    const secondStepElapsed = Date.now() - started;
    return { errorName, undo1Ran: undo.includes('undo1'), secondStepElapsed };
  },
  assert: (actual, expect) => {
    expect(actual.errorName).toBe('TransactionTimeoutError');
    expect(actual.undo1Ran).toBe(true);
    expect(actual.secondStepElapsed).toBeLessThan(250);
  },
});
