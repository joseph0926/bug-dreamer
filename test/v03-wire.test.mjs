import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WIRE_LIMITS,
  canonicalJson,
  domainDigest,
  parseJsonBytes,
} from '../src/v03-wire.mjs';

test('matches the RFC 8785 canonical serialization example', () => {
  const value = parseJsonBytes(`{
    "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    "string": "\\u20ac$\\u000F\\nA'B\\\"\\\\\\\"/",
    "literals": [null, true, false]
  }`);
  assert.equal(
    canonicalJson(value),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}',
  );
});

test('sorts properties by UTF-16 code units', () => {
  const value = parseJsonBytes('{"€":"euro","\\r":"cr","ö":"latin","😀":"face","1":"one","דּ":"ligature"}');
  assert.equal(canonicalJson(value), '{"\\r":"cr","1":"one","ö":"latin","€":"euro","😀":"face","דּ":"ligature"}');
});

test('rejects duplicate keys before JSON values are constructed', () => {
  assert.throws(() => parseJsonBytes('{"a":1,"a":2}'), /Duplicate JSON key/u);
  assert.throws(() => parseJsonBytes('{"a":1,"\\u0061":2}'), /Duplicate JSON key/u);
});

test('rejects invalid UTF-8, Unicode escapes, non-finite numbers, and negative zero', () => {
  assert.throws(() => parseJsonBytes(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), /valid UTF-8/u);
  assert.throws(() => parseJsonBytes('{"value":"\\ud800"}'), /surrogate/u);
  assert.throws(() => parseJsonBytes('{"value":1e400}'), /not finite/u);
  assert.throws(() => parseJsonBytes('{"value":-0}'), /Negative zero/u);
});

test('enforces byte, depth, string, and collection limits at their boundaries', () => {
  const exactBytes = `${' '.repeat(WIRE_LIMITS.inputBytes - 1)}0`;
  assert.equal(parseJsonBytes(exactBytes), 0);
  assert.throws(() => parseJsonBytes(` ${exactBytes}`), /input byte limit/u);

  const exactDepth = `${'['.repeat(WIRE_LIMITS.depth)}0${']'.repeat(WIRE_LIMITS.depth)}`;
  assert.doesNotThrow(() => parseJsonBytes(exactDepth));
  assert.throws(
    () => parseJsonBytes(`${'['.repeat(WIRE_LIMITS.depth + 1)}0${']'.repeat(WIRE_LIMITS.depth + 1)}`),
    /nesting depth/u,
  );

  assert.equal(parseJsonBytes(JSON.stringify('x'.repeat(WIRE_LIMITS.stringBytes))).length, WIRE_LIMITS.stringBytes);
  assert.throws(() => parseJsonBytes(JSON.stringify('x'.repeat(WIRE_LIMITS.stringBytes + 1))), /string byte limit/u);

  assert.equal(parseJsonBytes(JSON.stringify(Array(WIRE_LIMITS.collectionEntries).fill(0))).length, WIRE_LIMITS.collectionEntries);
  assert.throws(
    () => parseJsonBytes(JSON.stringify(Array(WIRE_LIMITS.collectionEntries + 1).fill(0))),
    /collection entry limit/u,
  );
});

test('preserves degenerate JSON values and produces domain-separated digests', () => {
  const value = parseJsonBytes('{"zero":0,"empty":"","flag":false,"items":[]}');
  assert.deepEqual(value, { zero: 0, empty: '', flag: false, items: [] });
  assert.equal(domainDigest('one', value), domainDigest('one', { items: [], flag: false, empty: '', zero: 0 }));
  assert.notEqual(domainDigest('one', value), domainDigest('two', value));
});
