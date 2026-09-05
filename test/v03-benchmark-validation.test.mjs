import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import prepaintDescriptor from '../registrations/v0.3/benchmark/prepaint.json' with { type: 'json' };

import {
  PHASE4_APPROVED_STATIC_POLICY_DIGEST,
  phase4RegistrationReadiness,
  phase4ViolationIdentityDigest,
} from '../src/v03-benchmark-contract.mjs';
import { PHASE4_SCORER_VERSION, scorePhase4Benchmark } from '../src/v03-benchmark-score.mjs';
import { buildBenchmarkDockerArgs } from '../src/v03-benchmark-runner.mjs';
import { benchmarkPlanDigest, benchmarkSpecDigest, buildBenchmarkPlan, buildBenchmarkSpec } from '../src/v03-benchmark-spec.mjs';
import { createBenchmarkTrustedResult } from '../src/v03-benchmark-result.mjs';
import { benchmarkImageContractKey, benchmarkImportClosures, canonicalizerClosure } from '../src/v03-benchmark-preparation.mjs';
import {
  PHASE4_AUTHOR_BUNDLE_SCHEMA_VERSION,
  PHASE4_AUTHOR_SESSION_DOMAIN,
  PHASE4_EPOCH_SCHEMA_VERSION,
  PHASE4_EVIDENCE_SCHEMA_VERSION,
  PHASE4_RAW_RUN_RECORD_SCHEMA_VERSION,
  PHASE4_EXECUTION_MANIFEST_DOMAIN,
  PHASE4_EXECUTION_MANIFEST_SCHEMA_VERSION,
  phase4BenchmarkEpochId,
  phase4EpochRegistrationDigest,
  phase4PackageIntegrityReceiptBytes,
  phase4PreparedImageIdentities,
  recomputePhase4RunClassification,
  validateActualPhase4Benchmark,
  validateActualPhase4BenchmarkReadiness,
  validatePhase4AuthorBundle,
  validatePhase4EpochClosure,
  validatePhase4Evidence,
  validatePhase4ExecutionManifest,
  validatePhase4FrozenInputs,
  validatePhase4GitCheckpointOrder,
  validatePhase4GitCheckpointContents,
  validatePhase4RawRunRecord,
  validatePhase4PreparedRunBinding,
  validatePhase4PreparationEvidence,
  validatePhase4PreparationSourceClosure,
} from '../src/v03-benchmark-validation.mjs';
import { domainDigest } from '../src/v03-wire.mjs';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const actualRegistration = JSON.parse(await readFile(new URL('benchmark/v0.3/registration.json', root)));
const cases = JSON.parse(await readFile(new URL('contracts/v0.3/benchmark-validation-cases.json', root)));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const DEFECT = 'd'.repeat(64);
const CLEAN = 'c'.repeat(64);
const INVARIANT = 'invariant.truth-one';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function authorBundle(checkpointA = A) {
  const sessions = ['G', 'P'].map((armId) => ({
    armId,
    sessionId: `session-${armId.toLowerCase()}`,
    fresh: true,
    inheritedConversationTurns: 0,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    visibleTaskTurns: 1,
    contextInputs: ['clean-pinned-module-source', 'public-documentation', 'registered-action-catalog', 'nightmare-seed-schema', 'arm-specific-authoring-prompt'],
    deniedInputsChecked: [
      'benchmark-defect-manifest', 'historical-private-checks', 'defect-patches',
      'truth-tables-with-item-answers', 'historical-or-current-results',
      'phase3-spike-and-reduction-truth', 'earlier-arm-outputs',
      'git-history-and-diffs-revealing-fixes', 'issues-prs-or-external-pages-revealing-fixes',
      'review-task-conversations-or-summaries',
    ],
    sourceTaskIds: [],
    deniedExposureFindings: [],
    seedRecords: [],
  }));
  const unavailableCounters = { internalModelCalls: null, inputTokens: null, outputTokens: null };
  return {
    schemaVersion: PHASE4_AUTHOR_BUNDLE_SCHEMA_VERSION,
    checkpointA,
    sessions,
    unavailableCounters,
    sessionRecordDigest: domainDigest(PHASE4_AUTHOR_SESSION_DOMAIN, { checkpointA, sessions, unavailableCounters }),
  };
}

