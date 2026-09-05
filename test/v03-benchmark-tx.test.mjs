import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateTrustedModuleDescriptor } from '../src/v03-benchmark-contract.mjs';
import { buildBenchmarkPlan, buildBenchmarkSpec } from '../src/v03-benchmark-spec.mjs';
import {
  TX_INVARIANT_PROJECTIONS,
  evaluateTxInvariant,
  evaluateTxResult,
  returnedObservation,
} from '../harness-v0.3/benchmark/tx-oracle.mjs';
import { validateActionArguments } from '../harness-v0.3/benchmark/tx-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const descriptor = JSON.parse(await readFile(path.join(root, 'registrations/v0.3/benchmark/tx.json')));

function action(adapterId, argumentsValue, overrides = {}) {
  return {
    instanceId: overrides.instanceId ?? 'action-0001',
    actionId: overrides.actionId ?? descriptor.actions.find((item) => item.adapterId === adapterId).id,
    adapterId,
    actor: 'client',
    arguments: argumentsValue,
    bind: overrides.bind ?? null,
  };
}

function plan(invariantId, actions) {
  const invariant = descriptor.invariants.find((item) => item.id === invariantId);
  return {
    schemaVersion: 'bug-dreamer/execution-plan/v1',
    specDigest: 'a'.repeat(64),
    targetRegistrationId: 'firsttx-public-packages-f624b09-v1',
    invariantRegistrationId: invariant.id,
    targetArtifactDigest: 'b'.repeat(64),
    evaluatorId: invariant.evaluatorId,
    normalizedObservedKind: invariant.normalizedObservedKind,
    observedFields: invariant.observedFields,
    actions,
    bindings: [],
    fixtureSetup: [],
    virtualTime: { originMs: 1000000000000 },
    scheduleControls: [],
  };
}

test('tx descriptor registers public D/E contracts while preserving static exclusions', async () => {
  assert.equal(validateTrustedModuleDescriptor(structuredClone(descriptor)).id, descriptor.id);
  assert.deepEqual(descriptor.actions.map((item) => item.adapterId), [
    'tx.start/v2',
    'tx.run-scripted/v2',
    'tx.commit/v2',
    'env.abort-controller/v1',
  ]);
  assert.equal(descriptor.invariants.length, 9);
  assert.equal(descriptor.comparisons.length, 10);
  assert.ok(descriptor.invariants.some((item) => item.id === 'tx.total-timeout/v1'));
  const preaborted = descriptor.invariants.find((item) => item.id === 'tx.preaborted-signal/v1');
  assert.equal(preaborted.strength, 'corroborating');
  assert.equal(preaborted.corroboratingRefs.length, 2);
  assert.ok(!descriptor.invariants.some((item) => item.id.includes('single-inflight')));

  const proposals = JSON.parse(await readFile(path.join(root, 'registrations/v0.3/benchmark/adapter-proposals.json')));
  assert.equal(proposals.rows.filter((row) => row.module === 'packages/tx').length, 10);
  assert.equal(proposals.rows.find((row) => row.id === 'tx-concurrent-step-guard-removed').metricEligibilityRecommendation, 'blocked');
});

test('synthetic tx smoke is self-contained, nominal, and outside the historical truth universe', async () => {
  const smoke = JSON.parse(await readFile(path.join(root, 'contracts/v0.3/benchmark-smoke-tx.json')));
  const proposals = JSON.parse(await readFile(path.join(root, 'registrations/v0.3/benchmark/adapter-proposals.json')));
  assert.equal(smoke.developmentOnly, true);
  assert.equal(smoke.measurementEligible, false);
  assert.equal(smoke.historicalTruthId, null);
  assert.equal(smoke.artifactRole, 'clean');
  assert.equal(smoke.sourceCommit, 'f624b09f148c3368a51807f48d3237db20cef9c6');
  assert.equal(smoke.preparationProbeRuns, 2);
  assert.ok(!proposals.rows.some((row) => row.id === smoke.id || row.id === smoke.seed.id));
  assert.ok(descriptor.comparisons.some((item) => item.id === smoke.comparisonRegistrationId
    && item.invariantId === smoke.invariantRegistrationId));

  const artifact = {
    role: smoke.artifactRole,
    targetArtifactDigest: smoke.comparisonInput.fixtureSetup[0].producerArtifact.targetArtifactDigest,
    evaluationContractKey: '0c08c61bbef849abb799afffb717e72779b3a7427165389e475326061b67064f',
  };
  const spec = buildBenchmarkSpec(structuredClone(smoke.seed), descriptor, artifact);
  const builtPlan = buildBenchmarkPlan(spec, descriptor, artifact);
  assert.deepEqual(smoke.comparisonInput, {
    actions: builtPlan.actions,
    fixtureSetup: builtPlan.fixtureSetup,
    virtualTime: builtPlan.virtualTime,
    scheduleControls: builtPlan.scheduleControls,
  });
  assert.deepEqual(smoke.runtimePolicy.virtualTime, builtPlan.virtualTime);
  const rawObservation = returnedObservation({
    kind: 'returned-value',
    value: { receipt: 'synthetic-nominal-7321' },
    attemptCount: 2,
    compensations: [],
  });
  assert.deepEqual(
    evaluateTxResult(
      descriptor.invariants.find((item) => item.id === smoke.invariantRegistrationId),
      rawObservation,
      builtPlan,
    ),
    smoke.expectedClean,
  );
});

