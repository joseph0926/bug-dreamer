import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PLAN_SCHEMA_VERSION, SEED_SCHEMA_VERSION, SPEC_SCHEMA_VERSION } from './v03-spec.mjs';
import { EXECUTION_BUDGET, RESULT_SCHEMA_VERSION } from './v03-trust.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

export const PHASE4_REGISTRATION_PATH = 'benchmark/v0.3/registration.json';
export const PHASE4_POLICY_DRAFT_PATH = 'benchmark/v0.3/phase4-policy.draft.json';
export const PHASE4_INVENTORY_PATH = 'benchmark/v0.3/phase4-inventory.draft.json';
export const PHASE4_REGISTRATION_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-registration/v1';
export const PHASE4_MODULE_INTERFACE_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-module-interface/v1';
export const PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-measurement-row/v1';
export const PHASE4_BUDGET_LEDGER_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-budget-ledger/v1';
export const PHASE4_STATIC_POLICY_DOMAIN = 'bug-dreamer/v03-benchmark-static-policy/v1';
export const PHASE4_VIOLATION_IDENTITY_DOMAIN = 'bug-dreamer/v03-benchmark-violation-identity/v1';
export const PHASE4_APPROVED_STATIC_POLICY_DIGEST = '4e1a92788ea6309d7075fafd20d636e479fcdd3d5352e787d80459375aa36701';
export const PHASE4_ARM_IDS = Object.freeze(['G', 'P', 'A', 'B', 'C', 'D', 'E']);
export const PHASE4_MODULE_IDS = Object.freeze(['tx', 'local-first', 'prepaint']);
export const PHASE4_MODULES = Object.freeze({
  tx: Object.freeze({ packageName: '@firsttx/tx', importSpecifier: '@firsttx/tx', allowedImportSpecifiers: Object.freeze(['@firsttx/tx']) }),
  'local-first': Object.freeze({ packageName: '@firsttx/local-first', importSpecifier: '@firsttx/local-first', allowedImportSpecifiers: Object.freeze(['@firsttx/local-first']) }),
  prepaint: Object.freeze({ packageName: '@firsttx/prepaint', importSpecifier: '@firsttx/prepaint', allowedImportSpecifiers: Object.freeze(['@firsttx/prepaint', '@firsttx/prepaint/plugin/vite']) }),
});
export const PHASE4_IO_SCHEMA_VERSIONS = Object.freeze({
  seed: SEED_SCHEMA_VERSION,
  spec: SPEC_SCHEMA_VERSION,
  plan: PLAN_SCHEMA_VERSION,
  trustedResult: RESULT_SCHEMA_VERSION,
  moduleInterface: PHASE4_MODULE_INTERFACE_SCHEMA_VERSION,
  measurementRow: PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION,
  budgetLedger: PHASE4_BUDGET_LEDGER_SCHEMA_VERSION,
});
export const PHASE4_APPROVED_BUDGETS = Object.freeze({
  evaluation: Object.freeze({
    timeoutMs: EXECUTION_BUDGET.evaluationTimeoutMs,
    stdoutLimitBytes: EXECUTION_BUDGET.stdoutLimitBytes,
    stderrLimitBytes: EXECUTION_BUDGET.stderrLimitBytes,
    recordedOutputBytes: EXECUTION_BUDGET.recordedOutputBytes,
  }),
  operatorRequestsPerPSeedPerArm: 1,
  initialDockerEvaluations: Object.freeze({
    perGenerationOrOperatorArm: 46,
    generationOrOperatorArmCount: 5,
    perRetentionArm: 40,
    retentionArmCount: 2,
    maximum: 310,
  }),
  replay: Object.freeze({
    generationOrOperatorCandidateMaximumPerArm: 2,
    generationOrOperatorArmCount: 5,
    generationOrOperatorCandidateMaximum: 10,
    DMaximum: 0,
    EMaximum: 20,
    candidateMaximum: 30,
    separateRunsPerCandidate: 5,
    dockerEvaluationMaximum: 150,
  }),
  measurement: Object.freeze({
    dockerEvaluationMaximum: 460,
    timeoutSecondsMaximum: 13800,
    monotonicWallClockSecondsMaximum: 18000,
  }),
  preparation: Object.freeze({
    separateFromMeasurement: true,
    dockerBuildMaximum: 24,
    dockerInspectOrProbeMaximum: 72,
    failedAttemptMaximum: 0,
    monotonicWallClockSecondsMaximum: 7200,
    recordedCounters: Object.freeze(['builds', 'inspects', 'probeContainers', 'failures', 'cleanups', 'cleanupFailures', 'elapsedSeconds']),
  }),
});

