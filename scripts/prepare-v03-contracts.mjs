import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registrationPath = path.join(repositoryRoot, 'registrations/v0.3/packages.json');
const evidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase1-contracts.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--target' || args[1].length === 0) {
    throw new TypeError('Usage: node scripts/prepare-v03-contracts.mjs --target <firsttx-path>');
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

async function archiveTarget(targetPath, destination, revision) {
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['-C', targetPath, 'archive', '--format=tar', revision], { stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar', ['-x', '-C', destination], { stdio: ['pipe', 'ignore', 'pipe'] });
    let archiveError = '';
    let extractError = '';
    let archiveExit;
    let extractExit;
    archive.stdout.pipe(extract.stdin);
    archive.stderr.on('data', (chunk) => { archiveError += chunk.toString(); });
    extract.stderr.on('data', (chunk) => { extractError += chunk.toString(); });
    archive.once('error', reject);
    extract.once('error', reject);
    const finish = () => {
      if (archiveExit === undefined || extractExit === undefined) return;
      if (archiveExit !== 0 || extractExit !== 0) reject(new Error(`Target archive failed: ${archiveError}${extractError}`));
      else resolve();
    };
    archive.once('close', (exitCode) => { archiveExit = exitCode; finish(); });
    extract.once('close', (exitCode) => { extractExit = exitCode; finish(); });
  });
}

async function aggregateFiles(paths) {
  const digest = createHash('sha256');
  for (const relativePath of [...paths].sort()) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(await readFile(path.join(repositoryRoot, relativePath)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function main() {
  const targetInput = parseArgs(process.argv.slice(2));
  const registrationBytes = await readFile(registrationPath);
  const registration = JSON.parse(registrationBytes.toString('utf8'));
  const targetPath = await realpath(path.resolve(targetInput));
  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) throw new Error('Target path must be a directory');
  const revisionResult = await run('git', ['-C', targetPath, 'rev-parse', 'HEAD']);
  if (revisionResult.exitCode !== 0) throw new Error(revisionResult.stderr.trim());
  if (revisionResult.stdout.trim() !== registration.targetRevision) {
    throw new Error(`Target HEAD must be ${registration.targetRevision}`);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-v03-contracts-'));
  const targetDestination = path.join(temporaryRoot, 'target');
  const imageTag = `bug-dreamer-v03-contracts:${registration.targetRevision.slice(0, 12)}`;
  const registrationSha256 = sha256(registrationBytes);
  try {
    await mkdir(targetDestination, { recursive: true });
    await archiveTarget(targetPath, targetDestination, registration.targetRevision);
    await cp(path.join(repositoryRoot, 'docker-v0.3'), path.join(temporaryRoot, 'docker-v0.3'), { recursive: true });
    await cp(path.join(repositoryRoot, 'harness-v0.3'), path.join(temporaryRoot, 'harness-v0.3'), { recursive: true });
    await mkdir(path.join(temporaryRoot, 'registrations/v0.3'), { recursive: true });
    await cp(registrationPath, path.join(temporaryRoot, 'registrations/v0.3/packages.json'));

    const build = await run('docker', [
      'build',
      '--load',
      '--progress',
      'plain',
      '--tag',
      imageTag,
      '--build-arg',
      `TARGET_REVISION=${registration.targetRevision}`,
      '--build-arg',
      `REGISTRATION_SHA256=${registrationSha256}`,
      '--file',
      path.join(temporaryRoot, 'docker-v0.3/Dockerfile'),
      temporaryRoot,
    ]);
    process.stdout.write(build.stdout);
    process.stderr.write(build.stderr);
    if (build.exitCode !== 0) throw new Error('Phase 1 consumer image build failed');

    const inspection = await run('docker', ['image', 'inspect', imageTag, '--format', '{{.Id}}']);
    if (inspection.exitCode !== 0) throw new Error(inspection.stderr.trim());
    const execution = await run('docker', [
      'run',
      '--rm',
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
      imageTag,
    ]);
    process.stderr.write(execution.stderr);
    if (execution.exitCode !== 0) throw new Error(`Phase 1 consumer probe failed: ${execution.stdout}`);
    const outputLines = execution.stdout.trim().split('\n').filter(Boolean);
    const probe = JSON.parse(outputLines.at(-1));
    const receipt = {
      schemaVersion: 'bug-dreamer/phase1-contract-evidence/v1',
      registration: {
        path: 'registrations/v0.3/packages.json',
        sha256: registrationSha256,
        registrationId: registration.registrationId,
      },
      targetRevision: registration.targetRevision,
      image: {
        tag: imageTag,
        imageId: inspection.stdout.trim(),
        baseImage: registration.baseImage,
      },
      buildInputs: {
        dockerfileSha256: sha256(await readFile(path.join(repositoryRoot, 'docker-v0.3/Dockerfile'))),
        harnessSha256: await aggregateFiles([
          'harness-v0.3/create-consumer.mjs',
          'harness-v0.3/probe-contracts.mjs',
        ]),
      },
      isolation: {
        network: 'none',
        readOnlyRoot: true,
        capabilities: 'none',
        noNewPrivileges: true,
        dockerSocket: false,
        pidsLimit: 128,
        memory: '512m',
        cpus: 1,
      },
      probe,
    };
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'ok', evidence: path.relative(repositoryRoot, evidencePath), image: imageTag })}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof TypeError ? 2 : 1;
});
