import { defineScenario } from '@bug-dreamer/scenario';

defineScenario({
  id: 'synthetic passing oracle',
  oracle: {
    basis: 'declared-invariant',
    ref: 'test fixture only',
  },
  inputs: {
    value: 'expected',
  },
  expected: 'The synthetic value matches its oracle.',
  act: async () => 'expected',
  assert: (actual, expect) => {
    expect(actual).toBe('expected');
  },
});
