import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'missing, non-object, routes-less and empty-routes policies all normalize to null',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-PP-01 — separated invariant catalog, sourced from pp/tests/policy.test.ts "disables capture and restore when policy or routes are missing" and pp/README.md opt-in statements',
  },
  inputs: {
    candidates: ['undefined', 'null', 'the string "policy"', '{} without routes', '{ routes: [] }'],
  },
  expected:
    'normalizePrepaintPolicy returns null for every candidate, leaving prepaint disabled.',
  act: async () => {
    return {
      missing: normalizePrepaintPolicy(undefined),
      explicitNull: normalizePrepaintPolicy(null),
      nonObject: normalizePrepaintPolicy('policy'),
      noRoutes: normalizePrepaintPolicy({}),
      emptyRoutes: normalizePrepaintPolicy({ routes: [] }),
    };
  },
  assert: (actual, expect) => {
    expect(actual.missing).toBe(null);
    expect(actual.explicitNull).toBe(null);
    expect(actual.nonObject).toBe(null);
    expect(actual.noRoutes).toBe(null);
    expect(actual.emptyRoutes).toBe(null);
  },
});
