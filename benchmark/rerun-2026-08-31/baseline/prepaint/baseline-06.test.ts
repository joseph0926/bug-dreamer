import { defineScenario } from '@bug-dreamer/scenario';
import { normalizeSnapshotStyleEntry } from '@target/style-utils';

defineScenario({
  id: 'style entry normalization drops blank entries and strips empty external content',
  oracle: {
    basis: 'public-type',
    ref: 'style-utils.ts normalizeSnapshotStyleEntry(): returns null for entries with no usable content or href, and only carries content on external entries when non-empty',
  },
  inputs: {
    entries:
      'empty string, whitespace-only string, plain css string, blank inline object, external without href, external with content, external with empty content',
  },
  expected:
    'Blank strings, blank inline entries and href-less external entries normalize to null; a plain string becomes an inline entry; external entries keep href and only include content when it is non-empty.',
  act: async () => {
    const externalWithEmptyContent = normalizeSnapshotStyleEntry({
      type: 'external',
      href: '/a.css',
      content: '',
    });
    return {
      emptyString: normalizeSnapshotStyleEntry(''),
      whitespaceString: normalizeSnapshotStyleEntry('   '),
      plainString: normalizeSnapshotStyleEntry('body{margin:0}'),
      blankInline: normalizeSnapshotStyleEntry({ type: 'inline', content: '  ' }),
      externalNoHref: normalizeSnapshotStyleEntry({ type: 'external', href: '' }),
      externalWithContent: normalizeSnapshotStyleEntry({
        type: 'external',
        href: '/a.css',
        content: 'x',
      }),
      emptyContentEntryExists: externalWithEmptyContent !== null,
      emptyContentHasContentField:
        externalWithEmptyContent !== null && 'content' in externalWithEmptyContent,
    };
  },
  assert: (actual, expect) => {
    expect(actual.emptyString).toBe(null);
    expect(actual.whitespaceString).toBe(null);
    expect(actual.plainString).toEqual({ type: 'inline', content: 'body{margin:0}' });
    expect(actual.blankInline).toBe(null);
    expect(actual.externalNoHref).toBe(null);
    expect(actual.externalWithContent).toEqual({ type: 'external', href: '/a.css', content: 'x' });
    expect(actual.emptyContentEntryExists).toBe(true);
    expect(actual.emptyContentHasContentField).toBe(false);
  },
});
