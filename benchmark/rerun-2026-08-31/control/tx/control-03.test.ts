import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'no compensation may run after commit succeeds while a step is in flight',
  oracle: {
    basis: 'documentation',
    ref: 'packages/tx/README.md "tx.commit()": "After commit: Transaction becomes immutable, No more steps can be added"',
  },
  inputs: {
    sequence:
      'step-0 succeeds with compensate, step-1 is started but not awaited, commit() is awaited while step-1 is still running, then step-1 fails',
  },
  expected:
    'Either commit is rejected while a step is running, or commit succeeds and the committed transaction stays immutable so the late step failure must not trigger compensation',
  act: async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tx = new Transaction({ timeout: 5000 });
    let compensateCalled = false;
    await tx.run(async () => 'ok', {
      compensate: async () => {
        compensateCalled = true;
      },
    });
    const pending = tx.run(async () => {
      await sleep(150);
      throw new Error('late-fail');
    });
    await sleep(30);
    let commitOutcome = 'resolved';
    try {
      await tx.commit();
    } catch (error) {
      commitOutcome = (error as Error).name;
    }
    await pending.catch(() => undefined);
    await sleep(20);
    return {
      commitOutcome,
      compensateCalledAfterCommit: commitOutcome === 'resolved' ? compensateCalled : false,
    };
  },
  assert: (actual, expect) => {
    expect(actual.compensateCalledAfterCommit).toBe(false);
  },
});
