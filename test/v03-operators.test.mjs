import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildTransformedSpec, loadPhase3Catalog } from '../src/v03-operators.mjs';
import { validateOperatorContracts } from '../src/v03-operators-validation.mjs';
import { parseNightmareSeed, stateDigest, validateNightmareSpec } from '../src/v03-spec.mjs';
import { parseJsonBytes } from '../src/v03-wire.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function context() {
  const { catalog, operatorCatalog } = await loadPhase3Catalog(repositoryRoot);
  return { catalog, operatorCatalog };
}

async function readSeed(relativePath, catalog) {
  return parseNightmareSeed(await readFile(path.join(repositoryRoot, relativePath)), catalog);
}

async function readRequest(relativePath) {
  return parseJsonBytes(await readFile(path.join(repositoryRoot, relativePath)));
}

test('validates all recorded operator cases against the registered catalog', async () => {
  const result = await validateOperatorContracts(repositoryRoot);
  assert.equal(result.positiveCaseCount, 4);
  assert.equal(result.negativeCaseCount, 7);
});

test('builds a chained time advance with an anchored transformation digest chain', async () => {
  const { catalog, operatorCatalog } = await context();
  const seed = await readSeed('contracts/v0.3/seeds/total-timeout.json', catalog);
  const request = await readRequest('contracts/v0.3/requests/chained-advance.json');
  const spec = buildTransformedSpec(seed, request, catalog, operatorCatalog);
  assert.equal(spec.transformations.length, 2);
  assert.equal(spec.scheduleControls.length, 2);
  assert.equal(spec.transformations[0].beforeDigest, stateDigest(spec.baseActions, []));
  assert.equal(spec.transformations[0].afterDigest, spec.transformations[1].beforeDigest);
  assert.equal(spec.transformations[1].afterDigest, stateDigest(spec.transformedActions, spec.scheduleControls));
});

test('fault transformation rewrites only the target arguments and keeps base actions intact', async () => {
  const { catalog, operatorCatalog } = await context();
  const seed = await readSeed('contracts/v0.3/seeds/two-steps.json', catalog);
  const request = await readRequest('contracts/v0.3/requests/fault-nonfinal.json');
  const spec = buildTransformedSpec(seed, request, catalog, operatorCatalog);
  assert.equal(spec.transformedActions[1].arguments.outcome, 'throw');
  assert.equal(spec.transformedActions[1].arguments.errorMessage, 'injected-fault');
  assert.equal(spec.baseActions[1].arguments.outcome, 'return');
  assert.equal(spec.transformedActions[1].instanceId, spec.baseActions[1].instanceId);
  assert.equal(spec.fixtures[0].canonicalWirePayload.outcome, 'throw');
});

test('accepts the maximum registered advance and rejects a tampered final digest', async () => {
  const { catalog, operatorCatalog } = await context();
  const seed = await readSeed('contracts/v0.3/seeds/total-timeout.json', catalog);
  const request = {
    schemaVersion: 'bug-dreamer/transformation-request/v1',
    transformations: [
      { operatorId: 'time.advance/v1', arguments: { afterInstanceId: 'action-0002', advanceMs: 86400000 } },
    ],
  };
  const spec = buildTransformedSpec(seed, request, catalog, operatorCatalog);
  assert.equal(spec.scheduleControls[0].advanceMs, 86400000);
  const tampered = structuredClone(spec);
  tampered.transformations[0].afterDigest = '0'.repeat(64);
  assert.throws(() => validateNightmareSpec(tampered, catalog), /Final transformation digest/u);
});

test('rejects an identity spec for an invariant that requires virtual-time advances', async () => {
  const { catalog } = await context();
  const seed = await readSeed('contracts/v0.3/seeds/total-timeout.json', catalog);
  const { buildNightmareSpec } = await import('../src/v03-spec.mjs');
  assert.throws(
    () => buildNightmareSpec(seed, catalog),
    /total virtual-time advance must exceed the transaction timeout/u,
  );
});
