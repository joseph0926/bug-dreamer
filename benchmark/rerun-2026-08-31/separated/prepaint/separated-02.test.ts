import { defineScenario } from '@bug-dreamer/scenario';
import { isRouteAllowed, normalizePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'route matching is exact pathname equality with duplicates deduplicated, never prefix matching',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-PP-03 — separated invariant catalog, sourced from pp/tests/policy.test.ts "deduplicates exact routes without enabling prefix matches" and pp/README.md "Matching is exact"',
  },
  inputs: {
    policy: { routes: ['/app', '/app', '/app/child'] },
    probes: ['/app', '/app/child', '/app/settings', '/application', '/ap'],
  },
  expected:
    'The resolved routes are exactly [/app, /app/child]; only those two exact pathnames are allowed and the prefix-shaped probes /app/settings, /application and /ap are rejected.',
  act: async () => {
    const policy = normalizePrepaintPolicy({ routes: ['/app', '/app', '/app/child'] });
    return {
      routes: policy?.routes ?? null,
      exactApp: isRouteAllowed(policy, '/app'),
      exactChild: isRouteAllowed(policy, '/app/child'),
      prefixSettings: isRouteAllowed(policy, '/app/settings'),
      prefixApplication: isRouteAllowed(policy, '/application'),
      shorterPath: isRouteAllowed(policy, '/ap'),
    };
  },
  assert: (actual, expect) => {
    expect(actual.routes).toEqual(['/app', '/app/child']);
    expect(actual.exactApp).toBe(true);
    expect(actual.exactChild).toBe(true);
    expect(actual.prefixSettings).toBe(false);
    expect(actual.prefixApplication).toBe(false);
    expect(actual.shorterPath).toBe(false);
  },
});