test('pure tx schema validator enforces exact arguments, bounds, and typed bindings', () => {
  const bindings = new Map([['transaction', 'tx-handle'], ['signal', 'abort-signal']]);
  const run = action('tx.run-scripted/v2', {
    tx: { $binding: 'transaction' },
    attemptOutcomes: [
      { kind: 'throw', errorName: 'Error', errorMessage: 'temporary' },
      { kind: 'return', value: { ok: true } },
    ],
    retry: { maxAttempts: 2, delayMs: 10, backoff: 'linear' },
    compensation: { kind: 'return' },
    externalSignal: { $binding: 'signal' },
    gate: null,
  });
  assert.doesNotThrow(() => validateActionArguments({ action: run, bindings, policy: {} }));

  const extra = structuredClone(run);
  extra.arguments.command = 'node generated.js';
  assert.throws(() => validateActionArguments({ action: extra, bindings, policy: {} }), /fields changed/u);
  const oversized = structuredClone(run);
  oversized.arguments.retry.delayMs = 1001;
  assert.throws(() => validateActionArguments({ action: oversized, bindings, policy: {} }), /delayMs/u);
  const forgedInfrastructure = structuredClone(run);
  forgedInfrastructure.arguments.attemptOutcomes[0].errorName = 'EvaluatorInfrastructureError';
  assert.throws(() => validateActionArguments({ action: forgedInfrastructure, bindings, policy: {} }), /allow-listed/u);
  assert.throws(() => validateActionArguments({ action: run, bindings: new Map([['transaction', 'abort-signal'], ['signal', 'abort-signal']]), policy: {} }), /wrong type/u);
});

