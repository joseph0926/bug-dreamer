import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'transaction timeout budget spans all steps so elapsed time of earlier steps counts against later steps',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-TX-09 — test "should handle timeout with multiple steps" in packages/tx/tests/transaction.test.ts; packages/tx/README.md startTransaction reference; code contract packages/tx/src/transaction.ts:158-159',
  },
  inputs: { timeoutMs: 150, firstStepMs: 100, secondStepMs: 100 },
  expected:
    'With a 150ms transaction timeout, a second 100ms step rejects with TransactionTimeoutError because the 100ms spent in the first step counts against the shared budget, even though the second step alone is under the timeout.',
  act: async () => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const tx = new Transaction({ timeout: 150 });
    await tx.run(async () => {
      await sleep(100);
      return 'first';
    });
    try {
      await tx.run(async () => {
        await sleep(100);
        return 'second';
      });
      return { timedOut: false };
    } catch (error) {
      const e = error as { name: string; timeoutMs?: number };
      return { timedOut: true, name: e.name, timeoutMs: e.timeoutMs };
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      timedOut: true,
      name: 'TransactionTimeoutError',
      timeoutMs: 150,
    });
  },
});