const TARGET_REVISION = 'f624b09f148c3368a51807f48d3237db20cef9c6';
const APPROVED_STATUS = 'approved-unsealed';
const SEALED_STATUS = 'sealed';
const EXPECTED_BLOCKERS = Object.freeze([
  'metric-eligible-row-ids-not-frozen',
  'retention-denominator-row-ids-not-frozen',
  'adapter-registration-ids-not-frozen',
  'truth-commitment-not-frozen',
  'checkpointA-not-recorded',
  'author-bundle-not-recorded',
  'image-identities-not-recorded',
  'checkpointB-not-recorded',
  'sealed-ref-not-recorded',
  'benchmark-epoch-id-not-derived',
]);
const EXPECTED_ARM_PATHS = Object.freeze([
  ['G', 'fresh-G-seeds', 'identity-interpreter'],
  ['P', 'fresh-P-seeds', 'identity-interpreter'],
  ['A', 'frozen-P-seeds', 'time.advance/v1'],
  ['B', 'frozen-P-seeds', 'schedule.release-order/v1'],
  ['C', 'frozen-P-seeds', 'fault.step-outcome/v1'],
  ['D', 'retention-denominator-rows', 'trusted-comparison'],
  ['E', 'retention-denominator-rows', 'trusted-interpreter'],
]);
const VERDICT_ORDER = Object.freeze([
  'epoch-abort',
  'non-repairable-trust-failure-retire',
  'incomplete-or-zero-denominator-or-coverage-gap-or-normal-budget-exhaustion-or-high-infrastructure-rate-or-clean-regression-or-repairable-issue-revise',
  'strategy-adopt',
  'sufficient-counterevidence-retire',
  'otherwise-revise',
]);
const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion', 'status', 'approvedOn', 'requiresUserCheckpoints', 'target', 'sourceArtifacts', 'universe', 'arms',
  'generation', 'budgets', 'pairing', 'observations', 'metrics', 'truthTable', 'verdicts', 'review', 'fastCheck',
  'trustedModuleInterface', 'executionOrder', 'checkpoints', 'authorBundle', 'images', 'benchmarkEpochId', 'readiness',
]);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const SHA_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/u;
const IMMUTABLE_REF_PATTERN = /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export class V03BenchmarkContractError extends Error {}

function fail(message) {
  throw new V03BenchmarkContractError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictKeys(value, keys, label) {
  assert(isObject(value), `${label} must be an object`);
  assert(canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `${label} fields changed`);
}

function equal(value, expected, message) {
  assert(canonicalJson(value) === canonicalJson(expected), message);
}

function validSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function staticPolicyDigestUnchecked(registration) {
  const { status, readiness, checkpoints, authorBundle, images, benchmarkEpochId, universe, ...approvedPolicy } = registration;
  const { metricEligibleRowIds, retentionDenominatorRowIds, adapterRegistrationIds, truthCommitmentRef, ...staticUniverse } = universe;
  return domainDigest(PHASE4_STATIC_POLICY_DOMAIN, { ...approvedPolicy, universe: staticUniverse });
}

function safeRelativePath(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} path is missing`);
  assert(!path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0'), `${label} path is unsafe`);
  const normalized = path.posix.normalize(value);
  assert(normalized === value && normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes the repository`);
}

function validateDigestRef(value, label) {
  strictKeys(value, ['path', 'sha256'], label);
  safeRelativePath(value.path, label);
  assert(validSha(value.sha256), `${label} digest is invalid`);
}

function validateStringMap(value, keys, label) {
  strictKeys(value, keys, label);
  for (const key of keys) assert(typeof value[key] === 'string' && value[key].length > 0, `${label}.${key} is invalid`);
}

export function phase4RegistrationReadiness(registration) {
  const authoringBlockers = [];
  if (registration.universe.metricEligibleRowIds === null) authoringBlockers.push('metric-eligible-row-ids-not-frozen');
  if (registration.universe.retentionDenominatorRowIds === null) authoringBlockers.push('retention-denominator-row-ids-not-frozen');
  if (registration.universe.adapterRegistrationIds === null) authoringBlockers.push('adapter-registration-ids-not-frozen');
  if (registration.universe.truthCommitmentRef === null) authoringBlockers.push('truth-commitment-not-frozen');
  if (registration.checkpoints.commitA === null) authoringBlockers.push('checkpointA-not-recorded');
  const measurementBlockers = [...authoringBlockers];
  if (registration.authorBundle.manifestDigest === null || registration.authorBundle.sessionRecordDigest === null) measurementBlockers.push('author-bundle-not-recorded');
  if (Object.values(registration.images).some((value) => value === null)) measurementBlockers.push('image-identities-not-recorded');
  if (registration.checkpoints.commitB === null) measurementBlockers.push('checkpointB-not-recorded');
  if (registration.checkpoints.sealedRef === null) measurementBlockers.push('sealed-ref-not-recorded');
  if (registration.benchmarkEpochId === null) measurementBlockers.push('benchmark-epoch-id-not-derived');
  return Object.freeze({
    authoringReady: authoringBlockers.length === 0,
    measurementReady: measurementBlockers.length === 0,
    blockers: Object.freeze(measurementBlockers),
  });
}

function validateOptionalIdArray(value, label) {
  if (value === null) return;
  assert(Array.isArray(value) && value.length > 0, `${label} must be null or a non-empty array`);
  assert(value.every(validId) && new Set(value).size === value.length, `${label} IDs are invalid or duplicated`);
}

function validateOptionalSha256(value, label) {
  assert(value === null || validSha(value), `${label} must be null or a SHA-256 digest`);
}

function validateOptionalGitOid(value, label) {
  assert(value === null || (typeof value === 'string' && GIT_OID_PATTERN.test(value)), `${label} must be null or a full Git object ID`);
}

function validateOptionalImmutableRef(value, label) {
  assert(value === null || (typeof value === 'string' && IMMUTABLE_REF_PATTERN.test(value)), `${label} must be null or an immutable tag ref`);
}