function makeObservation(artifactDigest) {
  const fields = { value: { outcome: 'registered' } };
  return {
    normalizedObservedKind: 'returned-value',
    normalizedObservedFields: fields,
    violationIdentity: phase4ViolationIdentityDigest({ invariantRegistrationId: INVARIANT, normalizedObservedKind: 'returned-value', normalizedObservedFields: fields, targetArtifactDigest: artifactDigest }),
    resultPayloadDigest: 'e'.repeat(64),
  };
}

function truthCommitment() {
  return { canonicalTruthId: 'truth-one', moduleId: 'tx', duplicateGroup: 'truth-one', invariantRegistrationId: INVARIANT, matcherId: 'matcher.truth-one', expected: { normalizedObservedKind: 'returned-value', normalizedObservedFields: { value: { outcome: 'registered' } } } };
}

function frozenInputDocuments() {
  const retentionRows = [{ rowId: 'truth-one', moduleId: 'tx', canonicalTruthId: 'truth-one', duplicateGroup: 'truth-one' }];
  const base = { status: 'source-reviewed-unmeasured', targetRevision: actualRegistration.target.revision, measurementState: 'not-started' };
  return {
    universe: { schemaVersion: 'bug-dreamer/v03-benchmark-universe/v1', ...base, sources: {}, metricEligibleTruthIds: ['truth-one'], retentionRows, developmentDiagnostics: [], blockedRows: [], auditRows: [], runtimeOutcomeMayChangeMembership: false },
    truth: { schemaVersion: 'bug-dreamer/v03-benchmark-truth-commitments/v1', ...base, artifactBinding: 'synthetic', expectedSemantics: 'synthetic', expectedDerivation: {}, commitments: [truthCommitment()], provenanceByCanonicalTruthId: {}, runtimeOutcomeMayChangeExpectedIdentity: false },
    comparison: { schemaVersion: 'bug-dreamer/v03-benchmark-comparison-inputs/v1', ...base, artifactBinding: {}, pairedInputRule: {}, rows: [{ rowId: 'truth-one', moduleId: 'tx', comparisonRegistrationId: 'comparison.truth-one', invariantRegistrationId: INVARIANT, publicActionTrace: ['tx.start'], inputRecipe: {} }], developmentDiagnostics: [], runtimeOutcomeMayChangeInputMembership: false },
  };
}

function makeRows(epochId) {
  let ordinal = 0;
  const rows = [];
  function add(armId, artifactRole, phase = 'initial', replayIndex = null, execution = artifactRole === 'clean' ? 'pass' : 'candidate-failure') {
    ordinal += 1;
    const targetArtifactDigest = artifactRole === 'clean' ? CLEAN : DEFECT;
    const observation = execution === 'candidate-failure'
      ? makeObservation(targetArtifactDigest)
      : { normalizedObservedKind: 'returned-value', normalizedObservedFields: { value: { outcome: 'clean' } }, violationIdentity: null, resultPayloadDigest: 'f'.repeat(64) };
    rows.push({
      schemaVersion: 'bug-dreamer/v03-benchmark-measurement-row/v1', epochId, sequence: rows.length,
      armId, moduleId: 'tx', inputId: 'truth-one', canonicalTruthId: 'truth-one', duplicateGroup: 'truth-one',
      artifactRole, targetArtifactDigest, phase, replayIndex, executionPath: armId === 'D' ? 'comparison' : 'interpreter',
      specDigest: '1'.repeat(64), planDigest: '2'.repeat(64), runRecordRef: `evidence/v0.3/phase4/runs/run-${ordinal}.json`,
      axes: { specAcceptance: 'accepted', plan: 'planned', evaluator: 'evaluated', execution }, observation, reasonCode: null,
      budget: { charged: true, evaluationOrdinal: ordinal },
    });
  }
  add('D', 'clean'); add('D', 'single-patch-defect');
  add('E', 'clean'); add('E', 'single-patch-defect');
  for (let replayIndex = 1; replayIndex <= 5; replayIndex += 1) add('E', 'single-patch-defect', 'replay', replayIndex);
  return rows;
}

function manifest(entries) {
  const value = { schemaVersion: PHASE4_EXECUTION_MANIFEST_SCHEMA_VERSION, checkpointA: A, entries, manifestDigest: null };
  value.manifestDigest = domainDigest(PHASE4_EXECUTION_MANIFEST_DOMAIN, { checkpointA: A, entries });
  return value;
}

