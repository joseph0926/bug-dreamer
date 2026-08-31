import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'degenerate policies: empty routes, null and undefined all resolve to no policy without throwing',
  oracle: {
    basis: 'declared-invariant',
    ref: 'policy.ts parsePolicy(): absent policy and zero routes both mean prepaint disabled, returned as null with no error',
  },
  inputs: {
    policies: ['{ routes: [] }', 'null', 'undefined'],
  },
  expected:
    'An empty routes array, null and undefined all yield null from both normalize and validate, and validate does not throw for any of them.',
  act: async () => {
    try {
      return {
        validateEmpty: validatePrepaintPolicy({ routes: [] }),
        normalizeEmpty: normalizePrepaintPolicy({ routes: [] }),
        normalizeNull: normalizePrepaintPolicy(null),
        normalizeUndefined: normalizePrepaintPolicy(undefined),
      };
    } catch (error) {
      return `threw:${(error as Error).message}`;
    }
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      validateEmpty: null,
      normalizeEmpty: null,
      normalizeNull: null,
      normalizeUndefined: null,
    });
  },
});
