import { createHash } from 'node:crypto';
import { chmod, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  PHASE4_APPROVED_BUDGETS,
  PHASE4_ARM_IDS,
  PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION,
  PHASE4_MODULE_IDS,
  phase4ViolationIdentityDigest,
  phase4RegistrationReadiness,
  validatePhase4BudgetLedger,
  validatePhase4MeasurementRow,
  validatePhase4Registration,
} from './v03-benchmark-contract.mjs';
import { classifyBenchmarkTrustedResult } from './v03-benchmark-trust.mjs';
import { createCaseRunner } from './v03-runner.mjs';

export const PHASE4_DOCKER_ISOLATION_ARGS = Object.freeze([
  '--pull', 'never', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m',
  '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
]);
export const PHASE4_CONTAINER_INPUT = '/run/bug-dreamer/input';
export const PHASE4_CONTAINER_RESULT = '/run/bug-dreamer/result';
export const PHASE4_DIRECT_MAIN = '/consumer/evaluator/source/harness-v0.3/benchmark/direct-main.mjs';
export const PHASE4_INTERPRETER_MAIN = '/consumer/evaluator/source/harness-v0.3/benchmark/interpreter-main.mjs';
export const PHASE4_RAW_RUN_RECORD_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-raw-run-record/v1';

const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const EXECUTION_PATH = Object.freeze({ D: 'comparison', G: 'interpreter', P: 'interpreter', A: 'interpreter', B: 'interpreter', C: 'interpreter', E: 'interpreter' });

export class V03BenchmarkRunnerError extends Error {}

