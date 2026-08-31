import { defineScenario } from '@bug-dreamer/scenario';
import { resolvePrepaintPolicy, isRouteAllowed, setGlobalPrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'mutating the resolved policy object between checks must not widen the stored global policy',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/prepaint/src/policy.ts parsePolicy copies routes into a fresh array, so the allowlist stored by setGlobalPrepaintPolicy is meant to be immune to caller mutation',
  },
  inputs: { initialRoutes: ['/home'], injectedRoute: '/admin' },
  expected:
    'Pushing /admin into the routes array returned by resolvePrepaintPolicy does not make a later global resolution treat /admin as an allowed route.',
  act: async () => {
    const first = resolvePrepaintPolicy({ routes: ['/home'] });
    if (!first) {
      setGlobalPrepaintPolicy(null);
      return 'no-policy';
    }

    first.routes.push('/admin');

    const second = resolvePrepaintPolicy();
    const result = {
      homeAllowed: isRouteAllowed(second, '/home'),
      injectedAllowed: isRouteAllowed(second, '/admin'),
      secondRouteCount: second ? second.routes.length : 0,
    };

    setGlobalPrepaintPolicy(null);
    return result;
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      homeAllowed: true,
      injectedAllowed: false,
      secondRouteCount: 1,
    });
  },
});
