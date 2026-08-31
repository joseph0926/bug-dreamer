import { defineScenario } from '@bug-dreamer/scenario';
import { isRouteAllowed, resolvePrepaintPolicy, setGlobalPrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'invalid policy update does not silently wipe the active global policy',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/prepaint/src/policy.ts validatePrepaintPolicy rejects malformed policies with an error — a malformed update must be rejected, not converted into a silent disable that discards the previously valid global policy',
  },
  inputs: {
    initialPolicy: { routes: ['/dashboard'] },
    invalidUpdate: { routes: 'not-an-array' },
    checkedRoute: '/dashboard',
  },
  expected:
    'After setting a valid global policy, resolving a malformed policy must not clobber it: /dashboard remains allowed by the effective global policy.',
  act: async () => {
    setGlobalPrepaintPolicy({ routes: ['/dashboard'] });
    const invalidUpdate = { routes: 'not-an-array' } as unknown;
    const invalidResult = resolvePrepaintPolicy(invalidUpdate as never);
    const effective = resolvePrepaintPolicy();
    const stillAllowed = isRouteAllowed(effective, '/dashboard');
    setGlobalPrepaintPolicy(null);
    return {
      invalidResultIsNull: invalidResult === null,
      stillAllowed,
    };
  },
  assert: (actual, expect) => {
    expect(actual.stillAllowed).toBe(true);
  },
});
