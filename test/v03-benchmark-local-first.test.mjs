import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertTrustedComparisonModuleImplementation,
  assertTrustedInterpreterModuleImplementation,
  validateTrustedModuleDescriptor,
} from '../src/v03-benchmark-contract.mjs';
import { buildBenchmarkPlan, buildBenchmarkSpec, validateBenchmarkSeed } from '../src/v03-benchmark-spec.mjs';
import * as direct from '../harness-v0.3/benchmark/local-first-direct.mjs';
import {
  createBroadcastPeerRelay,
  createFixtureRegistration,
  createIndexedDBActivityTracker,
  fixtureStateDigest,
  materializeFixtureRecord,
  registeredLocalFirstScenario,
  settleRelayQuiescence,
  validateFakeIndexedDBNamespace,
} from '../harness-v0.3/benchmark/local-first-environment.mjs';
import * as interpreter from '../harness-v0.3/benchmark/local-first.mjs';
import { evaluateLocalFirstObservation, normalizeReturnedValue } from '../harness-v0.3/benchmark/local-first-oracle.mjs';
import { validateActionArguments } from '../harness-v0.3/benchmark/local-first-schema.mjs';

const artifact = Object.freeze({ role: 'clean', targetArtifactDigest: 'a'.repeat(64), evaluationContractKey: 'b'.repeat(64) });

test('local-first descriptor and entrypoint exports satisfy the strict common interface', () => {
  assert.equal(validateTrustedModuleDescriptor(structuredClone(interpreter.descriptor)).id, 'local-first-benchmark-v1');
  assert.deepEqual(Object.keys(interpreter).sort(), ['descriptor', 'evaluateInvariant', 'executeAction', 'materializeFixture', 'validateActionArguments']);
  assert.deepEqual(Object.keys(direct).sort(), ['descriptor', 'materializeComparison']);
  assert.equal(assertTrustedInterpreterModuleImplementation(interpreter), interpreter);
  assert.equal(assertTrustedComparisonModuleImplementation(direct), direct);
});

test('synthetic nominal smoke is self-contained, non-measurement, and builds both caller inputs', async () => {
  const smokeBytes = await readFile(new URL('../contracts/v0.3/benchmark-smoke-local-first.json', import.meta.url));
  const smoke = JSON.parse(smokeBytes);
  assert.deepEqual(Object.keys(smoke).sort(), ['schemaVersion', 'id', 'moduleId', 'developmentOnly', 'measurementEligible', 'historicalTruthId', 'artifactRole', 'comparisonRegistrationId', 'invariantRegistrationId', 'sourceCommit', 'sourceRefs', 'seed', 'comparisonInput', 'runtimePolicy', 'expectedClean', 'preparationProbeRuns'].sort());
  assert.equal(smoke.schemaVersion, 'bug-dreamer/v03-benchmark-smoke/v1');
  assert.equal(smoke.developmentOnly, true);
  assert.equal(smoke.measurementEligible, false);
  assert.equal(smoke.historicalTruthId, null);
  assert.equal(smoke.preparationProbeRuns, 2);
  assert.match(smoke.id, /^synthetic-/u);
  assert.equal(validateBenchmarkSeed(structuredClone(smoke.seed), interpreter.descriptor).id, smoke.seed.id);
  const spec = buildBenchmarkSpec(smoke.seed, interpreter.descriptor, artifact);
  const plan = buildBenchmarkPlan(spec, interpreter.descriptor, artifact);
  assert.equal(plan.invariantRegistrationId, 'local.staleness-from-age-and-ttl/proposed-v1');
  assert.deepEqual(spec.fixtures.map((fixture) => fixture.registrationId).sort(), ['local.callback-log/v1', 'local.indexeddb/v1', 'local.zod-schema/v1']);
  assert.ok(interpreter.descriptor.comparisons.some((entry) => entry.id === smoke.comparisonRegistrationId));
  const scenario = registeredLocalFirstScenario(smoke.id);
  assert.equal(scenario.clockMs, smoke.runtimePolicy.virtualTime.originMs);
  assert.equal(scenario.actions[1].arguments.record.data.count, 42);
  assert.deepEqual(evaluateLocalFirstObservation(smoke.seed.invariantId, {
    normalizedObservedKind: smoke.expectedClean.observedKind,
    normalizedObservedFields: smoke.expectedClean.observedFields,
  }), smoke.expectedClean);
});

test('shared descriptor loader preserves the registration bytes semantically', async () => {
  const registered = JSON.parse(await readFile(new URL('../registrations/v0.3/benchmark/local-first.json', import.meta.url), 'utf8'));
  assert.deepEqual(interpreter.descriptor, registered);
  assert.deepEqual(direct.descriptor, registered);
});

