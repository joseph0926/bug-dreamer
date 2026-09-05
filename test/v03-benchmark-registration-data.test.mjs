import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { registeredLocalFirstScenario } from '../harness-v0.3/benchmark/local-first-environment.mjs';
import { evaluateLocalFirstObservation, normalizeReturnedValue as normalizeLocalFirst } from '../harness-v0.3/benchmark/local-first-oracle.mjs';
import { registeredPrepaintScenario } from '../harness-v0.3/benchmark/prepaint-environment.mjs';
import { evaluatePrepaintObservation, normalizeReturnedValue as normalizePrepaint } from '../harness-v0.3/benchmark/prepaint-oracle.mjs';
import { evaluateTxResult, returnedObservation } from '../harness-v0.3/benchmark/tx-oracle.mjs';
import { buildBenchmarkPlan, buildBenchmarkSpec, validateBenchmarkSeed } from '../src/v03-benchmark-spec.mjs';
import { canonicalJson } from '../src/v03-wire.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
const digestFile = async (relativePath) => createHash('sha256').update(await readFile(path.join(root, relativePath))).digest('hex');

const [universe, inputs, truth, descriptors] = await Promise.all([
  readJson('benchmark/v0.3/universe.json'),
  readJson('benchmark/v0.3/comparison-inputs.json'),
  readJson('benchmark/v0.3/truth-commitments.json'),
  Promise.all(['tx', 'local-first', 'prepaint'].map(async (moduleId) => [moduleId, await readJson(`registrations/v0.3/benchmark/${moduleId}.json`)])),
]);
const descriptorByModule = new Map(descriptors);
const commitmentByTruth = new Map(truth.commitments.map((item) => [item.canonicalTruthId, item]));
const inputByRow = new Map(inputs.rows.map((item) => [item.rowId, item]));
const fakeArtifact = { role: 'clean', targetArtifactDigest: '0'.repeat(64), evaluationContractKey: '1'.repeat(64) };

test('Phase 4 universe freezes 20 audited rows, 15 metric and retention rows, one development diagnostic, and four blockers', async () => {
  assert.equal(universe.status, 'source-reviewed-unmeasured');
  assert.equal(universe.measurementState, 'not-started');
  assert.equal(universe.auditRows.length, 20);
  assert.equal(universe.metricEligibleTruthIds.length, 15);
  assert.equal(universe.retentionRows.length, 15);
  assert.deepEqual(universe.retentionRows.map((row) => row.canonicalTruthId), universe.metricEligibleTruthIds);
  assert.deepEqual(universe.developmentDiagnostics.map((row) => row.rowId), ['tx-total-timeout-resets-per-step']);
  assert.equal(universe.blockedRows.length, 4);
  assert.deepEqual(Object.fromEntries(universe.blockedRows.map((row) => [row.rowId, row.reasons])), {
    'tx-concurrent-step-guard-removed': ['oracle-implementation-only'],
    'local-first-history-change-not-reflected': ['missing-public-action', 'oracle-implementation-only'],
    'local-first-cache-unsubscribe-noop': ['oracle-strength-unreviewed'],
    'local-first-unsubscribe-removes-all': ['missing-public-action', 'oracle-strength-unreviewed'],
  });
  assert.equal(universe.runtimeOutcomeMayChangeMembership, false);
  assert.equal(await digestFile(universe.sources.inventory.path), universe.sources.inventory.sha256);
  assert.equal(await digestFile(universe.sources.adapterReview.path), '1f10b34fdf3e57f62b57673e55b5f6adeb7b8f7e5f66c1e10108069cbacf762c');
});

