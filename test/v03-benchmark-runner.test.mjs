import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PHASE4_DOCKER_ISOLATION_ARGS,
  V03BenchmarkRunnerError,
  assertMeasurementReady,
  buildBenchmarkDockerArgs,
  buildPhase4AuditLedger,
  buildPhase4InitialSchedule,
  buildPhase4ReplaySchedule,
  buildPhase4RawRunRecord,
  createIsolatedBenchmarkCaseRunner,
  normalizePhase4ExecutedCase,
  runPhase4Measurement,
} from '../src/v03-benchmark-runner.mjs';
import { PHASE4_APPROVED_BUDGETS, PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION, phase4ViolationIdentityDigest } from '../src/v03-benchmark-contract.mjs';
import { PHASE4_BENCHMARK_PATHS, runV03BenchmarkCli } from '../scripts/run-v03-benchmark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registration = JSON.parse(await readFile(path.join(root, 'benchmark/v0.3/registration.json')));
const inventory = JSON.parse(await readFile(path.join(root, 'benchmark/v0.3/phase4-inventory.draft.json')));
const sha = (character) => character.repeat(64);

function artifacts() {
  return {
    clean: { role: 'clean', targetArtifactDigest: sha('a'), evaluationContractKey: sha('b'), imageId: `sha256:${sha('c')}` },
    'single-patch-defect': { role: 'single-patch-defect', targetArtifactDigest: sha('d'), evaluationContractKey: sha('e'), imageId: `sha256:${sha('f')}` },
  };
}

function logical(armId, moduleId, inputId, truthId = `${moduleId}-truth`) {
  return { armId, moduleId, inputId, canonicalTruthId: truthId, duplicateGroup: truthId, artifacts: artifacts() };
}

function commitment(moduleId, truthId, duplicateGroup = truthId) {
  return {
    canonicalTruthId: truthId,
    moduleId,
    duplicateGroup,
    invariantRegistrationId: `${moduleId}.invariant/v1`,
    matcherId: `${moduleId}.matcher/v1`,
    expected: { normalizedObservedKind: 'returned-value', normalizedObservedFields: { value: 'expected' } },
  };
}

test('actual approved-unsealed registration fails closed before Docker measurement', () => {
  assert.throws(() => assertMeasurementReady(registration), (error) => error instanceof V03BenchmarkRunnerError && /measurement is forbidden/u.test(error.message));
});

test('public benchmark CLI owns only the frozen Phase 4 artifact paths', () => {
  assert.deepEqual(PHASE4_BENCHMARK_PATHS, {
    authorBundle: 'benchmark/v0.3/authoring/bundle.json',
    executionManifest: 'benchmark/v0.3/execution-manifest.json',
    epoch: 'benchmark/v0.3/epoch.json',
    preparationEvidence: 'evidence/v0.3/phase4-preparation.json',
    measurementEvidence: 'evidence/v0.3/phase4/measurement.json',
    score: 'benchmark/v0.3/results/score.json',
    runRecordPattern: 'evidence/v0.3/phase4/runs/000000.json',
  });
});

test('public benchmark CLI rejects the checked-in unsealed epoch before author or measurement access', async () => {
  await assert.rejects(() => runV03BenchmarkCli(root), /not measurement-ready/u);
});

test('measurement runner requires an independently resolved immutable ref before scheduling', async () => {
  await assert.rejects(() => runPhase4Measurement({
    registration, epochId: sha('9'),
    generationCases: { G: [], P: [] }, operatorCases: [], retentionCases: [], executeCase: async () => {},
  }), /resolved immutable sealed ref/u);
});

test('Docker argv pins the image and fixes every isolation boundary', () => {
  const args = buildBenchmarkDockerArgs({
    containerName: 'bd-p4-0001', imageId: `sha256:${sha('a')}`,
    inputDirectory: '/tmp/p4-input', resultDirectory: '/tmp/p4-result', executionPath: 'comparison',
  });
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.deepEqual(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2), ['--user', '1000:1000']);
  assert.deepEqual(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 2), ['--entrypoint', 'node']);
  for (const value of PHASE4_DOCKER_ISOLATION_ARGS) assert.ok(args.includes(value));
  assert.ok(args.includes('/consumer/evaluator/source/harness-v0.3/benchmark/direct-main.mjs'));
  assert.ok(args.includes(`sha256:${sha('a')}`));
  assert.equal(args.some((value) => value.includes('docker.sock') || value.includes('.env')), false);
  assert.throws(() => buildBenchmarkDockerArgs({ containerName: 'case', imageId: 'latest', inputDirectory: '/tmp/i', resultDirectory: '/tmp/r', executionPath: 'interpreter' }), /pinned by image ID/u);
});