export function validatePhase4Registration(registration) {
  strictKeys(registration, TOP_LEVEL_KEYS, 'Phase 4 registration');
  assert(registration.schemaVersion === PHASE4_REGISTRATION_SCHEMA_VERSION, 'Unexpected Phase 4 registration schemaVersion');
  assert([APPROVED_STATUS, SEALED_STATUS].includes(registration.status), 'Phase 4 registration status is invalid');
  assert(registration.approvedOn === '2026-09-05' && registration.requiresUserCheckpoints === true, 'Phase 4 approval metadata changed');

  strictKeys(registration.target, ['registrationPath', 'registrationSha256', 'revision', 'moduleOrder'], 'Phase 4 target');
  safeRelativePath(registration.target.registrationPath, 'Target registration');
  assert(validSha(registration.target.registrationSha256), 'Target registration digest is invalid');
  assert(registration.target.revision === TARGET_REVISION, 'Phase 4 target revision changed');
  equal(registration.target.moduleOrder, PHASE4_MODULE_IDS, 'Phase 4 module order changed');

  strictKeys(registration.sourceArtifacts, ['approvedPolicyDraft', 'inventoryDraft', 'phase3'], 'Phase 4 source artifacts');
  validateDigestRef(registration.sourceArtifacts.approvedPolicyDraft, 'Approved policy draft');
  strictKeys(registration.sourceArtifacts.inventoryDraft, ['path', 'sha256', 'rowCount', 'moduleDistribution', 'currentInterpreterSupportedRows', 'historicalKnownClaims'], 'Inventory draft reference');
  safeRelativePath(registration.sourceArtifacts.inventoryDraft.path, 'Inventory draft');
  assert(validSha(registration.sourceArtifacts.inventoryDraft.sha256), 'Inventory draft digest is invalid');
  assert(registration.sourceArtifacts.inventoryDraft.rowCount === 20, 'Inventory must retain 20 rows');
  equal(registration.sourceArtifacts.inventoryDraft.moduleDistribution, { tx: 10, 'local-first': 6, prepaint: 4 }, 'Inventory module distribution changed');
  assert(registration.sourceArtifacts.inventoryDraft.currentInterpreterSupportedRows === 1 && registration.sourceArtifacts.inventoryDraft.historicalKnownClaims === true, 'Inventory status claim changed');
  const phase3 = registration.sourceArtifacts.phase3;
  strictKeys(phase3, ['verdict', 'spikeRegistration', 'spikeEvidence', 'reductionRegistration', 'reductionEvidence', 'cleanEvaluationContractKey', 'defectEvaluationContractKey', 'scoreContribution'], 'Phase 3 reference');
  for (const key of ['spikeRegistration', 'spikeEvidence', 'reductionRegistration', 'reductionEvidence']) validateDigestRef(phase3[key], `Phase 3 ${key}`);
  assert(phase3.verdict === 'adopt' && validSha(phase3.cleanEvaluationContractKey) && validSha(phase3.defectEvaluationContractKey) && phase3.scoreContribution === false, 'Phase 3 reference is invalid');

  strictKeys(registration.universe, ['auditInventoryPath', 'development', 'existingPublic', 'heldOutTemporal', 'heldOutClaimsAllowed', 'metricEligibleRowIds', 'retentionDenominatorRowIds', 'adapterRegistrationIds', 'truthCommitmentRef', 'freezeBefore', 'postCheckpointDenominatorDeletionForbidden'], 'Phase 4 universe');
  safeRelativePath(registration.universe.auditInventoryPath, 'Audit inventory');
  assert(Array.isArray(registration.universe.development) && Array.isArray(registration.universe.existingPublic) && Array.isArray(registration.universe.heldOutTemporal), 'Universe partitions must be arrays');
  assert(registration.universe.development.length === 1 && registration.universe.development[0] === 'tx-total-timeout-resets-per-step', 'Development universe changed');
  assert(registration.universe.existingPublic.length === 19 && registration.universe.heldOutTemporal.length === 0 && registration.universe.heldOutClaimsAllowed === false, 'Historical or held-out universe changed');
  validateOptionalIdArray(registration.universe.metricEligibleRowIds, 'Metric-eligible rows');
  validateOptionalIdArray(registration.universe.retentionDenominatorRowIds, 'Retention-denominator rows');
  validateOptionalIdArray(registration.universe.adapterRegistrationIds, 'Adapter registrations');
  if (registration.universe.truthCommitmentRef !== null) validateDigestRef(registration.universe.truthCommitmentRef, 'Truth commitment');
  assert(registration.universe.freezeBefore === 'checkpointA' && registration.universe.postCheckpointDenominatorDeletionForbidden === true, 'Universe freeze policy changed');

  assert(Array.isArray(registration.arms) && registration.arms.length === PHASE4_ARM_IDS.length, 'Phase 4 arm count changed');
  equal(registration.arms.map((item) => [item.id, item.inputSet, item.executionPath]), EXPECTED_ARM_PATHS, 'Phase 4 arm mapping changed');
  for (const arm of registration.arms) {
    strictKeys(arm, ['id', 'procedure', 'inputSet', 'executionPath'], `Arm ${arm.id}`);
    assert(PHASE4_ARM_IDS.includes(arm.id) && typeof arm.procedure === 'string' && arm.procedure.length > 0, `Arm ${arm.id} is invalid`);
  }

  strictKeys(registration.generation, ['model', 'reasoningEffort', 'freshSessions', 'submittedTaskTurnsPerSession', 'seedMaximumPerModulePerArm', 'seedMaximumPerArm', 'replacementAfterRejection', 'unavailableCounters', 'unavailableCounterReason'], 'Generation policy');
  assert(registration.generation.model === 'gpt-5.6-sol' && registration.generation.reasoningEffort === 'medium', 'Generation model policy changed');
  equal(registration.generation.freshSessions, { G: 1, P: 1 }, 'Generation session budget changed');
  assert(registration.generation.submittedTaskTurnsPerSession === 1 && registration.generation.seedMaximumPerModulePerArm === 2 && registration.generation.seedMaximumPerArm === 6 && registration.generation.replacementAfterRejection === false, 'Generation visible budget changed');
  strictKeys(registration.generation.unavailableCounters, ['internalModelCalls', 'inputTokens', 'outputTokens'], 'Unavailable generation counters');
  assert(Object.values(registration.generation.unavailableCounters).every((value) => value === null) && typeof registration.generation.unavailableCounterReason === 'string', 'Unavailable counters must remain null with a reason');
  equal(registration.budgets, PHASE4_APPROVED_BUDGETS, 'Phase 4 budgets changed');

  strictKeys(registration.pairing, ['artifactSpecificSpecAndPlan', 'specAndPlanDigestsMayDiffer', 'knownSinglePatchFtoPUsesInitialPair', 'extraPatchArtifactAllowed', 'cleanResultShareRequires', 'rejectedSeedReplacementAllowed'], 'Pairing policy');
  assert(registration.pairing.artifactSpecificSpecAndPlan === true && registration.pairing.specAndPlanDigestsMayDiffer === true && registration.pairing.knownSinglePatchFtoPUsesInitialPair === true && registration.pairing.extraPatchArtifactAllowed === false && registration.pairing.rejectedSeedReplacementAllowed === false, 'Artifact pairing policy changed');
  assert(Array.isArray(registration.pairing.cleanResultShareRequires) && registration.pairing.cleanResultShareRequires.length === 8, 'Clean-result sharing policy changed');

  validateStringMap(registration.observations, ['rawTwoSidedCandidate', 'replayConfirmedCatch', 'D', 'E'], 'Observation policy');
  strictKeys(registration.metrics, ['zeroDenominator', 'rawTwoSidedCandidateRate', 'replayConfirmedCatchRate', 'validBugYieldPerAcceptedSeed', 'falseOracleRate', 'fiveOfFiveRate', 'operatorIncrementalYield', 'operatorApplicabilityRate', 'interpreterRetention', 'unrunnableRate', 'budgetUtilization'], 'Metric policy');
  assert(registration.metrics.zeroDenominator === 'not-applicable', 'Zero-denominator policy changed');
  for (const [key, value] of Object.entries(registration.metrics)) assert(typeof value === 'string' && value.length > 0, `Metric ${key} is invalid`);
  strictKeys(registration.truthTable, ['rawRequires', 'confirmedRequires', 'retainedNonSuccessStates', 'operatorBaselineGuard', 'retentionDenominatorMutation'], 'Truth table');
  assert(registration.truthTable.rawRequires.length === 3 && registration.truthTable.confirmedRequires.length === 2 && registration.truthTable.retentionDenominatorMutation === 'forbidden-after-checkpointA', 'Truth table changed');

  strictKeys(registration.verdicts, ['firstMatchOrder', 'generationProcedure', 'interpreterPipeline', 'operatorStrategy'], 'Verdict policy');
  equal(registration.verdicts.firstMatchOrder, VERDICT_ORDER, 'Verdict first-match order changed');
  for (const key of ['generationProcedure', 'interpreterPipeline', 'operatorStrategy']) validateStringMap(registration.verdicts[key], ['adopt', 'retire', 'otherwise'], `${key} verdict`);
  strictKeys(registration.review, ['independentEligibilityReview', 'finalHumanVerdictOwner', 'userSheetArmMasked', 'rowOrder', 'unmaskAfterVerdict', 'undecidedTreatment'], 'Review policy');
  assert(registration.review.finalHumanVerdictOwner === 'user' && registration.review.userSheetArmMasked === true && registration.review.unmaskAfterVerdict === true, 'Human review policy changed');
  equal(registration.fastCheck, { status: 'disabled-outside-approved-policy', arm: null, budget: 0 }, 'fast-check policy changed');

  strictKeys(registration.trustedModuleInterface, ['schemaVersion', 'descriptorPathPattern', 'interpreterEntrypointPattern', 'comparisonEntrypointPattern', 'sharedOraclePattern', 'schemaEntrypointPattern', 'schemaRequiredExport', 'interpreterExports', 'comparisonExports', 'allowedSharedImports', 'forbiddenCrossImports', 'existingPhase2SpecPathModified', 'futureBenchmarkSpecPath', 'resealRule'], 'Trusted module interface policy');
  assert(registration.trustedModuleInterface.schemaVersion === PHASE4_MODULE_INTERFACE_SCHEMA_VERSION && registration.trustedModuleInterface.existingPhase2SpecPathModified === false, 'Trusted module interface policy changed');
  equal(registration.trustedModuleInterface.interpreterExports, ['descriptor', 'validateActionArguments', 'materializeFixture', 'executeAction', 'evaluateInvariant'], 'Trusted interpreter exports changed');
  equal(registration.trustedModuleInterface.comparisonExports, ['descriptor', 'materializeComparison'], 'Trusted comparison exports changed');
  assert(registration.trustedModuleInterface.schemaEntrypointPattern === 'harness-v0.3/benchmark/<module-id>-schema.mjs' && registration.trustedModuleInterface.schemaRequiredExport === 'validateActionArguments', 'Trusted schema entrypoint changed');
  equal(registration.trustedModuleInterface.allowedSharedImports, ['oracle', 'normalizer', 'result-serializer', 'canonicalizer', 'environment-primitive'], 'Trusted shared-import boundary changed');
  equal(registration.trustedModuleInterface.forbiddenCrossImports, ['comparison-entrypoint-imports-spec-plan-or-interpreter', 'interpreter-entrypoint-imports-direct-materializer'], 'Trusted cross-import boundary changed');

  strictKeys(registration.executionOrder, ['arms', 'modules', 'withinModule', 'duplicates', 'replacementAfterReplayAttempt', 'containerConcurrency'], 'Execution order');
  equal(registration.executionOrder.arms, PHASE4_ARM_IDS, 'Execution arm order changed');
  equal(registration.executionOrder.modules, PHASE4_MODULE_IDS, 'Execution module order changed');
  assert(registration.executionOrder.replacementAfterReplayAttempt === false && registration.executionOrder.containerConcurrency === 1, 'Execution ordering policy changed');
  strictKeys(registration.checkpoints, ['commitA', 'commitB', 'sealedRef'], 'Checkpoint state');
  strictKeys(registration.authorBundle, ['manifestDigest', 'sessionRecordDigest'], 'Author bundle state');
  strictKeys(registration.images, ['artifactFactoryImageId', 'evaluatorImageManifestDigest', 'evaluationContractKeysDigest'], 'Image identity state');
  validateOptionalGitOid(registration.checkpoints.commitA, 'Checkpoint A');
  validateOptionalGitOid(registration.checkpoints.commitB, 'Checkpoint B');
  validateOptionalImmutableRef(registration.checkpoints.sealedRef, 'Sealed ref');
  validateOptionalSha256(registration.authorBundle.manifestDigest, 'Author bundle manifest');
  validateOptionalSha256(registration.authorBundle.sessionRecordDigest, 'Author bundle session record');
  validateOptionalSha256(registration.images.artifactFactoryImageId, 'Artifact factory image ID');
  validateOptionalSha256(registration.images.evaluatorImageManifestDigest, 'Evaluator image manifest');
  validateOptionalSha256(registration.images.evaluationContractKeysDigest, 'Evaluation contract keys');
  validateOptionalSha256(registration.benchmarkEpochId, 'Benchmark epoch ID');
  strictKeys(registration.readiness, ['authoringReady', 'measurementReady', 'blockers'], 'Readiness state');
  equal(registration.readiness, phase4RegistrationReadiness(registration), 'Readiness state is not derived from the unsealed fields');
  if (registration.status === APPROVED_STATUS && registration.readiness.blockers.length === EXPECTED_BLOCKERS.length) {
    equal(registration.readiness.blockers, EXPECTED_BLOCKERS, 'Initial approved-unsealed blockers changed');
  }
  if (registration.status === SEALED_STATUS) assert(registration.readiness.measurementReady, 'Sealed registration is not measurement-ready');
  assert(staticPolicyDigestUnchecked(registration) === PHASE4_APPROVED_STATIC_POLICY_DIGEST, 'Approved Phase 4 static policy changed');
  return registration;
}

