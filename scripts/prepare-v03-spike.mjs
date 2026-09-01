import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { firstPartyEntryBlocks, lockfileSection } from '../src/v03-contracts.mjs';
import { buildTransformedSpec, loadPhase3Catalog } from '../src/v03-operators.mjs';
import { assertNoSymlinkAncestors, resolveContainedPath } from '../src/v03-paths.mjs';
import { createCaseRunner } from '../src/v03-runner.mjs';
import {
  V03SpecError,
  buildExecutionPlan,
  buildNightmareSpec,
  parseNightmareSeed,
  planDigest,
  specDigest,
} from '../src/v03-spec.mjs';
import { EXECUTION_BUDGET, classifyTrustedResult, readTrustedResultChannel } from '../src/v03-trust.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from '../src/v03-wire.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registrationPath = path.join(repositoryRoot, 'benchmark/v0.3/phase3-spike.json');
const manifestPath = path.join(repositoryRoot, 'benchmark/manifest.json');
const evidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase3-spike.json');
const trustEvidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase2-trust.json');
const contractEvidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase1-contracts.json');
const prepareScriptPath = path.join(repositoryRoot, 'scripts/prepare-v03-spike.mjs');
const seedPath = 'contracts/v0.3/seeds/total-timeout.json';
const operatorArmRequests = [
  { operatorId: 'time.advance/v1', requestPath: 'contracts/v0.3/requests/time-advance.json' },
  { operatorId: 'schedule.release-order/v1', requestPath: 'contracts/v0.3/requests/spike-release-order.json' },
  { operatorId: 'fault.step-outcome/v1', requestPath: 'contracts/v0.3/requests/spike-fault.json' },
];
const harnessFiles = ['harness-v0.3/trust/case-main.mjs', 'harness-v0.3/trust/evaluator.mjs', 'harness-v0.3/trust/main.mjs', 'harness-v0.3/trust/virtual-clock.mjs'];
const sourceFiles = ['src/v03-wire.mjs', 'src/v03-spec.mjs', 'src/v03-trust.mjs'];
const operatorModuleFile = 'src/v03-operators.mjs';
const specCasesPath = 'contracts/v0.3/spec-cases.json';
const productionCommand = ['/consumer/evaluator/main.mjs'];

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--target' || args[1].length === 0) {
    throw new TypeError('Usage: node scripts/prepare-v03-spike.mjs --target <firsttx-path>');
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

const runCase = createCaseRunner({ spawn, budget: EXECUTION_BUDGET });

const ISOLATION_ARGS = ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m'];

