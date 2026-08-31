import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'rejects overlapping steps in one transaction',
  oracle: {
    basis: 'existing-test',
    ref: 'packages/tx/tests/transaction.test.ts single in-flight step expectations',
  },
  inputs: {
    firstStepStillRunning: true,
  },
  expected: 'Adding a step while another step is running throws TransactionStateError.',
  act: async () => {
    const tx = startTransaction({ id: 'concurrent-step-check' });
    const first = tx.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'first';
    });

    let second: string;
    try {
      second = await tx.run(async () => 'second');
    } catch (error) {
      second = error instanceof Error ? error.name : String(error);
    }

    await first.catch(() => undefined);
    return second;
  },
  assert: (actual, expect) => {
    expect(actual).toBe('TransactionStateError');
  },
});