test('initial schedule is arm then module then input and D/E are paired', () => {
  const schedule = buildPhase4InitialSchedule({
    generationCases: {
      G: [logical('G', 'prepaint', 'g-prepaint'), logical('G', 'tx', 'g-tx')],
      P: [logical('P', 'local-first', 'p-local')],
    },
    operatorCases: [logical('C', 'local-first', 'p-local'), logical('A', 'local-first', 'p-local'), logical('B', 'local-first', 'p-local')],
    retentionCases: [{ ...logical('D', 'tx', 'retention-one'), armId: undefined }],
  });
  assert.deepEqual(schedule.map((item) => item.armId).filter((arm, index, all) => index === 0 || arm !== all[index - 1]), ['G', 'P', 'A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(schedule.filter((item) => item.armId === 'D').map((item) => item.artifactRole), ['clean', 'single-patch-defect']);
  assert.deepEqual(schedule.filter((item) => item.armId === 'E').map((item) => item.artifactRole), ['clean', 'single-patch-defect']);
});

test('replay manifest slots are fixed before outcomes and only selection flags change', () => {
  const generationCases = { G: [logical('G', 'tx', 'g-one'), logical('G', 'tx', 'g-two', 'tx-other')], P: [] };
  const initialSchedule = buildPhase4InitialSchedule({ generationCases, operatorCases: [], retentionCases: [] });
  const truthCommitments = [commitment('tx', 'tx-truth'), commitment('tx', 'tx-other')];
  const expectedIdentity = phase4ViolationIdentityDigest({
    invariantRegistrationId: truthCommitments[0].invariantRegistrationId,
    ...truthCommitments[0].expected,
    targetArtifactDigest: artifacts()['single-patch-defect'].targetArtifactDigest,
  });
  const initialRows = (candidate) => initialSchedule.map((item, sequence) => ({
    ...item,
    sequence,
    axes: { execution: candidate && item.inputId === 'g-one' && item.artifactRole === 'single-patch-defect' ? 'candidate-failure' : 'pass' },
    observation: candidate && item.inputId === 'g-one' && item.artifactRole === 'single-patch-defect' ? { violationIdentity: expectedIdentity } : null,
  }));
  const withoutCandidate = buildPhase4ReplaySchedule({ initialRows: initialRows(false), initialSchedule, retentionCases: [], truthCommitments });
  const withCandidate = buildPhase4ReplaySchedule({ initialRows: initialRows(true), initialSchedule, retentionCases: [], truthCommitments });
  const coordinates = (items) => items.map(({ replaySelected, artifact, ...item }) => item);
  assert.deepEqual(coordinates(withCandidate), coordinates(withoutCandidate));
  assert.equal(withoutCandidate.every((item) => !item.replaySelected), true);
  assert.equal(withCandidate.filter((item) => item.replaySelected).length, 5);
});

test('a wrong violation identity cannot consume replay quota ahead of an exact commitment match', () => {
  const generationCases = { G: [logical('G', 'tx', 'g-one'), logical('G', 'tx', 'g-two', 'tx-other')], P: [] };
  const initialSchedule = buildPhase4InitialSchedule({ generationCases, operatorCases: [], retentionCases: [] });
  const truthCommitments = [commitment('tx', 'tx-truth'), commitment('tx', 'tx-other')];
  const initialRows = initialSchedule.map((item, sequence) => {
    const registered = truthCommitments.find((entry) => entry.canonicalTruthId === item.canonicalTruthId);
    const exact = phase4ViolationIdentityDigest({
      invariantRegistrationId: registered.invariantRegistrationId,
      ...registered.expected,
      targetArtifactDigest: item.artifact.targetArtifactDigest,
    });
    return {
      ...item,
      sequence,
      axes: { execution: item.artifactRole === 'clean' ? 'pass' : 'candidate-failure' },
      observation: item.artifactRole === 'clean' ? null : { violationIdentity: item.inputId === 'g-one' ? sha('0') : exact },
    };
  });
  const replay = buildPhase4ReplaySchedule({ initialRows, initialSchedule, retentionCases: [], truthCommitments });
  assert.equal(replay.filter((item) => item.inputId === 'g-one' && item.replaySelected).length, 0);
  assert.equal(replay.filter((item) => item.inputId === 'g-two' && item.replaySelected).length, 5);
});

test('audit ledger preserves all 20 rows while eligibility is unresolved', () => {
  const ledger = buildPhase4AuditLedger(inventory, registration);
  assert.equal(ledger.length, 20);
  assert.equal(new Set(ledger.map((row) => row.rowId)).size, 20);
  assert.ok(ledger.every((row) => row.status === 'pending-freeze' && row.metricEligible === false));
});

test('synthetic runner charges before calls and schedules five separate G and E replays', async () => {
  const generationCases = { G: [logical('G', 'tx', 'g-one')], P: [logical('P', 'local-first', 'p-one')] };
  const retentionCases = [{ ...logical('D', 'prepaint', 'retention-one', 'prepaint-truth'), armId: undefined }];
  const truthCommitments = [commitment('tx', 'tx-truth'), commitment('local-first', 'local-first-truth'), commitment('prepaint', 'prepaint-truth')];
  const calls = [];
  const executeCase = async (item, context) => {
    calls.push({ item, context });
    const candidate = item.artifactRole === 'single-patch-defect' && ['G', 'D', 'E'].includes(item.armId);
    return {
      schemaVersion: PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION,
      epochId: context.epochId, sequence: context.sequence, armId: item.armId, moduleId: item.moduleId,
      inputId: item.inputId, canonicalTruthId: item.canonicalTruthId, duplicateGroup: item.duplicateGroup,
      artifactRole: item.artifactRole, targetArtifactDigest: item.artifact.targetArtifactDigest,
      phase: item.phase, replayIndex: item.replayIndex, executionPath: item.executionPath,
      specDigest: sha('1'), planDigest: sha('2'), runRecordRef: `evidence/v0.3/phase4/runs/${context.sequence}.json`,
      axes: { specAcceptance: 'accepted', plan: 'planned', evaluator: 'evaluated', execution: candidate ? 'candidate-failure' : 'pass' },
      observation: { normalizedObservedKind: 'returned-value', normalizedObservedFields: { value: candidate ? 'bad' : 'ok' }, violationIdentity: candidate ? phase4ViolationIdentityDigest({
        invariantRegistrationId: truthCommitments.find((entry) => entry.canonicalTruthId === item.canonicalTruthId).invariantRegistrationId,
        ...truthCommitments.find((entry) => entry.canonicalTruthId === item.canonicalTruthId).expected,
        targetArtifactDigest: item.artifact.targetArtifactDigest,
      }) : null, resultPayloadDigest: sha('4') },
      reasonCode: null, budget: { charged: true, evaluationOrdinal: context.evaluationOrdinal },
    };
  };
  const output = await runPhase4Measurement({
    registration, epochId: sha('9'), generationCases, operatorCases: [], retentionCases,
    truthCommitments,
    executeCase, mode: 'synthetic', nowSeconds: () => 0,
  });
  assert.equal(output.synthetic, true);
  assert.equal(output.rows.length, 23);
  assert.deepEqual(output.replayCandidates.map(({ armId, started, expectedRuns }) => ({ armId, started, expectedRuns })), [
    { armId: 'G', started: true, expectedRuns: 5 },
    { armId: 'E', started: true, expectedRuns: 5 },
  ]);
  assert.equal(output.rows.filter((row) => row.armId === 'G' && row.phase === 'replay').length, 5);
  assert.equal(output.rows.filter((row) => row.armId === 'E' && row.phase === 'replay').length, 5);
  assert.equal(output.rows.filter((row) => row.armId === 'D' && row.phase === 'replay').length, 0);
  assert.equal(output.rows.filter((row) => row.armId === 'P' && row.phase === 'replay' && row.reasonCode === 'replay-not-selected').length, 5);
  assert.equal(output.budgetLedger.measurement.dockerEvaluations, calls.length);
  assert.deepEqual(calls.map((call) => call.context.evaluationOrdinal), Array.from({ length: calls.length }, (_, index) => index + 1));
});

test('a partially executed replay candidate remains started after the measurement budget stops later runs', async () => {
  const truthCommitments = [commitment('tx', 'tx-truth')];
  let clock = 0;
  const executeCase = async (item, context) => {
    const candidate = item.artifactRole === 'single-patch-defect';
    if (item.phase === 'replay') clock = PHASE4_APPROVED_BUDGETS.measurement.monotonicWallClockSecondsMaximum;
    return {
      schemaVersion: PHASE4_MEASUREMENT_ROW_SCHEMA_VERSION,
      epochId: context.epochId, sequence: context.sequence, armId: item.armId, moduleId: item.moduleId,
      inputId: item.inputId, canonicalTruthId: item.canonicalTruthId, duplicateGroup: item.duplicateGroup,
      artifactRole: item.artifactRole, targetArtifactDigest: item.artifact.targetArtifactDigest,
      phase: item.phase, replayIndex: item.replayIndex, executionPath: item.executionPath,
      specDigest: sha('1'), planDigest: sha('2'), runRecordRef: `evidence/v0.3/phase4/runs/${context.sequence}.json`,
      axes: { specAcceptance: 'accepted', plan: 'planned', evaluator: 'evaluated', execution: candidate ? 'candidate-failure' : 'pass' },
      observation: {
        normalizedObservedKind: 'returned-value', normalizedObservedFields: { value: candidate ? 'bad' : 'ok' },
        violationIdentity: candidate ? phase4ViolationIdentityDigest({
          invariantRegistrationId: truthCommitments[0].invariantRegistrationId,
          ...truthCommitments[0].expected,
          targetArtifactDigest: item.artifact.targetArtifactDigest,
        }) : null,
        resultPayloadDigest: sha('4'),
      },
      reasonCode: null, budget: { charged: true, evaluationOrdinal: context.evaluationOrdinal },
    };
  };
  const output = await runPhase4Measurement({
    registration, epochId: sha('9'), generationCases: { G: [logical('G', 'tx', 'g-one')], P: [] },
    operatorCases: [], retentionCases: [], truthCommitments, executeCase, mode: 'synthetic', nowSeconds: () => clock,
  });
  assert.deepEqual(output.replayCandidates, [{ armId: 'G', inputId: 'g-one', canonicalTruthId: 'tx-truth', started: true, expectedRuns: 5 }]);
  assert.equal(output.rows.filter((row) => row.phase === 'replay' && row.budget.charged).length, 1);
  assert.equal(output.rows.filter((row) => row.phase === 'replay' && row.reasonCode === 'budget-exhausted').length, 4);
  assert.equal(output.budgetLedger.measurement.replayCandidates, 1);
  assert.equal(output.budgetLedger.measurement.replayRuns, 1);
});

test('executor failure is retained as a charged infrastructure row without retry', async () => {
  let calls = 0;
  const output = await runPhase4Measurement({
    registration, epochId: sha('8'),
    generationCases: { G: [logical('G', 'tx', 'g-one')], P: [] }, operatorCases: [], retentionCases: [],
    executeCase: async () => { calls += 1; throw new Error('synthetic failure'); }, mode: 'synthetic', nowSeconds: () => 0,
  });
  assert.equal(calls, 2);
  assert.equal(output.rows.length, 7);
  assert.ok(output.rows.slice(0, 2).every((row) => row.reasonCode === 'runner-infrastructure' && row.budget.charged));
  assert.ok(output.rows.slice(2).every((row) => row.reasonCode === 'replay-not-selected' && !row.budget.charged));
});

test('single isolated case helper executes one pinned Docker invocation without measurement readiness', async () => {
  class FakeChild extends EventEmitter {
    constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); }
    kill() { return true; }
  }
  const spawnCalls = [];
  const spawn = (command, args, options) => {
    const child = new FakeChild();
    spawnCalls.push({ command, args, options });
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  let writes = 0;
  const temporaryRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp('/tmp/p4-smoke-'));
  const inputDirectory = path.join(temporaryRoot, 'input');
  const resultDirectory = path.join(temporaryRoot, 'result');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(inputDirectory), mkdir(resultDirectory)]));
  const run = createIsolatedBenchmarkCaseRunner({
    spawn,
    readResultChannel: async () => ({ entries: [], resultBytes: null }),
    writeCaseInput: async (directory) => {
      writes += 1;
      await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(directory, 'case.json'), '{}'));
    },
    makeDirectories: async () => ({ inputDirectory, resultDirectory }),
  });
  const item = { ...logical('D', 'tx', 'synthetic-one'), artifacts: undefined, artifactRole: 'clean', artifact: artifacts().clean, phase: 'initial', replayIndex: null, executionPath: 'comparison' };
  const result = await run(item, { epochId: sha('9'), sequence: 0, evaluationOrdinal: 1 });
  assert.equal(writes, 1);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'docker');
  assert.ok(result.dockerArgs.includes('/consumer/evaluator/source/harness-v0.3/benchmark/direct-main.mjs'));
  assert.equal(result.execution.exitCode, 0);
});