async function executeSpec(imageId, spec, plan, catalog, workRoot, label) {
  const caseRoot = path.join(workRoot, `run-${label}-${randomUUID()}`);
  const inputDirectory = path.join(caseRoot, 'input');
  const resultDirectory = path.join(caseRoot, 'result');
  await mkdir(inputDirectory, { recursive: true });
  await mkdir(resultDirectory, { recursive: true });
  await chmod(resultDirectory, 0o777);
  await writeFile(path.join(inputDirectory, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
  await writeFile(path.join(inputDirectory, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const containerName = `bug-dreamer-v03-spike-${label}-${randomUUID()}`;
  const dockerRunArgs = [
    'run', '--rm', '--name', containerName, ...ISOLATION_ARGS,
    '--mount', `type=bind,source=${inputDirectory},target=/input,readonly`,
    '--mount', `type=bind,source=${resultDirectory},target=/result`,
    imageId,
    ...productionCommand,
  ];
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
  return {
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
  };
}

function rejectionRecord(error) {
  if (error instanceof V03SpecError) return { kind: error.kind, message: error.message };
  throw error;
}

function applyEdit(source, edit) {
  const occurrences = source.split(edit.find).length - 1;
  if (occurrences !== 1) throw new Error(`Defect edit for ${edit.file} matched ${occurrences} times; exactly one match is required`);
  return source.replace(edit.find, edit.replace);
}

async function archiveTarget(targetPath, destination, revision) {
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['-C', targetPath, 'archive', '--format=tar', revision], { stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] });
    archive.stdout.pipe(extract.stdin);
    archive.once('error', reject);
    extract.once('error', reject);
    archive.once('close', (code) => {
      if (code !== 0) reject(new Error('git archive failed'));
    });
    extract.once('close', (code) => (code === 0 ? resolve() : reject(new Error('tar extract failed'))));
  });
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

async function dockerBuild(args) {
  const build = await run('docker', ['build', '--load', '--progress', 'plain', ...args]);
  if (build.exitCode !== 0) throw new Error(`Docker build failed:\n${build.stderr.slice(-4000)}`);
}

async function inspectImage(reference, format) {
  const inspection = await run('docker', ['image', 'inspect', reference, '--format', format]);
  if (inspection.exitCode !== 0) throw new Error(inspection.stderr.trim());
  return inspection.stdout.trim();
}

async function imageId(reference) {
  const id = await inspectImage(reference, '{{.Id}}');
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`Image ID is invalid: ${reference}`);
  return id;
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

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

function targetEntryLineRange(lockfileText, targetKey) {
  const sectionStart = lockfileText.indexOf('packages:\n');
  if (sectionStart < 0) throw new Error('Consumer lockfile has no packages section');
  const section = lockfileSection(lockfileText, 'packages:', 'snapshots:');
  const blocks = firstPartyEntryBlocks(section);
  const bodyLength = blocks.reduce((sum, block) => sum + block.body.length, 0);
  let offset = sectionStart + section.length - bodyLength;
  for (const block of blocks) {
    if (block.key === targetKey) {
      const startLine = lineNumberAt(lockfileText, offset);
      const bodyLines = block.body.split('\n');
      let entryLines = 1;
      while (entryLines < bodyLines.length && !/^ {2}\S/u.test(bodyLines[entryLines])) entryLines += 1;
      return { startLine, endLine: startLine + entryLines - 1 };
    }
    offset += block.body.length;
  }
  throw new Error(`Consumer lockfile has no first-party entry for the target module: ${targetKey}`);
}

function parseResolutionLine(line) {
  return /^(?<prefix> {4}resolution: \{integrity: )(?<integrity>sha512-[A-Za-z0-9+/=]+)(?<suffix>[^\n]*)$/u.exec(line)?.groups;
}

function compareDefectLockfile(registeredLockfile, defectLockfile, targetKey) {
  const registeredLines = registeredLockfile.split('\n');
  const defectLines = defectLockfile.split('\n');
  if (defectLines.length !== registeredLines.length) throw new Error('Defect consumer lockfile line count changed');
  const changedIntegrityLines = registeredLines
    .map((line, index) => (line === defectLines[index] ? null : index + 1))
    .filter((line) => line !== null);
  if (changedIntegrityLines.length !== 1) {
    throw new Error(`Defect consumer lockfile changed an unexpected number of lines: ${changedIntegrityLines.length}`);
  }
  const [changedLine] = changedIntegrityLines;
  const { startLine, endLine } = targetEntryLineRange(registeredLockfile, targetKey);
  if (changedLine < startLine || changedLine > endLine) {
    throw new Error(`Defect consumer lockfile changed line ${changedLine} outside the target tarball entry`);
  }
  const registered = parseResolutionLine(registeredLines[changedLine - 1]);
  const rebuilt = parseResolutionLine(defectLines[changedLine - 1]);
  if (registered === undefined || rebuilt === undefined) {
    throw new Error(`Defect consumer lockfile changed a line that is not a tarball integrity value: ${changedLine}`);
  }
  if (registered.suffix !== rebuilt.suffix) {
    throw new Error(`Defect consumer lockfile changed a resolution field other than integrity: ${changedLine}`);
  }
  return { line: changedLine, packageKey: targetKey, registered: registered.integrity, defect: rebuilt.integrity };
}

async function main() {
  const targetInput = parseArgs(process.argv.slice(2));
  const targetPath = await realpath(path.resolve(targetInput));
  if (!(await stat(targetPath)).isDirectory()) throw new Error('Target path must be a directory');

  const [registrationBytes, manifestBytes, trustEvidenceBytes, contractEvidenceBytes] = await Promise.all([
    readFile(registrationPath),
    readFile(manifestPath),
    readFile(trustEvidencePath),
    readFile(contractEvidencePath),
  ]);
  const registration = JSON.parse(registrationBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const trustEvidence = JSON.parse(trustEvidenceBytes.toString('utf8'));
  const contractEvidence = JSON.parse(contractEvidenceBytes.toString('utf8'));
  const defect = manifest.defects.find((item) => item.id === registration.defect.id);
  if (defect === undefined) throw new Error(`Registered spike defect is not in the frozen manifest: ${registration.defect.id}`);
  if (defect.module !== registration.defect.module) throw new Error('Spike defect module mismatch');

  const { catalog: cleanCatalog, catalogBytes, operatorCatalog, operatorBytes } = await loadPhase3Catalog(repositoryRoot);
  if (registration.targetRevision !== cleanCatalog.target.targetRevision) throw new Error('Spike registration target revision mismatch');
  const revision = await run('git', ['-C', targetPath, 'rev-parse', 'HEAD']);
  if (revision.exitCode !== 0) throw new Error(revision.stderr.trim());
  if (revision.stdout.trim() !== registration.targetRevision) throw new Error(`Target HEAD must be ${registration.targetRevision}`);

  const cleanTrustTag = trustEvidence.image.tag;
  const cleanTrustId = await imageId(cleanTrustTag);
  if (cleanTrustId !== trustEvidence.image.imageId) throw new Error('Clean trust image does not match recorded Phase 2 evidence');

  const revisionShort = registration.targetRevision.slice(0, 12);
  const defectConsumerTag = `bug-dreamer-v03-spike-consumer:${revisionShort}-${defect.id}`;
  const defectTrustTag = `bug-dreamer-v03-spike-trust:${revisionShort}-${defect.id}`;
  const cleanSpikeTag = `bug-dreamer-v03-spike:${revisionShort}-clean`;
  const defectSpikeTag = `bug-dreamer-v03-spike:${revisionShort}-${defect.id}`;

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-v03-spike-'));
  try {
    const consumerContext = path.join(temporaryRoot, 'consumer-context');
    const targetDestination = path.join(consumerContext, 'target');
    await mkdir(targetDestination, { recursive: true });
    await archiveTarget(targetPath, targetDestination, registration.targetRevision);
    for (const edit of defect.edits) {
      const filePath = resolveContainedPath(targetDestination, edit.file);
      await assertNoSymlinkAncestors(targetDestination, filePath);
      await writeFile(filePath, applyEdit(await readFile(filePath, 'utf8'), edit));
    }
    await cp(path.join(repositoryRoot, 'docker-v0.3'), path.join(consumerContext, 'docker-v0.3'), { recursive: true });
    const consumerDockerfilePatch = {
      file: 'docker-v0.3/Dockerfile',
      find: 'RUN pnpm install --frozen-lockfile\n',
      replace: 'RUN pnpm install --update-checksums\n',
      reason: 'The frozen consumer lockfile pins the clean first-party tarball integrity; the defect tarball requires refreshed checksums while every other resolution stays locked.',
    };
    const consumerDockerfilePath = path.join(consumerContext, consumerDockerfilePatch.file);
    await writeFile(consumerDockerfilePath, applyEdit(await readFile(consumerDockerfilePath, 'utf8'), consumerDockerfilePatch));
    await cp(path.join(repositoryRoot, 'harness-v0.3'), path.join(consumerContext, 'harness-v0.3'), { recursive: true });
    await mkdir(path.join(consumerContext, 'registrations/v0.3'), { recursive: true });
    await cp(path.join(repositoryRoot, 'registrations/v0.3/packages.json'), path.join(consumerContext, 'registrations/v0.3/packages.json'));
    await cp(path.join(repositoryRoot, 'registrations/v0.3/consumer-lock.yaml'), path.join(consumerContext, 'registrations/v0.3/consumer-lock.yaml'));
    const packageRegistrationBytes = await readFile(path.join(repositoryRoot, 'registrations/v0.3/packages.json'));
    const packageRegistration = JSON.parse(packageRegistrationBytes.toString('utf8'));
    const targetPackage = packageRegistration.packages.find((item) => item.id === cleanCatalog.target.moduleId);
    if (targetPackage === undefined) throw new Error(`Target module is not registered: ${cleanCatalog.target.moduleId}`);
    const targetLockfileKey = `${targetPackage.packageName}@file:../artifacts/${targetPackage.id}.tgz`;
    const registrationSha256 = sha256(packageRegistrationBytes);
    await dockerBuild([
      '--tag', defectConsumerTag,
      '--build-arg', `TARGET_REVISION=${registration.targetRevision}`,
      '--build-arg', `REGISTRATION_SHA256=${registrationSha256}`,
      '--file', path.join(consumerContext, 'docker-v0.3/Dockerfile'),
      consumerContext,
    ]);
    const defectConsumerId = await imageId(defectConsumerTag);

    const digestScript = 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); const ids = ["shared", "tx", "local-first", "prepaint"]; console.log(JSON.stringify(Object.fromEntries(ids.map((id) => [id, createHash("sha256").update(readFileSync(`/artifacts/${id}.tgz`)).digest("hex")]))));';
    const digestRun = await run('docker', ['run', '--rm', ...ISOLATION_ARGS, '--entrypoint', 'node', defectConsumerId, '-e', digestScript]);
    if (digestRun.exitCode !== 0) throw new Error(`Defect artifact digest probe failed: ${digestRun.stdout}\n${digestRun.stderr}`);
    const defectTarballDigests = JSON.parse(digestRun.stdout.trim().split('\n').filter(Boolean).at(-1));
    const defectArtifactDigest = defectTarballDigests[cleanCatalog.target.moduleId];
    if (defectArtifactDigest === cleanCatalog.target.artifactSha256) throw new Error('Defect artifact digest equals the clean artifact digest');
    for (const artifact of contractEvidence.probe.artifacts) {
      if (artifact.id === cleanCatalog.target.moduleId) continue;
      if (defectTarballDigests[artifact.id] !== artifact.sha256) {
        throw new Error(`Defect build changed a non-target artifact: ${artifact.id}`);
      }
    }

    const lockfileRun = await run('docker', ['run', '--rm', ...ISOLATION_ARGS, '--entrypoint', 'cat', defectConsumerId, '/consumer/pnpm-lock.yaml']);
    if (lockfileRun.exitCode !== 0) throw new Error(`Defect consumer lockfile extraction failed: ${lockfileRun.stderr}`);
    const registeredLockfile = (await readFile(path.join(repositoryRoot, 'registrations/v0.3/consumer-lock.yaml'))).toString('utf8');
    const changedIntegrity = compareDefectLockfile(registeredLockfile, lockfileRun.stdout, targetLockfileKey);

    const baseCatalogJson = JSON.parse(catalogBytes.toString('utf8'));
    baseCatalogJson.target.artifactSha256 = defectArtifactDigest;
    const defectCatalogBytes = Buffer.from(`${JSON.stringify(baseCatalogJson, null, 2)}\n`);
    const defectCatalog = {
      ...cleanCatalog,
      target: { ...cleanCatalog.target, artifactSha256: defectArtifactDigest },
    };

    const trustContext = path.join(temporaryRoot, 'trust-context');
    await Promise.all([
      mkdir(path.join(trustContext, 'docker-v0.3'), { recursive: true }),
      mkdir(path.join(trustContext, 'harness-v0.3/trust'), { recursive: true }),
      mkdir(path.join(trustContext, 'src'), { recursive: true }),
      mkdir(path.join(trustContext, 'registrations/v0.3'), { recursive: true }),
    ]);
    const canonicalizeRoot = await realpath(path.join(repositoryRoot, 'node_modules/canonicalize'));
    const canonicalizeFiles = (await listFiles(canonicalizeRoot)).filter((file) => file.split(path.sep)[0] !== 'node_modules');
    await Promise.all([
      cp(path.join(repositoryRoot, 'docker-v0.3/Dockerfile.trust'), path.join(trustContext, 'docker-v0.3/Dockerfile.trust')),
      ...harnessFiles.map((relativePath) => cp(path.join(repositoryRoot, relativePath), path.join(trustContext, relativePath))),
      ...sourceFiles.map((relativePath) => cp(path.join(repositoryRoot, relativePath), path.join(trustContext, relativePath))),
      writeFile(path.join(trustContext, 'registrations/v0.3/phase2-catalog.json'), defectCatalogBytes),
      ...canonicalizeFiles.map(async (relativePath) => {
        const destination = path.join(trustContext, 'vendor/canonicalize', relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(path.join(canonicalizeRoot, relativePath), destination);
      }),
    ]);
    const defectBuildInputs = {
      contractImageId: defectConsumerId,
      targetRevision: registration.targetRevision,
      targetArtifactDigest: defectArtifactDigest,
      defectId: defect.id,
      catalogSha256: sha256(defectCatalogBytes),
      consumerDockerfileSha256: sha256(await readFile(consumerDockerfilePath)),
      trustDockerfileSha256: sha256(await readFile(path.join(repositoryRoot, 'docker-v0.3/Dockerfile.trust'))),
      harnessFiles,
      harnessSha256: await aggregateFiles(repositoryRoot, harnessFiles),
      sourceFiles,
      sourceSha256: await aggregateFiles(repositoryRoot, sourceFiles),
      prepareScriptSha256: sha256(await readFile(prepareScriptPath)),
      operatorCatalogSha256: sha256(operatorBytes),
    };
    const defectEvaluationContractKey = domainDigest('bug-dreamer/evaluation-contract/v1', defectBuildInputs);
    await dockerBuild([
      '--tag', defectTrustTag,
      '--build-arg', `CONTRACT_IMAGE=${defectConsumerTag}`,
      '--build-arg', `CONTRACT_IMAGE_ID=${defectConsumerId}`,
      '--build-arg', `EVALUATION_CONTRACT_DIGEST=${defectEvaluationContractKey}`,
      '--build-arg', `PHASE2_CATALOG_SHA256=${defectBuildInputs.catalogSha256}`,
      '--build-arg', `TRUST_HARNESS_SHA256=${defectBuildInputs.harnessSha256}`,
      '--file', path.join(trustContext, 'docker-v0.3/Dockerfile.trust'),
      trustContext,
    ]);

    const spikeContext = path.join(temporaryRoot, 'spike-context');
    await mkdir(path.join(spikeContext, 'src'), { recursive: true });
    await mkdir(path.join(spikeContext, 'registrations/v0.3'), { recursive: true });
    await mkdir(path.join(spikeContext, 'docker-v0.3'), { recursive: true });
    await Promise.all([
      cp(path.join(repositoryRoot, 'src/v03-operators.mjs'), path.join(spikeContext, 'src/v03-operators.mjs')),
      cp(path.join(repositoryRoot, 'registrations/v0.3/phase3-operators.json'), path.join(spikeContext, 'registrations/v0.3/phase3-operators.json')),
      cp(path.join(repositoryRoot, 'docker-v0.3/Dockerfile.spike'), path.join(spikeContext, 'docker-v0.3/Dockerfile.spike')),
    ]);
    const spikeRegistrationDigest = sha256(registrationBytes);
    const defectTrustImageId = await imageId(defectTrustTag);
    await assertBuiltFrom(defectTrustImageId, defectConsumerId, 'Defect trust image');
    const spikeBuildInputs = {
      registrationSha256: spikeRegistrationDigest,
      spikeDockerfileSha256: sha256(await readFile(path.join(repositoryRoot, 'docker-v0.3/Dockerfile.spike'))),
      operatorModuleSha256: sha256(await readFile(path.join(repositoryRoot, operatorModuleFile))),
      operatorCatalogSha256: sha256(operatorBytes),
    };
    const spikeContractKeys = {
      clean: domainDigest('bug-dreamer/spike-contract/v1', { ...spikeBuildInputs, baseImageId: cleanTrustId }),
      defect: domainDigest('bug-dreamer/spike-contract/v1', { ...spikeBuildInputs, baseImageId: defectTrustImageId }),
    };
    const spikeImageIds = {};
    for (const [name, tag, baseTag, baseImageId, key] of [
      ['clean', cleanSpikeTag, cleanTrustTag, cleanTrustId, spikeContractKeys.clean],
      ['defect', defectSpikeTag, defectTrustTag, defectTrustImageId, spikeContractKeys.defect],
    ]) {
      await dockerBuild([
        '--tag', tag,
        '--build-arg', `BASE_IMAGE=${baseTag}`,
        '--build-arg', `BASE_IMAGE_ID=${baseImageId}`,
        '--build-arg', `SPIKE_CONTRACT_DIGEST=${key}`,
        '--file', path.join(spikeContext, 'docker-v0.3/Dockerfile.spike'),
        spikeContext,
      ]);
      spikeImageIds[name] = await imageId(tag);
      await assertBuiltFrom(spikeImageIds[name], baseImageId, `${name} spike image`);
      const spikeLabels = JSON.parse(await inspectImage(spikeImageIds[name], '{{json .Config.Labels}}'));
      if (spikeLabels['org.bug-dreamer.base-image-id'] !== baseImageId) throw new Error(`${name} spike image base label mismatch`);
      if (spikeLabels['org.bug-dreamer.spike-contract-key'] !== key) throw new Error(`${name} spike image contract label mismatch`);
    }

    const seedBytes = await readFile(path.join(repositoryRoot, seedPath));
    const cleanSeed = parseNightmareSeed(seedBytes, cleanCatalog);
    let structuralRejection;
    try {
      buildNightmareSpec(cleanSeed, cleanCatalog);
      throw new Error('Baseline identity spec was unexpectedly accepted');
    } catch (error) {
      structuralRejection = rejectionRecord(error);
    }
    const specCasesBytes = await readFile(path.join(repositoryRoot, specCasesPath));
    const specCases = parseJsonBytes(specCasesBytes);
    const identityRuns = [];
    for (const relativePath of specCases.positive) {
      const baselineSeedBytes = await readFile(path.join(repositoryRoot, relativePath));
      const baselineSeed = parseNightmareSeed(baselineSeedBytes, defectCatalog);
      const baselineSpec = buildNightmareSpec(baselineSeed, defectCatalog);
      const baselinePlan = buildExecutionPlan(baselineSpec, defectCatalog);
      identityRuns.push({
        seedPath: relativePath,
        seedSha256: sha256(baselineSeedBytes),
        specDigest: specDigest(baselineSpec, defectCatalog),
        planDigest: planDigest(baselinePlan, baselineSpec, defectCatalog),
        run: await executeSpec(spikeImageIds.defect, baselineSpec, baselinePlan, defectCatalog, temporaryRoot, `baseline-${identityRuns.length}`),
      });
    }
    const baseline = {
      structuralRejection: { seedPath, spec: structuralRejection },
      specCases: { path: specCasesPath, sha256: sha256(specCasesBytes) },
      identityRuns,
      evaluatedSpecs: 1 + identityRuns.length,
    };
    if (baseline.evaluatedSpecs > registration.arms.baseline.maxEvaluatedSpecs) throw new Error('Baseline arm exceeded its registered budget');

    const arms = [];
    let adopted = null;
    for (const entry of operatorArmRequests) {
      const requestBytes = await readFile(path.join(repositoryRoot, entry.requestPath));
      const request = JSON.parse(requestBytes.toString('utf8'));
      const record = {
        operatorId: entry.operatorId,
        requestPath: entry.requestPath,
        requestSha256: sha256(requestBytes),
      };
      let cleanSpec;
      try {
        cleanSpec = buildTransformedSpec(cleanSeed, request, cleanCatalog, operatorCatalog);
      } catch (error) {
        record.rejection = rejectionRecord(error);
        arms.push(record);
        continue;
      }
      const cleanPlan = buildExecutionPlan(cleanSpec, cleanCatalog);
      const defectSeed = parseNightmareSeed(seedBytes, defectCatalog);
      const defectSpec = buildTransformedSpec(defectSeed, request, defectCatalog, operatorCatalog);
      const defectPlan = buildExecutionPlan(defectSpec, defectCatalog);
      record.cleanSpecDigest = specDigest(cleanSpec, cleanCatalog);
      record.cleanPlanDigest = planDigest(cleanPlan, cleanSpec, cleanCatalog);
      record.defectSpecDigest = specDigest(defectSpec, defectCatalog);
      record.defectPlanDigest = planDigest(defectPlan, defectSpec, defectCatalog);
      record.cleanRun = await executeSpec(spikeImageIds.clean, cleanSpec, cleanPlan, cleanCatalog, temporaryRoot, `clean-${entry.operatorId.replaceAll(/[^a-z0-9]+/gu, '-')}`);
      record.defectRun = await executeSpec(spikeImageIds.defect, defectSpec, defectPlan, defectCatalog, temporaryRoot, `defect-${entry.operatorId.replaceAll(/[^a-z0-9]+/gu, '-')}`);
      record.twoSided = record.defectRun.classification.execution.status === 'candidate-failure'
        && record.defectRun.classification.violationIdentity !== null
        && record.cleanRun.classification.execution.status === 'pass';
      if (record.twoSided) {
        const repeatRuns = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          repeatRuns.push(await executeSpec(spikeImageIds.defect, defectSpec, defectPlan, defectCatalog, temporaryRoot, `repeat-${attempt}`));
        }
        const identities = repeatRuns.map((item) => JSON.stringify(item.classification.violationIdentity));
        record.repeatRuns = repeatRuns;
        record.fiveOfFive = identities.every((identity) => identity !== 'null' && identity === JSON.stringify(record.defectRun.classification.violationIdentity));
        if (record.fiveOfFive && adopted === null) adopted = entry.operatorId;
      }
      arms.push(record);
    }

    const operatorEvaluatedSpecs = arms.reduce((sum, record) => sum + (record.rejection !== undefined ? 1 : 2 + (record.repeatRuns?.length ?? 0)), 0);
    if (operatorEvaluatedSpecs > registration.arms.operator.maxEvaluatedSpecs) throw new Error('Operator arm exceeded its registered budget');
    if (adopted !== null) {
      const adoptedArm = arms.find((record) => record.operatorId === adopted);
      const adoptedIdentity = canonicalJson(adoptedArm.defectRun.classification.violationIdentity);
      for (const identityRun of baseline.identityRuns) {
        const identity = identityRun.run.classification.violationIdentity;
        if (identity !== null && canonicalJson(identity) === adoptedIdentity) {
          throw new Error(`Baseline identity run reproduced the operator candidate: ${identityRun.seedPath}`);
        }
      }
    }
    const verdict = adopted !== null ? 'adopt' : 'retire';

    const receipt = {
      schemaVersion: 'bug-dreamer/phase3-spike-evidence/v1',
      registration: { path: 'benchmark/v0.3/phase3-spike.json', sha256: spikeRegistrationDigest },
      manifestDefect: { path: 'benchmark/manifest.json', sha256: sha256(manifestBytes), defectId: defect.id },
      targetRevision: registration.targetRevision,
      phase1Evidence: { path: 'evidence/v0.3/phase1-contracts.json', sha256: sha256(contractEvidenceBytes) },
      phase2TrustEvidence: { path: 'evidence/v0.3/phase2-trust.json', sha256: sha256(trustEvidenceBytes) },
      operatorCatalog: { path: 'registrations/v0.3/phase3-operators.json', sha256: sha256(operatorBytes) },
      seed: { path: seedPath, sha256: sha256(seedBytes) },
      cleanArtifactDigest: cleanCatalog.target.artifactSha256,
      defectArtifactDigest,
      defectTarballDigests,
      consumerDockerfilePatch,
      images: {
        cleanConsumer: { tag: contractEvidence.image.tag, imageId: contractEvidence.image.imageId },
        cleanTrust: { tag: cleanTrustTag, imageId: cleanTrustId },
        cleanSpike: { tag: cleanSpikeTag, imageId: spikeImageIds.clean },
        defectConsumer: { tag: defectConsumerTag, imageId: defectConsumerId },
        defectTrust: { tag: defectTrustTag, imageId: defectTrustImageId },
        defectSpike: { tag: defectSpikeTag, imageId: spikeImageIds.defect },
      },
      defectConsumerLockfile: {
        sha256: sha256(lockfileRun.stdout),
        changedIntegrity,
      },
      defectBuildInputs,
      defectEvaluationContractKey,
      spikeBuildInputs,
      spikeContractKeys,
      executionBudget: EXECUTION_BUDGET,
      baseline,
      arms,
      evaluatedSpecs: { baseline: baseline.evaluatedSpecs, operator: operatorEvaluatedSpecs },
      verdict,
      adoptedOperatorId: adopted,
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'ok', evidence: path.relative(repositoryRoot, evidencePath), verdict, adoptedOperatorId: adopted })}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = error instanceof TypeError ? 2 : 1;
});
