import { defineScenario } from '@bug-dreamer/scenario';

defineScenario({
  id: 'synthetic oracle failure',
  oracle: {
    basis: 'declared-invariant',
    ref: 'test fixture only',
  },
  inputs: {
    value: 'actual',
  },
  expected: 'The synthetic value is expected.',
  act: async () => 'actual',
  assert: (actual, expect) => {
    expect(actual).toBe('expected');
  },
});
