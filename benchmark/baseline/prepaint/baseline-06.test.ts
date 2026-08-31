import { defineScenario } from '@bug-dreamer/scenario';
import { validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'empty-string route is rejected by policy validation',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/README.md policy reference: "routes: string[] - Exact pathnames" — an empty string is not an absolute pathname, so validatePrepaintPolicy must throw instead of accepting it',
  },
  inputs: {
    policy: { routes: [''] },
  },
  expected:
    'validatePrepaintPolicy throws an invalid-policy error for a routes array containing an empty string, and never returns a resolved policy for it.',
  act: async () => {
    try {
      const resolved = validatePrepaintPolicy({ routes: [''] });
      return { outcome: 'no-throw', resolvedIsNull: resolved === null, message: '' };
    } catch (error) {
      return {
        outcome: 'threw',
        resolvedIsNull: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
  assert: (actual, expect) => {
    expect(actual.outcome).toBe('threw');
    expect(actual.message).toContain('Invalid prepaint policy');
  },
});
