import { defineScenario } from '@bug-dreamer/scenario';
import { serializePrepaintPolicy } from '@target/policy';

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

defineScenario({
  id: 'serialized policy never contains raw script-breaking characters, each is replaced by its unicode escape',
  oracle: {
    basis: 'declared-invariant',
    ref: 'INV-PP-09 — separated invariant catalog, sourced from pp/tests/policy.test.ts "escapes policy values before embedding them in a script" and code contract pp/src/policy.ts:148-155',
  },
  inputs: {
    policy: { routes: ['/x<y>&z', '/sep\\u2028mid\\u2029end'] },
  },
  expected:
    'The serialized string contains no raw &, <, >, U+2028 or U+2029 characters; each appears only as its \\uXXXX escape sequence.',
  act: async () => {
    const serialized = serializePrepaintPolicy({
      routes: ['/x<y>&z', `/sep${LINE_SEP}mid${PARA_SEP}end`],
    });
    return {
      hasRawAmp: serialized.includes('&'),
      hasRawLt: serialized.includes('<'),
      hasRawGt: serialized.includes('>'),
      hasRawLineSep: serialized.includes(LINE_SEP),
      hasRawParaSep: serialized.includes(PARA_SEP),
      hasEscapedAmp: serialized.includes('\\u0026'),
      hasEscapedLt: serialized.includes('\\u003c'),
      hasEscapedGt: serialized.includes('\\u003e'),
      hasEscapedLineSep: serialized.includes('\\u2028'),
      hasEscapedParaSep: serialized.includes('\\u2029'),
    };
  },
  assert: (actual, expect) => {
    expect(actual.hasRawAmp).toBe(false);
    expect(actual.hasRawLt).toBe(false);
    expect(actual.hasRawGt).toBe(false);
    expect(actual.hasRawLineSep).toBe(false);
    expect(actual.hasRawParaSep).toBe(false);
    expect(actual.hasEscapedAmp).toBe(true);
    expect(actual.hasEscapedLt).toBe(true);
    expect(actual.hasEscapedGt).toBe(true);
    expect(actual.hasEscapedLineSep).toBe(true);
    expect(actual.hasEscapedParaSep).toBe(true);
  },
});
