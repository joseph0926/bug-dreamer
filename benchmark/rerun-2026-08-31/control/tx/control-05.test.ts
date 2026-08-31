import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'transaction timeout budget spans idle time between steps and still rolls back',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "Timeout Protection": "startTransaction({ timeout: 5000 }); await tx.run(slowOperation); // If takes >5s, automatic rollback" and TransactionTimeoutError fields timeoutMs/elapsedMs',
  },
  inputs: {
    timeout: 120,
    sequence: 'step-0 succeeds fast with compensate, caller idles 200ms, then starts step-1',
  },
  expected:
    'The second step rejects with TransactionTimeoutError carrying timeoutMs 120, and the completed first step is compensated by the automatic rollback',
  act: async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tx = new Transaction({ timeout: 120 });
    let compensated = false;
    await tx.run(async () => 'fast', {
      compensate: async () => {
        compensated = true;
      },
    });
    await sleep(200);
    try {
      await tx.run(async () => {
        await sleep(50);
        return 'slow';
      });
      return { errorName: 'no-error', compensated, timeoutMs: -1 };
    } catch (error) {
      const e = error as { name?: string; timeoutMs?: number };
      return { errorName: e.name ?? 'unknown', compensated, timeoutMs: e.timeoutMs ?? -1 };
    }
  },
  assert: (actual, expect) => {
    expect(actual.errorName).toBe('TransactionTimeoutError');
    expect(actual.timeoutMs).toBe(120);
    expect(actual.compensated).toBe(true);
  },
});
