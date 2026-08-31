import { defineScenario } from '@bug-dreamer/scenario';
import { isRouteAllowed, normalizePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'allows only exact policy routes',
  oracle: {
    basis: 'public-type',
    ref: 'packages/prepaint PrepaintPolicy.routes lists absolute pathnames, not prefixes',
  },
  inputs: {
    policyRoutes: ['/checkout'],
    probedRoute: '/checkout-admin',
  },
  expected: 'A route outside the policy list is not allowed even when it shares a prefix.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/checkout'] });
    return {
      exact: isRouteAllowed(policy, '/checkout'),
      prefixed: isRouteAllowed(policy, '/checkout-admin'),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({ exact: true, prefixed: false });
  },
});