test('raw run record preserves exact execution inputs and result bytes for independent validation', () => {
  const item = { ...logical('E', 'prepaint', 'retention-one'), artifacts: undefined, artifactRole: 'single-patch-defect', artifact: artifacts()['single-patch-defect'], phase: 'initial', replayIndex: null, executionPath: 'interpreter' };
  const context = { epochId: sha('9'), sequence: 7, evaluationOrdinal: 8, inputDirectory: '/tmp/i', resultDirectory: '/tmp/r' };
  const dockerArgs = buildBenchmarkDockerArgs({ containerName: 'bd-p4-0007', imageId: item.artifact.imageId, inputDirectory: '/tmp/i', resultDirectory: '/tmp/r', executionPath: item.executionPath });
  const resultBytes = Buffer.from('{"trusted":true}');
  const record = buildPhase4RawRunRecord({
    item, context, dockerArgs, ref: 'evidence/v0.3/phase4/runs/0007.json',
    execution: { exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, timedOut: false, outputTruncated: false, cleanupError: null },
    channel: { entries: [{ name: 'result.json', type: 'regular', size: resultBytes.length }], resultBytes },
    spec: { id: 'spec' }, plan: { id: 'plan' }, descriptor: { id: 'descriptor' },
  });
  assert.deepEqual(Object.keys(record).sort(), ['artifact', 'budget', 'cleanup', 'consumerSequences', 'containerName', 'descriptor', 'dockerArgs', 'evaluationContractKey', 'executionPath', 'imageId', 'inputDirectory', 'plan', 'process', 'ref', 'resultChannel', 'resultDirectory', 'schemaVersion', 'sequence', 'spec'].sort());
  assert.equal(record.resultChannel.bytesBase64, resultBytes.toString('base64'));
  assert.equal(record.resultChannel.size, resultBytes.length);
  assert.equal(record.cleanup.succeeded, true);
  assert.deepEqual(record.consumerSequences, [7]);
});

test('normalization derives an unrunnable row from process and result-channel facts', () => {
  const item = { ...logical('E', 'tx', 'generated-one'), artifacts: undefined, artifactRole: 'clean', artifact: artifacts().clean, phase: 'initial', replayIndex: null, executionPath: 'interpreter' };
  const row = normalizePhase4ExecutedCase({
    item,
    context: { epochId: sha('9'), sequence: 3, evaluationOrdinal: 4 },
    execution: { exitCode: 7, timedOut: false, outputTruncated: false },
    channel: { entries: [], resultBytes: null },
    spec: {}, plan: {}, descriptor: {}, specDigest: sha('1'), planDigest: sha('2'),
    runRecordRef: 'evidence/v0.3/phase4/runs/0003.json',
  });
  assert.deepEqual(row.axes, { specAcceptance: 'accepted', plan: 'planned', evaluator: 'evaluator-error', execution: 'unrunnable' });
  assert.equal(row.reasonCode, 'evaluator-early-exit');
  assert.equal(row.observation, null);
  assert.equal(row.budget.charged, true);
});
