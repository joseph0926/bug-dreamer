import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import localDescriptor from '../registrations/v0.3/benchmark/local-first.json' with { type: 'json' };
import prepaintDescriptor from '../registrations/v0.3/benchmark/prepaint.json' with { type: 'json' };
import txDescriptor from '../registrations/v0.3/benchmark/tx.json' with { type: 'json' };
import {
  benchmarkPlanDigest,
  benchmarkSpecDigest,
  buildBenchmarkPlan,
  buildBenchmarkSpec,
  buildTransformedBenchmarkSpec,
  parseBenchmarkSeed,
  validateBenchmarkPlan,
  validateBenchmarkSeed,
  validateBenchmarkSpec,
} from '../src/v03-benchmark-spec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = Object.freeze({ role: 'clean', targetArtifactDigest: '1'.repeat(64), evaluationContractKey: '2'.repeat(64) });
const defectArtifact = Object.freeze({ role: 'single-patch-defect', targetArtifactDigest: '3'.repeat(64), evaluationContractKey: '4'.repeat(64) });

function txSeed() {
  return {
    schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: txDescriptor.catalogVersion, id: 'tx-seed', invariantId: txDescriptor.invariants[0].id, actors: ['client'], actions: [
      { actionId: 'tx.start', actor: 'client', arguments: { transactionId: 't1', timeoutMs: 100, transition: false }, bind: { name: 'tx', type: 'tx-handle' } },
      { actionId: 'tx.run-scripted', actor: 'client', arguments: { tx: { $binding: 'tx' }, attemptOutcomes: [{ kind: 'return', value: 1 }], retry: null, compensation: { kind: 'return' }, externalSignal: null, gate: 'first' }, bind: null },
      { actionId: 'tx.run-scripted', actor: 'client', arguments: { tx: { $binding: 'tx' }, attemptOutcomes: [{ kind: 'throw', errorName: 'Error', errorMessage: 'boom' }], retry: null, compensation: null, externalSignal: null, gate: 'second' }, bind: null },
    ],
  };
}

test('owned benchmark spec case manifest names positive and negative coverage', async () => {
  const cases = JSON.parse(await readFile(path.join(root, 'contracts/v0.3/benchmark-spec-cases.json'), 'utf8'));
  assert.equal(cases.schemaVersion, 'bug-dreamer/v03-benchmark-spec-cases/v1');
  assert.equal(cases.positive.length, 6);
  assert.equal(cases.negative.length, 10);
});

test('builds artifact-specific tx specs and plans with fixture provenance', () => {
  const seed = txSeed();
  const clean = buildBenchmarkSpec(seed, txDescriptor, artifact);
  const defect = buildBenchmarkSpec(seed, txDescriptor, defectArtifact);
  assert.notEqual(benchmarkSpecDigest(clean, txDescriptor, artifact), benchmarkSpecDigest(defect, txDescriptor, defectArtifact));
  assert.equal(clean.fixtures.length, 2);
  assert.equal(clean.fixtures[0].producerArtifact.targetArtifactDigest, artifact.targetArtifactDigest);
  const plan = buildBenchmarkPlan(clean, txDescriptor, artifact);
  assert.equal(plan.targetArtifactDigest, artifact.targetArtifactDigest);
  assert.match(benchmarkPlanDigest(plan, clean, txDescriptor, artifact), /^[0-9a-f]{64}$/u);
  assert.equal(validateBenchmarkPlan(plan, clean, txDescriptor, artifact), plan);
});

test('validates local-first binding flow and prepaint public subpath actions without importing product modules', () => {
  const local = {
    schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: localDescriptor.catalogVersion, id: 'local-seed', invariantId: localDescriptor.invariants[0].id, actors: ['client'], actions: [
      { actionId: 'local.define-model', actor: 'client', arguments: { name: 'cart', schemaId: 'local.count-record/v1', version: 1, ttlMs: 1000, hasInitialData: true, initialData: { count: 0 }, schemaFixture: { schemaVersion: 'bug-dreamer/local-first-schema-fixture/v1', schemaId: 'local.count-record/v1' }, indexedDbFixture: { schemaVersion: 'bug-dreamer/local-first-indexeddb-fixture/v1', database: 'firsttx-local-first', version: 2, stores: ['models', 'tx_journal', 'settings'] } }, bind: { name: 'model', type: 'model-handle' } },
      { actionId: 'local.get-history', actor: 'client', arguments: { modelBinding: 'model', ttlMs: 1000 }, bind: null },
    ],
  };
  assert.equal(buildBenchmarkPlan(buildBenchmarkSpec(local, localDescriptor, artifact), localDescriptor, artifact).bindings[0].type, 'model-handle');
  const prepaint = {
    schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: prepaintDescriptor.catalogVersion, id: 'prepaint-seed', invariantId: prepaintDescriptor.invariants.at(-1).id, actors: ['builder'], actions: [
      { actionId: 'prepaint.vite-create', actor: 'builder', arguments: { policy: { routes: ['relative'] }, inline: false, minify: false }, bind: null },
    ],
  };
  assert.equal(buildBenchmarkSpec(prepaint, prepaintDescriptor, artifact).fixtures.length, 0);
});