export function phase4StaticPolicyDigest(registration) {
  validatePhase4Registration(registration);
  return staticPolicyDigestUnchecked(registration);
}

export function phase4ViolationIdentityDigest({ invariantRegistrationId, normalizedObservedKind, normalizedObservedFields, targetArtifactDigest }) {
  assert(validId(invariantRegistrationId), 'Violation identity invariant is invalid');
  assert(['returned-value', 'thrown-error'].includes(normalizedObservedKind), 'Violation identity observed kind is invalid');
  assert(isObject(normalizedObservedFields), 'Violation identity observed fields are invalid');
  assert(validSha(targetArtifactDigest), 'Violation identity target artifact digest is invalid');
  return domainDigest(PHASE4_VIOLATION_IDENTITY_DOMAIN, { invariantRegistrationId, normalizedObservedKind, normalizedObservedFields, targetArtifactDigest });
}

export async function loadPhase4Registration(repositoryRoot) {
  const registrationBytes = await readFile(path.join(repositoryRoot, PHASE4_REGISTRATION_PATH));
  const registration = validatePhase4Registration(parseJsonBytes(registrationBytes));
  const references = [
    registration.sourceArtifacts.approvedPolicyDraft,
    registration.sourceArtifacts.inventoryDraft,
    registration.sourceArtifacts.phase3.spikeRegistration,
    registration.sourceArtifacts.phase3.spikeEvidence,
    registration.sourceArtifacts.phase3.reductionRegistration,
    registration.sourceArtifacts.phase3.reductionEvidence,
    { path: registration.target.registrationPath, sha256: registration.target.registrationSha256 },
  ];
  const loaded = new Map();
  for (const reference of references) {
    const bytes = await readFile(path.join(repositoryRoot, reference.path));
    assert(sha256(bytes) === reference.sha256, `Referenced artifact digest changed: ${reference.path}`);
    loaded.set(reference.path, bytes);
  }
  const inventory = parseJsonBytes(loaded.get(PHASE4_INVENTORY_PATH));
  assert(Array.isArray(inventory.rows) && inventory.rows.length === 20, 'Inventory row universe changed');
  const ids = inventory.rows.map((row) => row.id);
  assert(ids.every(validId) && new Set(ids).size === 20, 'Inventory row IDs are invalid or duplicated');
  equal([...registration.universe.development, ...registration.universe.existingPublic].sort(), [...ids].sort(), 'Registration partitions do not cover the 20-row inventory');
  for (const moduleId of PHASE4_MODULE_IDS) {
    const expected = registration.sourceArtifacts.inventoryDraft.moduleDistribution[moduleId];
    assert(inventory.rows.filter((row) => row.module === `packages/${moduleId}`).length === expected, `Inventory module count changed: ${moduleId}`);
  }
  const currentSupported = inventory.rows.filter((row) => row.support?.currentInterpreter === 'current-supported').length;
  assert(currentSupported === registration.sourceArtifacts.inventoryDraft.currentInterpreterSupportedRows, 'Inventory current-support count changed');
  const targetRegistration = parseJsonBytes(loaded.get(registration.target.registrationPath));
  for (const moduleId of PHASE4_MODULE_IDS) {
    const packageRegistration = targetRegistration.packages.find((item) => item.id === moduleId);
    assert(packageRegistration?.packageName === PHASE4_MODULES[moduleId].packageName, `Package registration changed: ${moduleId}`);
    equal(packageRegistration.allowedImportSpecifiers, PHASE4_MODULES[moduleId].allowedImportSpecifiers, `Allowed public imports changed: ${moduleId}`);
  }
  return Object.freeze({ registration, registrationBytes, inventory, inventoryBytes: loaded.get(PHASE4_INVENTORY_PATH), staticPolicyDigest: phase4StaticPolicyDigest(registration) });
}

