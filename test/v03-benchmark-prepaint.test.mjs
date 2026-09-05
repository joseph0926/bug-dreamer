import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertTrustedComparisonModuleImplementation,
  assertTrustedInterpreterModuleImplementation,
  validateTrustedModuleDescriptor,
} from '../src/v03-benchmark-contract.mjs';
import { buildBenchmarkPlan, buildBenchmarkSpec } from '../src/v03-benchmark-spec.mjs';
import * as direct from '../harness-v0.3/benchmark/prepaint-direct.mjs';
import {
  createFixtureRegistration,
  fixtureStateDigest,
  materializeFixtureRecord,
  prepaintPayloadDigest,
  registeredPrepaintScenario,
  validateBrowserPayload,
  validateIndexedDbPayload,
} from '../harness-v0.3/benchmark/prepaint-environment.mjs';
import * as interpreter from '../harness-v0.3/benchmark/prepaint.mjs';
import {
  classifyPrepaintError,
  evaluatePrepaintObservation,
  normalizeReturnedValue,
} from '../harness-v0.3/benchmark/prepaint-oracle.mjs';

const artifact = {
  role: 'clean',
  targetArtifactDigest: 'a'.repeat(64),
  evaluationContractKey: 'b'.repeat(64),
};

function action(adapterId, argumentsValue) {
  return { actionId: adapterId.slice(0, -3), adapterId, actor: 'browser', arguments: argumentsValue, bind: null };
}

test('prepaint descriptor records four independently sourced invariants and strict D/E exports', async () => {
  const fileDescriptor = JSON.parse(await readFile(new URL('../registrations/v0.3/benchmark/prepaint.json', import.meta.url), 'utf8'));
  assert.deepEqual(interpreter.descriptor, fileDescriptor);
  assert.deepEqual(direct.descriptor, fileDescriptor);
  assert.equal(validateTrustedModuleDescriptor(structuredClone(fileDescriptor)).id, 'prepaint-benchmark-v1');
  assert.equal(fileDescriptor.invariants.length, 4);
  for (const invariant of fileDescriptor.invariants) {
    assert.equal(invariant.sourceCommit, 'f624b09f148c3368a51807f48d3237db20cef9c6');
    assert.equal(invariant.authoredBeforeGeneration, true);
    assert.equal(invariant.visibility, 'public');
    assert.equal(invariant.strength, 'normative');
    assert.ok(invariant.sourceRef.length > 0);
    assert.ok(invariant.corroboratingRefs.length >= 1);
  }
  assert.deepEqual(Object.keys(interpreter).sort(), ['descriptor', 'evaluateInvariant', 'executeAction', 'materializeFixture', 'validateActionArguments']);
  assert.deepEqual(Object.keys(direct).sort(), ['descriptor', 'materializeComparison']);
  assert.equal(assertTrustedInterpreterModuleImplementation(interpreter), interpreter);
  assert.equal(assertTrustedComparisonModuleImplementation(direct), direct);
});

test('prepaint action arguments enforce exact keys, bounds, and registered relative-route reachability', () => {
  const bindings = new Map();
  const registered = registeredPrepaintScenario('prepaint-route-prefix-overcapture');
  const boot = action('prepaint.boot/v1', registered.arguments);
  assert.doesNotThrow(() => interpreter.validateActionArguments({ action: boot, bindings, policy: {} }));
  const plugin = action('prepaint.vite-create/v1', { policy: { routes: ['dashboard'], ttlMs: 1000, maxSnapshotBytes: 1024, includeStyles: true }, inline: false, minify: false });
  assert.doesNotThrow(() => interpreter.validateActionArguments({ action: plugin, bindings, policy: {} }));
  assert.throws(() => interpreter.validateActionArguments({ action: structuredClone({ ...boot, arguments: { ...boot.arguments, extra: true } }), bindings, policy: {} }), /fields changed/u);
  assert.throws(() => interpreter.validateActionArguments({ action: action('prepaint.boot/v1', { ...boot.arguments, policy: { ...boot.arguments.policy, routes: ['checkout'] } }), bindings, policy: {} }), /absolute pathname/u);
  assert.throws(() => interpreter.validateActionArguments({ action: action('prepaint.boot/v1', { ...boot.arguments, policy: { ...boot.arguments.policy, maxSnapshotBytes: 1_048_577 } }), bindings, policy: {} }), /registered bounds/u);
  assert.throws(() => interpreter.validateActionArguments({ action: action('prepaint.vite-create/v1', { ...plugin.arguments, inline: true }), bindings, policy: {} }), /must remain false/u);
});