function stage() {
  const registration = structuredClone(actualRegistration);
  const author = authorBundle();
  const temporaryRows = makeRows('9'.repeat(64));
  const executionManifest = manifest(temporaryRows.map((row) => ({
    sequence: row.sequence, armId: row.armId, moduleId: row.moduleId, inputId: row.inputId,
    canonicalTruthId: row.canonicalTruthId, duplicateGroup: row.duplicateGroup, artifactRole: row.artifactRole,
    phase: row.phase, replayIndex: row.replayIndex, executionPath: row.executionPath,
  })));
  const truthBytes = Buffer.from(`${JSON.stringify(frozenInputDocuments().truth)}\n`);
  registration.status = 'sealed';
  registration.universe.metricEligibleRowIds = ['truth-one'];
  registration.universe.retentionDenominatorRowIds = ['truth-one'];
  registration.universe.adapterRegistrationIds = ['adapter-one'];
  registration.universe.truthCommitmentRef = { path: 'benchmark/v0.3/truth-commitments.json', sha256: sha(truthBytes) };
  registration.checkpoints = { commitA: A, commitB: B, sealedRef: 'refs/tags/phase4-epoch-one' };
  registration.authorBundle = { manifestDigest: executionManifest.manifestDigest, sessionRecordDigest: author.sessionRecordDigest };
  registration.images = { artifactFactoryImageId: '3'.repeat(64), evaluatorImageManifestDigest: '4'.repeat(64), evaluationContractKeysDigest: '5'.repeat(64) };
  registration.benchmarkEpochId = '6'.repeat(64);
  registration.readiness = phase4RegistrationReadiness(registration);
  const phase3 = registration.sourceArtifacts.phase3;
  const closure = {
    schemaVersion: PHASE4_EPOCH_SCHEMA_VERSION,
    checkpointA: A, checkpointB: B,
    sealedRef: { name: registration.checkpoints.sealedRef, resolvedOid: B, immutable: true },
    registrationDigest: phase4EpochRegistrationDigest(registration),
    inventoryDigest: registration.sourceArtifacts.inventoryDraft.sha256,
    truthCommitmentDigest: registration.universe.truthCommitmentRef.sha256,
    authorBundleDigests: structuredClone(registration.authorBundle),
    phase3Prerequisites: [phase3.spikeRegistration, phase3.spikeEvidence, phase3.reductionRegistration, phase3.reductionEvidence].map((item) => ({ ...item, scoreContribution: false })),
    imageIdentities: structuredClone(registration.images),
    sourceClosures: { direct: '7'.repeat(64), interpreter: '8'.repeat(64), shared: '9'.repeat(64), canonicalizer: 'a'.repeat(64), packageIntegrity: 'b'.repeat(64) },
    platform: { os: 'darwin', arch: 'arm64', nodeVersion: 'v24.16.0' },
    scorerVersion: PHASE4_SCORER_VERSION,
    executionManifestDigest: executionManifest.manifestDigest,
    epochId: null,
  };
  closure.epochId = phase4BenchmarkEpochId(closure);
  registration.benchmarkEpochId = closure.epochId;
  registration.readiness = phase4RegistrationReadiness(registration);
  return { registration, author, executionManifest, closure, truthBytes };
}

function scorerInput(epochId, rows) {
  return {
    epochId, registrationStaticPolicyDigest: PHASE4_APPROVED_STATIC_POLICY_DIGEST,
    metricEligibleTruthIds: ['truth-one'],
    truthCommitments: [truthCommitment()],
    retentionRows: [{ rowId: 'truth-one', moduleId: 'tx', canonicalTruthId: 'truth-one', duplicateGroup: 'truth-one' }],
    acceptedSeedIds: { G: [], P: [] }, operatorRequests: [],
    replayCandidates: [{ armId: 'E', inputId: 'truth-one', canonicalTruthId: 'truth-one', started: true, expectedRuns: 5 }],
    measurementRows: rows,
    userReviews: [{ canonicalTruthId: 'truth-one', verdict: 'real-bug-worth-fixing' }],
    trust: { status: 'pass', reasonCode: null }, epochAbort: null,
    budgetLedger: {
      schemaVersion: 'bug-dreamer/v03-benchmark-budget-ledger/v1', epochId,
      generation: { freshSessions: 0, submittedTaskTurns: 0, emittedSeeds: 0, acceptedSeeds: 0, operatorRequests: 0, transformedSpecs: 0 },
      measurement: { dockerEvaluations: rows.length, replayCandidates: 1, replayRuns: 5, elapsedSeconds: rows.length },
      preparation: { builds: 0, inspects: 0, probeContainers: 0, failures: 0, cleanups: 0, cleanupFailures: 0, elapsedSeconds: 0 }, stoppedBy: null,
    },
  };
}