function validateObservedFields(value, label) {
  assert(Array.isArray(value) && value.length > 0, `${label} observedFields must be non-empty`);
  const names = new Set();
  for (const field of value) {
    strictKeys(field, ['name', 'type'], `${label} observed field`);
    assert(validId(field.name) && ['string', 'number', 'boolean', 'json'].includes(field.type), `${label} observed field is invalid`);
    assert(!names.has(field.name), `${label} observed field is duplicated`);
    names.add(field.name);
  }
}

export function validateTrustedModuleDescriptor(descriptor) {
  strictKeys(descriptor, ['schemaVersion', 'id', 'moduleId', 'packageName', 'importSpecifier', 'targetRegistrationPath', 'targetRegistrationSha256', 'catalogVersion', 'actions', 'fixtures', 'invariants', 'comparisons'], 'Trusted module descriptor');
  assert(descriptor.schemaVersion === PHASE4_MODULE_INTERFACE_SCHEMA_VERSION, 'Unexpected trusted module descriptor schemaVersion');
  assert(validId(descriptor.id) && PHASE4_MODULE_IDS.includes(descriptor.moduleId), 'Trusted module descriptor identity is invalid');
  const expectedModule = PHASE4_MODULES[descriptor.moduleId];
  assert(descriptor.packageName === expectedModule.packageName && descriptor.importSpecifier === expectedModule.importSpecifier, 'Trusted module descriptor import is not the registered public root');
  safeRelativePath(descriptor.targetRegistrationPath, 'Trusted module target registration');
  assert(validSha(descriptor.targetRegistrationSha256) && validId(descriptor.catalogVersion), 'Trusted module descriptor registration is invalid');
  for (const [key, requiredKeys] of [
    ['actions', ['id', 'importSpecifier', 'adapterId', 'argumentSchemaId', 'bindingOutputType']],
    ['invariants', ['id', 'evaluatorId', 'sourceKind', 'sourceRef', 'sourceCommit', 'authoredBeforeGeneration', 'visibility', 'strength', 'corroboratingRefs', 'normalizedObservedKind', 'observedFields']],
    ['comparisons', ['id', 'materializerId', 'invariantId', 'normalizedObservedKind', 'observedFields']],
  ]) {
    assert(Array.isArray(descriptor[key]) && descriptor[key].length > 0, `Trusted module ${key} must be non-empty`);
    assert(new Set(descriptor[key].map((item) => item.id)).size === descriptor[key].length, `Trusted module ${key} IDs are duplicated`);
    for (const item of descriptor[key]) {
      strictKeys(item, requiredKeys, `Trusted module ${key} ${item.id}`);
      assert(validId(item.id), `Trusted module ${key} ID is invalid`);
    }
  }
  assert(Array.isArray(descriptor.fixtures) && descriptor.fixtures.length > 0, 'Trusted module fixtures must be non-empty');
  assert(new Set(descriptor.fixtures.map((item) => item.id)).size === descriptor.fixtures.length, 'Trusted module fixtures IDs are duplicated');
  for (const fixture of descriptor.fixtures) {
    strictKeys(fixture, ['id', 'kind', 'materializerId', 'consumerActionId', 'payloadArgumentPointer', 'publicActionTrace'], `Trusted module fixture ${fixture.id}`);
    assert(validId(fixture.id), 'Trusted module fixture ID is invalid');
  }
  for (const action of descriptor.actions) {
    assert(expectedModule.allowedImportSpecifiers.includes(action.importSpecifier), `Action ${action.id} import is not a registered public specifier`);
    assert(validId(action.adapterId) && validId(action.argumentSchemaId) && (action.bindingOutputType === null || validId(action.bindingOutputType)), `Action ${action.id} is invalid`);
  }
  for (const fixture of descriptor.fixtures) {
    assert(['public-current-version', 'public-previous-version', 'public-test-seam', 'documented-wire-state', 'external-environment'].includes(fixture.kind), `Fixture ${fixture.id} kind is invalid`);
    assert(validId(fixture.materializerId) && descriptor.actions.some((action) => action.id === fixture.consumerActionId), `Fixture ${fixture.id} consumer is invalid`);
    assert(typeof fixture.payloadArgumentPointer === 'string' && (fixture.payloadArgumentPointer === '' || fixture.payloadArgumentPointer.startsWith('/')), `Fixture ${fixture.id} payload argument pointer is invalid`);
    assert(Array.isArray(fixture.publicActionTrace) && fixture.publicActionTrace.length > 0 && fixture.publicActionTrace.every((item) => validId(item)), `Fixture ${fixture.id} public action trace is invalid`);
  }
  for (const invariant of descriptor.invariants) {
    assert(typeof invariant.sourceRef === 'string' && invariant.sourceRef.length > 0, `Invariant ${invariant.id} source reference is invalid`);
    assert(validId(invariant.evaluatorId) && invariant.sourceCommit === TARGET_REVISION && invariant.authoredBeforeGeneration === true && invariant.visibility === 'public', `Invariant ${invariant.id} provenance is invalid`);
    assert(['requirements', 'documentation', 'existing-test', 'public-type', 'fixed-version-comparison', 'reference-implementation', 'differential-relation', 'metamorphic-relation'].includes(invariant.sourceKind), `Invariant ${invariant.id} source kind is invalid`);
    assert(['normative', 'corroborating'].includes(invariant.strength) && Array.isArray(invariant.corroboratingRefs) && invariant.corroboratingRefs.every((item) => typeof item === 'string' && item.length > 0), `Invariant ${invariant.id} strength is insufficient`);
    if (invariant.strength === 'corroborating') assert(invariant.corroboratingRefs.length >= 2, `Invariant ${invariant.id} needs two corroborating sources`);
    assert(['returned-value', 'thrown-error'].includes(invariant.normalizedObservedKind), `Invariant ${invariant.id} observation kind is invalid`);
    validateObservedFields(invariant.observedFields, `Invariant ${invariant.id}`);
  }
  for (const comparison of descriptor.comparisons) {
    const invariant = descriptor.invariants.find((item) => item.id === comparison.invariantId);
    assert(validId(comparison.materializerId) && invariant !== undefined, `Comparison ${comparison.id} binding is invalid`);
    assert(comparison.normalizedObservedKind === invariant.normalizedObservedKind && canonicalJson(comparison.observedFields) === canonicalJson(invariant.observedFields), `Comparison ${comparison.id} observation contract differs from its invariant`);
  }
  return descriptor;
}

