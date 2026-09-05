import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateRegistration } from '../src/v03-contracts.mjs';
import { loadPhase4Registration } from '../src/v03-benchmark-contract.mjs';
import { createIsolatedBenchmarkCaseRunner } from '../src/v03-benchmark-runner.mjs';
import {
  benchmarkPlanDigest,
  benchmarkSpecDigest,
  buildBenchmarkPlan,
  buildBenchmarkSpec,
} from '../src/v03-benchmark-spec.mjs';
import { validateBenchmarkTrustedResult } from '../src/v03-benchmark-trust.mjs';
import { readTrustedResultChannel } from '../src/v03-trust.mjs';
import { canonicalJson } from '../src/v03-wire.mjs';
import {
  assertTwentyOneArtifactPlan,
  benchmarkImageContractKey,
  benchmarkImportClosures,
  canonicalizerClosure,
  chargePreparation,
  createPreparationLedger,
  digestFileClosure,
  digestTreeClosure,
  freezeTargetTarballIntegrity,
  publicPreparationLedger,
  stopPreparationOnFailure,
  validateBenchmarkDefects,
} from '../src/v03-benchmark-preparation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase4-preparation.json');
const manifestPath = path.join(repositoryRoot, 'benchmark/manifest.json');
const packagesPath = path.join(repositoryRoot, 'registrations/v0.3/packages.json');
const lockfilePath = path.join(repositoryRoot, 'registrations/v0.3/consumer-lock.yaml');
const contractEvidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase1-contracts.json');
const factoryDockerfile = 'docker-v0.3/Dockerfile.benchmark-artifacts';
const finalDockerfile = 'docker-v0.3/Dockerfile.benchmark';
const factoryHarness = 'harness-v0.3/benchmark-build/materialize-artifacts.mjs';
const failClosedHarness = 'harness-v0.3/benchmark-build/fail-closed.mjs';
const verifyImageHarness = 'harness-v0.3/benchmark-build/verify-image.mjs';
const createConsumerHarness = 'harness-v0.3/create-consumer.mjs';
const directEntrypoints = ['harness-v0.3/benchmark/direct-main.mjs'];
const interpreterEntrypoints = ['harness-v0.3/benchmark/interpreter-main.mjs'];
const smokePaths = ['tx', 'local-first', 'prepaint'].map((id) => `contracts/v0.3/benchmark-smoke-${id}.json`);
const frozenExecutionPaths = [
  'benchmark/v0.3/authoring/bundle.json',
  'benchmark/v0.3/execution-manifest.json',
  'benchmark/v0.3/epoch.json',
  'benchmark/v0.3/universe.json',
  'benchmark/v0.3/comparison-inputs.json',
  'benchmark/v0.3/truth-commitments.json',
];
const runtimeDataFiles = [
  'registrations/v0.3/benchmark/adapter-proposals.json',
  ...['tx', 'local-first', 'prepaint'].map((id) => `registrations/v0.3/benchmark/${id}.json`),
];
const isolationArgs = ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function codeUnitSort(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) throw new Error(`${label} fields changed`);
  return value;
}

export function validateSyntheticSmokeEnvelope(smoke) {
  exactObject(smoke, [
    'schemaVersion', 'id', 'moduleId', 'developmentOnly', 'measurementEligible', 'historicalTruthId', 'artifactRole',
    'comparisonRegistrationId', 'invariantRegistrationId', 'sourceCommit', 'sourceRefs', 'seed', 'comparisonInput',
    'runtimePolicy', 'expectedClean', 'preparationProbeRuns',
  ], 'Synthetic smoke envelope');
  if (smoke.schemaVersion !== 'bug-dreamer/v03-benchmark-smoke/v1'
    || !['tx', 'local-first', 'prepaint'].includes(smoke.moduleId)
    || smoke.developmentOnly !== true || smoke.measurementEligible !== false || smoke.historicalTruthId !== null
    || smoke.artifactRole !== 'clean' || smoke.preparationProbeRuns !== 2) throw new Error(`Synthetic smoke policy changed: ${smoke.id}`);
  exactObject(smoke.expectedClean, ['execution', 'observedKind', 'observedFields'], 'Synthetic smoke expectedClean');
  if (smoke.expectedClean.execution !== 'pass' || smoke.expectedClean.observedKind !== 'returned-value') throw new Error(`Synthetic smoke expectation changed: ${smoke.id}`);
  return smoke;
}

