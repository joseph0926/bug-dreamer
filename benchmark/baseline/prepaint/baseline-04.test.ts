import { defineScenario } from '@bug-dreamer/scenario';
import { normalizeSnapshotStyleEntry } from '@target/style-utils';

defineScenario({
  id: 'external style with whitespace-only href normalizes to null',
  oracle: {
    basis: 'declared-invariant',
    ref: 'packages/prepaint/src/style-utils.ts — inline entries with empty or whitespace-only content are dropped (return null); an external entry with a whitespace-only href is equally unusable and must be dropped by the same rule',
  },
  inputs: {
    entry: { type: 'external', href: '   ' },
  },
  expected:
    'normalizeSnapshotStyleEntry returns null for an external style whose href is only whitespace, matching how blank inline content is dropped.',
  act: async () => {
    const result = normalizeSnapshotStyleEntry({ type: 'external', href: '   ' });
    return { result };
  },
  assert: (actual, expect) => {
    expect(actual.result).toBeNull();
  },
});
