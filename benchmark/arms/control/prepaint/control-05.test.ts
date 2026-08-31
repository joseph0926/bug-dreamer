import { defineScenario } from '@bug-dreamer/scenario';
import { normalizeSnapshotStyleEntry } from '@target/style-utils';

defineScenario({
  id: 'degenerate style entries are dropped and an empty external content field is omitted from the normalized entry',
  oracle: {
    basis: 'public-type',
    ref: 'packages/prepaint/src/types.ts SnapshotStyle union and style-utils.ts normalizeSnapshotStyleEntry: empty inline content and missing href yield null, empty external content is not carried over',
  },
  inputs: {
    whitespaceString: '   ',
    inlineEmpty: { type: 'inline', content: '' },
    externalNoHref: { type: 'external', href: '' },
    externalEmptyContent: { type: 'external', href: '/app.css', content: '' },
    plainString: 'body{margin:0}',
  },
  expected:
    'Whitespace-only strings, empty inline content and external entries without href normalize to null, an external entry with empty content keeps href but has no content key, and a plain CSS string becomes an inline style.',
  act: async () => {
    const whitespace = normalizeSnapshotStyleEntry('   ');
    const inlineEmpty = normalizeSnapshotStyleEntry({ type: 'inline', content: '' });
    const externalNoHref = normalizeSnapshotStyleEntry({ type: 'external', href: '' });
    const externalEmptyContent = normalizeSnapshotStyleEntry({
      type: 'external',
      href: '/app.css',
      content: '',
    });
    const plain = normalizeSnapshotStyleEntry('body{margin:0}');

    return {
      whitespaceIsNull: whitespace === null,
      inlineEmptyIsNull: inlineEmpty === null,
      externalNoHrefIsNull: externalNoHref === null,
      externalKeepsHref: externalEmptyContent !== null && externalEmptyContent.type === 'external'
        ? externalEmptyContent.href
        : null,
      emptyContentOmitted: externalEmptyContent !== null && !('content' in externalEmptyContent),
      plainNormalized: plain !== null && plain.type === 'inline' ? plain.content : null,
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      whitespaceIsNull: true,
      inlineEmptyIsNull: true,
      externalNoHrefIsNull: true,
      externalKeepsHref: '/app.css',
      emptyContentOmitted: true,
      plainNormalized: 'body{margin:0}',
    });
  },
});
