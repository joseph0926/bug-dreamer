import { defineScenario } from '@bug-dreamer/scenario';

defineScenario({
  id: 'missing assertion',
  oracle: {
    basis: 'declared-invariant',
    ref: 'test fixture only',
  },
  expected: 'This fixture is rejected before target execution.',
  act: async () => 'unused',
});