test('every retained row has one registered D/E input and one scorer-shaped source commitment', () => {
  assert.equal(inputs.status, 'source-reviewed-unmeasured');
  assert.equal(inputs.measurementState, 'not-started');
  assert.equal(inputs.rows.length, 15);
  assert.equal(truth.status, 'source-reviewed-unmeasured');
  assert.equal(truth.measurementState, 'not-started');
  assert.equal(truth.commitments.length, 15);
  assert.deepEqual([...inputByRow.keys()].sort(), universe.retentionRows.map((row) => row.rowId).sort());
  assert.deepEqual([...commitmentByTruth.keys()], universe.metricEligibleTruthIds);
  assert.deepEqual(Object.keys(truth.provenanceByCanonicalTruthId), universe.metricEligibleTruthIds);

  for (const retention of universe.retentionRows) {
    const input = inputByRow.get(retention.rowId);
    const commitment = commitmentByTruth.get(retention.canonicalTruthId);
    assert.equal(input.moduleId, retention.moduleId);
    assert.equal(commitment.moduleId, retention.moduleId);
    assert.equal(commitment.duplicateGroup, retention.duplicateGroup);
    assert.deepEqual(Object.keys(commitment).sort(), ['canonicalTruthId', 'duplicateGroup', 'expected', 'invariantRegistrationId', 'matcherId', 'moduleId']);
    assert.deepEqual(Object.keys(commitment.expected).sort(), ['normalizedObservedFields', 'normalizedObservedKind']);
    const descriptor = descriptorByModule.get(input.moduleId);
    assert.ok(descriptor.comparisons.some((item) => item.id === input.comparisonRegistrationId && item.invariantId === input.invariantRegistrationId));
    assert.ok(descriptor.invariants.some((item) => item.id === commitment.invariantRegistrationId));
    assert.equal(input.invariantRegistrationId, commitment.invariantRegistrationId);
    assert.ok(input.publicActionTrace.length > 0);
    assert.equal(canonicalJson(structuredClone(input.inputRecipe)), canonicalJson(input.inputRecipe), 'D/E canonical input identity must be stable');
  }
});

test('tx comparison recipes compile as data-only plans and committed defect observations are pure-oracle candidate failures', () => {
  const rawFields = {
    'tx-rollback-forward-order': { kind: 'thrown-error', message: 'trigger-rollback', attemptCount: 1, compensations: [
      { instanceId: 'action-0002', kind: 'return', errorMessage: null },
      { instanceId: 'action-0003', kind: 'return', errorMessage: null },
    ] },
    'tx-reuse-after-rollback-allowed': { kind: 'returned-value', value: 'must-not-run', attemptCount: 1, compensations: [] },
    'tx-compensation-errors-swallowed': { kind: 'thrown-error', name: 'Error', message: 'trigger-compensation', attemptCount: 1, compensations: [
      { instanceId: 'action-0003', kind: 'throw', errorMessage: 'undo-second' },
      { instanceId: 'action-0002', kind: 'return', errorMessage: null },
    ] },
    'tx-preaborted-signal-ignored': { kind: 'returned-value', value: 'must-not-run', attemptCount: 1, compensations: [] },
    'tx-commit-after-rollback-allowed': { kind: 'returned-value', value: null },
    'tx-retry-exhausted-drops-error-history': { kind: 'thrown-error', name: 'RetryExhaustedError', message: 'retry', attempts: 3, errorMessages: ['retry-three'], attemptCount: 3, compensations: [] },
    'tx-completed-steps-never-tracked': { kind: 'thrown-error', message: 'rollback', attemptCount: 1, compensations: [] },
    'tx-retry-skips-final-attempt': { kind: 'thrown-error', name: 'RetryExhaustedError', message: 'retry', attempts: 3, errorMessages: ['retry-one', 'retry-two'], attemptCount: 2, compensations: [] },
  };
  for (const row of inputs.rows.filter((item) => item.moduleId === 'tx')) {
    assert.equal(row.inputRecipe.kind, 'benchmark-seed');
    const descriptor = descriptorByModule.get('tx');
    assert.doesNotThrow(() => validateBenchmarkSeed(structuredClone(row.inputRecipe.seed), descriptor));
    const spec = buildBenchmarkSpec(structuredClone(row.inputRecipe.seed), descriptor, fakeArtifact);
    const plan = buildBenchmarkPlan(spec, descriptor, fakeArtifact);
    assert.deepEqual(plan.actions.map((action) => action.actionId), row.publicActionTrace);
    assert.equal(plan.virtualTime.originMs, 1000000000000);
    const invariant = descriptor.invariants.find((item) => item.id === row.invariantRegistrationId);
    const evaluation = evaluateTxResult(invariant, returnedObservation(rawFields[row.rowId]), plan);
    assert.equal(evaluation.execution, 'candidate-failure');
    assert.deepEqual({ normalizedObservedKind: evaluation.observedKind, normalizedObservedFields: evaluation.observedFields }, commitmentByTruth.get(row.rowId).expected);
  }
});

