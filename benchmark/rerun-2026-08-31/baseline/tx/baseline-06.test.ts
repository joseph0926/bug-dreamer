import { defineScenario } from '@bug-dreamer/scenario';
import { Transaction } from '@target/transaction';

defineScenario({
  id: 'external abort during a step rejects with the abort reason and rolls back completed steps',
  oracle: {
    basis: 'public-type',
    ref: 'types.ts StepOptions.signal jsdoc: optional AbortSignal to cancel the current step; StepOptions.compensate: compensation function to run on rollback',
  },
  inputs: {
    step1: 'succeeds and registers a compensation',
    step2: 'sleeps 2000ms, aborted after 30ms via AbortController with reason Error("user-cancelled")',
  },
  expected:
    'The aborted step rejects with the caller-supplied abort reason and the completed step is compensated before the rejection reaches the caller.',
  act: async () => {
    const events: string[] = [];
    const tx = new Transaction();
    await tx.run(async () => 'reserved', {
      compensate: async () => {
        events.push('released-reservation');
      },
    });
    const controller = new AbortController();
    const pending = tx.run(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve('finished'), 2000);
        }),
      { signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort(new Error('user-cancelled'));
    }, 30);
    try {
      await pending;
      events.push('step-resolved');
    } catch (error) {
      events.push(`step-rejected:${(error as Error).message}`);
    }
    return events;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual(['released-reservation', 'step-rejected:user-cancelled']);
  },
});