export function syntheticSmokeInputs(smoke, descriptor, hostArtifact) {
  exactObject(hostArtifact, ['role', 'targetArtifactDigest', 'evaluationContractKey', 'imageId'], 'Synthetic smoke host artifact');
  if (!/^sha256:[0-9a-f]{64}$/u.test(hostArtifact.imageId)) throw new Error(`Synthetic smoke image identity is invalid: ${smoke.id}`);
  const artifact = {
    role: hostArtifact.role,
    targetArtifactDigest: hostArtifact.targetArtifactDigest,
    evaluationContractKey: hostArtifact.evaluationContractKey,
  };
  const spec = buildBenchmarkSpec(structuredClone(smoke.seed), descriptor, artifact);
  const plan = buildBenchmarkPlan(spec, descriptor, artifact);
  const comparisonRegistration = descriptor.comparisons.find((item) => item.id === smoke.comparisonRegistrationId);
  if (comparisonRegistration === undefined || comparisonRegistration.invariantId !== smoke.invariantRegistrationId) throw new Error(`Synthetic smoke comparison is unregistered: ${smoke.id}`);
  const metadata = {
    specDigest: benchmarkSpecDigest(spec, descriptor, artifact),
    planDigest: benchmarkPlanDigest(plan, spec, descriptor, artifact),
    targetArtifactDigest: artifact.targetArtifactDigest,
    invariantRegistrationId: smoke.invariantRegistrationId,
  };
  const comparisonInput = structuredClone(smoke.comparisonInput);
  if (smoke.moduleId === 'tx') {
    for (const fixture of comparisonInput.fixtureSetup) {
      exactObject(fixture.producerArtifact, ['moduleRegistrationId', 'targetArtifactDigest'], 'Synthetic tx fixture producer');
      if (fixture.producerArtifact.moduleRegistrationId !== descriptor.moduleId
        || !/^[0-9a-f]{64}$/u.test(fixture.producerArtifact.targetArtifactDigest)) throw new Error(`Synthetic tx fixture producer changed: ${smoke.id}`);
      fixture.producerArtifact.targetArtifactDigest = artifact.targetArtifactDigest;
    }
    const plannedComparisonInput = { actions: plan.actions, fixtureSetup: plan.fixtureSetup, virtualTime: plan.virtualTime, scheduleControls: plan.scheduleControls };
    if (canonicalJson(comparisonInput) !== canonicalJson(plannedComparisonInput)) throw new Error(`Synthetic tx D/E input identity changed: ${smoke.id}`);
  } else if (smoke.moduleId === 'prepaint' && canonicalJson(comparisonInput) !== canonicalJson(plan.actions[0]?.arguments)) {
    throw new Error(`Synthetic prepaint D/E input identity changed: ${smoke.id}`);
  } else if (smoke.moduleId === 'local-first' && comparisonInput.row?.id !== smoke.comparisonRegistrationId) {
    throw new Error(`Synthetic local-first D/E input identity changed: ${smoke.id}`);
  }
  const row = smoke.moduleId === 'local-first'
    ? comparisonInput.row
    : { id: smoke.comparisonRegistrationId, comparisonInput };
  return {
    spec,
    plan,
    direct: {
      schemaVersion: 'bug-dreamer/v03-benchmark-direct-input/v1',
      moduleId: smoke.moduleId,
      descriptorId: descriptor.id,
      comparisonRegistration,
      row,
      artifact,
      runtimePolicy: smoke.runtimePolicy,
      policy: comparisonInput.policy ?? {},
      metadata,
    },
    interpreter: {
      schemaVersion: 'bug-dreamer/v03-benchmark-interpreter-input/v1',
      moduleId: smoke.moduleId,
      descriptorId: descriptor.id,
      artifact,
      spec,
      plan,
      policy: comparisonInput.policy ?? {},
    },
  };
}

function closureFiles(...closures) {
  return closures.flatMap((closure) => closure.files.map((file) => ({ path: file.path, kind: file.kind ?? 'file', sha256: file.sha256 }))).sort((left, right) => codeUnitSort(left.path, right.path));
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--target' || args[1].length === 0) throw new TypeError('Usage: node scripts/prepare-v03-benchmark.mjs --target <firsttx-path>');
  return args[1];
}

export function runBoundedCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 30_000, maxOutputBytes = 8_388_608, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let recordedOutputBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let terminationTimer;
    const terminate = () => {
      child.kill('SIGTERM');
      terminationTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      terminationTimer.unref();
    };
    const append = (name, chunk) => {
      outputBytes += chunk.length;
      const remaining = Math.max(0, maxOutputBytes - recordedOutputBytes);
      const text = chunk.subarray(0, remaining).toString();
      recordedOutputBytes += Buffer.byteLength(text);
      if (name === 'stdout') stdout += text;
      else stderr += text;
      if (outputBytes > maxOutputBytes && !outputTruncated) { outputTruncated = true; terminate(); }
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => {
      clearTimeout(deadline);
      clearTimeout(terminationTimer);
      reject(error);
    });
    const deadline = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, timeoutMs));
    deadline.unref();
    child.once('close', (exitCode) => {
      clearTimeout(deadline);
      clearTimeout(terminationTimer);
      resolve({ exitCode, stdout, stderr, timedOut, outputTruncated });
    });
  });
}

