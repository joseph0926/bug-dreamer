import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'missing, non-object, and empty-routes policies all normalize to null so prepaint stays opt-in',
  oracle: {
    basis: 'documentation',
    ref: 'INV-PP-01 — packages/prepaint/README.md:71,409 ("Missing or empty routes disable both capture and restore"); test "disables capture and restore when policy or routes are missing" in packages/prepaint/tests/policy.test.ts',
  },
  inputs: {
    candidates: ['undefined', 'null', 'string', 'zero', 'emptyRoutes', 'routesNotArray'],
  },
  expected:
    'normalizePrepaintPolicy returns null for undefined, null, a string, the number 0, an object with an empty routes array, and an object whose routes is not an array.',
  act: async () => {
    return {
      missing: normalizePrepaintPolicy(undefined),
      nullPolicy: normalizePrepaintPolicy(null),
      stringPolicy: normalizePrepaintPolicy('routes'),
      zeroPolicy: normalizePrepaintPolicy(0),
      emptyRoutes: normalizePrepaintPolicy({ routes: [] }),
      routesNotArray: normalizePrepaintPolicy({ routes: '/home' }),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      missing: null,
      nullPolicy: null,
      stringPolicy: null,
      zeroPolicy: null,
      emptyRoutes: null,
      routesNotArray: null,
    });
  },
});