function fail(message) { throw new V03BenchmarkRunnerError(message); }
function assert(condition, message) { if (!condition) fail(message); }
function validId(value) { return typeof value === 'string' && ID.test(value); }
function validSha(value) { return typeof value === 'string' && SHA256.test(value); }
function moduleOrder(value) { return PHASE4_MODULE_IDS.indexOf(value); }
function codeUnitOrder(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function assertMeasurementReady(registration, { resolvedSealedRef = null } = {}) {
  validatePhase4Registration(registration);
  const readiness = phase4RegistrationReadiness(registration);
  assert(registration.status === 'sealed' && readiness.measurementReady, `Phase 4 measurement is forbidden: ${readiness.blockers.join(',') || 'registration-not-sealed'}`);
  if (resolvedSealedRef !== null) assert(resolvedSealedRef === registration.checkpoints.commitB, 'Sealed ref does not resolve to Checkpoint B');
  return registration;
}

function safeAbsoluteDirectory(value, label) {
  assert(typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path`);
  return value;
}

export function buildBenchmarkDockerArgs({ containerName, imageId, inputDirectory, resultDirectory, executionPath }) {
  assert(validId(containerName), 'Container name is invalid');
  assert(typeof imageId === 'string' && /^sha256:[0-9a-f]{64}$/u.test(imageId), 'Benchmark image must be pinned by image ID');
  safeAbsoluteDirectory(inputDirectory, 'Input directory');
  safeAbsoluteDirectory(resultDirectory, 'Result directory');
  assert(['comparison', 'interpreter'].includes(executionPath), 'Execution path is invalid');
  const entrypoint = executionPath === 'comparison' ? PHASE4_DIRECT_MAIN : PHASE4_INTERPRETER_MAIN;
  return [
    'run', '--rm', '--name', containerName,
    ...PHASE4_DOCKER_ISOLATION_ARGS,
    '--mount', `type=bind,src=${inputDirectory},dst=${PHASE4_CONTAINER_INPUT},readonly`,
    '--mount', `type=bind,src=${resultDirectory},dst=${PHASE4_CONTAINER_RESULT}`,
    '--entrypoint', 'node', imageId, entrypoint,
    `${PHASE4_CONTAINER_INPUT}/case.json`, `${PHASE4_CONTAINER_RESULT}/result.json`,
  ];
}

function validateLogicalCase(item, allowedArms) {
  assert(item !== null && typeof item === 'object' && !Array.isArray(item), 'Logical benchmark case must be an object');
  const keys = ['armId', 'moduleId', 'inputId', 'canonicalTruthId', 'duplicateGroup', 'artifacts'];
  assert(JSON.stringify(Object.keys(item).sort()) === JSON.stringify(keys.sort()), 'Logical benchmark case fields changed');
  assert(allowedArms.includes(item.armId) && PHASE4_MODULE_IDS.includes(item.moduleId), 'Logical benchmark case arm or module is invalid');
  for (const key of ['inputId', 'canonicalTruthId', 'duplicateGroup']) assert(validId(item[key]), `Logical benchmark case ${key} is invalid`);
  const artifactKeys = Object.keys(item.artifacts).sort();
  assert(JSON.stringify(artifactKeys) === JSON.stringify(['clean', 'single-patch-defect']), 'Logical benchmark case artifacts changed');
  for (const role of artifactKeys) {
    const artifact = item.artifacts[role];
    assert(artifact.role === role && validSha(artifact.targetArtifactDigest) && validSha(artifact.evaluationContractKey) && /^sha256:[0-9a-f]{64}$/u.test(artifact.imageId), `Logical benchmark case ${role} artifact is invalid`);
  }
  return item;
}

function ordered(items) {
  return [...items].sort((left, right) => moduleOrder(left.moduleId) - moduleOrder(right.moduleId)
    || codeUnitOrder(left.inputId, right.inputId) || codeUnitOrder(left.canonicalTruthId, right.canonicalTruthId));
}

export function buildPhase4AuditLedger(inventory, registration) {
  validatePhase4Registration(registration);
  assert(Array.isArray(inventory?.rows) && inventory.rows.length === 20, 'Phase 4 audit inventory must contain 20 rows');
  const eligible = new Set(registration.universe.metricEligibleRowIds ?? []);
  const retention = new Set(registration.universe.retentionDenominatorRowIds ?? []);
  const partition = new Map([
    ...registration.universe.development.map((id) => [id, 'development']),
    ...registration.universe.existingPublic.map((id) => [id, 'existingPublic']),
    ...registration.universe.heldOutTemporal.map((id) => [id, 'heldOutTemporal']),
  ]);
  assert(partition.size === 20 && inventory.rows.every((row) => partition.has(row.id)), 'Registration partitions do not preserve the 20-row audit universe');
  return inventory.rows.map((row, index) => ({
    sequence: index,
    rowId: row.id,
    moduleId: row.module.replace(/^packages\//u, ''),
    partition: partition.get(row.id),
    duplicateGroup: row.duplicate.group,
    metricEligible: eligible.has(row.id),
    retentionEligible: retention.has(row.id),
    status: registration.universe.metricEligibleRowIds === null ? 'pending-freeze' : eligible.has(row.id) ? 'eligible' : 'ineligible',
    reason: registration.universe.metricEligibleRowIds === null ? row.metricEligibility.proposed : eligible.has(row.id) ? null : 'not-in-frozen-metric-universe',
  }));
}

export function buildPhase4InitialSchedule({ generationCases, operatorCases, retentionCases }) {
  assert(generationCases !== null && typeof generationCases === 'object', 'Generation cases are missing');
  assert(Array.isArray(generationCases.G) && Array.isArray(generationCases.P) && Array.isArray(operatorCases) && Array.isArray(retentionCases), 'Benchmark case collections are invalid');
  const logical = [];
  for (const armId of ['G', 'P']) for (const item of ordered(generationCases[armId])) logical.push(validateLogicalCase(item, [armId]));
  const pSeeds = new Set(generationCases.P.map((item) => item.inputId));
  for (const armId of ['A', 'B', 'C']) {
    const armCases = ordered(operatorCases.filter((item) => item.armId === armId));
    for (const item of armCases) {
      validateLogicalCase(item, [armId]);
      assert(pSeeds.has(item.inputId), `${armId} does not use a frozen P seed`);
      logical.push(item);
    }
  }
  for (const armId of ['D', 'E']) {
    for (const source of ordered(retentionCases)) logical.push(validateLogicalCase({ ...source, armId }, [armId]));
  }
  const counts = new Map(PHASE4_ARM_IDS.map((arm) => [arm, logical.filter((item) => item.armId === arm).length]));
  for (const arm of ['G', 'P', 'A', 'B', 'C']) assert(counts.get(arm) <= 23, `${arm} initial case budget exceeds 46 evaluations`);
  for (const arm of ['D', 'E']) assert(counts.get(arm) <= 20, `${arm} retention case budget exceeds 40 evaluations`);
  return logical.flatMap((item) => ['clean', 'single-patch-defect'].map((artifactRole) => ({
    ...item,
    artifacts: undefined,
    artifactRole,
    artifact: item.artifacts[artifactRole],
    phase: 'initial',
    replayIndex: null,
    executionPath: EXECUTION_PATH[item.armId],
  }))).map(({ artifacts, ...item }) => item);
}

function coordinate(row, role) {
  return `${row.armId}\0${row.inputId}\0${row.canonicalTruthId}\0${role}`;
}

export function buildPhase4ReplaySchedule({ initialRows, initialSchedule, retentionCases, truthCommitments = [] }) {
  const rows = new Map(initialRows.filter((row) => row.phase === 'initial').map((row) => [coordinate(row, row.artifactRole), row]));
  const commitments = new Map(truthCommitments.map((item) => [item.canonicalTruthId, item]));
  assert(commitments.size === truthCommitments.length, 'Replay truth commitments contain duplicate IDs');
  const selectedCoordinates = new Set();
  for (const armId of ['G', 'P', 'A', 'B', 'C']) {
    const raw = initialRows.filter((row) => row.armId === armId && row.artifactRole === 'single-patch-defect' && row.axes.execution === 'candidate-failure')
      .filter((row) => rows.get(coordinate(row, 'clean'))?.axes.execution === 'pass')
      .filter((row) => {
        const commitment = commitments.get(row.canonicalTruthId);
        if (commitment === undefined || commitment.moduleId !== row.moduleId || commitment.duplicateGroup !== row.duplicateGroup) return false;
        const targetArtifactDigest = row.targetArtifactDigest ?? row.artifact?.targetArtifactDigest;
        return row.observation?.violationIdentity === phase4ViolationIdentityDigest({
          invariantRegistrationId: commitment.invariantRegistrationId,
          normalizedObservedKind: commitment.expected.normalizedObservedKind,
          normalizedObservedFields: commitment.expected.normalizedObservedFields,
          targetArtifactDigest,
        });
      })
      .sort((left, right) => moduleOrder(left.moduleId) - moduleOrder(right.moduleId)
        || codeUnitOrder(left.inputId, right.inputId) || codeUnitOrder(left.canonicalTruthId, right.canonicalTruthId));
    const seen = new Set();
    for (const row of raw) {
      if (seen.has(row.duplicateGroup)) continue;
      seen.add(row.duplicateGroup);
      if (seen.size <= 2) selectedCoordinates.add(coordinate(row, 'single-patch-defect'));
    }
  }
  const potential = initialSchedule.filter((item) => item.artifactRole === 'single-patch-defect' && ['G', 'P', 'A', 'B', 'C'].includes(item.armId));
  const retention = ordered(retentionCases).map((source) => {
    const item = initialSchedule.find((candidate) => candidate.armId === 'E' && candidate.inputId === source.inputId
      && candidate.canonicalTruthId === source.canonicalTruthId && candidate.artifactRole === 'single-patch-defect');
    assert(item !== undefined, `E initial row is missing: ${source.inputId}`);
    return item;
  });
  assert(selectedCoordinates.size + retention.length <= 30, 'Replay candidate budget exceeds 30');
  return [...potential, ...retention].flatMap((source) => {
    const replaySelected = source.armId === 'E' || selectedCoordinates.has(coordinate(source, 'single-patch-defect'));
    return Array.from({ length: 5 }, (_, index) => ({
    armId: source.armId,
    moduleId: source.moduleId,
    inputId: source.inputId,
    canonicalTruthId: source.canonicalTruthId,
    duplicateGroup: source.duplicateGroup,
    artifactRole: 'single-patch-defect',
    artifact: source.artifact,
    phase: 'replay',
    replayIndex: index + 1,
    executionPath: EXECUTION_PATH[source.armId],
    replaySelected,
    }));
  }).sort((left, right) => PHASE4_ARM_IDS.indexOf(left.armId) - PHASE4_ARM_IDS.indexOf(right.armId)
    || moduleOrder(left.moduleId) - moduleOrder(right.moduleId)
    || codeUnitOrder(left.inputId, right.inputId)
    || codeUnitOrder(left.canonicalTruthId, right.canonicalTruthId)
    || left.replayIndex - right.replayIndex);
}

function notRunRow(item, epochId, sequence, reasonCode) {
  return validatePhase4MeasurementRow({
    schemaVersion: PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION,
    epochId, sequence, armId: item.armId, moduleId: item.moduleId, inputId: item.inputId,
    canonicalTruthId: item.canonicalTruthId, duplicateGroup: item.duplicateGroup,
    artifactRole: item.artifactRole, targetArtifactDigest: item.artifact.targetArtifactDigest,
    phase: item.phase, replayIndex: item.replayIndex, executionPath: item.executionPath,
    specDigest: null, planDigest: null, runRecordRef: null,
    axes: { specAcceptance: 'accepted', plan: 'not-run', evaluator: 'not-run', execution: 'not-run' },
    observation: null, reasonCode, budget: { charged: false, evaluationOrdinal: null },
  });
}

function createLedger(epochId) {
  return {
    schemaVersion: 'bug-dreamer/v03-benchmark-budget-ledger/v1', epochId,
    generation: { freshSessions: 0, submittedTaskTurns: 0, emittedSeeds: 0, acceptedSeeds: 0, operatorRequests: 0, transformedSpecs: 0 },
    measurement: { dockerEvaluations: 0, replayCandidates: 0, replayRuns: 0, elapsedSeconds: 0 },
    preparation: { builds: 0, inspects: 0, probeContainers: 0, failures: 0, cleanups: 0, cleanupFailures: 0, elapsedSeconds: 0 },
    stoppedBy: null,
  };
}

export async function runPhase4Measurement({ registration, epochId, resolvedSealedRef = null, generationCases, operatorCases, retentionCases, truthCommitments = [], executeCase, mode = 'measurement', nowSeconds = () => 0 }) {
  assert(validSha(epochId) && typeof executeCase === 'function', 'Measurement epoch or executor is invalid');
  if (mode === 'measurement') {
    assert(resolvedSealedRef !== null, 'Measurement requires a resolved immutable sealed ref');
    assertMeasurementReady(registration, { resolvedSealedRef });
    assert(epochId === registration.benchmarkEpochId, 'Measurement epoch differs from the sealed registration');
  }
  else assert(mode === 'synthetic', 'Runner mode is invalid');
  const initialSchedule = buildPhase4InitialSchedule({ generationCases, operatorCases, retentionCases });
  const ledger = createLedger(epochId);
  const rows = [];
  const startedAt = nowSeconds();
  const execute = async (item) => {
    const sequence = rows.length;
    if (ledger.measurement.dockerEvaluations >= PHASE4_APPROVED_BUDGETS.measurement.dockerEvaluationMaximum
      || nowSeconds() - startedAt >= PHASE4_APPROVED_BUDGETS.measurement.monotonicWallClockSecondsMaximum) {
      ledger.stoppedBy ??= 'measurement-budget-exhausted';
      rows.push(notRunRow(item, epochId, sequence, 'budget-exhausted'));
      return;
    }
    const ordinal = ledger.measurement.dockerEvaluations + 1;
    ledger.measurement.dockerEvaluations = ordinal;
    if (item.phase === 'replay') ledger.measurement.replayRuns += 1;
    let row;
    try {
      row = await executeCase(item, { epochId, sequence, evaluationOrdinal: ordinal });
    } catch {
      row = {
        schemaVersion: PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION, epochId, sequence,
        armId: item.armId, moduleId: item.moduleId, inputId: item.inputId,
        canonicalTruthId: item.canonicalTruthId, duplicateGroup: item.duplicateGroup,
        artifactRole: item.artifactRole, targetArtifactDigest: item.artifact.targetArtifactDigest,
        phase: item.phase, replayIndex: item.replayIndex, executionPath: item.executionPath,
        specDigest: null, planDigest: null, runRecordRef: null,
        axes: { specAcceptance: 'accepted', plan: 'planner-error', evaluator: 'not-run', execution: 'not-run' },
        observation: null, reasonCode: 'runner-infrastructure', budget: { charged: true, evaluationOrdinal: ordinal },
      };
    }
    rows.push(validatePhase4MeasurementRow(row));
  };
  for (const item of initialSchedule) await execute(item);
  const replaySchedule = buildPhase4ReplaySchedule({ initialRows: rows, initialSchedule, retentionCases, truthCommitments });
  const replayCandidates = [];
  for (let index = 0; index < replaySchedule.length; index += 5) {
    const [candidate] = replaySchedule.slice(index, index + 5);
    if (!candidate.replaySelected) continue;
    replayCandidates.push({ armId: candidate.armId, inputId: candidate.inputId, canonicalTruthId: candidate.canonicalTruthId, started: false, expectedRuns: 5 });
  }
  for (const { replaySelected, ...item } of replaySchedule) {
    if (replaySelected) await execute(item);
    else rows.push(notRunRow(item, epochId, rows.length, 'replay-not-selected'));
  }
  for (const candidate of replayCandidates) {
    candidate.started = rows.filter((row) => row.phase === 'replay' && row.armId === candidate.armId
      && row.inputId === candidate.inputId && row.canonicalTruthId === candidate.canonicalTruthId).some((row) => row.budget.charged);
  }
  ledger.measurement.replayCandidates = replayCandidates.filter((candidate) => candidate.started).length;
  ledger.measurement.elapsedSeconds = Math.max(0, Math.floor(nowSeconds() - startedAt));
  validatePhase4BudgetLedger(ledger);
  return { synthetic: mode === 'synthetic', rows, replayCandidates, budgetLedger: ledger };
}

export function createIsolatedBenchmarkCaseRunner({ spawn, readResultChannel, writeCaseInput, makeDirectories }) {
  assert(typeof readResultChannel === 'function' && typeof writeCaseInput === 'function' && typeof makeDirectories === 'function', 'Isolated case runner dependencies are incomplete');
  const { timeoutMs: evaluationTimeoutMs, ...outputBudget } = PHASE4_APPROVED_BUDGETS.evaluation;
  const runCase = createCaseRunner({ spawn, budget: { evaluationTimeoutMs, ...outputBudget } });
  return async function runIsolatedBenchmarkCase(item, context) {
    assert(item !== null && typeof item === 'object' && ['comparison', 'interpreter'].includes(item.executionPath), 'Isolated benchmark case is invalid');
    const locations = await makeDirectories(item, context);
    safeAbsoluteDirectory(locations.inputDirectory, 'Isolated input directory');
    safeAbsoluteDirectory(locations.resultDirectory, 'Isolated result directory');
    const [inputMetadata, resultMetadata, resultEntries] = await Promise.all([
      lstat(locations.inputDirectory), lstat(locations.resultDirectory), readdir(locations.resultDirectory),
    ]);
    assert(inputMetadata.isDirectory() && resultMetadata.isDirectory(), 'Isolated case paths must be directories');
    assert(resultEntries.length === 0, 'Isolated result directory must start empty');
    await writeCaseInput(locations.inputDirectory, item, context);
    await Promise.all([
      chmod(locations.inputDirectory, 0o555),
      chmod(path.join(locations.inputDirectory, 'case.json'), 0o444),
      chmod(locations.resultDirectory, 0o733),
    ]);
    const containerName = `bd-p4-${String(context.sequence).padStart(4, '0')}`;
    const args = buildBenchmarkDockerArgs({ containerName, imageId: item.artifact.imageId, inputDirectory: locations.inputDirectory, resultDirectory: locations.resultDirectory, executionPath: item.executionPath });
    const execution = await runCase(args, containerName);
    const channel = await readResultChannel(locations.resultDirectory);
    return { item, context, execution, channel, locations, containerName, dockerArgs: args };
  };
}

export function createDockerCaseExecutor({ spawn, readResultChannel, classifyResult, writeCaseInput, makeDirectories }) {
  assert(typeof classifyResult === 'function', 'Docker executor classifier is missing');
  const runIsolatedCase = createIsolatedBenchmarkCaseRunner({ spawn, readResultChannel, writeCaseInput, makeDirectories });
  return async function executeDockerCase(item, context) {
    return classifyResult(await runIsolatedCase(item, context));
  };
}

function resultChannelEvidence(channel) {
  const present = Array.isArray(channel?.entries) && channel.entries.length === 1
    && channel.entries[0].name === 'result.json' && channel.entries[0].type === 'regular'
    && Buffer.isBuffer(channel.resultBytes);
  const bytes = present ? channel.resultBytes : null;
  return {
    present,
    regular: present,
    size: bytes?.length ?? 0,
    sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex'),
    bytesBase64: bytes === null ? null : bytes.toString('base64'),
  };
}

export function buildPhase4RawRunRecord({ item, context, execution, channel, dockerArgs, locations = context, containerName = `bd-p4-${String(context.sequence).padStart(4, '0')}`, ref, consumerSequences = [context.sequence], spec, plan, descriptor }) {
  assert(typeof ref === 'string' && !path.posix.isAbsolute(ref) && !ref.includes('..'), 'Raw run record ref is unsafe');
  assert(Array.isArray(dockerArgs) && dockerArgs.length > 0, 'Raw run Docker argv is missing');
  assert(Array.isArray(consumerSequences) && consumerSequences.includes(context.sequence), 'Raw run consumers omit their source sequence');
  return {
    schemaVersion: PHASE4_RAW_RUN_RECORD_SCHEMA_VERSION,
    sequence: context.sequence,
    consumerSequences: [...consumerSequences],
    ref,
    containerName,
    inputDirectory: safeAbsoluteDirectory(locations.inputDirectory, 'Raw run input directory'),
    resultDirectory: safeAbsoluteDirectory(locations.resultDirectory, 'Raw run result directory'),
    executionPath: item.executionPath,
    imageId: item.artifact.imageId,
    evaluationContractKey: item.artifact.evaluationContractKey,
    dockerArgs: [...dockerArgs],
    budget: { ...PHASE4_APPROVED_BUDGETS.evaluation },
    resultChannel: resultChannelEvidence(channel),
    process: {
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      outputTruncated: execution.outputTruncated,
      stdoutBytes: execution.stdoutBytes,
      stderrBytes: execution.stderrBytes,
    },
    cleanup: { succeeded: execution.cleanupError === null, reasonCode: execution.cleanupError },
    plan,
    spec,
    descriptor,
    artifact: {
      role: item.artifact.role,
      targetArtifactDigest: item.artifact.targetArtifactDigest,
      evaluationContractKey: item.artifact.evaluationContractKey,
    },
  };
}

export function normalizePhase4ExecutedCase({ item, context, execution, channel, spec, plan, descriptor, specDigest, planDigest, runRecordRef }) {
  const classification = classifyBenchmarkTrustedResult({
    resultBytes: channel.resultBytes,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    outputTruncated: execution.outputTruncated,
    plan,
    spec,
    descriptor,
    artifact: item.artifact,
  });
  const completed = classification.status !== 'unrunnable';
  const result = classification.result;
  return validatePhase4MeasurementRow({
    schemaVersion: PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION,
    epochId: context.epochId,
    sequence: context.sequence,
    armId: item.armId,
    moduleId: item.moduleId,
    inputId: item.inputId,
    canonicalTruthId: item.canonicalTruthId,
    duplicateGroup: item.duplicateGroup,
    artifactRole: item.artifactRole,
    targetArtifactDigest: item.artifact.targetArtifactDigest,
    phase: item.phase,
    replayIndex: item.replayIndex,
    executionPath: item.executionPath,
    specDigest: completed ? result.specDigest : specDigest,
    planDigest: completed ? result.planDigest : planDigest,
    runRecordRef,
    axes: {
      specAcceptance: 'accepted',
      plan: 'planned',
      evaluator: completed ? 'evaluated' : 'evaluator-error',
      execution: completed ? classification.status : 'unrunnable',
    },
    observation: completed ? {
      normalizedObservedKind: result.observedKind,
      normalizedObservedFields: result.observedFields,
      violationIdentity: classification.status === 'candidate-failure' ? phase4ViolationIdentityDigest(result.violationIdentity) : null,
      resultPayloadDigest: result.payloadDigest,
    } : null,
    reasonCode: completed ? null : classification.reason,
    budget: { charged: true, evaluationOrdinal: context.evaluationOrdinal },
  });
}