async function archiveTarget(targetPath, destination, revision, timeoutMs) {
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['-C', targetPath, 'archive', '--format=tar', revision], { stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] });
    archive.stdout.pipe(extract.stdin);
    let settled = false;
    const deadline = setTimeout(() => {
      archive.kill('SIGKILL');
      extract.kill('SIGKILL');
      abort(new Error('Target archive exceeded the preparation deadline'));
    }, Math.max(1, timeoutMs));
    deadline.unref();
    const abort = (error) => { if (!settled) { settled = true; clearTimeout(deadline); reject(error); } };
    archive.once('error', abort);
    extract.once('error', abort);
    archive.once('close', (code) => { if (code !== 0) abort(new Error('git archive failed')); });
    extract.once('close', (code) => { if (!settled && code === 0) { settled = true; clearTimeout(deadline); resolve(); } else if (code !== 0) abort(new Error('tar extract failed')); });
  });
}

function nowMs() {
  return Math.floor(performance.now());
}

async function chargedRun(ledger, kind, command, args, label, options = {}) {
  chargePreparation(ledger, kind, nowMs());
  const remainingMs = 7_200_000 - (nowMs() - ledger.startedAtMs);
  const result = await runBoundedCommand(command, args, { ...options, timeoutMs: remainingMs });
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
    stopPreparationOnFailure(ledger, `${label}-failed`);
    if (options.containerName !== undefined) {
      chargePreparation(ledger, 'cleanups', nowMs());
      const cleanup = await runBoundedCommand('docker', ['rm', '--force', options.containerName], { timeoutMs: 30_000, maxOutputBytes: 65_536 });
      if (cleanup.exitCode !== 0 && !/No such container/u.test(cleanup.stderr)) ledger.cleanupFailures += 1;
    }
    throw new Error(`${label} failed (${result.exitCode}, timedOut=${result.timedOut}, outputTruncated=${result.outputTruncated}):\n${result.stderr.slice(-4000)}`);
  }
  return result;
}

async function copyClosureFiles(closure, destination) {
  for (const file of closure.files) {
    const target = path.join(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(repositoryRoot, file.path), target);
  }
}

