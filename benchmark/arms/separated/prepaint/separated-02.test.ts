import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, isRouteAllowed } from '@target/policy';

defineScenario({
  id: 'route matching is exact pathname equality with duplicates deduplicated and no prefix matching',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-PP-03 — test "deduplicates exact routes without enabling prefix matches" in packages/prepaint/tests/policy.test.ts; packages/prepaint/README.md:71 ("Matching is exact")',
  },
  inputs: { routes: ['/app', '/app', '/app/settings', '/app'] },
  expected:
    'The resolved policy keeps each route once in first-seen order, allows only exact pathname matches, and rejects prefix children, trailing-slash variants, and the parent root.',
  act: async () => {
    const policy = normalizePrepaintPolicy({
      routes: ['/app', '/app', '/app/settings', '/app'],
    });
    return {
      routes: policy?.routes ?? null,
      exactMatch: isRouteAllowed(policy, '/app'),
      configuredChild: isRouteAllowed(policy, '/app/settings'),
      prefixChild: isRouteAllowed(policy, '/app/profile'),
      trailingSlash: isRouteAllowed(policy, '/app/'),
      rootParent: isRouteAllowed(policy, '/'),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      routes: ['/app', '/app/settings'],
      exactMatch: true,
      configuredChild: true,
      prefixChild: false,
      trailingSlash: false,
      rootParent: false,
    });
  },
});
