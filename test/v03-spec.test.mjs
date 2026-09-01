import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  V03SpecError,
  buildExecutionPlan,
  buildNightmareSpec,
  loadPhase2Catalog,
  parseNightmareSeed,
  planDigest,
  specDigest,
  validateExecutionPlan,
  validateNightmareSeed,
  validateNightmareSpec,
  validatePhase2Catalog,
} from '../src/v03-spec.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

async function readSeed(relativePath, catalog) {
  return parseNightmareSeed(await readFile(path.join(repositoryRoot, relativePath)), catalog);
}

test('validates the Phase 2 catalog and binds it to the package registration', async () => {
  const { catalog } = await loadPhase2Catalog(repositoryRoot);
  assert.equal(catalog.actions.length, 3);
  assert.equal(catalog.invariants.length, 2);
  assert.equal(catalog.fixtures.length, 1);
});

test('builds deterministic self-contained specs and plans for every positive seed', async () => {
  const [{ catalog }, cases] = await Promise.all([
    loadPhase2Catalog(repositoryRoot),
    readJson('contracts/v0.3/spec-cases.json'),
  ]);
  for (const relativePath of cases.positive) {
    const seed = await readSeed(relativePath, catalog);
    const firstSpec = buildNightmareSpec(seed, catalog);
    const secondSpec = buildNightmareSpec(seed, catalog);
    assert.deepEqual(secondSpec, firstSpec);
    assert.equal(specDigest(secondSpec, catalog), specDigest(firstSpec, catalog));
    const firstPlan = buildExecutionPlan(firstSpec, catalog);
    const secondPlan = buildExecutionPlan(secondSpec, catalog);
    assert.deepEqual(secondPlan, firstPlan);
    assert.equal(planDigest(secondPlan, secondSpec, catalog), planDigest(firstPlan, firstSpec, catalog));
    assert.deepEqual(firstSpec.transformedActions, firstSpec.baseActions);
    assert.deepEqual(firstSpec.transformations, []);
    assert.deepEqual(firstPlan.scheduleControls, []);
  }
});

test('keeps base and transformed actions as independent objects', async () => {
  const { catalog } = await loadPhase2Catalog(repositoryRoot);
  const seed = await readSeed('contracts/v0.3/seeds/pass.json', catalog);
  const spec = buildNightmareSpec(seed, catalog);
  assert.notStrictEqual(spec.transformedActions, spec.baseActions);
  spec.transformedActions.forEach((action, index) => {
    assert.notStrictEqual(action, spec.baseActions[index]);
    assert.notStrictEqual(action.arguments, spec.baseActions[index].arguments);
  });
  spec.transformedActions[1].arguments.value = { zero: 0, empty: '', flag: false, items: [], extra: true };
  assert.deepEqual(spec.baseActions[1].arguments.value, { zero: 0, empty: '', flag: false, items: [] });
});

test('preserves zero-like values through seed, spec, and plan construction', async () => {
  const { catalog } = await loadPhase2Catalog(repositoryRoot);
  const seed = await readSeed('contracts/v0.3/seeds/pass.json', catalog);
  const spec = buildNightmareSpec(seed, catalog);
  const plan = buildExecutionPlan(spec, catalog);
  assert.deepEqual(plan.actions[1].arguments.value, { zero: 0, empty: '', flag: false, items: [] });
  assert.equal(plan.actions[0].arguments.transactionId, '');
  assert.equal(plan.actions[0].arguments.transition, false);
});

test('rejects every owned negative seed with its registered reason', async () => {
  const [{ catalog }, cases] = await Promise.all([
    loadPhase2Catalog(repositoryRoot),
    readJson('contracts/v0.3/spec-cases.json'),
  ]);
  for (const fixture of cases.negative) {
    const bytes = await readFile(path.join(repositoryRoot, fixture.path));
    assert.throws(
      () => parseNightmareSeed(bytes, catalog),
      (error) => {
        const kind = error instanceof V03SpecError ? error.kind : 'rejected-schema';
        return kind === fixture.expectedKind && error.message.includes(fixture.expectedMessage);
      },
      fixture.path,
    );
  }
});