test('pure action validator accepts registered data and rejects code, wrong binding types, and TTL overflow', () => {
  const bindings = new Map();
  const define = {
    actionId: 'local.define-model',
    arguments: { name: 'benchmark-model', schemaId: 'local.count-record/v1', version: 1, ttlMs: 5000, hasInitialData: false, initialData: null, schemaFixture: { schemaVersion: 'bug-dreamer/local-first-schema-fixture/v1', schemaId: 'local.count-record/v1' }, indexedDbFixture: { schemaVersion: 'bug-dreamer/local-first-indexeddb-fixture/v1', database: 'firsttx-local-first', version: 2, stores: ['models', 'tx_journal', 'settings'] } },
    bind: { name: 'model', type: 'model-handle' },
  };
  assert.doesNotThrow(() => validateActionArguments({ action: define, bindings, policy: {} }));
  assert.throws(() => validateActionArguments({ action: { ...define, bind: 'model' }, bindings, policy: {} }), /binding must be a plain object/u);
  assert.throws(() => validateActionArguments({ action: { ...define, arguments: { ...define.arguments, ttlMs: 86_400_001 } }, bindings, policy: {} }), /TTL/u);
  assert.throws(() => validateActionArguments({ action: { ...define, arguments: { ...define.arguments, hasInitialData: true, initialData: { count() {} } } }, bindings, policy: {} }), /finite/u);

  bindings.set('model', { type: 'wrong-handle', value: {} });
  const history = { actionId: 'local.get-history', arguments: { modelBinding: 'model', ttlMs: 5000 }, bind: null };
  assert.throws(() => validateActionArguments({ action: history, bindings, policy: {} }), /not a model-handle/u);
  bindings.set('model', { type: 'model-handle', value: {} });
  assert.doesNotThrow(() => validateActionArguments({ action: history, bindings, policy: {} }));
  assert.throws(() => validateActionArguments({ action: { actionId: 'local.patch', arguments: { modelBinding: 'model', patchId: 'generator-function', value: 1, callbackLogId: 'primary', broadcastFixture: { schemaVersion: 'bug-dreamer/local-first-broadcast-fixture/v1', channel: 'firsttx:models', senderSelfDelivery: false, peerInstances: 1, retransmitLimit: 1 } }, bind: null }, bindings, policy: {} }), /not registered/u);
});

test('registered fixture records preserve canonical state and provenance digests', async () => {
  const scenario = registeredLocalFirstScenario('local-first-stale-flag-inverted');
  const registration = scenario.fixtureRegistrations[0];
  const record = materializeFixtureRecord({ fixtureRegistration: registration, artifact, moduleRegistrationId: interpreter.descriptor.moduleId, consumerActionInstanceId: 'define' });
  assert.equal(record.registrationId, 'local.indexeddb/v1');
  assert.equal(record.stateDigest, fixtureStateDigest(record.canonicalWirePayload));
  assert.equal(record.producerArtifact.targetArtifactDigest, artifact.targetArtifactDigest);
  assert.deepEqual(record.publicActionTrace, ['local.define-model']);
  assert.notEqual(record.registrationDigest, record.stateDigest);

  const recreated = createFixtureRegistration(
    { id: registration.id, kind: registration.kind, materializerId: registration.materializerId, consumerActionId: registration.consumerActionId, payloadArgumentPointer: registration.payloadArgumentPointer, publicActionTrace: registration.publicActionTrace },
    registration.canonicalWirePayload,
  );
  assert.deepEqual(recreated, registration);
  assert.deepEqual(await interpreter.materializeFixture({ fixtureRecord: record, actionInstance: scenario.actions[0], artifact, policy: {} }), record);
});

test('fake-indexeddb namespace validation is fail-closed', () => {
  class KeyRange {}
  const valid = { indexedDB: { open() {} }, IDBKeyRange: KeyRange };
  assert.equal(validateFakeIndexedDBNamespace(valid), valid);
  assert.throws(() => validateFakeIndexedDBNamespace({ indexedDB: {}, IDBKeyRange: KeyRange }), /indexedDB export/u);
  assert.throws(() => validateFakeIndexedDBNamespace({ indexedDB: { open() {} } }), /IDBKeyRange/u);
});

test('IndexedDB completion uses observed open and transaction quiescence instead of a delay', async () => {
  const transaction = new EventTarget();
  const database = {
    transaction() {
      queueMicrotask(() => transaction.dispatchEvent(new Event('complete')));
      return transaction;
    },
  };
  const request = new EventTarget();
  request.result = database;
  const tracker = createIndexedDBActivityTracker({
    open() {
      queueMicrotask(() => {
        request.dispatchEvent(new Event('success'));
        request.onsuccess?.();
      });
      return request;
    },
  });
  const marker = tracker.marker();
  const opening = tracker.indexedDB.open('firsttx-local-first', 2);
  opening.onsuccess = () => opening.result.transaction('models', 'readonly');
  await tracker.settleAfter(marker);
  assert.deepEqual(tracker.snapshot(), { generation: 2, pending: 0 });
});

test('broadcast mechanic uses a separate peer, never self-delivers, and retransmits once', async () => {
  const relay = createBroadcastPeerRelay();
  const product = new relay.BroadcastChannel('firsttx:models');
  const received = [];
  product.onmessage = (event) => received.push(event.data);
  product.postMessage({ type: 'model-patched', key: 'cart', senderId: 'sender-1', timestamp: 10 });
  assert.deepEqual(received, []);
  await relay.retransmitOnce();
  assert.deepEqual(received, [{ type: 'model-patched', key: 'cart', senderId: 'sender-1', timestamp: 10 }]);
  assert.deepEqual(relay.snapshot(), { senderSelfDeliveries: 0, peerReceipts: 1, peerRetransmissions: 1 });
  await assert.rejects(() => relay.retransmitOnce(), /limit exceeded/u);
  relay.close();
});