export function assertTrustedModuleImplementation(implementation, descriptor = implementation?.descriptor) {
  return assertTrustedInterpreterModuleImplementation(implementation, descriptor);
}

function strictImplementationExports(implementation, exports, label) {
  assert(implementation !== null && typeof implementation === 'object' && !Array.isArray(implementation), `${label} must be an object or module namespace`);
  assert(canonicalJson(Object.keys(implementation).sort()) === canonicalJson([...exports].sort()), `${label} fields changed`);
}

export function assertTrustedInterpreterModuleImplementation(implementation, descriptor = implementation?.descriptor) {
  const exports = ['descriptor', 'validateActionArguments', 'materializeFixture', 'executeAction', 'evaluateInvariant'];
  strictImplementationExports(implementation, exports, 'Trusted interpreter implementation');
  validateTrustedModuleDescriptor(descriptor);
  assert(canonicalJson(implementation.descriptor) === canonicalJson(descriptor), 'Trusted interpreter implementation descriptor mismatch');
  for (const name of exports.slice(1)) assert(typeof implementation[name] === 'function', `Trusted module export is not a function: ${name}`);
  return implementation;
}

export function assertTrustedComparisonModuleImplementation(implementation, descriptor = implementation?.descriptor) {
  const exports = ['descriptor', 'materializeComparison'];
  strictImplementationExports(implementation, exports, 'Trusted comparison implementation');
  validateTrustedModuleDescriptor(descriptor);
  assert(canonicalJson(implementation.descriptor) === canonicalJson(descriptor), 'Trusted comparison implementation descriptor mismatch');
  assert(typeof implementation.materializeComparison === 'function', 'Trusted module export is not a function: materializeComparison');
  return implementation;
}

