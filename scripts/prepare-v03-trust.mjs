import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCaseRunner } from '../src/v03-runner.mjs';
import {
  buildExecutionPlan,
  buildNightmareSpec,
  loadPhase2Catalog,
  parseNightmareSeed,
} from '../src/v03-spec.mjs';
import { EXECUTION_BUDGET, classifyTrustedResult, readTrustedResultChannel } from '../src/v03-trust.mjs';
import { domainDigest } from '../src/v03-wire.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase2-trust.json');
const prepareScriptPath = path.join(repositoryRoot, 'scripts/prepare-v03-trust.mjs');
const contractEvidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase1-contracts.json');
const dockerfilePath = path.join(repositoryRoot, 'docker-v0.3/Dockerfile.trust');
const catalogPath = path.join(repositoryRoot, 'registrations/v0.3/phase2-catalog.json');
const harnessFiles = ['harness-v0.3/trust/case-main.mjs', 'harness-v0.3/trust/evaluator.mjs', 'harness-v0.3/trust/main.mjs', 'harness-v0.3/trust/virtual-clock.mjs'];
const sourceFiles = ['src/v03-wire.mjs', 'src/v03-spec.mjs', 'src/v03-trust.mjs'];
const productionCommand = ['/consumer/evaluator/main.mjs'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--target' || args[1].length === 0) {
    throw new TypeError('Usage: node scripts/prepare-v03-trust.mjs --target <firsttx-path>');
  }
  return args[1];
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function aggregateFiles(root, relativePaths) {
  const digest = createHash('sha256');
  for (const relativePath of [...relativePaths].sort()) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(await readFile(path.join(root, relativePath)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function listFiles(root, prefix = '') {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function caseCommand(mode) {
  return ['/consumer/evaluator/case-main.mjs', '--mode', mode];
}

function normalizedRunArgs(args, inputDirectory, resultDirectory, imageId, command, containerName) {
  const normalized = args.slice(0, args.length - command.length).map((argument) => {
    if (argument === `type=bind,source=${inputDirectory},target=/input,readonly`) return '<input-mount>';
    if (argument === `type=bind,source=${resultDirectory},target=/result`) return '<result-mount>';
    if (argument === imageId) return '<image>';
    if (argument === containerName) return '<container-name>';
    return argument;
  });
  return [...normalized, '<command>'];
}

const runCase = createCaseRunner({ spawn, budget: EXECUTION_BUDGET });

async function inspectImage(reference, format) {
  const inspection = await run('docker', ['image', 'inspect', reference, '--format', format]);
  if (inspection.exitCode !== 0) throw new Error(inspection.stderr.trim());
  return inspection.stdout.trim();
}

async function resolveImageId(reference) {
  const imageId = await inspectImage(reference, '{{.Id}}');
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`Image ID is invalid: ${reference}`);
  return imageId;
}

async function assertBuiltFrom(childReference, baseImageId, label) {
  const [childLayers, baseLayers] = await Promise.all([
    inspectImage(childReference, '{{json .RootFS.Layers}}').then((value) => JSON.parse(value)),
    inspectImage(baseImageId, '{{json .RootFS.Layers}}').then((value) => JSON.parse(value)),
  ]);
  const descends = baseLayers.length > 0
    && baseLayers.length <= childLayers.length
    && baseLayers.every((layer, index) => layer === childLayers[index]);
  if (!descends) throw new Error(`${label} was not built from the recorded base image ID`);
}

async function readCanonicalizerIntegrity(lockfilePath) {
  const lockfile = await readFile(lockfilePath, 'utf8');
  const match = lockfile.match(/^ {2}canonicalize@4\.0\.0:\r?\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/mu);
  if (match === null) throw new Error('canonicalize@4.0.0 integrity is missing from pnpm-lock.yaml');
  return match[1];
}

async function main() {
  const targetInput = parseArgs(process.argv.slice(2));
  const targetPath = await realpath(path.resolve(targetInput));
  if (!(await stat(targetPath)).isDirectory()) throw new Error('Target path must be a directory');
  const [{ catalog, catalogBytes }, contractEvidenceBytes] = await Promise.all([
    loadPhase2Catalog(repositoryRoot),
    readFile(contractEvidencePath),
  ]);
  const contractEvidence = JSON.parse(contractEvidenceBytes.toString('utf8'));
  const revision = await run('git', ['-C', targetPath, 'rev-parse', 'HEAD']);
  if (revision.exitCode !== 0) throw new Error(revision.stderr.trim());
  if (revision.stdout.trim() !== catalog.target.targetRevision) throw new Error(`Target HEAD must be ${catalog.target.targetRevision}`);
  const contractImageTag = contractEvidence.image.tag;
  if (await resolveImageId(contractImageTag) !== contractEvidence.image.imageId) throw new Error('Phase 1 image tag does not match recorded evidence');

  const canonicalizeRoot = await realpath(path.join(repositoryRoot, 'node_modules/canonicalize'));
  const canonicalizeFiles = (await listFiles(canonicalizeRoot)).filter((file) => file.split(path.sep)[0] !== 'node_modules');
  const buildInputs = {
    contractImageId: contractEvidence.image.imageId,
    targetRevision: catalog.target.targetRevision,
    targetArtifactDigest: catalog.target.artifactSha256,
    dockerfileSha256: sha256(await readFile(dockerfilePath)),
    harnessFiles,
    harnessSha256: await aggregateFiles(repositoryRoot, harnessFiles),
    sourceFiles,
    sourceSha256: await aggregateFiles(repositoryRoot, sourceFiles),
    catalogSha256: sha256(catalogBytes),
    prepareScriptSha256: sha256(await readFile(prepareScriptPath)),
    executionBudget: EXECUTION_BUDGET,
    canonicalizer: {
      package: 'canonicalize',
      version: '4.0.0',
      integritySha512: await readCanonicalizerIntegrity(path.join(repositoryRoot, 'pnpm-lock.yaml')),
      files: canonicalizeFiles,
      aggregateSha256: await aggregateFiles(canonicalizeRoot, canonicalizeFiles),
    },
  };
  const evaluationContractKey = domainDigest('bug-dreamer/evaluation-contract/v1', buildInputs);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-v03-trust-'));
  const imageTag = `bug-dreamer-v03-trust:${catalog.target.targetRevision.slice(0, 12)}`;
  try {
    await Promise.all([
      mkdir(path.join(temporaryRoot, 'docker-v0.3'), { recursive: true }),
      mkdir(path.join(temporaryRoot, 'harness-v0.3/trust'), { recursive: true }),
      mkdir(path.join(temporaryRoot, 'src'), { recursive: true }),
      mkdir(path.join(temporaryRoot, 'registrations/v0.3'), { recursive: true }),
      mkdir(path.join(temporaryRoot, 'vendor'), { recursive: true }),
    ]);
    await Promise.all([
      cp(dockerfilePath, path.join(temporaryRoot, 'docker-v0.3/Dockerfile.trust')),
      ...harnessFiles.map((relativePath) => cp(path.join(repositoryRoot, relativePath), path.join(temporaryRoot, relativePath))),
      ...sourceFiles.map((relativePath) => cp(path.join(repositoryRoot, relativePath), path.join(temporaryRoot, relativePath))),
      cp(catalogPath, path.join(temporaryRoot, 'registrations/v0.3/phase2-catalog.json')),
      ...canonicalizeFiles.map(async (relativePath) => {
        const destination = path.join(temporaryRoot, 'vendor/canonicalize', relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(path.join(canonicalizeRoot, relativePath), destination);
      }),
    ]);

    const build = await run('docker', [
      'build',
      '--load',
      '--progress',
      'plain',
      '--tag',
      imageTag,
      '--build-arg',
      `CONTRACT_IMAGE=${contractImageTag}`,
      '--build-arg',
      `CONTRACT_IMAGE_ID=${contractEvidence.image.imageId}`,
      '--build-arg',
      `EVALUATION_CONTRACT_DIGEST=${evaluationContractKey}`,
      '--build-arg',
      `PHASE2_CATALOG_SHA256=${buildInputs.catalogSha256}`,
      '--build-arg',
      `TRUST_HARNESS_SHA256=${buildInputs.harnessSha256}`,
      '--file',
      path.join(temporaryRoot, 'docker-v0.3/Dockerfile.trust'),
      temporaryRoot,
    ]);
    process.stdout.write(build.stdout);
    process.stderr.write(build.stderr);
    if (build.exitCode !== 0) throw new Error('Phase 2 evaluator image build failed');

    const [imageId, labelJson] = await Promise.all([
      resolveImageId(imageTag),
      inspectImage(imageTag, '{{json .Config.Labels}}'),
    ]);
    await assertBuiltFrom(imageId, contractEvidence.image.imageId, 'Phase 2 evaluator image');
    const labels = JSON.parse(labelJson);
    if (labels['org.bug-dreamer.evaluation-contract-key'] !== evaluationContractKey) throw new Error('Evaluator image contract label mismatch');

    const caseDefinitions = [
      { id: 'pass', seed: 'contracts/v0.3/seeds/pass.json', mode: 'valid', command: productionCommand, expectedEvaluator: 'evaluated', expectedExecution: 'pass' },
      { id: 'candidate', seed: 'contracts/v0.3/seeds/candidate.json', mode: 'valid', command: productionCommand, expectedEvaluator: 'evaluated', expectedExecution: 'candidate-failure' },
      { id: 'marker-forgery', seed: 'contracts/v0.3/seeds/marker-forgery.json', mode: 'valid', command: productionCommand, expectedEvaluator: 'evaluated', expectedExecution: 'pass' },
      { id: 'kind-flip', seed: 'contracts/v0.3/seeds/kind-flip.json', mode: 'valid', command: productionCommand, expectedEvaluator: 'evaluated', expectedExecution: 'candidate-failure' },
      { id: 'retry-delay', seed: 'contracts/v0.3/seeds/retry-delay.json', mode: 'valid', command: productionCommand, expectedEvaluator: 'evaluated', expectedExecution: 'candidate-failure' },
      { id: 'missing-result', seed: 'contracts/v0.3/seeds/marker-forgery.json', mode: 'missing', command: caseCommand('missing'), expectedEvaluator: 'evaluator-error', expectedExecution: 'unrunnable' },
      { id: 'malformed-result', seed: 'contracts/v0.3/seeds/pass.json', mode: 'malformed', command: caseCommand('malformed'), expectedEvaluator: 'evaluator-error', expectedExecution: 'unrunnable' },
      { id: 'wrong-digest', seed: 'contracts/v0.3/seeds/pass.json', mode: 'wrong-digest', command: caseCommand('wrong-digest'), expectedEvaluator: 'evaluator-error', expectedExecution: 'unrunnable' },
      { id: 'early-exit', seed: 'contracts/v0.3/seeds/pass.json', mode: 'early-exit', command: caseCommand('early-exit'), expectedEvaluator: 'evaluator-error', expectedExecution: 'unrunnable' },
      { id: 'timeout', seed: 'contracts/v0.3/seeds/pass.json', mode: 'timeout', command: caseCommand('timeout'), expectedEvaluator: 'evaluator-error', expectedExecution: 'unrunnable' },
      { id: 'log-overflow', seed: 'contracts/v0.3/seeds/pass.json', mode: 'log-overflow', command: caseCommand('log-overflow'), expectedEvaluator: 'evaluator-error', expectedExecution: 'unrunnable' },
    ];
    const caseResults = [];
    let dockerRunArgsTemplate;
    for (const definition of caseDefinitions) {
      const caseRoot = path.join(temporaryRoot, `case-${definition.id}`);
      const inputDirectory = path.join(caseRoot, 'input');
      const resultDirectory = path.join(caseRoot, 'result');
      await Promise.all([
        mkdir(inputDirectory, { recursive: true }),
        mkdir(resultDirectory, { recursive: true }),
      ]);
      await chmod(resultDirectory, 0o777);
      const seedBytes = await readFile(path.join(repositoryRoot, definition.seed));
      const seed = parseNightmareSeed(seedBytes, catalog);
      const spec = buildNightmareSpec(seed, catalog);
      const plan = buildExecutionPlan(spec, catalog);
      await Promise.all([
        writeFile(path.join(inputDirectory, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`),
        writeFile(path.join(inputDirectory, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`),
      ]);
      const containerName = `bug-dreamer-v03-trust-${definition.id}-${randomUUID()}`;
      const dockerRunArgs = [
        'run',
        '--rm',
        '--name',
        containerName,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--mount',
        `type=bind,source=${inputDirectory},target=/input,readonly`,
        '--mount',
        `type=bind,source=${resultDirectory},target=/result`,
        imageId,
        ...definition.command,
      ];
      const normalizedArgs = normalizedRunArgs(dockerRunArgs, inputDirectory, resultDirectory, imageId, definition.command, containerName);
      dockerRunArgsTemplate ??= normalizedArgs;
      if (JSON.stringify(normalizedArgs) !== JSON.stringify(dockerRunArgsTemplate)) throw new Error('Trust cases use different isolation arguments');
      const execution = await runCase(dockerRunArgs, containerName);
      const { entries: resultEntries, resultBytes } = await readTrustedResultChannel(resultDirectory);
      const classification = classifyTrustedResult({
        resultBytes,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        outputTruncated: execution.outputTruncated,
        plan,
        spec,
        catalog,
      });
      if (classification.evaluator !== definition.expectedEvaluator || classification.execution.status !== definition.expectedExecution) {
        throw new Error(`Unexpected trust classification: ${definition.id} ${JSON.stringify({ exitCode: execution.exitCode, stdout: execution.stdout, stderr: execution.stderr, resultEntries, classification })}`);
      }
      caseResults.push({
        id: definition.id,
        seedPath: definition.seed,
        seedSha256: sha256(seedBytes),
        mode: definition.mode,
        command: definition.command,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        stdoutBytes: execution.stdoutBytes,
        stderrBytes: execution.stderrBytes,
        timedOut: execution.timedOut,
        outputTruncated: execution.outputTruncated,
        cleanupError: execution.cleanupError,
        resultEntries,
        rawResult: resultBytes === null ? null : resultBytes.toString('utf8'),
        classification,
      });
    }

    const receipt = {
      schemaVersion: 'bug-dreamer/phase2-trust-evidence/v1',
      targetRevision: catalog.target.targetRevision,
      phase1Evidence: {
        path: 'evidence/v0.3/phase1-contracts.json',
        sha256: sha256(contractEvidenceBytes),
        imageId: contractEvidence.image.imageId,
      },
      catalog: {
        path: 'registrations/v0.3/phase2-catalog.json',
        sha256: buildInputs.catalogSha256,
        catalogVersion: catalog.catalogVersion,
      },
      evaluationContractKey,
      image: {
        tag: imageTag,
        imageId,
        contractImageId: contractEvidence.image.imageId,
        labels,
      },
      buildInputs,
      isolation: {
        dockerRunArgs: dockerRunArgsTemplate,
        network: 'none',
        readOnlyRoot: true,
        capabilities: 'none',
        noNewPrivileges: true,
        dockerSocket: false,
        pidsLimit: 128,
        memory: '512m',
        cpus: 1,
        freshInputAndResultMountsPerRun: true,
      },
      cases: caseResults,
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'ok', evidence: path.relative(repositoryRoot, evidencePath), image: imageTag })}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = error instanceof TypeError ? 2 : 1;
});
