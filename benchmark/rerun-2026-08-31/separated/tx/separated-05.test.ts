import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

defineScenario({
  id: 'timeout budget spans the whole transaction so time spent in earlier steps counts against later steps',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-TX-09 — separated invariant catalog, sourced from tx/tests/transaction.test.ts "should handle timeout with multiple steps" and code contract tx/src/transaction.ts:158-159',
  },
  inputs: {
    timeout: 300,
    steps: ['step-0 sleeps 200ms and succeeds', 'step-1 sleeps 1000ms'],
  },
  expected:
    'step-1 rejects with TransactionTimeoutError roughly 100ms after it starts, because the 200ms spent in step-0 already consumed most of the 300ms transaction budget.',
  act: async () => {
    const tx = new Transaction({ timeout: 300 });
    const step1Value = await tx.run(async () => {
      await sleep(200);
      return 'first-done';
    });
    let errName = 'did-not-throw';
    let timeoutMs = -1;
    const step2Start = Date.now();
    try {
      await tx.run(async () => {
        await sleep(1000);
        return 'second-done';
      });
    } catch (error) {
      errName = (error as Error).name;
      timeoutMs = (error as { timeoutMs?: number }).timeoutMs ?? -1;
    }
    const step2Duration = Date.now() - step2Start;
    return { step1Value, errName, timeoutMs, step2Duration };
  },
  assert: (actual, expect) => {
    expect(actual.step1Value).toBe('first-done');
    expect(actual.errName).toBe('TransactionTimeoutError');
    expect(actual.timeoutMs).toBe(300);
    expect(actual.step2Duration).toBeLessThan(600);
  },
});
