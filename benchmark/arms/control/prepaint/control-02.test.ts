import { defineScenario } from '@bug-dreamer/scenario';
import { validatePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'empty routes disable the policy silently while a relative route is a validation error and duplicates are deduplicated',
  oracle: {
    basis: 'documentation',
    ref: 'packages/prepaint/src/policy.ts parsePolicy: empty routes yield value null with no error, non-absolute routes yield an error, duplicate routes are collapsed',
  },
  inputs: { emptyRoutes: [], invalidRoutes: ['relative/path'], duplicatedRoutes: ['/a', '/a', '/b'] },
  expected:
    'validatePrepaintPolicy returns null for an empty routes array without throwing, throws mentioning absolute pathname for a relative route, and collapses duplicate routes to a two-entry allowlist.',
  act: async () => {
    const empty = validatePrepaintPolicy({ routes: [] });

    let invalidOutcome = 'no-error';
    try {
      validatePrepaintPolicy({ routes: ['relative/path'] });
    } catch (error) {
      invalidOutcome =
        error instanceof Error && error.message.includes('absolute pathname')
          ? 'threw-absolute-pathname'
          : 'threw-other';
    }

    const deduped = validatePrepaintPolicy({ routes: ['/a', '/a', '/b'] });

    return {
      emptyIsNull: empty === null,
      invalidOutcome,
      dedupedRoutes: deduped ? deduped.routes : null,
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      emptyIsNull: true,
      invalidOutcome: 'threw-absolute-pathname',
      dedupedRoutes: ['/a', '/b'],
    });
  },
});
