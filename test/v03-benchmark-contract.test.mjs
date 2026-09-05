import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PHASE4_APPROVED_BUDGETS,
  PHASE4_APPROVED_STATIC_POLICY_DIGEST,
  PHASE4_ARM_IDS,
  PHASE4_IO_SCHEMA_VERSIONS,
  PHASE4_MODULE_IDS,
  V03BenchmarkContractError,
  assertTrustedComparisonModuleImplementation,
  assertTrustedInterpreterModuleImplementation,
  loadPhase4Registration,
  phase4RegistrationReadiness,
  phase4StaticPolicyDigest,
  phase4ViolationIdentityDigest,
  validatePhase4BudgetLedger,
  validatePhase4MeasurementRow,
  validatePhase4Registration,
  validateTrustedModuleDescriptor,
} from '../src/v03-benchmark-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registration = JSON.parse(await readFile(path.join(repositoryRoot, 'benchmark/v0.3/registration.json')));
const cases = JSON.parse(await readFile(path.join(repositoryRoot, 'contracts/v0.3/benchmark-registration-cases.json')));

function mutate(base, pathParts, value) {
  const copy = structuredClone(base);
  let cursor = copy;
  for (const part of pathParts.slice(0, -1)) cursor = cursor[part];
  cursor[pathParts.at(-1)] = value;
  return copy;
}

function contractError(fragment) {
  return (error) => error instanceof V03BenchmarkContractError && error.message.includes(fragment);
}

