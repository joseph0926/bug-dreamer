import { defineScenario } from '@bug-dreamer/scenario';
import { normalizeSnapshotStyleEntry } from '@target/style-utils';

defineScenario({
  id: 'style entry normalization drops degenerate entries and preserves usable ones',
  oracle: {
    basis: 'public-type',
    ref: 'src/style-utils.ts signature normalizeSnapshotStyleEntry(style: SnapshotStyle | string): SnapshotStyle | null and src/types.ts Snapshot.styles?: Array<SnapshotStyle | string> - null is the declared channel for entries that carry no restorable style',
  },
  inputs: {
    entries: [
      "'' and '   ' strings",
      'css string',
      'inline with empty content',
      'external with empty href',
      'external with empty and non-empty content',
    ],
  },
  expected:
    'Empty or whitespace-only strings and contentless inline or href-less external entries normalize to null; CSS strings become inline entries; external entries keep href and only keep content when non-empty',
  act: async () => {
    return {
      emptyString: normalizeSnapshotStyleEntry(''),
      whitespaceString: normalizeSnapshotStyleEntry('   '),
      cssString: normalizeSnapshotStyleEntry('body{margin:0}'),
      emptyInline: normalizeSnapshotStyleEntry({ type: 'inline', content: '' }),
      inline: normalizeSnapshotStyleEntry({ type: 'inline', content: '.a{}' }),
      externalNoHref: normalizeSnapshotStyleEntry({ type: 'external', href: '' }),
      externalEmptyContent: normalizeSnapshotStyleEntry({
        type: 'external',
        href: '/a.css',
        content: '',
      }),
      externalWithContent: normalizeSnapshotStyleEntry({
        type: 'external',
        href: '/a.css',
        content: '.b{}',
      }),
    };
  },
  assert: (actual, expect) => {
    expect(actual.emptyString).toBeNull();
    expect(actual.whitespaceString).toBeNull();
    expect(actual.cssString).toEqual({ type: 'inline', content: 'body{margin:0}' });
    expect(actual.emptyInline).toBeNull();
    expect(actual.inline).toEqual({ type: 'inline', content: '.a{}' });
    expect(actual.externalNoHref).toBeNull();
    expect(actual.externalEmptyContent).toEqual({ type: 'external', href: '/a.css' });
    expect(actual.externalWithContent).toEqual({
      type: 'external',
      href: '/a.css',
      content: '.b{}',
    });
  },
});