const ACCEPTANCE_STATES = ['accepted', 'rejected-schema', 'rejected-catalog', 'rejected-policy'];
const PLAN_STATES = ['planned', 'planner-error', 'not-run'];
const EVALUATOR_STATES = ['evaluated', 'evaluator-error', 'not-run'];
const EXECUTION_STATES = ['pass', 'candidate-failure', 'unrunnable', 'not-run'];

export function validatePhase4MeasurementRow(row) {
  strictKeys(row, ['schemaVersion', 'epochId', 'sequence', 'armId', 'moduleId', 'inputId', 'canonicalTruthId', 'duplicateGroup', 'artifactRole', 'targetArtifactDigest', 'phase', 'replayIndex', 'executionPath', 'specDigest', 'planDigest', 'runRecordRef', 'axes', 'observation', 'reasonCode', 'budget'], 'Measurement row');
  assert(row.schemaVersion === PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION && validSha(row.epochId), 'Measurement row identity is invalid');
  assert(Number.isSafeInteger(row.sequence) && row.sequence >= 0 && PHASE4_ARM_IDS.includes(row.armId) && PHASE4_MODULE_IDS.includes(row.moduleId), 'Measurement row order or arm is invalid');
  for (const [key, value] of [['inputId', row.inputId], ['canonicalTruthId', row.canonicalTruthId], ['duplicateGroup', row.duplicateGroup]]) assert(validId(value), `Measurement row ${key} is invalid`);
  assert(['clean', 'single-patch-defect'].includes(row.artifactRole) && ['initial', 'replay'].includes(row.phase) && ['interpreter', 'comparison'].includes(row.executionPath), 'Measurement row execution coordinates are invalid');
  assert(validSha(row.targetArtifactDigest), 'Measurement row target artifact digest is invalid');
  assert((row.phase === 'initial' && row.replayIndex === null) || (row.phase === 'replay' && Number.isInteger(row.replayIndex) && row.replayIndex >= 1 && row.replayIndex <= 5), 'Measurement row replay index is invalid');
  for (const key of ['specDigest', 'planDigest']) assert(row[key] === null || validSha(row[key]), `Measurement row ${key} is invalid`);
  if (row.runRecordRef !== null) safeRelativePath(row.runRecordRef, 'Measurement run record');
  strictKeys(row.axes, ['specAcceptance', 'plan', 'evaluator', 'execution'], 'Measurement row axes');
  assert(ACCEPTANCE_STATES.includes(row.axes.specAcceptance) && PLAN_STATES.includes(row.axes.plan) && EVALUATOR_STATES.includes(row.axes.evaluator) && EXECUTION_STATES.includes(row.axes.execution), 'Measurement row axis value is invalid');
  if (row.observation !== null) {
    strictKeys(row.observation, ['normalizedObservedKind', 'normalizedObservedFields', 'violationIdentity', 'resultPayloadDigest'], 'Measurement row observation');
    assert(['returned-value', 'thrown-error'].includes(row.observation.normalizedObservedKind), 'Measurement row observation kind is invalid');
    assert(isObject(row.observation.normalizedObservedFields), 'Measurement row observed fields are invalid');
    assert(row.observation.violationIdentity === null || validSha(row.observation.violationIdentity), 'Measurement row violation identity is invalid');
    assert(validSha(row.observation.resultPayloadDigest), 'Measurement row result payload digest is invalid');
  }
  assert(row.reasonCode === null || validId(row.reasonCode), 'Measurement row reason code is invalid');
  strictKeys(row.budget, ['charged', 'evaluationOrdinal'], 'Measurement row budget');
  assert(typeof row.budget.charged === 'boolean' && (row.budget.evaluationOrdinal === null || (Number.isSafeInteger(row.budget.evaluationOrdinal) && row.budget.evaluationOrdinal >= 1 && row.budget.evaluationOrdinal <= 460)), 'Measurement row budget coordinate is invalid');
  assert(row.budget.charged === (row.budget.evaluationOrdinal !== null), 'Measurement row budget charge disagrees with its ordinal');
  if (row.axes.specAcceptance !== 'accepted') assert(row.axes.plan === 'not-run' && row.axes.evaluator === 'not-run' && row.axes.execution === 'not-run' && row.runRecordRef === null && row.observation === null, 'Rejected measurement row has downstream execution');
  if (row.axes.plan === 'planner-error') assert(row.axes.evaluator === 'not-run' && row.axes.execution === 'not-run' && row.observation === null, 'Planner-error row has downstream execution');
  if (row.axes.evaluator === 'evaluator-error') assert(row.axes.execution === 'unrunnable', 'Evaluator-error row must be unrunnable');
  if (['pass', 'candidate-failure'].includes(row.axes.execution)) assert(row.observation !== null, 'Completed measurement row is missing its raw normalized observation');
  if (row.axes.execution === 'candidate-failure') assert(row.observation.violationIdentity !== null, 'Candidate failure is missing its violation identity');
  if (['unrunnable', 'not-run'].includes(row.axes.execution)) assert(row.observation === null, 'Non-result measurement row contains an observation');
  return row;
}