test('rejects reserved actors, duplicate bindings, and missing declared actors', async () => {
  const { catalog } = await loadPhase2Catalog(repositoryRoot);
  const base = await readSeed('contracts/v0.3/seeds/pass.json', catalog);

  const reserved = structuredClone(base);
  reserved.actors = ['host'];
  reserved.actions = reserved.actions.map((action) => ({ ...action, actor: 'host' }));
  assert.throws(() => validateNightmareSeed(reserved, catalog), /reserved/u);

  const duplicate = structuredClone(base);
  duplicate.actions.splice(1, 0, structuredClone(duplicate.actions[0]));
  assert.throws(() => validateNightmareSeed(duplicate, catalog), /Duplicate binding/u);

  const missing = structuredClone(base);
  missing.actions[0].actor = 'other';
  assert.throws(() => validateNightmareSeed(missing, catalog), /not declared/u);
});

test('rejects catalog, spec, fixture, and plan tampering', async () => {
  const { catalog } = await loadPhase2Catalog(repositoryRoot);
  const seed = await readSeed('contracts/v0.3/seeds/pass.json', catalog);
  const spec = buildNightmareSpec(seed, catalog);
  const plan = buildExecutionPlan(spec, catalog);

  const catalogTamper = structuredClone(catalog);
  catalogTamper.actions[0].adapterId = 'arbitrary/import/v1';
  assert.throws(() => validatePhase2Catalog(catalogTamper), /adapter/u);

  const sourceTamper = structuredClone(catalog);
  sourceTamper.invariants[0].sourceRef = 'generated-claim';
  assert.throws(() => validatePhase2Catalog(sourceTamper), /source changed/u);

  const observationTamper = structuredClone(catalog);
  observationTamper.invariants[0].observedFields = [{ name: 'generatorVerdict', type: 'string' }];
  assert.throws(() => validatePhase2Catalog(observationTamper), /observed contract changed/u);

  const specTamper = structuredClone(spec);
  specTamper.baseActions[0].adapterId = 'arbitrary/import/v1';
  specTamper.transformedActions[0].adapterId = 'arbitrary/import/v1';
  assert.throws(() => validateNightmareSpec(specTamper, catalog), /adapter binding changed/u);

  const identityTamper = structuredClone(spec);
  identityTamper.transformedActions[0].adapterId = 'arbitrary/import/v1';
  assert.throws(() => validateNightmareSpec(identityTamper, catalog), /Identity transformation/u);

  const fixtureTamper = structuredClone(spec);
  fixtureTamper.fixtures[0].stateDigest = '0'.repeat(64);
  assert.throws(() => validateNightmareSpec(fixtureTamper, catalog), /state digest mismatch/u);

  const planTamper = structuredClone(plan);
  planTamper.actions[0].adapterId = 'arbitrary/import/v1';
  assert.throws(() => validateExecutionPlan(planTamper, spec, catalog), /actions changed/u);
});

test('rejects actor and action counts above the v1 limits', async () => {
  const { catalog } = await loadPhase2Catalog(repositoryRoot);
  const seed = await readSeed('contracts/v0.3/seeds/pass.json', catalog);

  const actors = structuredClone(seed);
  actors.actors = Array.from({ length: 17 }, (_, index) => `actor-${index}`);
  assert.throws(() => validateNightmareSeed(actors, catalog), /actor count/u);

  const actions = structuredClone(seed);
  actions.actions = Array.from({ length: 65 }, () => structuredClone(seed.actions[0]));
  assert.throws(() => validateNightmareSeed(actions, catalog), /action count/u);
});

function seedBytes(actions) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 'bug-dreamer/nightmare-seed/v1',
    catalogVersion: 'firsttx-phase2-f624b09-v1',
    id: 'tx-total-timeout-causal',
    invariantId: 'tx.total-timeout',
    actors: ['checkout'],
    actions,
  }));
}

