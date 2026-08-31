import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';
import { TransactionTimeoutError } from '@target/errors';

defineScenario({
  id: 'transaction timeout racing a slow step rejects with TransactionTimeoutError and aborts the step signal',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/src/types.ts TxOptions.timeout and packages/tx/src/errors.ts TransactionTimeoutError: recoverable timeout carrying timeoutMs',
  },
  inputs: { timeoutMs: 150, stepDurationMs: 400 },
  expected:
    'A step that outlives the 150ms transaction timeout makes run reject with a recoverable TransactionTimeoutError whose timeoutMs is 150, and the AbortSignal handed to the step is aborted.',
  act: async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const tx = new Transaction({ timeout: 150 });
    let capturedSignal: AbortSignal | undefined;

    try {
      await tx.run(async (signal) => {
        capturedSignal = signal;
        await sleep(400);
        return 'done';
      });
      return 'no-error';
    } catch (error) {
      if (error instanceof TransactionTimeoutError) {
        return {
          name: error.name,
          timeoutMs: error.timeoutMs,
          elapsedAtLeastTimeout: error.elapsedMs >= 150,
          recoverable: error.isRecoverable(),
          signalAborted: capturedSignal?.aborted ?? false,
        };
      }
      return 'unexpected-error';
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      name: 'TransactionTimeoutError',
      timeoutMs: 150,
      elapsedAtLeastTimeout: true,
      recoverable: true,
      signalAborted: true,
    });
  },
});
