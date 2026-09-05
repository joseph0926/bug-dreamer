import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  PHASE4_APPROVED_STATIC_POLICY_DIGEST,
  PHASE4_ARM_IDS,
  PHASE4_MODULE_IDS,
  PHASE4_APPROVED_BUDGETS,
  loadPhase4Registration,
  phase4ViolationIdentityDigest,
  phase4RegistrationReadiness,
  validatePhase4BudgetLedger,
  validatePhase4MeasurementRow,
  validatePhase4Registration,
} from './v03-benchmark-contract.mjs';
import { classifyBenchmarkTrustedResult } from './v03-benchmark-trust.mjs';
import { buildBenchmarkDockerArgs } from './v03-benchmark-runner.mjs';
import { benchmarkImageContractKey, benchmarkImportClosures, canonicalizerClosure } from './v03-benchmark-preparation.mjs';
import { PHASE4_SCORER_VERSION, scorePhase4Benchmark } from './v03-benchmark-score.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';
import { assertNoSymlinkAncestors, resolveContainedPath } from './v03-paths.mjs';

export const PHASE4_EPOCH_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-epoch-closure/v1';
export const PHASE4_AUTHOR_BUNDLE_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-author-bundle/v1';
export const PHASE4_EXECUTION_MANIFEST_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-execution-manifest/v1';
export const PHASE4_EVIDENCE_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-evidence/v1';
export const PHASE4_RAW_RUN_RECORD_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-raw-run-record/v1';
export const PHASE4_EPOCH_DOMAIN = 'bug-dreamer/v03-benchmark-epoch/v1';
export const PHASE4_AUTHOR_SESSION_DOMAIN = 'bug-dreamer/v03-benchmark-author-sessions/v1';
export const PHASE4_EXECUTION_MANIFEST_DOMAIN = 'bug-dreamer/v03-benchmark-execution-manifest/v1';
export const PHASE4_EPOCH_REGISTRATION_DOMAIN = 'bug-dreamer/v03-benchmark-epoch-registration/v1';
export const PHASE4_AUTHOR_BUNDLE_PATH = 'benchmark/v0.3/authoring/bundle.json';
export const PHASE4_EXECUTION_MANIFEST_PATH = 'benchmark/v0.3/execution-manifest.json';
export const PHASE4_EPOCH_PATH = 'benchmark/v0.3/epoch.json';
export const PHASE4_SCORE_PATH = 'benchmark/v0.3/results/score.json';
export const PHASE4_MEASUREMENT_PATH = 'evidence/v0.3/phase4/measurement.json';
export const PHASE4_PREPARATION_PATH = 'evidence/v0.3/phase4-preparation.json';
export const PHASE4_UNIVERSE_PATH = 'benchmark/v0.3/universe.json';
export const PHASE4_TRUTH_COMMITMENTS_PATH = 'benchmark/v0.3/truth-commitments.json';
export const PHASE4_COMPARISON_INPUTS_PATH = 'benchmark/v0.3/comparison-inputs.json';
export const PHASE4_DEFECT_MANIFEST_PATH = 'benchmark/manifest.json';
export const PHASE4_EVALUATOR_IMAGES_DOMAIN = 'bug-dreamer/v03-benchmark-evaluator-images/v1';
export const PHASE4_EVALUATION_CONTRACT_KEYS_DOMAIN = 'bug-dreamer/v03-benchmark-evaluation-contract-keys/v1';

export class V03BenchmarkValidationError extends Error {}

const SHA = /^[0-9a-f]{64}$/u;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const IMMUTABLE_REF = /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const AUTHOR_ARMS = ['G', 'P'];
const ALLOWED_INPUTS = new Set([
  'clean-pinned-module-source', 'public-documentation', 'public-tests-and-types',
  'approved-invariant-identifiers-and-provenance', 'registered-action-catalog',
  'nightmare-seed-schema', 'arm-specific-authoring-prompt',
]);
const DENIED_INPUTS = new Set([
  'benchmark-defect-manifest', 'historical-private-checks', 'defect-patches',
  'truth-tables-with-item-answers', 'historical-or-current-results',
  'phase3-spike-and-reduction-truth', 'earlier-arm-outputs',
  'git-history-and-diffs-revealing-fixes', 'issues-prs-or-external-pages-revealing-fixes',
  'review-task-conversations-or-summaries',
]);
const DENIED_TASK_IDS = new Set([
  '01a06f53-181f-71e1-b0e8-181cd7d3c19a',
  '01a06f53-1a66-7273-af6a-b25d99fbfa91',
  '01a06f53-1d05-7ed0-aa5a-2579508fef77',
  '01a06f80-360c-7690-97b2-7d99430da13e',
  '01a06f88-ea82-7e22-98cf-16cede06a7cb',
  '01a06f89-7ff0-7811-acb9-ce93c774a6ba',
  '01a06f90-9365-7563-bc50-53c56f31110e',
  '01a06ea5-9119-79a0-9129-3cf5c401e048',
]);
const execFileAsync = promisify(execFile);

