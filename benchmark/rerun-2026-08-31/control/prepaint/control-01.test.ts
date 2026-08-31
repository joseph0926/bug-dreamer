import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, validatePrepaintPolicy, isRouteAllowed } from '@target/policy';

defineScenario({
  id: 'missing or empty routes disable prepaint and allow no route',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/README.md: "Prepaint is disabled until policy.routes explicitly opts pathnames in" and config "routes: string[] // Exact pathnames; empty or omitted disables Prepaint"',
  },
  inputs: {
    policies: ['undefined', 'null', '{ routes: [] }'],
    probeRoute: '/dashboard',
  },
  expected:
    'Undefined, null, and empty-routes policies all resolve to null without throwing, and with a null policy no route is allowed',
  act: async () => {
    return {
      omitted: normalizePrepaintPolicy(undefined),
      explicitNull: normalizePrepaintPolicy(null),
      emptyRoutes: normalizePrepaintPolicy({ routes: [] }),
      validatedEmpty: validatePrepaintPolicy({ routes: [] }),
      allowedWithoutPolicy: isRouteAllowed(null, '/dashboard'),
    };
  },
  assert: (actual, expect) => {
    expect(actual.omitted).toBeNull();
    expect(actual.explicitNull).toBeNull();
    expect(actual.emptyRoutes).toBeNull();
    expect(actual.validatedEmpty).toBeNull();
    expect(actual.allowedWithoutPolicy).toBe(false);
  },
});