async function writeEvidence(value) {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const targetInput = parseArgs(process.argv.slice(2));
  const targetPath = await realpath(path.resolve(targetInput));
  if (!(await stat(targetPath)).isDirectory()) throw new Error('Target path must be a directory');
  const ledger = createPreparationLedger(nowMs());
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-v03-benchmark-'));
  const partialEvidence = {
    targetRevision: null,
    buildPlan: null,
    artifactFactory: null,
    sourceClosures: null,
    canonicalizer: null,
    fixtureClosure: null,
    images: [],
    syntheticSmoke: { runs: 0, results: [] },
  };
  let cleanupStarted = false;
  async function cleanupTemporary() {
    if (cleanupStarted) return;
    cleanupStarted = true;
    chargePreparation(ledger, 'cleanups', nowMs());
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      ledger.cleanupFailures += 1;
      throw error;
    }
  }
  try {
    const [{ registration: phase4, inventory, inventoryBytes }, manifestBytes, packagesBytes, registeredLockBytes, phase1EvidenceBytes, smokeBytes] = await Promise.all([
      loadPhase4Registration(repositoryRoot),
      readFile(manifestPath),
      readFile(packagesPath),
      readFile(lockfilePath),
      readFile(contractEvidencePath),
      Promise.all(smokePaths.map((relativePath) => readFile(path.join(repositoryRoot, relativePath)))),
    ]);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const packages = validateRegistration(JSON.parse(packagesBytes.toString('utf8')));
    const phase1Evidence = JSON.parse(phase1EvidenceBytes.toString('utf8'));
    const smokes = smokeBytes.map((bytes) => validateSyntheticSmokeEnvelope(JSON.parse(bytes.toString('utf8'))));
    partialEvidence.targetRevision = phase4.target.revision;
    if (packages.targetRevision !== phase4.target.revision || manifest.target_revision !== phase4.target.revision) throw new Error('Benchmark target revision inputs disagree');
    if (smokes.some((smoke) => smoke.sourceCommit !== phase4.target.revision)) throw new Error('Synthetic smoke source revision changed');
    const defects = validateBenchmarkDefects(manifest, inventory);
    const buildPlan = assertTwentyOneArtifactPlan(defects);
    partialEvidence.buildPlan = buildPlan;
    const revision = await runBoundedCommand('git', ['-C', targetPath, 'rev-parse', 'HEAD'], { timeoutMs: Math.max(1, 7_200_000 - (nowMs() - ledger.startedAtMs)), maxOutputBytes: 65_536 });
    if (revision.exitCode !== 0 || revision.stdout.trim() !== phase4.target.revision) throw new Error(`Target HEAD must be ${phase4.target.revision}`);

    const sourceClosures = await benchmarkImportClosures(repositoryRoot, { directEntrypoints, interpreterEntrypoints });
    const runtimeDataClosure = await digestFileClosure(repositoryRoot, runtimeDataFiles);
    const canonicalizer = await canonicalizerClosure(repositoryRoot);
    partialEvidence.sourceClosures = sourceClosures;
    partialEvidence.canonicalizer = canonicalizer;
    const infrastructureFiles = [
      factoryDockerfile,
      finalDockerfile,
      factoryHarness,
      failClosedHarness,
      verifyImageHarness,
      createConsumerHarness,
      'scripts/prepare-v03-benchmark.mjs',
      'src/v03-benchmark-preparation.mjs',
      'src/v03-benchmark-runner.mjs',
      'src/v03-runner.mjs',
      ...smokePaths,
      ...frozenExecutionPaths,
    ];
    const infrastructureClosure = await digestFileClosure(repositoryRoot, infrastructureFiles);

    const factoryContext = path.join(temporaryRoot, 'factory-context');
    const factoryOutput = path.join(temporaryRoot, 'factory-output');
    await Promise.all([
      mkdir(path.join(factoryContext, 'target'), { recursive: true }),
      mkdir(path.join(factoryContext, 'preparation'), { recursive: true }),
      mkdir(path.join(factoryContext, 'docker-v0.3'), { recursive: true }),
      mkdir(path.join(factoryContext, 'harness-v0.3/benchmark-build'), { recursive: true }),
      mkdir(factoryOutput, { recursive: true }),
    ]);
    await archiveTarget(targetPath, path.join(factoryContext, 'target'), phase4.target.revision, 7_200_000 - (nowMs() - ledger.startedAtMs));
    await Promise.all([
      cp(path.join(repositoryRoot, factoryDockerfile), path.join(factoryContext, factoryDockerfile)),
      cp(path.join(repositoryRoot, factoryHarness), path.join(factoryContext, factoryHarness)),
      writeFile(path.join(factoryContext, 'preparation/manifest.json'), manifestBytes),
      writeFile(path.join(factoryContext, 'preparation/inventory.json'), Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`)),
      writeFile(path.join(factoryContext, 'preparation/packages.json'), packagesBytes),
    ]);
    const factoryTag = `bug-dreamer-v03-benchmark-factory:${phase4.target.revision.slice(0, 12)}`;
    await chargedRun(ledger, 'builds', 'docker', [
      'build', '--load', '--progress', 'plain', '--tag', factoryTag,
      '--build-arg', `TARGET_REVISION=${phase4.target.revision}`,
      '--file', path.join(factoryContext, factoryDockerfile), factoryContext,
    ], 'artifact-factory-build');

    const factoryInspection = await chargedRun(ledger, 'inspects', 'docker', ['image', 'inspect', factoryTag, '--format', '{{.Id}}\n{{json .Config.Labels}}'], 'artifact-factory-inspect');
    const [artifactFactoryImageId, factoryLabelsJson] = factoryInspection.stdout.trim().split('\n');
    const factoryLabels = JSON.parse(factoryLabelsJson);
    if (!/^sha256:[0-9a-f]{64}$/u.test(artifactFactoryImageId)
      || factoryLabels['org.bug-dreamer.target-revision'] !== phase4.target.revision
      || factoryLabels['org.bug-dreamer.artifact-factory'] !== 'true') throw new Error('Artifact factory image identity or labels changed');
    partialEvidence.artifactFactory = { tag: factoryTag, imageId: artifactFactoryImageId, labels: factoryLabels, extraction: null, receiptSha256: null, receipt: null };
    const factoryContainerName = `bug-dreamer-v03-factory-${randomUUID()}`;
    await chargedRun(ledger, 'probeContainers', 'docker', ['create', '--name', factoryContainerName, artifactFactoryImageId, '/no-execution'], 'artifact-factory-container-create', { containerName: factoryContainerName });
    let extractionError = null;
    try {
      const remainingMs = Math.max(1, 7_200_000 - (nowMs() - ledger.startedAtMs));
      const extraction = await runBoundedCommand('docker', ['cp', `${factoryContainerName}:/prepared/.`, factoryOutput], { timeoutMs: remainingMs, maxOutputBytes: 1_048_576 });
      partialEvidence.artifactFactory.extraction = {
        exitCode: extraction.exitCode,
        timedOut: extraction.timedOut,
        outputTruncated: extraction.outputTruncated,
        stdout: extraction.stdout,
        stderr: extraction.stderr,
      };
      if (extraction.exitCode !== 0 || extraction.timedOut || extraction.outputTruncated) {
        extractionError = new Error(`Artifact factory extraction failed (${extraction.exitCode}, timedOut=${extraction.timedOut}, outputTruncated=${extraction.outputTruncated}):\n${extraction.stderr.slice(-4000)}`);
      }
    } finally {
      chargePreparation(ledger, 'cleanups', nowMs());
      const removal = await runBoundedCommand('docker', ['rm', '--force', factoryContainerName], { timeoutMs: 30_000, maxOutputBytes: 65_536 });
      if (removal.exitCode !== 0 && !/No such container/u.test(removal.stderr)) {
        ledger.cleanupFailures += 1;
        extractionError ??= new Error(`Artifact factory container cleanup failed: ${removal.stderr.slice(-4000)}`);
      }
    }
    if (extractionError !== null) {
      stopPreparationOnFailure(ledger, 'artifact-factory-extraction-failed');
      throw extractionError;
    }

    const factoryReceiptBytes = await readFile(path.join(factoryOutput, 'receipt.json'));
    const factoryReceipt = JSON.parse(factoryReceiptBytes.toString('utf8'));
    partialEvidence.artifactFactory.receiptSha256 = sha256(factoryReceiptBytes);
    partialEvidence.artifactFactory.receipt = factoryReceipt;
    if (factoryReceipt.sets?.length !== 21 || factoryReceipt.sets.map((set) => set.id).join('\0') !== buildPlan.artifactSetIds.join('\0')) throw new Error('Artifact factory output does not match the 21-set build plan');
    const fixtureClosure = await digestTreeClosure(path.join(factoryOutput, 'fixture-tools'));
    partialEvidence.fixtureClosure = fixtureClosure;
    if (fixtureClosure.aggregateSha256 !== factoryReceipt.fixtureTools.aggregateSha256) throw new Error('Fixture-tools closure digest differs from the factory receipt');
    if (factoryReceipt.fixtureTools.targetLockfileSha256 !== sha256(await readFile(path.join(factoryContext, 'target/pnpm-lock.yaml')))) throw new Error('Fixture-tools target lock digest mismatch');

    const cleanProbeDigests = Object.fromEntries(phase1Evidence.probe.artifacts.map((artifact) => [artifact.id, artifact.sha256]));
    const cleanSet = factoryReceipt.sets[0];
    if (JSON.stringify(cleanSet.artifactDigests) !== JSON.stringify(cleanProbeDigests)) throw new Error('Factory clean artifacts differ from the sealed Phase 1 artifacts');

    const images = [];
    partialEvidence.images = images;
    for (const set of factoryReceipt.sets) {
      const packageRegistration = set.moduleId === null ? null : packages.packages.find((item) => item.id === set.moduleId);
      let frozenLock = { bytes: registeredLockBytes, changedLine: null, integritySha512: null, targetKey: null };
      if (packageRegistration !== null) {
        const targetKey = `${packageRegistration.packageName}@file:../artifacts/${packageRegistration.id}.tgz`;
        frozenLock = freezeTargetTarballIntegrity(registeredLockBytes.toString('utf8'), targetKey, await readFile(path.join(factoryOutput, 'artifact-sets', set.id, `${set.moduleId}.tgz`)));
      }
      const finalContext = path.join(temporaryRoot, 'final-contexts', set.id);
      await Promise.all([
        mkdir(path.join(finalContext, 'registrations'), { recursive: true }),
        mkdir(path.join(finalContext, 'harness'), { recursive: true }),
        mkdir(path.join(finalContext, 'evaluator/source'), { recursive: true }),
        mkdir(path.join(finalContext, 'evaluator/vendor'), { recursive: true }),
      ]);
      await Promise.all([
        cp(path.join(factoryOutput, 'artifact-sets', set.id), path.join(finalContext, 'artifacts'), { recursive: true }),
        cp(path.join(factoryOutput, 'fixture-tools'), path.join(finalContext, 'fixture-tools'), { recursive: true }),
        cp(path.join(repositoryRoot, finalDockerfile), path.join(finalContext, 'Dockerfile.benchmark')),
        cp(path.join(repositoryRoot, createConsumerHarness), path.join(finalContext, 'harness/create-consumer.mjs')),
        cp(path.join(repositoryRoot, failClosedHarness), path.join(finalContext, 'harness/fail-closed.mjs')),
        cp(path.join(repositoryRoot, verifyImageHarness), path.join(finalContext, 'harness/verify-image.mjs')),
        cp(packagesPath, path.join(finalContext, 'registrations/packages.json')),
        writeFile(path.join(finalContext, 'registrations/consumer-lock.yaml'), frozenLock.bytes),
      ]);
      await Promise.all([
        copyClosureFiles(sourceClosures.direct, path.join(finalContext, 'evaluator/source')),
        copyClosureFiles(sourceClosures.interpreter, path.join(finalContext, 'evaluator/source')),
        copyClosureFiles(sourceClosures.shared, path.join(finalContext, 'evaluator/source')),
        copyClosureFiles(runtimeDataClosure, path.join(finalContext, 'evaluator/source')),
        cp(path.join(repositoryRoot, 'node_modules/canonicalize'), path.join(finalContext, 'evaluator/vendor/canonicalize'), { recursive: true, dereference: true }),
      ]);
      const sourceClosureDigest = sha256(Buffer.from(JSON.stringify(sourceClosures)));
      const imageInputs = {
        artifactSetId: set.id,
        artifactDigests: set.artifactDigests,
        lockfileSha256: sha256(frozenLock.bytes),
        registrationSha256: sha256(packagesBytes),
        dockerfileSha256: infrastructureClosure.files.find((file) => file.path === finalDockerfile).sha256,
        sourceClosures,
        runtimeDataClosure,
        infrastructureClosure,
        canonicalizer,
        fixtureTools: factoryReceipt.fixtureTools,
        targetRevision: phase4.target.revision,
        approvedStaticPolicySha256: phase4.sourceArtifacts.approvedPolicyDraft.sha256,
        inventorySha256: sha256(inventoryBytes),
        manifestSha256: sha256(manifestBytes),
        artifactFactoryReceiptSha256: sha256(factoryReceiptBytes),
      };
      const contractKey = benchmarkImageContractKey(imageInputs);
      const infrastructureSha = (relativePath) => infrastructureClosure.files.find((file) => file.path === relativePath)?.sha256;
      const imageManifest = {
        schemaVersion: 'bug-dreamer/v03-benchmark-image-manifest/v1',
        artifactSetId: set.id,
        benchmarkImageContractKey: contractKey,
        roots: [
          { path: '/artifacts', files: Object.entries(set.artifactDigests).map(([artifactId, digest]) => ({ path: `${artifactId}.tgz`, kind: 'file', sha256: digest })).sort((left, right) => codeUnitSort(left.path, right.path)) },
          { path: '/consumer/evaluator/source', files: closureFiles(sourceClosures.direct, sourceClosures.interpreter, sourceClosures.shared, runtimeDataClosure) },
          { path: '/consumer/evaluator/node_modules/canonicalize', files: canonicalizer.files.map((file) => ({ ...file, kind: 'file' })).sort((left, right) => codeUnitSort(left.path, right.path)) },
          { path: '/fixture-tools', files: fixtureClosure.files },
          { path: '/harness', files: [
            { path: 'create-consumer.mjs', kind: 'file', sha256: infrastructureSha(createConsumerHarness) },
            { path: 'verify-image.mjs', kind: 'file', sha256: infrastructureSha(verifyImageHarness) },
          ] },
        ],
        files: [
          { path: '/consumer/pnpm-lock.yaml', sha256: imageInputs.lockfileSha256 },
          { path: '/consumer/evaluator/fail-closed.mjs', sha256: infrastructureSha(failClosedHarness) },
          { path: '/registration/packages.json', sha256: imageInputs.registrationSha256 },
        ],
      };
      await writeFile(path.join(finalContext, 'registrations/image-manifest.json'), `${JSON.stringify(imageManifest, null, 2)}\n`);
      const tag = `bug-dreamer-v03-benchmark:${phase4.target.revision.slice(0, 12)}-${set.id}`;
      await chargedRun(ledger, 'builds', 'docker', [
        'build', '--load', '--progress', 'plain', '--tag', tag,
        '--build-arg', `TARGET_REVISION=${phase4.target.revision}`,
        '--build-arg', `ARTIFACT_SET_ID=${set.id}`,
        '--build-arg', `BENCHMARK_IMAGE_CONTRACT_KEY=${contractKey}`,
        '--build-arg', `SOURCE_CLOSURE_SHA256=${sourceClosureDigest}`,
        '--build-arg', `FIXTURE_TOOLS_LOCK_SHA256=${factoryReceipt.fixtureTools.lockfileSha256}`,
        '--file', path.join(finalContext, 'Dockerfile.benchmark'), finalContext,
      ], `final-image-build-${set.id}`);
      const inspection = await chargedRun(ledger, 'inspects', 'docker', ['image', 'inspect', tag, '--format', '{{.Id}}\n{{json .Config.Labels}}'], `image-inspect-${set.id}`);
      const [inspectedId, labelsJson] = inspection.stdout.trim().split('\n');
      const inspectedLabels = JSON.parse(labelsJson);
      if (!/^sha256:[0-9a-f]{64}$/u.test(inspectedId) || inspectedLabels['org.bug-dreamer.benchmark-image-contract-key'] !== contractKey) throw new Error(`Final image identity or contract label mismatch: ${set.id}`);
      const containerName = `bug-dreamer-v03-prep-${randomUUID()}`;
      const probe = await chargedRun(ledger, 'probeContainers', 'docker', ['run', '--rm', ...isolationArgs, '--name', containerName, '--entrypoint', 'node', inspectedId, '/harness/verify-image.mjs', '--json'], `identity-probe-${set.id}`, { containerName });
      const probeIdentity = JSON.parse(probe.stdout.trim());
      if (probeIdentity.artifactSetId !== set.id || probeIdentity.benchmarkImageContractKey !== contractKey) throw new Error(`Final image identity probe mismatch: ${set.id}`);
      images.push({ artifactSetId: set.id, tag, imageId: inspectedId, contractKey, lockfileSha256: imageInputs.lockfileSha256, changedIntegrity: frozenLock.changedLine === null ? null : { packageKey: frozenLock.targetKey, line: frozenLock.changedLine, integritySha512: frozenLock.integritySha512 }, buildInputs: imageInputs });
    }
    const cleanImage = images.find((image) => image.artifactSetId === 'clean');
    if (cleanImage === undefined) throw new Error('Synthetic smoke requires the clean image');
    const descriptorByModule = new Map(await Promise.all(['tx', 'local-first', 'prepaint'].map(async (moduleId) => [
      moduleId,
      JSON.parse(await readFile(path.join(repositoryRoot, `registrations/v0.3/benchmark/${moduleId}.json`), 'utf8')),
    ])));
    const smokeDirectoryRoot = path.join(temporaryRoot, 'synthetic-smoke');
    const runSmokeCase = createIsolatedBenchmarkCaseRunner({
      spawn,
      readResultChannel: readTrustedResultChannel,
      writeCaseInput: async (inputDirectory, item) => writeFile(path.join(inputDirectory, 'case.json'), `${JSON.stringify(item.caseInput, null, 2)}\n`),
      makeDirectories: async (_item, context) => {
        const root = path.join(smokeDirectoryRoot, String(context.sequence).padStart(4, '0'));
        const inputDirectory = path.join(root, 'input');
        const resultDirectory = path.join(root, 'result');
        await Promise.all([mkdir(inputDirectory, { recursive: true }), mkdir(resultDirectory, { recursive: true })]);
        return { inputDirectory, resultDirectory };
      },
    });
    const smokeResults = [];
    partialEvidence.syntheticSmoke.results = smokeResults;
    let smokeSequence = 0;
    for (const smoke of smokes) {
      const descriptor = descriptorByModule.get(smoke.moduleId);
      const targetArtifactDigest = cleanSet.artifactDigests[smoke.moduleId];
      if (descriptor === undefined || !/^[0-9a-f]{64}$/u.test(targetArtifactDigest)) throw new Error(`Synthetic smoke clean artifact is unavailable: ${smoke.id}`);
      const artifact = { role: 'clean', targetArtifactDigest, evaluationContractKey: cleanImage.contractKey, imageId: cleanImage.imageId };
      const inputs = syntheticSmokeInputs(smoke, descriptor, artifact);
      for (const executionPath of ['comparison', 'interpreter']) {
        smokeSequence += 1;
        chargePreparation(ledger, 'probeContainers', nowMs());
        const attemptEvidence = {
          sequence: smokeSequence,
          smokeId: smoke.id,
          moduleId: smoke.moduleId,
          executionPath,
          artifactRole: artifact.role,
          imageId: artifact.imageId,
          targetArtifactDigest: artifact.targetArtifactDigest,
          evaluationContractKey: artifact.evaluationContractKey,
          process: null,
          resultChannel: null,
          dockerArgs: null,
          validation: { status: 'pending', error: null },
        };
        smokeResults.push(attemptEvidence);
        partialEvidence.syntheticSmoke.runs = smokeResults.length;
        let executed;
        try {
          executed = await runSmokeCase({ executionPath, artifact, caseInput: executionPath === 'comparison' ? inputs.direct : inputs.interpreter }, { sequence: smokeSequence });
        } catch (error) {
          attemptEvidence.validation = { status: 'failed', error: `runner-error:${error.message}` };
          stopPreparationOnFailure(ledger, `synthetic-smoke-${smoke.moduleId}-${executionPath}-failed`);
          throw error;
        }
        chargePreparation(ledger, 'cleanups', nowMs());
        const processEvidence = {
          exitCode: executed.execution.exitCode,
          timedOut: executed.execution.timedOut,
          outputTruncated: executed.execution.outputTruncated,
          stdoutBytes: executed.execution.stdoutBytes,
          stderrBytes: executed.execution.stderrBytes,
          stdout: executed.execution.stdout,
          stderr: executed.execution.stderr,
          cleanupError: executed.execution.cleanupError,
        };
        attemptEvidence.process = processEvidence;
        attemptEvidence.dockerArgs = executed.dockerArgs;
        attemptEvidence.resultChannel = {
          entries: executed.channel.entries,
          bytesBase64: executed.channel.resultBytes?.toString('base64') ?? null,
          sha256: executed.channel.resultBytes === null ? null : sha256(executed.channel.resultBytes),
        };
        if (executed.execution.cleanupError !== null) ledger.cleanupFailures += 1;
        if (executed.execution.exitCode !== 0 || executed.execution.timedOut || executed.execution.outputTruncated || executed.execution.cleanupError !== null || executed.channel.resultBytes === null) {
          attemptEvidence.validation = { status: 'failed', error: 'process-or-result-channel-failure' };
          stopPreparationOnFailure(ledger, `synthetic-smoke-${smoke.moduleId}-${executionPath}-failed`);
          throw new Error(`Synthetic clean smoke failed: ${smoke.id}/${executionPath}`);
        }
        let result;
        try {
          result = JSON.parse(executed.channel.resultBytes.toString('utf8'));
          validateBenchmarkTrustedResult(result, inputs.plan, inputs.spec, descriptor);
        } catch (error) {
          attemptEvidence.validation = { status: 'failed', error: `trusted-result-invalid:${error.message}` };
          stopPreparationOnFailure(ledger, `synthetic-smoke-${smoke.moduleId}-${executionPath}-failed`);
          throw error;
        }
        const observed = { execution: result.execution, observedKind: result.observedKind, observedFields: result.observedFields };
        try {
          exactObject(observed, ['execution', 'observedKind', 'observedFields'], 'Synthetic smoke result projection');
          if (canonicalJson(observed) !== canonicalJson(smoke.expectedClean)) throw new Error('expected-clean-mismatch');
        } catch (error) {
          attemptEvidence.validation = { status: 'failed', error: error.message };
          stopPreparationOnFailure(ledger, `synthetic-smoke-${smoke.moduleId}-${executionPath}-expectation-mismatch`);
          throw new Error(`Synthetic clean smoke expectation mismatch: ${smoke.id}/${executionPath}: ${error.message}`);
        }
        attemptEvidence.validation = { status: 'pass', error: null, payloadDigest: result.payloadDigest, expectedClean: observed };
      }
    }
    if (smokeResults.length !== 6 || ledger.builds !== 22 || ledger.inspects + ledger.probeContainers !== 50) throw new Error('Preparation did not consume the planned 22 builds and 50 inspect/probe operations');
    await cleanupTemporary();
    const completedLedger = publicPreparationLedger(ledger, nowMs());
    if (completedLedger.elapsedSeconds > 7200 || completedLedger.failures !== 0 || completedLedger.cleanupFailures !== 0) throw new Error('Preparation completed outside its approved wall-clock or failure budget');
    await writeEvidence({ schemaVersion: 'bug-dreamer/v03-benchmark-preparation-evidence/v1', status: 'prepared', ...partialEvidence, ledger: completedLedger });
    process.stdout.write(`${JSON.stringify({ status: 'ok', evidence: path.relative(repositoryRoot, evidencePath), builds: ledger.builds, inspectOrProbe: ledger.inspects + ledger.probeContainers })}\n`);
  } catch (error) {
    if (ledger.stoppedBy === null) stopPreparationOnFailure(ledger, 'preparation-validation-failed');
    try {
      await cleanupTemporary();
    } catch (cleanupError) {
      process.stderr.write(`Cleanup failed: ${cleanupError.message}\n`);
    }
    await writeEvidence({ schemaVersion: 'bug-dreamer/v03-benchmark-preparation-evidence/v1', status: 'stopped', error: error.message, ...partialEvidence, ledger: publicPreparationLedger(ledger, nowMs()) });
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = error instanceof TypeError ? 2 : 1;
  });
}
