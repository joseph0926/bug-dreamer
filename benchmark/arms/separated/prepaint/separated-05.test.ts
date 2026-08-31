import { defineScenario } from '@bug-dreamer/scenario';
import { normalizeSnapshotStyleEntry } from '@target/style-utils';

defineScenario({
  id: 'style entries normalize to the tagged inline union and blank content drops to null',
  oracle: {
    basis: 'public-type',
    ref: 'INV-PP-12 — public type SnapshotStyle in packages/prepaint/src/types.ts:25-36; code contract packages/prepaint/src/style-utils.ts:3-11; test "injects inline and external styles into the overlay shadow root" in packages/prepaint/tests/overlay.test.ts',
  },
  inputs: {
    entries: ['plainString', 'emptyString', 'whitespaceString', 'inlineWithContent', 'inlineBlank', 'inlineEmpty'],
  },
  expected:
    'A plain string becomes { type: inline, content }, while empty strings, whitespace-only strings, and inline entries with blank or empty content normalize to null instead of producing an empty style.',
  act: async () => {
    return {
      plainString: normalizeSnapshotStyleEntry('body { color: red; }'),
      emptyString: normalizeSnapshotStyleEntry(''),
      whitespaceString: normalizeSnapshotStyleEntry('   \n\t  '),
      inlineWithContent: normalizeSnapshotStyleEntry({ type: 'inline', content: '.a { top: 0; }' }),
      inlineBlank: normalizeSnapshotStyleEntry({ type: 'inline', content: '   ' }),
      inlineEmpty: normalizeSnapshotStyleEntry({ type: 'inline', content: '' }),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      plainString: { type: 'inline', content: 'body { color: red; }' },
      emptyString: null,
      whitespaceString: null,
      inlineWithContent: { type: 'inline', content: '.a { top: 0; }' },
      inlineBlank: null,
      inlineEmpty: null,
    });
  },
});