test('local-first and prepaint committed defect observations are fixed source inputs and pure-oracle candidate failures', () => {
  const localRaw = {
    'local-first-stale-flag-inverted': { updatedAt: 999999992000, age: 8000, isStale: false, isConflicted: false, ttlMs: 5000 },
    'local-first-error-not-notified': { notified: false, errorName: 'ValidationError' },
    'local-first-self-broadcast-not-filtered': { localMutationCallbacks: 1, callbackCountAfterPeerRelay: 1, senderSelfDeliveries: 0, peerReceipts: 1, peerRetransmissions: 1 },
  };
  for (const row of inputs.rows.filter((item) => item.moduleId === 'local-first')) {
    const scenario = registeredLocalFirstScenario(row.inputRecipe.registrationId);
    assert.equal(scenario.rowId, row.rowId);
    assert.deepEqual(scenario.actions.map((action) => action.actionId), row.publicActionTrace);
    assert.equal(scenario.clockMs, 1000000000000);
    const evaluated = evaluateLocalFirstObservation(row.invariantRegistrationId, normalizeLocalFirst(localRaw[row.rowId]));
    assert.equal(evaluated.execution, 'candidate-failure');
    assert.deepEqual({ normalizedObservedKind: evaluated.observedKind, normalizedObservedFields: evaluated.observedFields }, commitmentByTruth.get(row.rowId).expected);
  }

  const prepaintRaw = {
    'prepaint-route-prefix-overcapture': { overlayMounted: true, dataPrepaint: true, present: true, payloadDigest: '37248967bf40ea9c5ffb1e5a734b8a8bf71a5a8841143618750a88c3f5eed6a5' },
    'prepaint-expired-snapshot-kept': { overlayMounted: false, dataPrepaint: false, present: true, payloadDigest: '8de11d3469842d57fbaedf89f49e7a9037f9242742a3009625101abf2afcbd03' },
    'prepaint-oversize-snapshot-kept': { overlayMounted: true, dataPrepaint: true, present: true, payloadDigest: 'b4b0c3f5bb70a28a178ecbcd72d61b9513fc58655d5e8e1d9c81c3558dd66994' },
    'prepaint-relative-route-accepted': { kind: 'returned', name: 'vite-plugin-firsttx', messageClass: null },
  };
  for (const row of inputs.rows.filter((item) => item.moduleId === 'prepaint')) {
    const scenario = registeredPrepaintScenario(row.inputRecipe.registrationId);
    assert.equal(scenario.rowId, row.rowId);
    if (scenario.adapterId === 'prepaint.boot/v1') assert.equal(scenario.arguments.browser.clockMs, 1000000000000);
    const plan = { actions: [{ instanceId: 'action-0001', actionId: scenario.adapterId === 'prepaint.boot/v1' ? 'prepaint.boot' : 'prepaint.vite-create', arguments: scenario.arguments }] };
    const evaluated = evaluatePrepaintObservation(row.invariantRegistrationId, normalizePrepaint(prepaintRaw[row.rowId]), plan);
    assert.equal(evaluated.execution, 'candidate-failure');
    assert.deepEqual({ normalizedObservedKind: evaluated.observedKind, normalizedObservedFields: evaluated.observedFields }, commitmentByTruth.get(row.rowId).expected);
  }
});

test('local-first stale comparison reaches the planted public cache-history path in both D and E', async () => {
  const row = inputByRow.get('local-first-stale-flag-inverted');
  const scenario = registeredLocalFirstScenario(row.inputRecipe.registrationId);
  assert.deepEqual(scenario.actions.map((action) => action.actionId), ['local.define-model', 'local.storage-set', 'local.subscribe', 'local.get-cached-history']);
  assert.deepEqual(row.publicActionTrace, scenario.actions.map((action) => action.actionId));
  const [direct, interpreter] = await Promise.all([
    readFile(path.join(root, 'harness-v0.3/benchmark/local-first-direct.mjs'), 'utf8'),
    readFile(path.join(root, 'harness-v0.3/benchmark/local-first.mjs'), 'utf8'),
  ]);
  assert.match(direct, /async function compareStaleness[\s\S]*model\.subscribe[\s\S]*model\.getCachedHistory\(\)/u);
  assert.match(interpreter, /id === 'local\.subscribe\/v1'[\s\S]*model\.getCachedHistory\(\)[\s\S]*id === 'local\.get-cached-history\/v1'[\s\S]*environment\.callbackValue/u);
});

test('development timeout stays diagnostic-only and no registration data claims measured outcomes', () => {
  assert.deepEqual(inputs.developmentDiagnostics.map((row) => row.rowId), ['tx-total-timeout-resets-per-step']);
  assert.equal(inputs.developmentDiagnostics[0].metricEligible, false);
  assert.equal(inputs.developmentDiagnostics[0].retentionEligible, false);
  const serialized = canonicalJson({ universe, inputs, truth });
  assert.doesNotMatch(serialized, /"status":"(?:prepared|complete)"|"measurementState":"(?:started|complete)"/u);
  assert.doesNotMatch(canonicalJson(truth.provenanceByCanonicalTruthId), /evidence\/v0\.3/u);
});