test('registered prepaint fixtures are canonical data with bounded inline-only state', () => {
  for (const rowId of ['prepaint-route-prefix-overcapture', 'prepaint-expired-snapshot-kept', 'prepaint-oversize-snapshot-kept']) {
    const scenario = registeredPrepaintScenario(rowId);
    assert.equal(scenario.fixtureRegistrations.length, 2);
    const [browser, indexeddb] = scenario.fixtureRegistrations;
    assert.equal(validateBrowserPayload(browser.canonicalWirePayload), browser.canonicalWirePayload);
    assert.equal(validateIndexedDbPayload(indexeddb.canonicalWirePayload), indexeddb.canonicalWirePayload);
    for (const registration of scenario.fixtureRegistrations) {
      const record = materializeFixtureRecord({ fixtureRegistration: registration, artifact, moduleRegistrationId: 'prepaint', consumerActionInstanceId: 'prepaint-01' });
      assert.equal(record.stateDigest, fixtureStateDigest(record.canonicalWirePayload));
      assert.deepEqual(record.producerArtifact, { moduleRegistrationId: 'prepaint', targetArtifactDigest: artifact.targetArtifactDigest });
    }
  }
  const unsafeBrowser = { schemaVersion: 'bug-dreamer/prepaint-browser-fixture/v1', url: 'https://benchmark.invalid/', html: '<script src="https://example.test/x.js"></script>', clockMs: 1 };
  assert.throws(() => validateBrowserPayload(unsafeBrowser), /fixed document/u);
  const mismatchedClock = structuredClone(registeredPrepaintScenario('prepaint-expired-snapshot-kept').arguments.browser);
  mismatchedClock.clockMs -= 1;
  assert.throws(() => validateBrowserPayload(mismatchedClock), /registered virtual-time origin/u);
  const externalStyle = registeredPrepaintScenario('prepaint-expired-snapshot-kept').fixtureRegistrations[1].canonicalWirePayload;
  externalStyle.records[0].styles = [{ type: 'external', content: 'https://example.test/x.css' }];
  assert.throws(() => validateIndexedDbPayload(externalStyle), /external resource/u);
});

test('fixture provenance and state hashes fail closed', () => {
  const scenario = registeredPrepaintScenario('prepaint-route-prefix-overcapture');
  const tampered = structuredClone(scenario.fixtureRegistrations[0]);
  tampered.canonicalWirePayload.clockMs += 1;
  assert.throws(() => materializeFixtureRecord({ fixtureRegistration: tampered, artifact, moduleRegistrationId: 'prepaint', consumerActionInstanceId: 'x' }), /registration digest mismatch/u);
  const registration = createFixtureRegistration({ id: 'prepaint.browser/v1', kind: 'external-environment', materializerId: 'prepaint.browser/v1', consumerActionId: 'prepaint.boot', payloadArgumentPointer: '/browser', publicActionTrace: ['prepaint.boot'] }, scenario.fixtureRegistrations[0].canonicalWirePayload);
  assert.match(registration.registrationDigest, /^[0-9a-f]{64}$/u);
});

test('interpreter materializer consumes and revalidates the builder-owned FixtureRecord', async () => {
  const scenario = registeredPrepaintScenario('prepaint-expired-snapshot-kept');
  const fixtureRegistration = scenario.fixtureRegistrations[0];
  const fixtureRecord = materializeFixtureRecord({ fixtureRegistration, artifact, moduleRegistrationId: 'prepaint', consumerActionInstanceId: 'action-0001' });
  const actionInstance = { instanceId: 'action-0001', actionId: 'prepaint.boot', adapterId: 'prepaint.boot/v1', actor: 'browser', arguments: scenario.arguments, bind: null };
  assert.deepEqual(await interpreter.materializeFixture({ fixtureRecord, actionInstance, artifact, policy: {} }), fixtureRecord);
  const tampered = structuredClone(fixtureRecord);
  tampered.stateDigest = '0'.repeat(64);
  await assert.rejects(interpreter.materializeFixture({ fixtureRecord: tampered, actionInstance, artifact, policy: {} }), /state or provenance digest mismatch/u);
});

test('host builder projects canonical boot fixture payloads without importing the product', () => {
  const scenario = registeredPrepaintScenario('prepaint-oversize-snapshot-kept');
  const seed = {
    schemaVersion: 'bug-dreamer/nightmare-seed/v1',
    catalogVersion: interpreter.descriptor.catalogVersion,
    id: 'prepaint-oversize-seed',
    invariantId: 'prepaint.utf8-size-pruned/v1',
    actors: ['browser'],
    actions: [{ actionId: 'prepaint.boot', actor: 'browser', arguments: scenario.arguments, bind: null }],
  };
  const spec = buildBenchmarkSpec(seed, interpreter.descriptor, artifact);
  assert.deepEqual(spec.fixtures.map((fixture) => fixture.canonicalWirePayload), [scenario.arguments.browser, scenario.arguments.indexeddb]);
  assert.deepEqual(spec.fixtures.map((fixture) => fixture.publicActionTrace), [['prepaint.boot'], ['prepaint.boot']]);
  assert.deepEqual(buildBenchmarkPlan(spec, interpreter.descriptor, artifact).fixtureSetup, spec.fixtures);
});