test('validation fixture catalog covers the approved static and evidence gates', () => {
  assert.equal(cases.schemaVersion, 'bug-dreamer/v03-benchmark-validation-cases/v1');
  assert.equal(cases.cases.length, 16);
  assert.equal(new Set(cases.cases).size, 16);
});

test('actual approved-unsealed registration and public benchmark validator fail readiness instead of succeeding vacuously', async () => {
  assert.throws(() => validateActualPhase4BenchmarkReadiness(actualRegistration), /not measurement-ready/u);
  await assert.rejects(validateActualPhase4Benchmark(rootPath), /not measurement-ready/u);
});

test('author bundle requires fresh isolated G and P sessions and rejects deny-listed exposure', () => {
  const { registration, author } = stage();
  assert.equal(validatePhase4AuthorBundle(author, registration), author);
  const exposed = structuredClone(author);
  exposed.sessions[0].deniedExposureFindings.push('benchmark-defect-manifest');
  assert.throws(() => validatePhase4AuthorBundle(exposed, registration), /deny-listed/u);
  const inherited = structuredClone(author);
  inherited.sessions[1].sourceTaskIds.push('01a06f53-181f-71e1-b0e8-181cd7d3c19a');
  assert.throws(() => validatePhase4AuthorBundle(inherited, registration), /denied review task/u);
  const implementationTask = structuredClone(author);
  implementationTask.sessions[0].sourceTaskIds.push('01a06f80-360c-7690-97b2-7d99430da13e');
  assert.throws(() => validatePhase4AuthorBundle(implementationTask, registration), /denied review task/u);
});

test('epoch closure binds checkpoints, immutable tag, Phase 3 exclusions, images, sources, platform, and scorer', () => {
  const { registration, closure } = stage();
  assert.equal(validatePhase4EpochClosure(closure, registration), closure);
  const moved = structuredClone(closure);
  moved.sealedRef.resolvedOid = A;
  moved.epochId = phase4BenchmarkEpochId(moved);
  assert.throws(() => validatePhase4EpochClosure(moved, registration), /immutably resolve/u);
  const scoredPhase3 = structuredClone(closure);
  scoredPhase3.phase3Prerequisites[0].scoreContribution = true;
  scoredPhase3.epochId = phase4BenchmarkEpochId(scoredPhase3);
  assert.throws(() => validatePhase4EpochClosure(scoredPhase3, registration), /contributes to score/u);
});

test('execution manifest is deterministic, ordered, and checkpoint-bound', () => {
  const { registration, executionManifest } = stage();
  assert.equal(validatePhase4ExecutionManifest(executionManifest, registration), executionManifest);
  const reordered = structuredClone(executionManifest);
  [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]];
  assert.throws(() => validatePhase4ExecutionManifest(reordered, registration), /order/u);
  const selfReferential = structuredClone(executionManifest);
  selfReferential.checkpointB = B;
  assert.throws(() => validatePhase4ExecutionManifest(selfReferential, registration), /fields changed/u);
});