test('pure tx oracle evaluates retry and compensation semantics independently of execution', () => {
  const start = action('tx.start/v2', { transactionId: 'synthetic', timeoutMs: 2000, transition: false }, {
    instanceId: 'action-0001',
    bind: { name: 'transaction', type: 'tx-handle' },
  });
  const first = action('tx.run-scripted/v2', {
    tx: { $binding: 'transaction' }, attemptOutcomes: [{ kind: 'return', value: 1 }], retry: null,
    compensation: { kind: 'return' }, externalSignal: null, gate: null,
  }, { instanceId: 'action-0002' });
  const second = action('tx.run-scripted/v2', {
    tx: { $binding: 'transaction' }, attemptOutcomes: [{ kind: 'return', value: 2 }], retry: null,
    compensation: { kind: 'throw', errorName: 'Error', errorMessage: 'undo-two' }, externalSignal: null, gate: null,
  }, { instanceId: 'action-0003' });
  const failure = action('tx.run-scripted/v2', {
    tx: { $binding: 'transaction' }, attemptOutcomes: [{ kind: 'throw', errorName: 'Error', errorMessage: 'stop' }], retry: null,
    compensation: null, externalSignal: null, gate: null,
  }, { instanceId: 'action-0004' });
  const compensationPlan = plan('tx.compensation-failure/v1', [start, first, second, failure]);
  const observed = returnedObservation({
    kind: 'thrown-error', name: 'CompensationFailedError', message: 'Compensation failed', attemptCount: 1,
    failureCount: 1, failureMessages: ['undo-two'], completedSteps: 2,
    compensations: [
      { instanceId: 'action-0003', kind: 'throw', errorMessage: 'undo-two' },
      { instanceId: 'action-0002', kind: 'return', errorMessage: null },
    ],
  });
  assert.equal(evaluateTxInvariant('tx.compensation-failure/v1', observed, compensationPlan).passed, true);
  assert.deepEqual(evaluateTxResult(descriptor.invariants.find((item) => item.id === 'tx.compensation-failure/v1'), observed, compensationPlan), {
    execution: 'pass',
    observedKind: 'returned-value',
    observedFields: {
      value: {
        kind: 'thrown-error',
        name: 'CompensationFailedError',
        failureCount: 1,
        failureMessages: ['undo-two'],
        completedSteps: 2,
        compensations: [
          { instanceId: 'action-0003', kind: 'throw', errorMessage: 'undo-two' },
          { instanceId: 'action-0002', kind: 'return', errorMessage: null },
        ],
      },
    },
  });

  const wrongOrder = structuredClone(observed);
  wrongOrder.normalizedObservedFields.value.failureMessages = ['undo-one'];
  assert.equal(evaluateTxInvariant('tx.compensation-failure/v1', wrongOrder, compensationPlan).passed, false);

  const retry = action('tx.run-scripted/v2', {
    tx: { $binding: 'transaction' },
    attemptOutcomes: [
      { kind: 'throw', errorName: 'Error', errorMessage: 'one' },
      { kind: 'throw', errorName: 'TypeError', errorMessage: 'two' },
    ],
    retry: { maxAttempts: 2, delayMs: 1, backoff: 'linear' }, compensation: null, externalSignal: null, gate: null,
  }, { instanceId: 'action-0002' });
  const retryPlan = plan('tx.retry-error-history/v1', [start, retry]);
  const retryObservation = returnedObservation({
    kind: 'thrown-error', name: 'RetryExhaustedError', message: 'retry', attemptCount: 2,
    attempts: 2, errorMessages: ['one', 'two'], compensations: [],
  });
  assert.equal(evaluateTxInvariant('tx.retry-error-history/v1', retryObservation, retryPlan).passed, true);
  assert.deepEqual(TX_INVARIANT_PROJECTIONS['tx.retry-error-history/v1'], ['kind', 'name', 'attempts', 'errorMessages', 'attemptCount']);
  assert.ok(!TX_INVARIANT_PROJECTIONS['tx.retry-error-history/v1'].includes('message'));
  assert.deepEqual(TX_INVARIANT_PROJECTIONS['tx.rollback-reverse-order/v1'], ['kind', 'compensations']);
  assert.deepEqual(TX_INVARIANT_PROJECTIONS['tx.completed-steps-compensated/v1'], ['kind', 'compensations']);

  const reusePlan = plan('tx.no-run-after-rollback/v1', [start, failure]);
  const unexpectedReturn = returnedObservation({ kind: 'returned-value', value: 'must-not-run', attemptCount: 1, compensations: [] });
  assert.deepEqual(
    evaluateTxResult(descriptor.invariants.find((item) => item.id === 'tx.no-run-after-rollback/v1'), unexpectedReturn, reusePlan),
    {
      execution: 'candidate-failure',
      observedKind: 'returned-value',
      observedFields: { value: { kind: 'returned-value', name: null, currentState: null, attemptedAction: null, attemptCount: 1 } },
    },
  );
});

test('D and E entrypoints keep exact exports and independent import closures', async () => {
  const [interpreter, direct, oracle, schema] = await Promise.all([
    readFile(path.join(root, 'harness-v0.3/benchmark/tx.mjs'), 'utf8'),
    readFile(path.join(root, 'harness-v0.3/benchmark/tx-direct.mjs'), 'utf8'),
    readFile(path.join(root, 'harness-v0.3/benchmark/tx-oracle.mjs'), 'utf8'),
    readFile(path.join(root, 'harness-v0.3/benchmark/tx-schema.mjs'), 'utf8'),
  ]);
  const exported = (source) => [...source.matchAll(/^export (?:async )?(?:const|function) ([A-Za-z0-9_]+)/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(exported(interpreter), ['descriptor', 'evaluateInvariant', 'executeAction', 'materializeFixture', 'validateActionArguments']);
  assert.deepEqual(exported(direct), ['descriptor', 'materializeComparison']);
  assert.deepEqual(exported(schema), ['validateActionArguments']);
  assert.doesNotMatch(direct, /(?:tx\.mjs|benchmark-spec|execution-plan|interpreter)/u);
  assert.doesNotMatch(interpreter, /tx-direct/u);
  assert.doesNotMatch(oracle, /v03-spec|v03-benchmark-spec|tx\.mjs|tx-direct/u);
  assert.match(interpreter, /from '@firsttx\/tx'/u);
  assert.match(direct, /from '@firsttx\/tx'/u);
  assert.match(interpreter, /materializeFixture\(\{ fixtureRecord, actionInstance, artifact, policy \}\)/u);
  assert.match(direct, /materializeComparison\(\{ comparisonRegistration, row, artifact, policy, runtime \}\)/u);
  assert.doesNotMatch(oracle, /planDigest|specDigest|payloadDigest|violationIdentity/u);
});
