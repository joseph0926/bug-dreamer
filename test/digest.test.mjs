import assert from 'node:assert/strict';
import test from 'node:test';

import { renderDigest } from '../src/digest.mjs';

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