test('preparation closure is recomputed from disjoint D/E imports, canonicalizer files, and package integrity bytes', async () => {
  const { registration, closure } = stage();
  const directEntrypoints = ['harness-v0.3/benchmark/direct-main.mjs'];
  const interpreterEntrypoints = ['harness-v0.3/benchmark/interpreter-main.mjs'];
  const [sources, canonicalizer] = await Promise.all([
    benchmarkImportClosures(rootPath, { directEntrypoints, interpreterEntrypoints }),
    canonicalizerClosure(rootPath),
  ]);
  const packageIntegrityBytes = phase4PackageIntegrityReceiptBytes(canonicalizer);
  closure.sourceClosures = {
    direct: sources.direct.aggregateSha256,
    interpreter: sources.interpreter.aggregateSha256,
    shared: sources.shared.aggregateSha256,
    canonicalizer: canonicalizer.aggregateSha256,
    packageIntegrity: sha(packageIntegrityBytes),
  };
  const result = await validatePhase4PreparationSourceClosure(rootPath, { directEntrypoints, interpreterEntrypoints, packageIntegrityBytes }, closure);
  assert.equal(result.packageIntegritySha256, closure.sourceClosures.packageIntegrity);
  const tampered = Buffer.from(packageIntegrityBytes); tampered[0] ^= 1;
  await assert.rejects(validatePhase4PreparationSourceClosure(rootPath, { directEntrypoints, interpreterEntrypoints, packageIntegrityBytes: tampered }, closure), /Package integrity closure/u);

  const frozenBytes = {
    universeBytes: await readFile(new URL('benchmark/v0.3/universe.json', root)),
    truthCommitmentBytes: await readFile(new URL('benchmark/v0.3/truth-commitments.json', root)),
    comparisonInputsBytes: await readFile(new URL('benchmark/v0.3/comparison-inputs.json', root)),
    defectManifestBytes: await readFile(new URL('benchmark/manifest.json', root)),
  };
  const infrastructureClosure = { files: [
    { path: 'benchmark/v0.3/universe.json', sha256: sha(frozenBytes.universeBytes) },
    { path: 'benchmark/v0.3/truth-commitments.json', sha256: sha(frozenBytes.truthCommitmentBytes) },
    { path: 'benchmark/v0.3/comparison-inputs.json', sha256: sha(frozenBytes.comparisonInputsBytes) },
  ], aggregateSha256: 'c'.repeat(64) };
  const buildInputs = { artifactSetId: 'clean', artifactDigests: { tx: CLEAN }, lockfileSha256: '1'.repeat(64), registrationSha256: registration.target.registrationSha256, dockerfileSha256: '3'.repeat(64), sourceClosures: sources, canonicalizer, infrastructureClosure, targetRevision: registration.target.revision, inventorySha256: registration.sourceArtifacts.inventoryDraft.sha256, approvedStaticPolicySha256: registration.sourceArtifacts.approvedPolicyDraft.sha256, manifestSha256: sha(frozenBytes.defectManifestBytes), artifactFactoryReceiptSha256: '5'.repeat(64) };
  const preparation = {
    schemaVersion: 'bug-dreamer/v03-benchmark-preparation-evidence/v1', status: 'prepared', targetRevision: registration.target.revision,
    buildPlan: { artifactSetIds: ['clean'] }, artifactFactory: { tag: 'synthetic-factory', imageId: `sha256:${'4'.repeat(64)}`, labels: { 'org.bug-dreamer.target-revision': registration.target.revision, 'org.bug-dreamer.artifact-factory': 'true' }, extraction: { exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '' }, receiptSha256: '5'.repeat(64), receipt: { sets: [{ id: 'clean', artifactDigests: { tx: CLEAN } }] } },
    sourceClosures: sources, canonicalizer, fixtureClosure: {},
    images: [{ artifactSetId: 'clean', tag: 'synthetic', imageId: `sha256:${'6'.repeat(64)}`, contractKey: benchmarkImageContractKey(buildInputs), lockfileSha256: buildInputs.lockfileSha256, changedIntegrity: null, buildInputs }],
    syntheticSmoke: {}, ledger: { schemaVersion: 'bug-dreamer/v03-benchmark-preparation/v1', builds: 1, inspects: 1, probeContainers: 0, failures: 0, cleanups: 1, cleanupFailures: 0, elapsedSeconds: 1, stoppedBy: null },
  };
  registration.images = phase4PreparedImageIdentities(preparation);
  closure.imageIdentities = structuredClone(registration.images);
  assert.equal((await validatePhase4PreparationEvidence(rootPath, preparation, registration, closure, frozenBytes)).preparation, preparation);
  const changedInput = structuredClone(preparation);
  changedInput.images[0].buildInputs.infrastructureClosure.files[2].sha256 = 'f'.repeat(64);
  changedInput.images[0].contractKey = benchmarkImageContractKey(changedInput.images[0].buildInputs);
  await assert.rejects(validatePhase4PreparationEvidence(rootPath, changedInput, registration, closure, frozenBytes), /did not seal benchmark\/v0.3\/comparison-inputs.json/u);
});

test('checkpoint order is verified through read-only Git queries', async () => {
  const { registration } = stage();
  const calls = [];
  const gitQuery = async (_root, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return B;
    return '';
  };
  const result = await validatePhase4GitCheckpointOrder('/synthetic/repository', registration, { gitQuery });
  assert.equal(result.ordered, true);
  assert(calls.some((args) => args[0] === 'merge-base' && args.includes('--is-ancestor')));
  const wrongTag = async (_root, args) => args[0] === 'rev-parse' ? A : '';
  await assert.rejects(validatePhase4GitCheckpointOrder('/synthetic/repository', registration, { gitQuery: wrongTag }), /does not resolve/u);

  const authorBundleBytes = Buffer.from('{"author":true}\n');
  const executionManifestBytes = Buffer.from('{"manifest":true}\n');
  const gitFileQuery = async (_root, args) => args[1].endsWith('authoring/bundle.json') ? authorBundleBytes : executionManifestBytes;
  const contents = await validatePhase4GitCheckpointContents('/synthetic/repository', registration, { authorBundleBytes, executionManifestBytes }, { gitFileQuery });
  assert.equal(contents.checkpointB, B);
  const wrongFile = async () => Buffer.from('changed');
  await assert.rejects(validatePhase4GitCheckpointContents('/synthetic/repository', registration, { authorBundleBytes, executionManifestBytes }, { gitFileQuery: wrongFile }), /differ from Checkpoint B/u);
});