test('replays all three registered transformations and rejects tampering', () => {
  const seed = txSeed();
  const requests = [
    { schemaVersion: 'bug-dreamer/transformation-request/v1', transformations: [{ operatorId: 'time.advance/v1', arguments: { afterInstanceId: 'action-0001', advanceMs: 101 } }] },
    { schemaVersion: 'bug-dreamer/transformation-request/v1', transformations: [{ operatorId: 'schedule.release-order/v1', arguments: { instanceIds: ['action-0003', 'action-0002'] } }] },
    { schemaVersion: 'bug-dreamer/transformation-request/v1', transformations: [{ operatorId: 'fault.step-outcome/v1', arguments: { targetInstanceId: 'action-0002', outcome: 'throw', value: null, errorName: 'TypeError', errorMessage: 'fault' } }] },
  ];
  for (const request of requests) {
    const spec = buildTransformedBenchmarkSpec(seed, request, txDescriptor, artifact);
    assert.equal(spec.transformations.length, 1);
    assert.equal(validateBenchmarkSpec(spec, txDescriptor, artifact), spec);
    const tampered = structuredClone(spec);
    tampered.transformations[0].afterDigest = 'f'.repeat(64);
    assert.throws(() => validateBenchmarkSpec(tampered, txDescriptor, artifact), (error) => error.kind === 'rejected-policy');
  }
});

test('rejects unknown fields, reserved actors, forward bindings, module arguments, and fixture tampering', () => {
  assert.throws(() => parseBenchmarkSeed(Buffer.from('{"schemaVersion":"a","schemaVersion":"b"}'), txDescriptor), (error) => error.kind === 'rejected-schema' && /Duplicate JSON key/u.test(error.message));
  const extra = txSeed();
  extra.command = 'node evil.mjs';
  assert.throws(() => validateBenchmarkSeed(extra, txDescriptor), (error) => error.kind === 'rejected-schema');
  const reserved = txSeed();
  reserved.actors = ['host'];
  reserved.actions.forEach((action) => { action.actor = 'host'; });
  assert.throws(() => validateBenchmarkSeed(reserved, txDescriptor), (error) => error.kind === 'rejected-policy');
  const forward = txSeed();
  forward.actions = [forward.actions[1], forward.actions[0]];
  assert.throws(() => validateBenchmarkSeed(forward, txDescriptor), (error) => error.kind === 'rejected-policy');
  const bad = txSeed();
  bad.actions[0].arguments.timeoutMs = 10001;
  assert.throws(() => validateBenchmarkSeed(bad, txDescriptor), (error) => error.kind === 'rejected-policy');
  const unknownAction = txSeed();
  unknownAction.actions[0].actionId = 'tx.private-import';
  assert.throws(() => validateBenchmarkSeed(unknownAction, txDescriptor), (error) => error.kind === 'rejected-catalog');
  const unknownInvariant = txSeed();
  unknownInvariant.invariantId = 'generator.claim';
  assert.throws(() => validateBenchmarkSeed(unknownInvariant, txDescriptor), (error) => error.kind === 'rejected-catalog');
  const overLimit = txSeed();
  overLimit.actions = Array.from({ length: 65 }, () => structuredClone(overLimit.actions[0]));
  assert.throws(() => validateBenchmarkSeed(overLimit, txDescriptor), (error) => error.kind === 'rejected-schema');
  const spec = buildBenchmarkSpec(txSeed(), txDescriptor, artifact);
  spec.fixtures[0].stateDigest = '0'.repeat(64);
  assert.throws(() => validateBenchmarkSpec(spec, txDescriptor, artifact), (error) => error.kind === 'rejected-policy');
  const unsupported = { schemaVersion: 'bug-dreamer/transformation-request/v1', transformations: [{ operatorId: 'time.advance/v1', arguments: { afterInstanceId: 'action-0001', advanceMs: 1 } }] };
  const prepaint = { schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: prepaintDescriptor.catalogVersion, id: 'p', invariantId: prepaintDescriptor.invariants[0].id, actors: ['a'], actions: [{ actionId: 'prepaint.boot', actor: 'a', arguments: { policy: { routes: ['/'] }, browser: { schemaVersion: 'bug-dreamer/prepaint-browser-fixture/v1', url: 'https://benchmark.invalid/', html: '<!doctype html><html><head></head><body><div id="root"></div></body></html>', clockMs: 1000000000000 }, indexeddb: { schemaVersion: 'bug-dreamer/prepaint-indexeddb-fixture/v1', database: 'firsttx-prepaint', version: 2, store: 'snapshots', records: [] } }, bind: null }] };
  assert.throws(() => buildTransformedBenchmarkSpec(prepaint, unsupported, prepaintDescriptor, artifact), (error) => error.kind === 'rejected-policy');
});