function startAction(transactionId, bindName, timeoutMs) {
  return {
    actionId: 'tx.start',
    actor: 'checkout',
    arguments: { transactionId, timeoutMs, transition: false },
    bind: { name: bindName, type: 'tx-handle' },
  };
}

function runAction(bindName) {
  return {
    actionId: 'tx.run',
    actor: 'checkout',
    arguments: {
      tx: { $binding: bindName },
      outcome: 'return',
      value: null,
      errorName: null,
      errorMessage: null,
      log: null,
      retry: null,
    },
    bind: null,
  };
}

function advanceRequest(...entries) {
  return {
    schemaVersion: 'bug-dreamer/transformation-request/v1',
    transformations: entries.map(([afterInstanceId, advanceMs]) => ({
      operatorId: 'time.advance/v1',
      arguments: { afterInstanceId, advanceMs },
    })),
  };
}

test('counts only virtual-time advances on the causal prefix of the final tx.run', async () => {
  const { loadPhase3Catalog, buildTransformedSpec } = await import('../src/v03-operators.mjs');
  const { catalog, operatorCatalog } = await loadPhase3Catalog(repositoryRoot);
  const build = (seed, request) => buildTransformedSpec(seed, request, catalog, operatorCatalog);
  const inapplicable = /total virtual-time advance must exceed the transaction timeout/u;

  const single = parseNightmareSeed(seedBytes([
    startAction('causal-single', 'tx', 5000),
    runAction('tx'),
    runAction('tx'),
  ]), catalog);

  assert.throws(() => build(single, advanceRequest(['action-0003', 5001])), inapplicable);
  assert.throws(() => build(single, advanceRequest(['action-0002', 3000], ['action-0003', 5000])), inapplicable);
  assert.equal(build(single, advanceRequest(['action-0002', 6000], ['action-0003', 99999])).scheduleControls.length, 2);
  assert.equal(build(single, advanceRequest(['action-0001', 6000])).scheduleControls.length, 1);

  const twoTransactions = parseNightmareSeed(seedBytes([
    startAction('causal-other', 'other', 5000),
    runAction('other'),
    startAction('causal-final', 'tx', 5000),
    runAction('tx'),
  ]), catalog);

  assert.throws(() => build(twoTransactions, advanceRequest(['action-0001', 6000])), inapplicable);
  assert.throws(() => build(twoTransactions, advanceRequest(['action-0002', 6000])), inapplicable);
  assert.equal(build(twoTransactions, advanceRequest(['action-0003', 6000])).scheduleControls.length, 1);

  const releaseOnly = {
    schemaVersion: 'bug-dreamer/transformation-request/v1',
    transformations: [
      { operatorId: 'schedule.release-order/v1', arguments: { instanceIds: ['action-0002', 'action-0003'] } },
    ],
  };
  assert.throws(() => build(single, releaseOnly), inapplicable);

  const gatedAdvance = {
    schemaVersion: 'bug-dreamer/transformation-request/v1',
    transformations: [
      { operatorId: 'schedule.release-order/v1', arguments: { instanceIds: ['action-0002', 'action-0003'] } },
      { operatorId: 'time.advance/v1', arguments: { afterInstanceId: 'action-0002', advanceMs: 6000 } },
    ],
  };
  assert.throws(() => build(single, gatedAdvance), inapplicable);
});

test('keeps the registered time-advance request applicable to the total-timeout invariant', async () => {
  const { loadPhase3Catalog, buildTransformedSpec } = await import('../src/v03-operators.mjs');
  const { catalog, operatorCatalog } = await loadPhase3Catalog(repositoryRoot);
  const seed = await readSeed('contracts/v0.3/seeds/total-timeout.json', catalog);
  const request = await readJson('contracts/v0.3/requests/time-advance.json');
  const spec = buildTransformedSpec(seed, request, catalog, operatorCatalog);
  assert.deepEqual(spec.scheduleControls, [{ kind: 'virtual-time-advance', afterInstanceId: 'action-0002', advanceMs: 6000 }]);
});