test('normalized evidence and actual file loader require every manifest row, artifact, and exact scorer recomputation', async () => {
  const { registration, author, executionManifest, closure, truthBytes } = stage();
  const rows = makeRows(closure.epochId);
  for (const row of rows) {
    row.axes.evaluator = 'evaluator-error';
    row.axes.execution = 'unrunnable';
    row.observation = null;
    row.reasonCode = 'evaluator-timeout';
  }
  const input = scorerInput(closure.epochId, rows);
  const artifacts = rows.map((row) => {
    const imageId = `sha256:${'7'.repeat(64)}`;
    const containerName = `case-${row.sequence}`;
    const inputDirectory = `/tmp/phase4-input-${row.sequence}`;
    const resultDirectory = `/tmp/phase4-result-${row.sequence}`;
    const record = {
      schemaVersion: PHASE4_RAW_RUN_RECORD_SCHEMA_VERSION,
      sequence: row.sequence,
      consumerSequences: [row.sequence],
      ref: row.runRecordRef,
      containerName, inputDirectory, resultDirectory, executionPath: row.executionPath,
      imageId,
      evaluationContractKey: '8'.repeat(64),
      dockerArgs: buildBenchmarkDockerArgs({ containerName, imageId, inputDirectory, resultDirectory, executionPath: row.executionPath }),
      budget: { timeoutMs: 30000, stdoutLimitBytes: 1048576, stderrLimitBytes: 1048576, recordedOutputBytes: 4096 },
      resultChannel: { present: false, regular: false, size: 0, sha256: null, bytesBase64: null },
      process: { exitCode: null, timedOut: true, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 },
      cleanup: { succeeded: true, reasonCode: null },
      plan: {}, spec: {}, descriptor: {},
      artifact: { role: row.artifactRole, targetArtifactDigest: row.targetArtifactDigest, evaluationContractKey: '8'.repeat(64) },
    };
    const bytes = Buffer.from(JSON.stringify(record));
    return { path: row.runRecordRef, sha256: sha(bytes), bytesBase64: bytes.toString('base64') };
  });
  const evidence = { schemaVersion: PHASE4_EVIDENCE_SCHEMA_VERSION, mode: 'synthetic', epochClosure: closure, authorBundle: author, executionManifest, scorerInput: input, checkedScore: scorePhase4Benchmark(input), artifacts };
  assert.equal(validatePhase4Evidence(evidence, registration).epochId, closure.epochId);
  const missing = structuredClone(evidence);
  missing.artifacts.pop();
  assert.throws(() => validatePhase4Evidence(missing, registration), /Missing run record artifact/u);
  const forgedScore = structuredClone(evidence);
  forgedScore.checkedScore.counts.frozenRetentionRows = 0;
  assert.throws(() => validatePhase4Evidence(forgedScore, registration), /independent recomputation/u);

  const actualRows = structuredClone(rows);
  const actualArtifacts = artifacts.map((artifact, index) => {
    const ref = `evidence/v0.3/phase4/runs/${String(index).padStart(6, '0')}.json`;
    actualRows[index].runRecordRef = ref;
    const record = JSON.parse(Buffer.from(artifact.bytesBase64, 'base64'));
    record.ref = ref;
    const bytes = Buffer.from(JSON.stringify(record));
    return { path: ref, bytes };
  });
  const actualInput = scorerInput(closure.epochId, actualRows);
  const frozen = frozenInputDocuments();
  const authorBytes = Buffer.from(JSON.stringify(author));
  const manifestBytes = Buffer.from(JSON.stringify(executionManifest));
  const files = new Map([
    ['benchmark/v0.3/authoring/bundle.json', authorBytes],
    ['benchmark/v0.3/execution-manifest.json', manifestBytes],
    ['benchmark/v0.3/epoch.json', Buffer.from(JSON.stringify(closure))],
    ['benchmark/v0.3/results/score.json', Buffer.from(JSON.stringify(scorePhase4Benchmark(actualInput)))],
    ['evidence/v0.3/phase4/measurement.json', Buffer.from(JSON.stringify(actualInput))],
    ['evidence/v0.3/phase4-preparation.json', Buffer.from('{"synthetic":"injected"}')],
    ['benchmark/v0.3/universe.json', Buffer.from(JSON.stringify(frozen.universe))],
    [registration.universe.truthCommitmentRef.path, truthBytes],
    ['benchmark/v0.3/comparison-inputs.json', Buffer.from(JSON.stringify(frozen.comparison))],
    ['benchmark/manifest.json', Buffer.from('{"synthetic":"manifest"}')],
    ...actualArtifacts.map((artifact) => [artifact.path, artifact.bytes]),
  ]);
  const actual = await validateActualPhase4Benchmark('/synthetic/repository', {
    registrationLoader: async () => ({ registration }),
    repositoryFileReader: async (_root, relativePath) => files.get(relativePath) ?? Promise.reject(new Error(`missing ${relativePath}`)),
    gitQuery: async (_root, args) => args[0] === 'rev-parse' ? B : '',
    gitFileQuery: async (_root, args) => args[1].endsWith('authoring/bundle.json') ? authorBytes : manifestBytes,
    preparationValidator: async () => ({}),
    preparedRunValidator: () => ({}),
  });
  assert.equal(actual.status, 'measured-evidence-structure-valid');
  assert.equal(actual.files.runRecords[0], 'evidence/v0.3/phase4/runs/000000.json');
  assert.equal(validatePhase4FrozenInputs({ universe: frozen.universe, truthCommitments: frozen.truth, comparisonInputs: frozen.comparison }, actualInput, registration).universe, frozen.universe);
  const forgedTruth = structuredClone(frozen.truth);
  forgedTruth.commitments[0].expected.normalizedObservedFields.value.outcome = 'forged';
  assert.throws(() => validatePhase4FrozenInputs({ universe: frozen.universe, truthCommitments: forgedTruth, comparisonInputs: frozen.comparison }, actualInput, registration), /truth commitments differ/u);
  const forgedRetention = structuredClone(frozen.universe);
  forgedRetention.retentionRows[0].moduleId = 'prepaint';
  assert.throws(() => validatePhase4FrozenInputs({ universe: forgedRetention, truthCommitments: frozen.truth, comparisonInputs: frozen.comparison }, actualInput, registration), /retention row identities differ/u);
});