export function validatePhase4BudgetLedger(ledger) {
  strictKeys(ledger, ['schemaVersion', 'epochId', 'generation', 'measurement', 'preparation', 'stoppedBy'], 'Budget ledger');
  assert(ledger.schemaVersion === PHASE4_BUDGET_LEDGER_SCHEMA_VERSION && validSha(ledger.epochId), 'Budget ledger identity is invalid');
  strictKeys(ledger.generation, ['freshSessions', 'submittedTaskTurns', 'emittedSeeds', 'acceptedSeeds', 'operatorRequests', 'transformedSpecs'], 'Generation ledger');
  for (const [key, value] of Object.entries(ledger.generation)) assert(Number.isSafeInteger(value) && value >= 0, `Generation ledger ${key} is invalid`);
  strictKeys(ledger.measurement, ['dockerEvaluations', 'replayCandidates', 'replayRuns', 'elapsedSeconds'], 'Measurement ledger');
  assert(ledger.measurement.dockerEvaluations <= 460 && ledger.measurement.replayCandidates <= 30 && ledger.measurement.replayRuns <= 150 && ledger.measurement.elapsedSeconds <= 18000, 'Measurement ledger exceeds the approved budget');
  strictKeys(ledger.preparation, ['builds', 'inspects', 'probeContainers', 'failures', 'cleanups', 'cleanupFailures', 'elapsedSeconds'], 'Preparation ledger');
  assert(ledger.preparation.builds <= 24 && ledger.preparation.inspects + ledger.preparation.probeContainers <= 72 && ledger.preparation.failures === 0 && ledger.preparation.elapsedSeconds <= 7200, 'Preparation ledger exceeds the approved budget');
  for (const value of Object.values({ ...ledger.measurement, ...ledger.preparation })) assert(Number.isSafeInteger(value) && value >= 0, 'Budget ledger count is invalid');
  assert(ledger.stoppedBy === null || validId(ledger.stoppedBy), 'Budget ledger stop reason is invalid');
  return ledger;
}
