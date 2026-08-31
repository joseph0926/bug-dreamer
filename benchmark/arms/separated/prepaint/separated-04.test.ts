import { defineScenario } from '@bug-dreamer/scenario';
import { serializePrepaintPolicy } from '@target/policy';

defineScenario({
  id: 'serialized policy never contains raw script-breaking characters even when routes embed them',
  oracle: {
    basis: 'existing-test',
    ref: 'INV-PP-09 — test "escapes policy values before embedding them in a script" in packages/prepaint/tests/policy.test.ts:94; code contract packages/prepaint/src/policy.ts:148-155',
  },
  inputs: { hostileRoute: '/</script><script>&', includesLineSeparators: true },
  expected:
    'The serialized string contains no raw &, <, >, U+2028, or U+2029 characters; each is replaced by its backslash-u escape sequence.',
  act: async () => {
    const hostileRoute = '/</script><script>&' + '\u2028' + '\u2029';
    const serialized = serializePrepaintPolicy({ routes: [hostileRoute] });
    return {
      rawAmp: serialized.includes('&'),
      rawLt: serialized.includes('<'),
      rawGt: serialized.includes('>'),
      rawLineSeparator: serialized.includes('\u2028'),
      rawParagraphSeparator: serialized.includes('\u2029'),
      escapedAmp: serialized.includes('\\u0026'),
      escapedLt: serialized.includes('\\u003c'),
      escapedGt: serialized.includes('\\u003e'),
      escapedLineSeparator: serialized.includes('\\u2028'),
      escapedParagraphSeparator: serialized.includes('\\u2029'),
    };
  },
  assert: (actual, expect) => {
    expect(actual).toEqual({
      rawAmp: false,
      rawLt: false,
      rawGt: false,
      rawLineSeparator: false,
      rawParagraphSeparator: false,
      escapedAmp: true,
      escapedLt: true,
      escapedGt: true,
      escapedLineSeparator: true,
      escapedParagraphSeparator: true,
    });
  },
});
