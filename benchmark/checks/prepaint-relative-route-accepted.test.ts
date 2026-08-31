import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'rejects relative routes in a prepaint policy',
  oracle: {
    basis: 'public-type',
    ref: 'packages/prepaint PrepaintPolicy.routes must be absolute pathnames starting with /',
  },
  inputs: {
    routes: ['home'],
  },
  expected: 'A policy containing a relative route is rejected and stays inactive.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['home'] });
    return policy === null;
  },
  assert: (actual, expect) => {
    expect(actual).toBe(true);
  },
});
