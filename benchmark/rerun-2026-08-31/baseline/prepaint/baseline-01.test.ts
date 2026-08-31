import { defineScenario } from '@bug-dreamer/scenario';
import { normalizePrepaintPolicy, validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'relative route rejected: validate throws while normalize silently returns null',
  oracle: {
    basis: 'public-type',
    ref: 'policy.ts: routes are absolute pathnames; validatePrepaintPolicy throws on invalid input while normalizePrepaintPolicy is the non-throwing variant',
  },
  inputs: {
    policy: { routes: ['dashboard', '/ok'] },
  },
  expected:
    'A policy containing a route without a leading slash makes validatePrepaintPolicy throw a route-related error and makes normalizePrepaintPolicy return null.',
  act: async () => {
    const invalid = { routes: ['dashboard', '/ok'] };
    let validateOutcome = 'returned';
    let message = '';
    try {
      validatePrepaintPolicy(invalid);
    } catch (error) {
      validateOutcome = 'threw';
      message = (error as Error).message;
    }
    return {
      validateOutcome,
      mentionsRoute: message.includes('route'),
      normalized: normalizePrepaintPolicy(invalid),
    };
  },
  assert: (actual, expect) => {
    expect(actual.validateOutcome).toBe('threw');
    expect(actual.mentionsRoute).toBe(true);
    expect(actual.normalized).toBe(null);
  },
});
