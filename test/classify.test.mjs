import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRun, event, parseEvents } from '../src/classify.mjs';

function result({ lines = [], exitCode = 0, timedOut = false }) {
  return {
    stdout: lines.join('\n'),
    stderr: '',
    exitCode,
    signal: null,
    timedOut,
  };
}

test('classifies a completed successful oracle as pass', () => {
  const classified = classifyRun(
    result({
      lines: [event('P1'), event('P2', { scenario_id: 'pass' }), event('P3'), event('P4')],
    }),
  );

  assert.equal(classified.outcome, 'pass');
  assert.equal(classified.rule, 'oracle-satisfied');
});

test('classifies a missing test definition marker as unrunnable', () => {
  const classified = classifyRun(result({ lines: [event('P1')], exitCode: 1 }));

  assert.equal(classified.outcome, 'unrunnable');
  assert.equal(classified.unrunnableKind, 'test-definition');
  assert.equal(classified.rule, 'test-load-failure');
});

test('classifies an outer timeout as infrastructure unrunnable', () => {
  const classified = classifyRun(
    result({ lines: [event('P1'), event('P2'), event('P3')], timedOut: true, exitCode: null }),
  );

  assert.equal(classified.outcome, 'unrunnable');
  assert.equal(classified.unrunnableKind, 'infrastructure');
  assert.equal(classified.rule, 'harness-timeout');
});

test('classifies an explicit assertion failure as a candidate', () => {
  const classified = classifyRun(
    result({
      lines: [
        event('P1'),
        event('P2', { scenario_id: 'failure', oracle_basis_ref: 'contract:1' }),
        event('P3'),
        event('P4', { actual: 'actual' }),
        event('ORACLE_FAILURE', {
          message: 'expected actual to be expected',
          expected: 'expected',
          actual: 'actual',
        }),
      ],
      exitCode: 1,
    }),
  );

  assert.equal(classified.outcome, 'candidate-failure');
  assert.equal(classified.rule, 'oracle-violation');
  assert.equal(classified.failureSignature.actual, 'actual');
});

test('classifies empty output as an infrastructure failure', () => {
  const classified = classifyRun(result({ lines: [], exitCode: 125 }));

  assert.equal(parseEvents('').length, 0);
  assert.equal(classified.outcome, 'unrunnable');
  assert.equal(classified.unrunnableKind, 'infrastructure');
});