test('synthetic nominal smoke is self-contained, non-measurement, and accepted by the real oracle', async () => {
  const smoke = JSON.parse(await readFile(new URL('../contracts/v0.3/benchmark-smoke-prepaint.json', import.meta.url), 'utf8'));
  assert.equal(smoke.schemaVersion, 'bug-dreamer/v03-benchmark-smoke/v1');
  assert.equal(smoke.id, 'synthetic-prepaint-nominal');
  assert.equal(smoke.developmentOnly, true);
  assert.equal(smoke.measurementEligible, false);
  assert.equal(smoke.historicalTruthId, null);
  assert.equal(smoke.artifactRole, 'clean');
  assert.deepEqual(smoke.runtimePolicy, { virtualTime: { originMs: 1_000_000_000_000 } });
  assert.equal(smoke.preparationProbeRuns, 2);
  assert.equal(smoke.expectedClean.observedFields.value.payloadDigest, prepaintPayloadDigest(smoke.comparisonInput.indexeddb));
  assert.deepEqual(smoke.comparisonInput, smoke.seed.actions[0].arguments);
  assert.ok(interpreter.descriptor.comparisons.some((comparison) => comparison.id === smoke.comparisonRegistrationId));
  const spec = buildBenchmarkSpec(smoke.seed, interpreter.descriptor, artifact);
  const plan = buildBenchmarkPlan(spec, interpreter.descriptor, artifact);
  assert.equal(plan.virtualTime.originMs, smoke.runtimePolicy.virtualTime.originMs);
  const invariant = interpreter.descriptor.invariants.find((item) => item.id === smoke.invariantRegistrationId);
  const observation = { normalizedObservedKind: smoke.expectedClean.observedKind, normalizedObservedFields: smoke.expectedClean.observedFields };
  assert.deepEqual(interpreter.evaluateInvariant({ invariantRegistration: invariant, observation, plan }), smoke.expectedClean);
  assert.deepEqual(registeredPrepaintScenario(smoke.id).arguments, smoke.comparisonInput);
});

test('prepaint oracle follows the pinned contract rather than current product behavior', () => {
  const passing = [
    ['prepaint.exact-route/v1', { overlayMounted: false, dataPrepaint: false, present: false, payloadDigest: 'a'.repeat(64) }],
    ['prepaint.expired-pruned/v1', { overlayMounted: false, dataPrepaint: false, present: false, payloadDigest: 'b'.repeat(64) }],
    ['prepaint.utf8-size-pruned/v1', { overlayMounted: false, dataPrepaint: false, present: false, payloadDigest: 'c'.repeat(64) }],
    ['prepaint.absolute-routes/v1', { kind: 'thrown', name: 'Error', messageClass: 'absolute-pathname' }],
  ];
  for (const [invariantId, value] of passing) assert.equal(evaluatePrepaintObservation(invariantId, normalizeReturnedValue(value)).execution, 'pass');
  assert.equal(evaluatePrepaintObservation('prepaint.exact-route/v1', normalizeReturnedValue({ overlayMounted: true, dataPrepaint: true })).execution, 'candidate-failure');
  assert.equal(evaluatePrepaintObservation('prepaint.expired-pruned/v1', normalizeReturnedValue({ present: true })).execution, 'candidate-failure');
  assert.deepEqual(classifyPrepaintError(new Error('[FirstTx] Invalid prepaint policy: every route must be an absolute pathname')), { kind: 'thrown', name: 'Error', messageClass: 'absolute-pathname' });
});

test('oversize scenario is over its registered UTF-8 JSON threshold', () => {
  const scenario = registeredPrepaintScenario('prepaint-oversize-snapshot-kept');
  const snapshot = scenario.fixtureRegistrations[1].canonicalWirePayload.records[0];
  const bytes = Buffer.byteLength(JSON.stringify({ body: snapshot.body, styles: snapshot.styles }), 'utf8');
  assert.ok(bytes > scenario.arguments.policy.maxSnapshotBytes);
  assert.ok(bytes > JSON.stringify({ body: snapshot.body, styles: snapshot.styles }).length);
});
