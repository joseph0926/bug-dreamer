import { defineScenario } from '@bug-dreamer/scenario';

defineScenario({
  id: 'synthetic harness timeout',
  oracle: {
    basis: 'declared-invariant',
    ref: 'test fixture only',
  },
  expected: 'The outer runner stops this fixture.',
  act: async () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return 'unreachable';
  },
  assert: (actual, expect) => {
    expect(actual).toBe('unreachable');
  },
});
