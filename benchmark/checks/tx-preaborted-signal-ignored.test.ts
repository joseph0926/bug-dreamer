import { defineScenario } from '@bug-dreamer/scenario';
import { startTransaction } from '@target/index';

defineScenario({
  id: 'rejects a step whose external signal is already aborted',
  oracle: {
    basis: 'public-type',
    ref: 'packages/tx StepOptions.signal follows the AbortSignal contract, including pre-aborted signals',
  },
  inputs: {
    signalAbortedBeforeRun: true,
  },
  expected: 'A step given an already-aborted signal rejects with the abort reason and never executes.',
  act: async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    const tx = startTransaction({ id: 'preaborted-signal-check' });

    try {
      await tx.run(async () => 'ran', { signal: controller.signal });
      return 'ran';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
  assert: (actual, expect) => {
    expect(actual).toBe('pre-aborted');
  },
});