function fail(message) { throw new V03BenchmarkValidationError(message); }
function assert(condition, message) { if (!condition) fail(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function strict(value, keys, label) {
  assert(object(value), `${label} must be an object`);
  assert(canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `${label} fields changed`);
}
function sha(value, label) { assert(typeof value === 'string' && SHA.test(value), `${label} is not a SHA-256 digest`); }
function oid(value, label) { assert(typeof value === 'string' && OID.test(value), `${label} is not a full Git object ID`); }
function id(value, label) { assert(typeof value === 'string' && ID.test(value), `${label} is invalid`); }
function unique(values, label) { assert(new Set(values).size === values.length, `${label} contains duplicates`); }
function digestBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function phase4PackageIntegrityReceiptBytes(canonicalizer) {
  strict(canonicalizer, ['package', 'version', 'integritySha512', 'files', 'aggregateSha256'], 'Canonicalizer closure');
  return Buffer.from(`${canonicalJson({ package: canonicalizer.package, version: canonicalizer.version, integritySha512: canonicalizer.integritySha512 })}\n`);
}

function evaluatorImageProjection(preparation) {
  return preparation.images.map((image) => ({
    artifactSetId: image.artifactSetId,
    imageId: image.imageId,
    contractKey: image.contractKey,
    artifactDigests: image.buildInputs.artifactDigests,
  }));
}

export function phase4PreparedImageIdentities(preparation) {
  assert(object(preparation.artifactFactory) && /^sha256:[0-9a-f]{64}$/u.test(preparation.artifactFactory.imageId), 'Artifact factory image ID is missing');
  assert(Array.isArray(preparation.images), 'Prepared evaluator images are missing');
  return Object.freeze({
    artifactFactoryImageId: preparation.artifactFactory.imageId.slice('sha256:'.length),
    evaluatorImageManifestDigest: domainDigest(PHASE4_EVALUATOR_IMAGES_DOMAIN, evaluatorImageProjection(preparation)),
    evaluationContractKeysDigest: domainDigest(PHASE4_EVALUATION_CONTRACT_KEYS_DOMAIN, preparation.images.map((image) => ({ artifactSetId: image.artifactSetId, contractKey: image.contractKey }))),
  });
}

function registrationEpochProjection(registration) {
  return {
    ...registration,
    benchmarkEpochId: null,
    readiness: phase4RegistrationReadiness({ ...registration, benchmarkEpochId: null }),
  };
}

export function phase4EpochRegistrationDigest(registration) {
  validatePhase4Registration(registration);
  return domainDigest(PHASE4_EPOCH_REGISTRATION_DOMAIN, registrationEpochProjection(registration));
}

function closurePayload(closure) {
  const { epochId, ...payload } = closure;
  return payload;
}

export function phase4BenchmarkEpochId(closure) {
  return domainDigest(PHASE4_EPOCH_DOMAIN, closurePayload(closure));
}

export function validatePhase4AuthorBundle(bundle, registration) {
  strict(bundle, ['schemaVersion', 'checkpointA', 'sessions', 'unavailableCounters', 'sessionRecordDigest'], 'Author bundle');
  assert(bundle.schemaVersion === PHASE4_AUTHOR_BUNDLE_SCHEMA_VERSION, 'Unexpected author bundle schemaVersion');
  oid(bundle.checkpointA, 'Author bundle Checkpoint A');
  assert(bundle.checkpointA === registration.checkpoints.commitA, 'Author bundle was not based on Checkpoint A');
  strict(bundle.unavailableCounters, ['internalModelCalls', 'inputTokens', 'outputTokens'], 'Unavailable counters');
  assert(Object.values(bundle.unavailableCounters).every((value) => value === null), 'Unavailable authoring counters must remain null');
  assert(Array.isArray(bundle.sessions) && bundle.sessions.length === 2, 'Author bundle must contain exactly G and P sessions');
  unique(bundle.sessions.map((session) => session.armId), 'Author session arms');
  for (const session of bundle.sessions) {
    strict(session, ['armId', 'sessionId', 'fresh', 'inheritedConversationTurns', 'model', 'reasoningEffort', 'visibleTaskTurns', 'contextInputs', 'deniedInputsChecked', 'sourceTaskIds', 'deniedExposureFindings', 'seedRecords'], `Author session ${session.armId}`);
    assert(AUTHOR_ARMS.includes(session.armId), 'Author session arm is invalid');
    id(session.sessionId, 'Author session ID');
    assert(session.fresh === true && session.inheritedConversationTurns === 0, 'Author session is not fresh');
    assert(session.model === registration.generation.model && session.reasoningEffort === registration.generation.reasoningEffort && session.visibleTaskTurns === 1, 'Author session model or visible-turn budget changed');
    assert(Array.isArray(session.contextInputs) && session.contextInputs.every((item) => ALLOWED_INPUTS.has(item)), 'Author session received an unapproved input');
    unique(session.contextInputs, 'Author session inputs');
    assert(Array.isArray(session.deniedInputsChecked) && canonicalJson([...session.deniedInputsChecked].sort()) === canonicalJson([...DENIED_INPUTS].sort()), 'Author session deny-list check is incomplete');
    assert(Array.isArray(session.sourceTaskIds) && session.sourceTaskIds.every((taskId) => !DENIED_TASK_IDS.has(taskId)), 'Author session inherited a denied review task');
    assert(Array.isArray(session.deniedExposureFindings) && session.deniedExposureFindings.length === 0, 'Author session saw deny-listed benchmark truth');
    assert(Array.isArray(session.seedRecords) && session.seedRecords.length <= registration.generation.seedMaximumPerArm, 'Author session seed cap exceeded');
    unique(session.seedRecords.map((record) => record.id), 'Author seed IDs');
    const moduleCounts = new Map();
    for (const record of session.seedRecords) {
      strict(record, ['id', 'moduleId', 'status', 'digest', 'reasonCode'], 'Author seed record');
      id(record.id, 'Author seed ID');
      assert(PHASE4_MODULE_IDS.includes(record.moduleId), 'Author seed module is invalid');
      assert(['accepted', 'rejected'].includes(record.status), 'Author seed status is invalid');
      sha(record.digest, 'Author seed digest');
      assert((record.status === 'accepted' && record.reasonCode === null) || (record.status === 'rejected' && typeof record.reasonCode === 'string'), 'Author seed reason disagrees with status');
      moduleCounts.set(record.moduleId, (moduleCounts.get(record.moduleId) ?? 0) + 1);
    }
    assert([...moduleCounts.values()].every((count) => count <= registration.generation.seedMaximumPerModulePerArm), 'Per-module author seed cap exceeded');
  }
  const expectedDigest = domainDigest(PHASE4_AUTHOR_SESSION_DOMAIN, { checkpointA: bundle.checkpointA, sessions: bundle.sessions, unavailableCounters: bundle.unavailableCounters });
  assert(bundle.sessionRecordDigest === expectedDigest, 'Author session record digest mismatch');
  assert(bundle.sessionRecordDigest === registration.authorBundle.sessionRecordDigest, 'Author session digest differs from registration');
  return bundle;
}

function manifestEntryKey(entry) {
  return canonicalJson(entry);
}

export function validatePhase4ExecutionManifest(manifest, registration) {
  strict(manifest, ['schemaVersion', 'checkpointA', 'entries', 'manifestDigest'], 'Execution manifest');
  assert(manifest.schemaVersion === PHASE4_EXECUTION_MANIFEST_SCHEMA_VERSION, 'Unexpected execution manifest schemaVersion');
  assert(manifest.checkpointA === registration.checkpoints.commitA, 'Execution manifest checkpoint mismatch');
  assert(Array.isArray(manifest.entries) && manifest.entries.length > 0, 'Execution manifest is empty');
  for (const [index, entry] of manifest.entries.entries()) {
    strict(entry, ['sequence', 'armId', 'moduleId', 'inputId', 'canonicalTruthId', 'duplicateGroup', 'artifactRole', 'phase', 'replayIndex', 'executionPath'], 'Execution manifest entry');
    assert(entry.sequence === index && PHASE4_ARM_IDS.includes(entry.armId) && PHASE4_MODULE_IDS.includes(entry.moduleId), 'Execution manifest order or arm is invalid');
    id(entry.inputId, 'Execution manifest input ID');
    id(entry.canonicalTruthId, 'Execution manifest truth ID');
    id(entry.duplicateGroup, 'Execution manifest duplicate group');
    assert(['clean', 'single-patch-defect'].includes(entry.artifactRole), 'Execution manifest artifact role is invalid');
    assert(['initial', 'replay'].includes(entry.phase) && ((entry.phase === 'initial' && entry.replayIndex === null) || (entry.phase === 'replay' && Number.isInteger(entry.replayIndex) && entry.replayIndex >= 1 && entry.replayIndex <= 5)), 'Execution manifest phase is invalid');
    assert(['interpreter', 'comparison'].includes(entry.executionPath), 'Execution manifest path is invalid');
  }
  unique(manifest.entries.map(manifestEntryKey), 'Execution manifest coordinates');
  const phaseOrder = { initial: 0, replay: 1 };
  const roleOrder = { clean: 0, 'single-patch-defect': 1 };
  const expectedOrder = [...manifest.entries].sort((left, right) => phaseOrder[left.phase] - phaseOrder[right.phase]
    || registration.executionOrder.arms.indexOf(left.armId) - registration.executionOrder.arms.indexOf(right.armId)
    || registration.executionOrder.modules.indexOf(left.moduleId) - registration.executionOrder.modules.indexOf(right.moduleId)
    || left.inputId.localeCompare(right.inputId, 'en')
    || left.canonicalTruthId.localeCompare(right.canonicalTruthId, 'en')
    || roleOrder[left.artifactRole] - roleOrder[right.artifactRole]
    || (left.replayIndex ?? 0) - (right.replayIndex ?? 0));
  assert(canonicalJson(expectedOrder) === canonicalJson(manifest.entries), 'Execution manifest violates the registered serial order');
  const expectedDigest = domainDigest(PHASE4_EXECUTION_MANIFEST_DOMAIN, { checkpointA: manifest.checkpointA, entries: manifest.entries });
  assert(manifest.manifestDigest === expectedDigest, 'Execution manifest digest mismatch');
  assert(manifest.manifestDigest === registration.authorBundle.manifestDigest, 'Execution manifest digest differs from registration');
  return manifest;
}

export function validatePhase4EpochClosure(closure, registration) {
  validatePhase4Registration(registration);
  assert(registration.readiness.measurementReady && registration.status === 'sealed', `Phase 4 benchmark is not measurement-ready: ${registration.readiness.blockers.join(',')}`);
  strict(closure, ['schemaVersion', 'checkpointA', 'checkpointB', 'sealedRef', 'registrationDigest', 'inventoryDigest', 'truthCommitmentDigest', 'authorBundleDigests', 'phase3Prerequisites', 'imageIdentities', 'sourceClosures', 'platform', 'scorerVersion', 'executionManifestDigest', 'epochId'], 'Epoch closure');
  assert(closure.schemaVersion === PHASE4_EPOCH_SCHEMA_VERSION, 'Unexpected epoch closure schemaVersion');
  oid(closure.checkpointA, 'Checkpoint A'); oid(closure.checkpointB, 'Checkpoint B');
  assert(closure.checkpointA === registration.checkpoints.commitA && closure.checkpointB === registration.checkpoints.commitB && closure.checkpointA !== closure.checkpointB, 'Epoch checkpoint mismatch');
  strict(closure.sealedRef, ['name', 'resolvedOid', 'immutable'], 'Sealed ref');
  assert(IMMUTABLE_REF.test(closure.sealedRef.name) && closure.sealedRef.name === registration.checkpoints.sealedRef && closure.sealedRef.resolvedOid === closure.checkpointB && closure.sealedRef.immutable === true, 'Sealed ref does not immutably resolve to Checkpoint B');
  assert(closure.registrationDigest === phase4EpochRegistrationDigest(registration), 'Epoch registration digest mismatch');
  sha(closure.inventoryDigest, 'Inventory digest'); sha(closure.truthCommitmentDigest, 'Truth commitment digest');
  assert(closure.inventoryDigest === registration.sourceArtifacts.inventoryDraft.sha256 && closure.truthCommitmentDigest === registration.universe.truthCommitmentRef.sha256, 'Epoch universe digest mismatch');
  strict(closure.authorBundleDigests, ['manifestDigest', 'sessionRecordDigest'], 'Epoch author bundle digests');
  assert(canonicalJson(closure.authorBundleDigests) === canonicalJson(registration.authorBundle), 'Epoch author bundle digest mismatch');
  assert(Array.isArray(closure.phase3Prerequisites) && closure.phase3Prerequisites.length === 4, 'Epoch must bind four Phase 3 prerequisite artifacts');
  const phase3 = registration.sourceArtifacts.phase3;
  const requiredPhase3 = [phase3.spikeRegistration, phase3.spikeEvidence, phase3.reductionRegistration, phase3.reductionEvidence];
  assert(closure.phase3Prerequisites.every((item, index) => canonicalJson(item) === canonicalJson({ ...requiredPhase3[index], scoreContribution: false })), 'Phase 3 prerequisite closure changed or contributes to score');
  assert(phase3.scoreContribution === false, 'Phase 3 prerequisite contributes to Phase 4 score');
  strict(closure.imageIdentities, ['artifactFactoryImageId', 'evaluatorImageManifestDigest', 'evaluationContractKeysDigest'], 'Epoch image identities');
  assert(canonicalJson(closure.imageIdentities) === canonicalJson(registration.images), 'Epoch image identities differ from registration');
  strict(closure.sourceClosures, ['direct', 'interpreter', 'shared', 'canonicalizer', 'packageIntegrity'], 'Epoch source closures');
  for (const value of Object.values(closure.sourceClosures)) sha(value, 'Epoch source closure');
  strict(closure.platform, ['os', 'arch', 'nodeVersion'], 'Epoch platform');
  assert(closure.platform.os === 'darwin' && closure.platform.arch === 'arm64' && /^v24\./u.test(closure.platform.nodeVersion), 'Epoch platform is not the approved Node 24 macOS arm64 host');
  assert(closure.scorerVersion === PHASE4_SCORER_VERSION && closure.executionManifestDigest === registration.authorBundle.manifestDigest, 'Epoch scorer or manifest binding changed');
  assert(closure.epochId === phase4BenchmarkEpochId(closure) && closure.epochId === registration.benchmarkEpochId, 'Benchmark epoch ID mismatch');
  return closure;
}

function rowCoordinate(row) {
  return {
    sequence: row.sequence, armId: row.armId, moduleId: row.moduleId, inputId: row.inputId,
    canonicalTruthId: row.canonicalTruthId, duplicateGroup: row.duplicateGroup,
    artifactRole: row.artifactRole, phase: row.phase, replayIndex: row.replayIndex, executionPath: row.executionPath,
  };
}

export function recomputePhase4RunClassification(run) {
  strict(run, ['resultBytesBase64', 'exitCode', 'timedOut', 'outputTruncated', 'plan', 'spec', 'descriptor', 'artifact'], 'Raw benchmark run');
  assert(run.resultBytesBase64 === null || typeof run.resultBytesBase64 === 'string', 'Raw result bytes are invalid');
  return classifyBenchmarkTrustedResult({
    resultBytes: run.resultBytesBase64 === null ? null : Buffer.from(run.resultBytesBase64, 'base64'),
    exitCode: run.exitCode, timedOut: run.timedOut, outputTruncated: run.outputTruncated,
    plan: run.plan, spec: run.spec, descriptor: run.descriptor, artifact: run.artifact,
  });
}

export function validatePhase4RawRunRecord(record, row) {
  strict(record, ['schemaVersion', 'sequence', 'consumerSequences', 'ref', 'containerName', 'inputDirectory', 'resultDirectory', 'executionPath', 'imageId', 'evaluationContractKey', 'dockerArgs', 'budget', 'resultChannel', 'process', 'cleanup', 'plan', 'spec', 'descriptor', 'artifact'], 'Raw run record');
  assert(record.schemaVersion === PHASE4_RAW_RUN_RECORD_SCHEMA_VERSION && Number.isSafeInteger(record.sequence) && record.sequence >= 0 && record.ref === row.runRecordRef, 'Raw run record coordinate mismatch');
  assert(Array.isArray(record.consumerSequences) && record.consumerSequences.every((value) => Number.isSafeInteger(value) && value >= 0) && record.consumerSequences.includes(row.sequence), 'Raw run record does not name the consuming row');
  unique(record.consumerSequences, 'Raw run consumer sequences');
  assert(/^sha256:[0-9a-f]{64}$/u.test(record.imageId), 'Raw run record image is not pinned by ID');
  sha(record.evaluationContractKey, 'Raw run evaluation contract key');
  assert(record.executionPath === row.executionPath, 'Raw run execution path differs from its row');
  const expectedDockerArgs = buildBenchmarkDockerArgs({ containerName: record.containerName, imageId: record.imageId, inputDirectory: record.inputDirectory, resultDirectory: record.resultDirectory, executionPath: record.executionPath });
  assert(canonicalJson(record.dockerArgs) === canonicalJson(expectedDockerArgs), 'Raw run Docker argv differs from the fixed isolation command');
  strict(record.budget, ['timeoutMs', 'stdoutLimitBytes', 'stderrLimitBytes', 'recordedOutputBytes'], 'Raw run budget');
  assert(canonicalJson(record.budget) === canonicalJson(PHASE4_APPROVED_BUDGETS.evaluation), 'Raw run resource budget changed');
  strict(record.process, ['exitCode', 'timedOut', 'outputTruncated', 'stdoutBytes', 'stderrBytes'], 'Raw run process');
  assert((record.process.exitCode === null || Number.isInteger(record.process.exitCode)) && typeof record.process.timedOut === 'boolean' && typeof record.process.outputTruncated === 'boolean', 'Raw run process status is invalid');
  assert(Number.isSafeInteger(record.process.stdoutBytes) && record.process.stdoutBytes >= 0 && Number.isSafeInteger(record.process.stderrBytes) && record.process.stderrBytes >= 0, 'Raw run byte counters are invalid');
  const outputExceeded = record.process.stdoutBytes > record.budget.stdoutLimitBytes || record.process.stderrBytes > record.budget.stderrLimitBytes;
  assert(record.process.outputTruncated === outputExceeded, 'Raw run output truncation flag disagrees with byte counters');
  strict(record.resultChannel, ['present', 'regular', 'size', 'sha256', 'bytesBase64'], 'Raw result channel');
  assert(typeof record.resultChannel.present === 'boolean' && typeof record.resultChannel.regular === 'boolean' && Number.isSafeInteger(record.resultChannel.size) && record.resultChannel.size >= 0, 'Raw result channel metadata is invalid');
  let resultBytes = null;
  if (record.resultChannel.present) {
    assert(record.resultChannel.regular === true && typeof record.resultChannel.bytesBase64 === 'string', 'Raw result is not one regular file');
    sha(record.resultChannel.sha256, 'Raw result digest');
    resultBytes = Buffer.from(record.resultChannel.bytesBase64, 'base64');
    assert(resultBytes.toString('base64') === record.resultChannel.bytesBase64, 'Raw result is not canonical base64');
    assert(resultBytes.length === record.resultChannel.size && digestBytes(resultBytes) === record.resultChannel.sha256, 'Raw result bytes disagree with channel metadata');
  } else {
    assert(record.resultChannel.regular === false && record.resultChannel.size === 0 && record.resultChannel.sha256 === null && record.resultChannel.bytesBase64 === null, 'Missing raw result contains fabricated metadata');
  }
  strict(record.cleanup, ['succeeded', 'reasonCode'], 'Raw run cleanup');
  assert(record.cleanup.succeeded === true && record.cleanup.reasonCode === null, 'Raw run container cleanup failed');
  strict(record.artifact, ['role', 'targetArtifactDigest', 'evaluationContractKey'], 'Raw run artifact');
  assert(record.artifact.role === row.artifactRole && record.artifact.targetArtifactDigest === row.targetArtifactDigest && record.artifact.evaluationContractKey === record.evaluationContractKey, 'Raw run artifact binding mismatch');
  const classification = classifyBenchmarkTrustedResult({
    resultBytes, exitCode: record.process.exitCode, timedOut: record.process.timedOut,
    outputTruncated: record.process.outputTruncated, plan: record.plan, spec: record.spec,
    descriptor: record.descriptor, artifact: record.artifact,
  });
  if (classification.status === 'unrunnable') {
    assert(row.axes.evaluator === 'evaluator-error' && row.axes.execution === 'unrunnable' && row.observation === null && row.reasonCode === classification.reason, 'Stored row disagrees with raw unrunnable classification');
  } else {
    assert(row.axes.evaluator === 'evaluated' && row.axes.execution === classification.status && row.reasonCode === null, 'Stored row disagrees with raw trusted classification');
    const result = classification.result;
    assert(row.specDigest === result.specDigest && row.planDigest === result.planDigest && row.targetArtifactDigest === result.targetArtifactDigest, 'Stored row digest binding differs from raw trusted result');
    const expectedIdentity = classification.status === 'candidate-failure' ? phase4ViolationIdentityDigest(result.violationIdentity) : null;
    const observation = { normalizedObservedKind: result.observedKind, normalizedObservedFields: result.observedFields, violationIdentity: expectedIdentity, resultPayloadDigest: result.payloadDigest };
    assert(canonicalJson(row.observation) === canonicalJson(observation), 'Stored row observation differs from raw trusted result');
  }
  return Object.freeze({ record, classification });
}

export function validatePhase4Evidence(evidence, registration) {
  strict(evidence, ['schemaVersion', 'mode', 'epochClosure', 'authorBundle', 'executionManifest', 'scorerInput', 'checkedScore', 'artifacts'], 'Phase 4 evidence');
  assert(evidence.schemaVersion === PHASE4_EVIDENCE_SCHEMA_VERSION, 'Unexpected Phase 4 evidence schemaVersion');
  assert(['synthetic', 'measured'].includes(evidence.mode), 'Phase 4 evidence mode is invalid');
  validatePhase4EpochClosure(evidence.epochClosure, registration);
  validatePhase4AuthorBundle(evidence.authorBundle, registration);
  validatePhase4ExecutionManifest(evidence.executionManifest, registration);
  assert(Array.isArray(evidence.artifacts), 'Evidence artifacts must be an array');
  const artifactMap = new Map();
  for (const artifact of evidence.artifacts) {
    strict(artifact, ['path', 'sha256', 'bytesBase64'], 'Evidence artifact');
    assert(typeof artifact.path === 'string' && !artifact.path.startsWith('/') && !artifact.path.includes('..') && !artifactMap.has(artifact.path), 'Evidence artifact path is unsafe or duplicated');
    sha(artifact.sha256, 'Evidence artifact digest');
    const bytes = Buffer.from(artifact.bytesBase64, 'base64');
    assert(bytes.toString('base64') === artifact.bytesBase64, `Evidence artifact is not canonical base64: ${artifact.path}`);
    assert(digestBytes(bytes) === artifact.sha256, `Evidence artifact digest mismatch: ${artifact.path}`);
    artifactMap.set(artifact.path, { ...artifact, bytes });
  }
  const rows = evidence.scorerInput.measurementRows;
  assert(canonicalJson(evidence.scorerInput.metricEligibleTruthIds) === canonicalJson(registration.universe.metricEligibleRowIds), 'Scorer metric universe differs from sealed registration');
  assert(canonicalJson(evidence.scorerInput.retentionRows.map((row) => row.rowId)) === canonicalJson(registration.universe.retentionDenominatorRowIds), 'Scorer retention denominator differs from sealed registration');
  assert(Array.isArray(rows) && rows.length === evidence.executionManifest.entries.length, 'Normalized row ledger is incomplete');
  for (const [index, row] of rows.entries()) {
    validatePhase4MeasurementRow(row);
    assert(canonicalJson(rowCoordinate(row)) === canonicalJson(evidence.executionManifest.entries[index]), `Normalized row order differs at sequence ${index}`);
    if (row.budget.charged) assert(row.runRecordRef !== null, `Charged row is missing its run record: ${row.sequence}`);
    if (row.runRecordRef !== null) {
      const artifact = artifactMap.get(row.runRecordRef);
      assert(artifact !== undefined, `Missing run record artifact: ${row.runRecordRef}`);
      validatePhase4RawRunRecord(parseJsonBytes(artifact.bytes), row);
    }
  }
  const referencedArtifacts = new Set(rows.filter((row) => row.runRecordRef !== null).map((row) => row.runRecordRef));
  assert([...artifactMap.keys()].every((path) => referencedArtifacts.has(path)), 'Evidence contains an unreferenced run record artifact');
  validatePhase4BudgetLedger(evidence.scorerInput.budgetLedger);
  const recomputed = scorePhase4Benchmark(evidence.scorerInput);
  assert(canonicalJson(recomputed) === canonicalJson(evidence.checkedScore), 'Checked scorer output differs from independent recomputation');
  return Object.freeze({ status: `${evidence.mode}-evidence-structure-valid`, completionClaimAllowed: false, epochId: evidence.epochClosure.epochId, score: recomputed });
}

export function validatePhase4FrozenInputs({ universe, truthCommitments, comparisonInputs }, scorerInput, registration) {
  strict(universe, ['schemaVersion', 'status', 'targetRevision', 'sources', 'metricEligibleTruthIds', 'retentionRows', 'developmentDiagnostics', 'blockedRows', 'auditRows', 'runtimeOutcomeMayChangeMembership', 'measurementState'], 'Frozen benchmark universe');
  strict(truthCommitments, ['schemaVersion', 'status', 'targetRevision', 'artifactBinding', 'expectedSemantics', 'expectedDerivation', 'commitments', 'provenanceByCanonicalTruthId', 'runtimeOutcomeMayChangeExpectedIdentity', 'measurementState'], 'Frozen truth commitments');
  strict(comparisonInputs, ['schemaVersion', 'status', 'targetRevision', 'artifactBinding', 'pairedInputRule', 'rows', 'developmentDiagnostics', 'runtimeOutcomeMayChangeInputMembership', 'measurementState'], 'Frozen comparison inputs');
  assert(universe.schemaVersion === 'bug-dreamer/v03-benchmark-universe/v1' && truthCommitments.schemaVersion === 'bug-dreamer/v03-benchmark-truth-commitments/v1' && comparisonInputs.schemaVersion === 'bug-dreamer/v03-benchmark-comparison-inputs/v1', 'Frozen Phase 4 input schema changed');
  assert([universe, truthCommitments, comparisonInputs].every((item) => item.status === 'source-reviewed-unmeasured' && item.targetRevision === registration.target.revision && item.measurementState === 'not-started'), 'Frozen Phase 4 input provenance changed');
  assert(universe.runtimeOutcomeMayChangeMembership === false && truthCommitments.runtimeOutcomeMayChangeExpectedIdentity === false && comparisonInputs.runtimeOutcomeMayChangeInputMembership === false, 'Runtime outcome can alter a frozen Phase 4 input');
  assert(canonicalJson(universe.metricEligibleTruthIds) === canonicalJson(registration.universe.metricEligibleRowIds) && canonicalJson(universe.metricEligibleTruthIds) === canonicalJson(scorerInput.metricEligibleTruthIds), 'Frozen metric universe differs from registration or scorer input');
  assert(canonicalJson(universe.retentionRows.map((row) => row.rowId)) === canonicalJson(registration.universe.retentionDenominatorRowIds), 'Frozen retention row IDs differ from registration');
  assert(canonicalJson(universe.retentionRows) === canonicalJson(scorerInput.retentionRows), 'Frozen retention row identities differ from scorer input');
  assert(canonicalJson(truthCommitments.commitments) === canonicalJson(scorerInput.truthCommitments), 'Frozen truth commitments differ from scorer input');
  assert(Array.isArray(comparisonInputs.rows) && comparisonInputs.rows.length === universe.retentionRows.length, 'Frozen comparison inputs do not cover the retention universe');
  for (const [index, row] of comparisonInputs.rows.entries()) {
    const retention = universe.retentionRows[index];
    const truth = truthCommitments.commitments[index];
    assert(row.rowId === retention.rowId && row.moduleId === retention.moduleId && row.rowId === truth.canonicalTruthId && row.invariantRegistrationId === truth.invariantRegistrationId, `Frozen comparison input identity differs at row ${index}`);
  }
  return Object.freeze({ universe, truthCommitments, comparisonInputs });
}

function closureFileDigest(closure, relativePath) {
  assert(object(closure) && Array.isArray(closure.files), 'Preparation infrastructure closure is invalid');
  const entries = closure.files.filter((file) => file.path === relativePath);
  assert(entries.length === 1 && typeof entries[0].sha256 === 'string', `Preparation infrastructure closure is missing ${relativePath}`);
  return entries[0].sha256;
}

export async function validatePhase4PreparationEvidence(repositoryRoot, preparation, registration, epochClosure, frozenBytes) {
  strict(preparation, ['schemaVersion', 'status', 'targetRevision', 'buildPlan', 'artifactFactory', 'sourceClosures', 'canonicalizer', 'fixtureClosure', 'images', 'syntheticSmoke', 'ledger'], 'Phase 4 preparation evidence');
  assert(preparation.schemaVersion === 'bug-dreamer/v03-benchmark-preparation-evidence/v1' && preparation.status === 'prepared' && preparation.targetRevision === registration.target.revision, 'Phase 4 preparation did not complete for the registered target');
  strict(preparation.artifactFactory, ['tag', 'imageId', 'labels', 'extraction', 'receiptSha256', 'receipt'], 'Artifact factory evidence');
  assert(/^sha256:[0-9a-f]{64}$/u.test(preparation.artifactFactory.imageId), 'Artifact factory evidence is not pinned by image ID');
  assert(preparation.artifactFactory.labels?.['org.bug-dreamer.target-revision'] === registration.target.revision && preparation.artifactFactory.labels?.['org.bug-dreamer.artifact-factory'] === 'true', 'Artifact factory labels differ from the registered target');
  strict(preparation.artifactFactory.extraction, ['exitCode', 'timedOut', 'outputTruncated', 'stdout', 'stderr'], 'Artifact factory extraction');
  assert(preparation.artifactFactory.extraction.exitCode === 0 && preparation.artifactFactory.extraction.timedOut === false && preparation.artifactFactory.extraction.outputTruncated === false, 'Artifact factory extraction did not complete cleanly');
  sha(preparation.artifactFactory.receiptSha256, 'Artifact factory receipt digest');
  assert(Array.isArray(preparation.buildPlan.artifactSetIds) && Array.isArray(preparation.images) && preparation.images.length === preparation.buildPlan.artifactSetIds.length, 'Preparation image set differs from its build plan');
  assert(canonicalJson(preparation.images.map((image) => image.artifactSetId)) === canonicalJson(preparation.buildPlan.artifactSetIds), 'Preparation image order differs from its build plan');
  unique(preparation.images.map((image) => image.artifactSetId), 'Preparation artifact set IDs');
  assert(Array.isArray(preparation.artifactFactory.receipt?.sets) && canonicalJson(preparation.artifactFactory.receipt.sets.map((set) => set.id)) === canonicalJson(preparation.buildPlan.artifactSetIds), 'Artifact factory receipt differs from the build plan');
  const packageIntegrityBytes = phase4PackageIntegrityReceiptBytes(preparation.canonicalizer);
  const actualClosures = await validatePhase4PreparationSourceClosure(repositoryRoot, {
    directEntrypoints: ['harness-v0.3/benchmark/direct-main.mjs'],
    interpreterEntrypoints: ['harness-v0.3/benchmark/interpreter-main.mjs'],
    packageIntegrityBytes,
  }, epochClosure);
  assert(canonicalJson(preparation.sourceClosures) === canonicalJson(actualClosures.sources), 'Preparation source closure receipt differs from repository files');
  assert(canonicalJson(preparation.canonicalizer) === canonicalJson(actualClosures.canonicalizer), 'Preparation canonicalizer receipt differs from repository package');
  const fixedInputs = [
    [PHASE4_UNIVERSE_PATH, frozenBytes.universeBytes],
    [PHASE4_TRUTH_COMMITMENTS_PATH, frozenBytes.truthCommitmentBytes],
    [PHASE4_COMPARISON_INPUTS_PATH, frozenBytes.comparisonInputsBytes],
  ];
  for (const image of preparation.images) {
    strict(image, ['artifactSetId', 'tag', 'imageId', 'contractKey', 'lockfileSha256', 'changedIntegrity', 'buildInputs'], `Prepared image ${image.artifactSetId}`);
    assert(/^sha256:[0-9a-f]{64}$/u.test(image.imageId), `Prepared image is not pinned: ${image.artifactSetId}`);
    sha(image.contractKey, `Prepared image contract key ${image.artifactSetId}`);
    assert(image.buildInputs.artifactSetId === image.artifactSetId && image.contractKey === benchmarkImageContractKey(image.buildInputs), `Prepared image contract key mismatch: ${image.artifactSetId}`);
    const factorySet = preparation.artifactFactory.receipt.sets.find((set) => set.id === image.artifactSetId);
    assert(factorySet !== undefined && canonicalJson(factorySet.artifactDigests) === canonicalJson(image.buildInputs.artifactDigests), `Prepared artifact digests differ from the factory receipt: ${image.artifactSetId}`);
    assert(image.lockfileSha256 === image.buildInputs.lockfileSha256 && image.buildInputs.targetRevision === registration.target.revision && image.buildInputs.registrationSha256 === registration.target.registrationSha256 && image.buildInputs.inventorySha256 === registration.sourceArtifacts.inventoryDraft.sha256 && image.buildInputs.approvedStaticPolicySha256 === registration.sourceArtifacts.approvedPolicyDraft.sha256 && image.buildInputs.manifestSha256 === digestBytes(frozenBytes.defectManifestBytes) && image.buildInputs.artifactFactoryReceiptSha256 === preparation.artifactFactory.receiptSha256, `Prepared image build-input receipt mismatch: ${image.artifactSetId}`);
    assert(canonicalJson(image.buildInputs.sourceClosures) === canonicalJson(preparation.sourceClosures) && canonicalJson(image.buildInputs.canonicalizer) === canonicalJson(preparation.canonicalizer), `Prepared image source closure mismatch: ${image.artifactSetId}`);
    for (const [relativePath, bytes] of fixedInputs) assert(closureFileDigest(image.buildInputs.infrastructureClosure, relativePath) === digestBytes(bytes), `Prepared image did not seal ${relativePath}: ${image.artifactSetId}`);
  }
  assert(canonicalJson(phase4PreparedImageIdentities(preparation)) === canonicalJson(registration.images), 'Prepared image identities differ from sealed registration');
  strict(preparation.ledger, ['schemaVersion', 'builds', 'inspects', 'probeContainers', 'failures', 'cleanups', 'cleanupFailures', 'elapsedSeconds', 'stoppedBy'], 'Preparation ledger');
  assert(preparation.ledger.schemaVersion === 'bug-dreamer/v03-benchmark-preparation/v1' && preparation.ledger.failures === 0 && preparation.ledger.cleanupFailures === 0 && preparation.ledger.stoppedBy === null, 'Preparation ledger contains a failed attempt');
  assert(preparation.ledger.builds <= PHASE4_APPROVED_BUDGETS.preparation.dockerBuildMaximum && preparation.ledger.inspects + preparation.ledger.probeContainers <= PHASE4_APPROVED_BUDGETS.preparation.dockerInspectOrProbeMaximum && preparation.ledger.elapsedSeconds <= PHASE4_APPROVED_BUDGETS.preparation.monotonicWallClockSecondsMaximum, 'Preparation ledger exceeded its approved budget');
  return Object.freeze({ preparation, actualClosures });
}

export function validatePhase4PreparedRunBinding(record, row, preparation) {
  const artifactSetId = row.artifactRole === 'clean' ? 'clean' : row.canonicalTruthId;
  const image = preparation.images.find((item) => item.artifactSetId === artifactSetId);
  assert(image !== undefined, `Prepared artifact set is missing for row ${row.sequence}: ${artifactSetId}`);
  const artifactDigest = image.buildInputs.artifactDigests[row.moduleId];
  assert(record.imageId === image.imageId && record.evaluationContractKey === image.contractKey && record.artifact.evaluationContractKey === image.contractKey && record.artifact.targetArtifactDigest === artifactDigest && row.targetArtifactDigest === artifactDigest, `Raw run identity differs from preparation receipt at row ${row.sequence}`);
  return image;
}

export function validateActualPhase4BenchmarkReadiness(registration) {
  validatePhase4Registration(registration);
  assert(registration.status === 'sealed' && registration.readiness.measurementReady, `Phase 4 benchmark is not measurement-ready: ${registration.readiness.blockers.join(',')}`);
  assert(registration.benchmarkEpochId !== null, 'Phase 4 benchmark epoch is not sealed');
  return registration;
}

async function defaultGitQuery(repositoryRoot, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  return stdout.trim();
}

async function defaultGitFileQuery(repositoryRoot, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function validatePhase4GitCheckpointOrder(repositoryRoot, registration, { gitQuery = defaultGitQuery } = {}) {
  validateActualPhase4BenchmarkReadiness(registration);
  assert(typeof repositoryRoot === 'string' && repositoryRoot.length > 0 && typeof gitQuery === 'function', 'Git checkpoint validator input is invalid');
  const { commitA, commitB, sealedRef } = registration.checkpoints;
  try {
    await gitQuery(repositoryRoot, ['cat-file', '-e', `${commitA}^{commit}`]);
    await gitQuery(repositoryRoot, ['cat-file', '-e', `${commitB}^{commit}`]);
    await gitQuery(repositoryRoot, ['merge-base', '--is-ancestor', commitA, commitB]);
    const resolved = await gitQuery(repositoryRoot, ['rev-parse', '--verify', `${sealedRef}^{commit}`]);
    assert(resolved === commitB, 'Immutable tag does not resolve to Checkpoint B');
  } catch (error) {
    if (error instanceof V03BenchmarkValidationError) throw error;
    fail(`Checkpoint A is not an ancestor of Checkpoint B or Git evidence is missing: ${error.message}`);
  }
  return Object.freeze({ checkpointA: commitA, checkpointB: commitB, sealedRef, ordered: true });
}

export async function validatePhase4GitCheckpointContents(repositoryRoot, registration, { authorBundleBytes, executionManifestBytes }, { gitFileQuery = defaultGitFileQuery } = {}) {
  validateActualPhase4BenchmarkReadiness(registration);
  assert(Buffer.isBuffer(authorBundleBytes) && Buffer.isBuffer(executionManifestBytes), 'Checkpoint B file bytes are missing');
  assert(typeof gitFileQuery === 'function', 'Git file validator input is invalid');
  try {
    const [committedAuthorBundle, committedExecutionManifest] = await Promise.all([
      gitFileQuery(repositoryRoot, ['show', `${registration.checkpoints.commitB}:${PHASE4_AUTHOR_BUNDLE_PATH}`]),
      gitFileQuery(repositoryRoot, ['show', `${registration.checkpoints.commitB}:${PHASE4_EXECUTION_MANIFEST_PATH}`]),
    ]);
    assert(Buffer.isBuffer(committedAuthorBundle) && committedAuthorBundle.equals(authorBundleBytes), 'Author bundle bytes differ from Checkpoint B');
    assert(Buffer.isBuffer(committedExecutionManifest) && committedExecutionManifest.equals(executionManifestBytes), 'Execution manifest bytes differ from Checkpoint B');
  } catch (error) {
    if (error instanceof V03BenchmarkValidationError) throw error;
    fail(`Checkpoint B benchmark files are missing: ${error.message}`);
  }
  return Object.freeze({ checkpointB: registration.checkpoints.commitB, authorBundlePath: PHASE4_AUTHOR_BUNDLE_PATH, executionManifestPath: PHASE4_EXECUTION_MANIFEST_PATH });
}

async function readRequiredRepositoryFile(repositoryRoot, relativePath) {
  try {
    const absolutePath = resolveContainedPath(repositoryRoot, relativePath);
    await assertNoSymlinkAncestors(repositoryRoot, absolutePath);
    return await readFile(absolutePath);
  } catch (error) {
    fail(`Required Phase 4 file is missing or unsafe: ${relativePath}: ${error.message}`);
  }
}

export async function validateActualPhase4Benchmark(repositoryRoot, {
  gitQuery = defaultGitQuery,
  gitFileQuery = defaultGitFileQuery,
  registrationLoader = loadPhase4Registration,
  repositoryFileReader = readRequiredRepositoryFile,
  preparationValidator = validatePhase4PreparationEvidence,
  preparedRunValidator = validatePhase4PreparedRunBinding,
} = {}) {
  let loaded;
  try {
    loaded = await registrationLoader(repositoryRoot);
  } catch (error) {
    fail(`Phase 4 registration closure is invalid: ${error.message}`);
  }
  const { registration } = loaded;
  validateActualPhase4BenchmarkReadiness(registration);
  const [authorBundleBytes, executionManifestBytes, epochBytes, scoreBytes, measurementBytes, preparationBytes, universeBytes, truthCommitmentBytes, comparisonInputsBytes, defectManifestBytes] = await Promise.all([
    repositoryFileReader(repositoryRoot, PHASE4_AUTHOR_BUNDLE_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_EXECUTION_MANIFEST_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_EPOCH_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_SCORE_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_MEASUREMENT_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_PREPARATION_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_UNIVERSE_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_TRUTH_COMMITMENTS_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_COMPARISON_INPUTS_PATH),
    repositoryFileReader(repositoryRoot, PHASE4_DEFECT_MANIFEST_PATH),
  ]);
  assert(registration.universe.truthCommitmentRef.path === PHASE4_TRUTH_COMMITMENTS_PATH, 'Registration truth commitment path is not the fixed Phase 4 file');
  assert(digestBytes(truthCommitmentBytes) === registration.universe.truthCommitmentRef.sha256, 'Truth commitment file digest mismatch');
  const authorBundle = parseJsonBytes(authorBundleBytes);
  const executionManifest = parseJsonBytes(executionManifestBytes);
  const epochClosure = parseJsonBytes(epochBytes);
  const checkedScore = parseJsonBytes(scoreBytes);
  const scorerInput = parseJsonBytes(measurementBytes);
  const preparation = parseJsonBytes(preparationBytes);
  const frozenInputs = {
    universe: parseJsonBytes(universeBytes),
    truthCommitments: parseJsonBytes(truthCommitmentBytes),
    comparisonInputs: parseJsonBytes(comparisonInputsBytes),
  };
  assert(Array.isArray(scorerInput.measurementRows), 'Measurement file has no normalized row ledger');
  validatePhase4FrozenInputs(frozenInputs, scorerInput, registration);
  await preparationValidator(repositoryRoot, preparation, registration, epochClosure, { universeBytes, truthCommitmentBytes, comparisonInputsBytes, defectManifestBytes });
  const runRefs = [...new Set(scorerInput.measurementRows.filter((row) => row.runRecordRef !== null).map((row) => row.runRecordRef))];
  for (const ref of runRefs) assert(/^evidence\/v0\.3\/phase4\/runs\/[0-9]{6}\.json$/u.test(ref), `Measured run record ref is not a fixed Phase 4 path: ${ref}`);
  const runRecords = new Map();
  const artifacts = await Promise.all(runRefs.map(async (ref) => {
    const bytes = await repositoryFileReader(repositoryRoot, ref);
    const record = parseJsonBytes(bytes);
    assert(record.ref === ref && ref === `evidence/v0.3/phase4/runs/${String(record.sequence).padStart(6, '0')}.json`, `Measured run record path disagrees with its sequence: ${ref}`);
    runRecords.set(ref, record);
    return { path: ref, sha256: digestBytes(bytes), bytesBase64: bytes.toString('base64') };
  }));
  await validatePhase4GitCheckpointOrder(repositoryRoot, registration, { gitQuery });
  await validatePhase4GitCheckpointContents(repositoryRoot, registration, { authorBundleBytes, executionManifestBytes }, { gitFileQuery });
  const result = validatePhase4Evidence({
    schemaVersion: PHASE4_EVIDENCE_SCHEMA_VERSION,
    mode: 'measured',
    epochClosure,
    authorBundle,
    executionManifest,
    scorerInput,
    checkedScore,
    artifacts,
  }, registration);
  for (const row of scorerInput.measurementRows) if (row.runRecordRef !== null) preparedRunValidator(runRecords.get(row.runRecordRef), row, preparation);
  return Object.freeze({ ...result, files: Object.freeze({
    authorBundle: PHASE4_AUTHOR_BUNDLE_PATH,
    executionManifest: PHASE4_EXECUTION_MANIFEST_PATH,
    epoch: PHASE4_EPOCH_PATH,
    score: PHASE4_SCORE_PATH,
    measurement: PHASE4_MEASUREMENT_PATH,
    preparation: PHASE4_PREPARATION_PATH,
    universe: PHASE4_UNIVERSE_PATH,
    truthCommitments: PHASE4_TRUTH_COMMITMENTS_PATH,
    comparisonInputs: PHASE4_COMPARISON_INPUTS_PATH,
    runRecords: Object.freeze(runRefs),
  }) });
}

export async function validatePhase4PreparationSourceClosure(repositoryRoot, { directEntrypoints, interpreterEntrypoints, packageIntegrityBytes }, epochClosure) {
  assert(typeof repositoryRoot === 'string' && repositoryRoot.length > 0, 'Preparation source root is invalid');
  assert(Array.isArray(directEntrypoints) && directEntrypoints.length > 0 && Array.isArray(interpreterEntrypoints) && interpreterEntrypoints.length > 0, 'Preparation entrypoints are incomplete');
  assert(Buffer.isBuffer(packageIntegrityBytes) && packageIntegrityBytes.length > 0, 'Package integrity receipt bytes are missing');
  const [sources, canonicalizer] = await Promise.all([
    benchmarkImportClosures(repositoryRoot, { directEntrypoints, interpreterEntrypoints }),
    canonicalizerClosure(repositoryRoot),
  ]);
  assert(sources.direct.aggregateSha256 === epochClosure.sourceClosures.direct, 'Direct source closure digest mismatch');
  assert(sources.interpreter.aggregateSha256 === epochClosure.sourceClosures.interpreter, 'Interpreter source closure digest mismatch');
  assert(sources.shared.aggregateSha256 === epochClosure.sourceClosures.shared, 'Shared primitive closure digest mismatch');
  assert(canonicalizer.aggregateSha256 === epochClosure.sourceClosures.canonicalizer, 'Canonicalizer file closure digest mismatch');
  assert(digestBytes(packageIntegrityBytes) === epochClosure.sourceClosures.packageIntegrity, 'Package integrity closure digest mismatch');
  return Object.freeze({ sources, canonicalizer, packageIntegritySha256: digestBytes(packageIntegrityBytes) });
}
