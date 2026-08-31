import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDigestBudget, DIGEST_SCENARIO_BUDGET, renderDigest } from '../src/digest.mjs';

function batchWith(results) {
  return {
    scenario_directory: 'scenarios/firsttx',
    module: 'packages/tx',
    runs_per_scenario: 3,
    scenario_count: results.length,
    results,
  };
}

function result(scenario, outcome, rule, reportable, signature) {
  return {
    scenario,
    aggregate: { outcome, rule, reportable, signatures_match: reportable ? true : undefined },
    runs: [
      {
        classification: { outcome, failure_signature: signature },
        reproduction: { command: `node scripts/run-scenario.mjs --scenario ${scenario}` },
      },
    ],
  };
}

const signature = {
  oracle_basis_ref: 'contract:1',
  expected: 'expected',
  actual: 'actual',
};

test('includes only reportable candidates and excludes pass and unrunnable results', () => {
  const digest = renderDigest(
    batchWith([
      result('a.test.ts', 'candidate-failure', 'consistent-candidate-failure', true, signature),
      result('b.test.ts', 'pass', 'all-pass', false),
      result('c.test.ts', 'unrunnable', 'all-unrunnable', false),
      result('d.test.ts', 'intermittent', 'mixed-outcomes', false),
      result('e.test.ts', 'candidate-failure', 'diverging-candidate-failure', false, signature),
    ]),
    '2026-08-31',
  );

  assert.ok(digest.includes('### a.test.ts'));
  assert.equal(digest.includes('### b.test.ts'), false);
  assert.equal(digest.includes('### c.test.ts'), false);
  assert.equal(digest.includes('### d.test.ts'), false);
  assert.equal(digest.includes('### e.test.ts'), false);
  assert.ok(digest.includes('pass: 1, unrunnable: 1, intermittent: 1, diverging signatures: 1'));
  assert.ok(digest.includes('not a reported nightmare'));
});

test('renders candidate evidence fields', () => {
  const digest = renderDigest(
    batchWith([
      result('a.test.ts', 'candidate-failure', 'consistent-candidate-failure', true, signature),
    ]),
    '2026-08-31',
  );

  assert.ok(digest.includes('Oracle: contract:1'));
  assert.ok(digest.includes('Expected: "expected"'));
  assert.ok(digest.includes('Actual: "actual"'));
  assert.ok(digest.includes('Reproduction: `node scripts/run-scenario.mjs --scenario a.test.ts`'));
});

test('renders an empty batch with no candidates', () => {
  const digest = renderDigest(batchWith([]), '2026-08-31');

  assert.ok(digest.includes('None. No scenario produced a consistent candidate failure.'));
  assert.ok(digest.includes('pass: 0, unrunnable: 0, intermittent: 0, diverging signatures: 0'));
});

test('renders evidence reference, model calls, and execution time when provided', () => {
  const batch = batchWith([
    result('a.test.ts', 'candidate-failure', 'consistent-candidate-failure', true, signature),
  ]);
  batch.execution = { started_at: 't0', finished_at: 't1', duration_ms: 1234 };

  const digest = renderDigest(batch, '2026-08-31', {
    evidenceRef: 'evidence/2026-08-31/digest-batch.json',
    modelCalls: 4,
  });

  assert.ok(digest.includes('Evidence: evidence/2026-08-31/digest-batch.json'));
  assert.ok(digest.includes('Model calls: 4'));
  assert.ok(digest.includes('Execution time: 1234 ms'));
  assert.ok(
    digest.includes('- Evidence: evidence/2026-08-31/digest-batch.json (results entry for a.test.ts)'),
  );
});

test('records model calls as not-recorded when the count is not provided', () => {
  const digest = renderDigest(batchWith([]), '2026-08-31');

  assert.ok(digest.includes('Model calls: not-recorded'));
});

test('budget check accepts counts up to the budget including zero', () => {
  assert.doesNotThrow(() => assertDigestBudget(0));
  assert.doesNotThrow(() => assertDigestBudget(DIGEST_SCENARIO_BUDGET));
});

test('budget check rejects one scenario over the budget before any execution', () => {
  assert.throws(
    () => assertDigestBudget(DIGEST_SCENARIO_BUDGET + 1),
    /exceeds the recorded budget of 20; nothing was executed/,
  );
});

test('budget check rejects a negative or non-integer count', () => {
  assert.throws(() => assertDigestBudget(-1), /non-negative integer/);
  assert.throws(() => assertDigestBudget(1.5), /non-negative integer/);
});
