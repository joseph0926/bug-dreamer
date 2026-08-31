import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateRuns, signatureKey } from '../src/batch.mjs';

function run(outcome, failureSignature) {
  return { classification: { outcome, failure_signature: failureSignature } };
}

const signature = {
  oracle_basis_ref: 'contract:1',
  expected: 'expected',
  actual: 'actual',
};

test('aggregates all passing runs as pass', () => {
  const aggregate = aggregateRuns([run('pass'), run('pass'), run('pass')]);

  assert.equal(aggregate.outcome, 'pass');
  assert.equal(aggregate.reportable, false);
  assert.equal(aggregate.rule, 'all-pass');
});

test('aggregates matching candidate failures as reportable', () => {
  const aggregate = aggregateRuns([
    run('candidate-failure', signature),
    run('candidate-failure', { ...signature }),
    run('candidate-failure', { ...signature }),
  ]);

  assert.equal(aggregate.outcome, 'candidate-failure');
  assert.equal(aggregate.signaturesMatch, true);
  assert.equal(aggregate.reportable, true);
  assert.equal(aggregate.rule, 'consistent-candidate-failure');
});

test('keeps matching candidate failures below three runs unreportable', () => {
  const aggregate = aggregateRuns([
    run('candidate-failure', signature),
    run('candidate-failure', { ...signature }),
  ]);

  assert.equal(aggregate.signaturesMatch, true);
  assert.equal(aggregate.reportable, false);
});

test('flags diverging candidate failure signatures', () => {
  const aggregate = aggregateRuns([
    run('candidate-failure', signature),
    run('candidate-failure', { ...signature, actual: 'other' }),
    run('candidate-failure', { ...signature }),
  ]);

  assert.equal(aggregate.outcome, 'candidate-failure');
  assert.equal(aggregate.signaturesMatch, false);
  assert.equal(aggregate.reportable, false);
  assert.equal(aggregate.rule, 'diverging-candidate-failure');
});

test('aggregates all unrunnable runs as unrunnable', () => {
  const aggregate = aggregateRuns([run('unrunnable'), run('unrunnable'), run('unrunnable')]);

  assert.equal(aggregate.outcome, 'unrunnable');
  assert.equal(aggregate.reportable, false);
  assert.equal(aggregate.rule, 'all-unrunnable');
});

test('aggregates mixed outcomes as intermittent', () => {
  const aggregate = aggregateRuns([run('pass'), run('candidate-failure', signature), run('unrunnable')]);

  assert.equal(aggregate.outcome, 'intermittent');
  assert.equal(aggregate.reportable, false);
  assert.equal(aggregate.rule, 'mixed-outcomes');
});

test('rejects an empty run list', () => {
  assert.throws(() => aggregateRuns([]), /At least one run/u);
});

test('treats missing signatures as equal keys', () => {
  assert.equal(signatureKey(undefined), signatureKey(undefined));
  assert.notEqual(signatureKey(signature), signatureKey(undefined));
});