test('broadcast observation window discards setup traffic before the measured retransmission', async () => {
  const relay = createBroadcastPeerRelay();
  const product = new relay.BroadcastChannel('firsttx:models');
  const received = [];
  product.onmessage = (event) => received.push(event.data);
  product.postMessage({ type: 'model-replaced', key: 'cart', senderId: 'sender-1', timestamp: 9 });
  await relay.beginObservationWindow();
  product.postMessage({ type: 'model-patched', key: 'cart', senderId: 'sender-1', timestamp: 10 });
  await relay.retransmitOnce();
  assert.deepEqual(received, [{ type: 'model-patched', key: 'cart', senderId: 'sender-1', timestamp: 10 }]);
  assert.deepEqual(relay.snapshot(), { senderSelfDeliveries: 0, peerReceipts: 1, peerRetransmissions: 1 });
  relay.close();
});

test('relay quiescence completes for clean zero-I/O and defect-like reload I/O without callback predicates', async () => {
  function factory() {
    return {
      open() {
        const transaction = new EventTarget();
        const database = { transaction() { queueMicrotask(() => transaction.dispatchEvent(new Event('complete'))); return transaction; } };
        const request = new EventTarget();
        request.result = database;
        queueMicrotask(() => { request.dispatchEvent(new Event('success')); request.onsuccess?.(); });
        return request;
      },
    };
  }
  async function exercise({ reload }) {
    const activity = createIndexedDBActivityTracker(factory());
    const relay = createBroadcastPeerRelay();
    const product = new relay.BroadcastChannel('firsttx:models');
    product.onmessage = () => {
      if (!reload) return;
      const opening = activity.indexedDB.open('firsttx-local-first', 2);
      opening.onsuccess = () => opening.result.transaction('models', 'readonly');
    };
    await relay.beginObservationWindow();
    product.postMessage({ type: 'model-patched', key: 'cart', senderId: 'sender-1', timestamp: 10 });
    await settleRelayQuiescence(relay, activity);
    const snapshot = activity.snapshot();
    relay.close();
    return snapshot;
  }
  assert.deepEqual(await exercise({ reload: false }), { generation: 0, pending: 0 });
  assert.deepEqual(await exercise({ reload: true }), { generation: 2, pending: 0 });
});

test('oracle excludes the TTL equality boundary and classifies only normalized public observations', () => {
  const stale = normalizeReturnedValue({ updatedAt: 100, age: 8000, isStale: true, isConflicted: false, ttlMs: 5000 });
  assert.equal(evaluateLocalFirstObservation('local.staleness-from-age-and-ttl/proposed-v1', stale).execution, 'pass');
  assert.throws(() => evaluateLocalFirstObservation('local.staleness-from-age-and-ttl/proposed-v1', normalizeReturnedValue({ updatedAt: 100, age: 5000, isStale: true, isConflicted: false, ttlMs: 5000 })), /excluded TTL equality/u);
  assert.equal(evaluateLocalFirstObservation('local.error-transition-notifies/proposed-v1', normalizeReturnedValue({ notified: true, errorName: 'ValidationError' })).execution, 'pass');
  assert.equal(evaluateLocalFirstObservation('local.error-transition-notifies/proposed-v1', normalizeReturnedValue({ notified: false, errorName: 'ValidationError' })).execution, 'candidate-failure');
  assert.equal(evaluateLocalFirstObservation('local.ignore-self-broadcast/proposed-v1', normalizeReturnedValue({ localMutationCallbacks: 1, callbackCountAfterPeerRelay: 0, senderSelfDeliveries: 0, peerReceipts: 1, peerRetransmissions: 1 })).execution, 'pass');
  assert.equal(evaluateLocalFirstObservation('local.ignore-self-broadcast/proposed-v1', normalizeReturnedValue({ localMutationCallbacks: 1, callbackCountAfterPeerRelay: 1, senderSelfDeliveries: 0, peerReceipts: 1, peerRetransmissions: 1 })).execution, 'candidate-failure');
});

test('D and E import closures remain independent and schema stays host-pure', async () => {
  const [directSource, interpreterSource, schemaSource] = await Promise.all([
    readFile(new URL('../harness-v0.3/benchmark/local-first-direct.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../harness-v0.3/benchmark/local-first.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../harness-v0.3/benchmark/local-first-schema.mjs', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(directSource, /local-first\.mjs|v03-benchmark-spec|buildBenchmarkPlan/u);
  assert.doesNotMatch(interpreterSource, /local-first-direct\.mjs/u);
  assert.doesNotMatch(schemaSource, /^import\s/mu);
  assert.doesNotMatch(`${directSource}\n${interpreterSource}`, /@firsttx\/local-first[/\\]|cache-manager|storage-manager|ModelBroadcaster|\.prototype\s*[.=]/u);
});