test('raw result classification ignores host labels and fails missing results closed', () => {
  const classification = recomputePhase4RunClassification({ resultBytesBase64: null, exitCode: 0, timedOut: false, outputTruncated: false, plan: {}, spec: {}, descriptor: {}, artifact: {} });
  assert.deepEqual(classification, { status: 'unrunnable', reason: 'missing-trusted-result', result: null });
  const timeout = recomputePhase4RunClassification({ resultBytesBase64: null, exitCode: 0, timedOut: true, outputTruncated: false, plan: {}, spec: {}, descriptor: {}, artifact: {} });
  assert.equal(timeout.reason, 'evaluator-timeout');
});

test('raw run records recompute a valid candidate from result bytes and bound spec, plan, descriptor, artifact, and image', () => {
  const artifact = { role: 'single-patch-defect', targetArtifactDigest: DEFECT, evaluationContractKey: '8'.repeat(64) };
  const seed = {
    schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: prepaintDescriptor.catalogVersion,
    id: 'validation-seed', invariantId: prepaintDescriptor.invariants.at(-1).id, actors: ['builder'],
    actions: [{ actionId: 'prepaint.vite-create', actor: 'builder', arguments: { policy: { routes: ['relative'] }, inline: false, minify: false }, bind: null }],
  };
  const spec = buildBenchmarkSpec(seed, prepaintDescriptor, artifact);
  const plan = buildBenchmarkPlan(spec, prepaintDescriptor, artifact);
  const result = createBenchmarkTrustedResult({
    specDigest: benchmarkSpecDigest(spec, prepaintDescriptor, artifact),
    planDigest: benchmarkPlanDigest(plan, spec, prepaintDescriptor, artifact),
    targetArtifactDigest: artifact.targetArtifactDigest,
    invariantRegistrationId: plan.invariantRegistrationId,
  }, { execution: 'candidate-failure', observedKind: 'returned-value', observedFields: { value: { accepted: false } } });
  const resultBytes = Buffer.from(JSON.stringify(result));
  const ref = 'evidence/v0.3/phase4/runs/raw-positive.json';
  const row = {
    schemaVersion: 'bug-dreamer/v03-benchmark-measurement-row/v1', epochId: '9'.repeat(64), sequence: 0,
    armId: 'E', moduleId: 'prepaint', inputId: 'raw-positive', canonicalTruthId: 'raw-positive', duplicateGroup: 'raw-positive',
    artifactRole: artifact.role, targetArtifactDigest: artifact.targetArtifactDigest, phase: 'initial', replayIndex: null,
    executionPath: 'interpreter', specDigest: benchmarkSpecDigest(spec, prepaintDescriptor, artifact),
    planDigest: benchmarkPlanDigest(plan, spec, prepaintDescriptor, artifact), runRecordRef: ref,
    axes: { specAcceptance: 'accepted', plan: 'planned', evaluator: 'evaluated', execution: 'candidate-failure' },
    observation: {
      normalizedObservedKind: result.observedKind,
      normalizedObservedFields: result.observedFields,
      violationIdentity: phase4ViolationIdentityDigest(result.violationIdentity),
      resultPayloadDigest: result.payloadDigest,
    },
    reasonCode: null, budget: { charged: true, evaluationOrdinal: 1 },
  };
  const imageId = `sha256:${'7'.repeat(64)}`;
  const containerName = 'raw-positive';
  const inputDirectory = '/tmp/phase4-raw-positive-input';
  const resultDirectory = '/tmp/phase4-raw-positive-result';
  const record = {
    schemaVersion: PHASE4_RAW_RUN_RECORD_SCHEMA_VERSION, sequence: 0, consumerSequences: [0], ref,
    containerName, inputDirectory, resultDirectory, executionPath: 'interpreter', imageId,
    evaluationContractKey: artifact.evaluationContractKey,
    dockerArgs: buildBenchmarkDockerArgs({ containerName, imageId, inputDirectory, resultDirectory, executionPath: 'interpreter' }),
    budget: { timeoutMs: 30000, stdoutLimitBytes: 1048576, stderrLimitBytes: 1048576, recordedOutputBytes: 4096 },
    resultChannel: { present: true, regular: true, size: resultBytes.length, sha256: sha(resultBytes), bytesBase64: resultBytes.toString('base64') },
    process: { exitCode: 0, timedOut: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 },
    cleanup: { succeeded: true, reasonCode: null }, plan, spec, descriptor: prepaintDescriptor, artifact,
  };
  assert.equal(validatePhase4RawRunRecord(record, row).classification.status, 'candidate-failure');
  const preparation = { images: [{ artifactSetId: row.canonicalTruthId, imageId, contractKey: artifact.evaluationContractKey, buildInputs: { artifactDigests: { prepaint: artifact.targetArtifactDigest } } }] };
  assert.equal(validatePhase4PreparedRunBinding(record, row, preparation).imageId, imageId);
  const wrongPreparedImage = structuredClone(preparation);
  wrongPreparedImage.images[0].imageId = `sha256:${'9'.repeat(64)}`;
  assert.throws(() => validatePhase4PreparedRunBinding(record, row, wrongPreparedImage), /differs from preparation receipt/u);
  const forged = structuredClone(record);
  forged.resultChannel.bytesBase64 = Buffer.from('{"claimed":"pass"}').toString('base64');
  assert.throws(() => validatePhase4RawRunRecord(forged, row), /channel metadata/u);

  const overflow = structuredClone(record);
  overflow.process.outputTruncated = true;
  overflow.process.stdoutBytes = overflow.budget.stdoutLimitBytes + 1;
  const overflowRow = structuredClone(row);
  overflowRow.axes = { specAcceptance: 'accepted', plan: 'planned', evaluator: 'evaluator-error', execution: 'unrunnable' };
  overflowRow.observation = null;
  overflowRow.reasonCode = 'evaluator-log-limit';
  assert.equal(validatePhase4RawRunRecord(overflow, overflowRow).classification.reason, 'evaluator-log-limit');

  const missingFlag = structuredClone(overflow);
  missingFlag.process.outputTruncated = false;
  assert.throws(() => validatePhase4RawRunRecord(missingFlag, overflowRow), /truncation flag disagrees/u);
  const falseFlag = structuredClone(overflow);
  falseFlag.process.stdoutBytes = 0;
  assert.throws(() => validatePhase4RawRunRecord(falseFlag, overflowRow), /truncation flag disagrees/u);
});