test('loads the approved-unsealed registration and verifies every referenced digest', async () => {
  const loaded = await loadPhase4Registration(repositoryRoot);
  assert.equal(loaded.registration.status, 'approved-unsealed');
  assert.deepEqual(loaded.registration.readiness, phase4RegistrationReadiness(loaded.registration));
  assert.equal(loaded.registration.readiness.authoringReady, false);
  assert.equal(loaded.registration.readiness.measurementReady, false);
  assert.equal(loaded.inventory.rows.length, 20);
  assert.match(loaded.staticPolicyDigest, /^[0-9a-f]{64}$/u);
  assert.equal(loaded.staticPolicyDigest, phase4StaticPolicyDigest(loaded.registration));
  assert.equal(loaded.staticPolicyDigest, PHASE4_APPROVED_STATIC_POLICY_DIGEST);
  assert.deepEqual(PHASE4_ARM_IDS, ['G', 'P', 'A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(PHASE4_MODULE_IDS, ['tx', 'local-first', 'prepaint']);
  assert.equal(PHASE4_APPROVED_BUDGETS.measurement.dockerEvaluationMaximum, 460);
  assert.equal(PHASE4_IO_SCHEMA_VERSIONS.seed, 'bug-dreamer/nightmare-seed/v1');
});

test('registration validator rejects policy drift and unsupported state claims', () => {
  assert.equal(validatePhase4Registration(structuredClone(registration)).status, 'approved-unsealed');
  for (const item of cases.registrationMutations) {
    assert.throws(() => validatePhase4Registration(mutate(registration, item.path, item.value)), contractError(item.error), item.id);
  }
});

test('readiness separates Checkpoint A authoring from later measurement closure', () => {
  const staged = structuredClone(registration);
  staged.universe.metricEligibleRowIds = ['tx-rollback-forward-order'];
  staged.universe.retentionDenominatorRowIds = ['tx-rollback-forward-order'];
  staged.universe.adapterRegistrationIds = ['tx-benchmark-v1'];
  staged.universe.truthCommitmentRef = { path: 'benchmark/v0.3/truth-commitments.json', sha256: '9'.repeat(64) };
  staged.checkpoints.commitA = 'a'.repeat(40);
  staged.readiness = phase4RegistrationReadiness(staged);
  assert.equal(staged.readiness.authoringReady, true);
  assert.equal(staged.readiness.measurementReady, false);
  assert.deepEqual(staged.readiness.blockers, ['author-bundle-not-recorded', 'image-identities-not-recorded', 'checkpointB-not-recorded', 'sealed-ref-not-recorded', 'benchmark-epoch-id-not-derived']);
  assert.doesNotThrow(() => validatePhase4Registration(staged));
  assert.equal(phase4StaticPolicyDigest(staged), phase4StaticPolicyDigest(registration));

  staged.status = 'sealed';
  staged.authorBundle.manifestDigest = 'b'.repeat(64);
  staged.authorBundle.sessionRecordDigest = 'c'.repeat(64);
  staged.images.artifactFactoryImageId = 'd'.repeat(64);
  staged.images.evaluatorImageManifestDigest = 'e'.repeat(64);
  staged.images.evaluationContractKeysDigest = 'f'.repeat(64);
  staged.checkpoints.commitB = '1'.repeat(40);
  staged.checkpoints.sealedRef = 'refs/tags/v0.3-phase4-epoch-1';
  staged.benchmarkEpochId = '2'.repeat(64);
  staged.readiness = phase4RegistrationReadiness(staged);
  assert.equal(staged.readiness.measurementReady, true);
  assert.doesNotThrow(() => validatePhase4Registration(staged));
  assert.equal(phase4StaticPolicyDigest(staged), phase4StaticPolicyDigest(registration));
});

test('trusted module descriptor and independent entrypoint exports are strict', () => {
  const descriptor = cases.trustedModuleDescriptor;
  assert.equal(validateTrustedModuleDescriptor(structuredClone(descriptor)).id, descriptor.id);
  for (const item of cases.trustedModuleMutations) {
    assert.throws(() => validateTrustedModuleDescriptor(mutate(descriptor, item.path, item.value)), contractError(item.error), item.id);
  }
  for (const field of ['payloadArgumentPointer', 'publicActionTrace']) {
    const incomplete = structuredClone(descriptor);
    delete incomplete.fixtures[0][field];
    assert.throws(() => validateTrustedModuleDescriptor(incomplete), contractError('fields changed'), `reject-missing-${field}`);
  }
  const interpreter = Object.assign(Object.create(null), {
    descriptor,
    validateActionArguments() {},
    materializeFixture() {},
    executeAction() {},
    evaluateInvariant() {},
  });
  const comparison = Object.assign(Object.create(null), { descriptor, materializeComparison() {} });
  assert.equal(assertTrustedInterpreterModuleImplementation(interpreter), interpreter);
  assert.equal(assertTrustedComparisonModuleImplementation(comparison), comparison);
  assert.throws(() => assertTrustedInterpreterModuleImplementation({ ...interpreter, materializeComparison() {} }), contractError('fields changed'));
  assert.throws(() => assertTrustedComparisonModuleImplementation({ ...comparison, executeAction() {} }), contractError('fields changed'));

  const prepaint = structuredClone(descriptor);
  prepaint.id = 'prepaint-benchmark-v1';
  prepaint.moduleId = 'prepaint';
  prepaint.packageName = '@firsttx/prepaint';
  prepaint.importSpecifier = '@firsttx/prepaint';
  prepaint.actions[0].id = 'prepaint.vite-plugin-create';
  prepaint.actions[0].importSpecifier = '@firsttx/prepaint/plugin/vite';
  prepaint.fixtures[0].consumerActionId = 'prepaint.vite-plugin-create';
  assert.equal(validateTrustedModuleDescriptor(prepaint).moduleId, 'prepaint');
});

test('measurement rows preserve raw observations and reject inconsistent axes', () => {
  for (const row of Object.values(cases.measurementRows)) assert.equal(validatePhase4MeasurementRow(structuredClone(row)).inputId, row.inputId);
  for (const item of cases.measurementMutations) {
    assert.throws(() => validatePhase4MeasurementRow(mutate(cases.measurementRows[item.base], item.path, item.value)), contractError(item.error), item.id);
  }
  const missingObservation = mutate(cases.measurementRows.accepted, ['observation'], null);
  assert.throws(() => validatePhase4MeasurementRow(missingObservation), contractError('missing its raw normalized observation'));
  assert.match(phase4ViolationIdentityDigest({
    invariantRegistrationId: 'tx.example',
    normalizedObservedKind: 'returned-value',
    normalizedObservedFields: { value: true },
    targetArtifactDigest: 'e'.repeat(64),
  }), /^[0-9a-f]{64}$/u);
});

test('budget ledger accepts exact caps and rejects overruns', () => {
  assert.equal(validatePhase4BudgetLedger(structuredClone(cases.budgetLedger)).measurement.dockerEvaluations, 460);
  for (const item of cases.budgetMutations) {
    assert.throws(() => validatePhase4BudgetLedger(mutate(cases.budgetLedger, item.path, item.value)), contractError(item.error), item.id);
  }
});
