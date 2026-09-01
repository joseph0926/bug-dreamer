import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exportedSpecifiers(packageRegistration, manifest) {
  const keys = Object.keys(manifest.exports).sort();
  return keys.map((key) => key === '.' ? packageRegistration.packageName : `${packageRegistration.packageName}/${key.slice(2)}`);
}

async function inspectArtifact(packageRegistration) {
  const tarballPath = `/artifacts/${packageRegistration.id}.tgz`;
  const [tarball, tarballStat, manifestResult, listResult] = await Promise.all([
    readFile(tarballPath),
    stat(tarballPath),
    execFileAsync('tar', ['-xOf', tarballPath, 'package/package.json']),
    execFileAsync('tar', ['-tzf', tarballPath]),
  ]);
  const manifestBytes = Buffer.from(manifestResult.stdout);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const files = listResult.stdout.trim().split('\n').filter(Boolean).sort();
  assert(manifest.name === packageRegistration.packageName, `Packed name mismatch: ${packageRegistration.id}`);
  assert(manifest.version === packageRegistration.version, `Packed version mismatch: ${packageRegistration.id}`);
  assert(JSON.stringify(exportedSpecifiers(packageRegistration, manifest)) === JSON.stringify([...packageRegistration.allowedImportSpecifiers].sort()), `Packed exports mismatch: ${packageRegistration.id}`);
  assert(!JSON.stringify(manifest).includes('workspace:'), `Packed workspace protocol remains: ${packageRegistration.id}`);
  for (const firstPartyDependency of packageRegistration.firstPartyDependencies) {
    assert(manifest.dependencies?.[firstPartyDependency] !== undefined, `Packed first-party dependency missing: ${packageRegistration.id}/${firstPartyDependency}`);
    assert(!manifest.dependencies[firstPartyDependency].startsWith('workspace:'), `Packed dependency was not rewritten: ${packageRegistration.id}/${firstPartyDependency}`);
  }
  for (const exportedPath of Object.values(manifest.exports)) {
    const importPath = typeof exportedPath === 'string' ? exportedPath : exportedPath.import;
    assert(files.includes(`package/${importPath.replace(/^\.\//, '')}`), `Packed export target missing: ${packageRegistration.id}/${importPath}`);
  }
  return {
    id: packageRegistration.id,
    packageName: manifest.name,
    version: manifest.version,
    byteLength: tarballStat.size,
    sha256: sha256(tarball),
    manifestSha256: sha256(manifestBytes),
    exports: manifest.exports,
    exportsSha256: sha256(JSON.stringify(manifest.exports)),
    filesSha256: sha256(`${files.join('\n')}\n`),
    firstPartyDependencies: packageRegistration.firstPartyDependencies.map((packageName) => ({
      packageName,
      version: manifest.dependencies[packageName],
    })),
  };
}

async function probeAllowedImport(packageRegistration, specifier) {
  const module = await import(specifier);
  const requiredExports = specifier === packageRegistration.packageName ? packageRegistration.requiredRuntimeExports : [];
  const missingExports = requiredExports.filter((name) => !Object.hasOwn(module, name));
  assert(missingExports.length === 0, `Required exports missing: ${specifier}/${missingExports.join(',')}`);
  return { specifier, status: 'imported', runtimeExports: Object.keys(module).sort() };
}

async function probePrivateImport(specifier) {
  try {
    await import(specifier);
  } catch (error) {
    assert(error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', `Unexpected private import error: ${specifier}/${error?.code}`);
    return { specifier, status: 'rejected', code: error.code };
  }
  throw new Error(`Private import succeeded: ${specifier}`);
}

async function nightmare01(startTransaction) {
  const events = [];
  const tx = startTransaction({ id: 'phase1-nightmare-01' });
  await tx.run(async () => events.push('step1-run'), { compensate: async () => events.push('step1-compensate') });
  await tx.run(async () => {
    events.push('step2-start');
    throw new Error('step2 failure');
  }, { compensate: async () => events.push('step2-compensate') }).catch(() => undefined);
  return { id: 'nightmare-01', moduleId: 'tx', status: 'executed', importSpecifier: '@firsttx/tx', actions: ['startTransaction', 'run', 'run'], observed: { events } };
}

async function nightmare03(startTransaction, TransactionStateError) {
  const tx = startTransaction({ id: 'phase1-nightmare-03' });
  const compensated = [];
  await tx.run(async () => 'first', { compensate: async () => compensated.push('step-1') });
  let releaseFailure;
  const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
  const inFlight = tx.run(async () => {
    await failureGate;
    throw new Error('late failure');
  }, { compensate: async () => compensated.push('step-2') });
  let commitOutcome = 'resolved';
  try {
    await tx.commit();
  } catch (error) {
    commitOutcome = error instanceof TransactionStateError ? 'state-error' : 'other-error';
  }
  releaseFailure();
  await inFlight.catch(() => undefined);
  let stateAfter = 'accepted-new-step';
  try {
    await tx.run(async () => 'probe');
  } catch (error) {
    stateAfter = error instanceof TransactionStateError ? error.currentState : 'other-error';
  }
  return { id: 'nightmare-03', moduleId: 'tx', status: 'executed', importSpecifier: '@firsttx/tx', actions: ['startTransaction', 'run', 'commit', 'run'], observed: { commitOutcome, compensated, stateAfter } };
}

async function nightmare04(startTransaction) {
  const tx = startTransaction({ id: 'phase1-nightmare-04', timeout: 5000 });
  let observed;
  try {
    await tx.run(async () => { throw new TypeError('original-boom'); });
    observed = { name: 'no-error', message: '' };
  } catch (error) {
    observed = { name: error.name, message: error.message };
  }
  return { id: 'nightmare-04', moduleId: 'tx', status: 'executed', importSpecifier: '@firsttx/tx', actions: ['startTransaction', 'run'], observed };
}

async function nightmare07(startTransaction) {
  const tx = startTransaction({ id: 'phase1-nightmare-07' });
  let calls = 0;
  let outcome = 'resolved';
  try {
    await tx.run(async () => {
      calls += 1;
      return 'ok';
    }, { retry: { maxAttempts: 0 } });
  } catch (error) {
    outcome = error.name;
  }
  return { id: 'nightmare-07', moduleId: 'tx', status: 'executed', importSpecifier: '@firsttx/tx', actions: ['startTransaction', 'run'], observed: { calls, outcome } };
}

const registration = JSON.parse(await readFile('/registration/packages.json', 'utf8'));
const lockfile = await readFile('/consumer/pnpm-lock.yaml', 'utf8');
const workspacePolicy = await readFile('/consumer/pnpm-workspace.yaml', 'utf8');
const packageJson = JSON.parse(await readFile('/consumer/package.json', 'utf8'));

async function absent(filePath) {
  try {
    await stat(filePath);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

const targetSourceAbsent = await absent('/target');
const dockerSocketAbsent = await absent('/var/run/docker.sock');
let rootWriteRejected = false;
try {
  await writeFile('/consumer/.isolation-write-probe', 'forbidden');
} catch (error) {
  rootWriteRejected = error.code === 'EROFS';
}
assert(targetSourceAbsent, 'Final image contains target source');
assert(dockerSocketAbsent, 'Final image exposes Docker socket');
assert(rootWriteRejected, 'Final image root is writable');

assert(!lockfile.includes('workspace:'), 'Consumer lockfile contains workspace protocol');
assert(!lockfile.includes('link:'), 'Consumer lockfile contains link protocol');
assert(!lockfile.includes('/target'), 'Consumer lockfile contains target source path');
assert(!lockfile.includes('registry.npmjs.org/@firsttx/'), 'Consumer lockfile resolves a first-party registry package');

const artifacts = [];
const publicImports = [];
const privateImports = [];
const packageRealpaths = [];
for (const packageRegistration of registration.packages) {
  assert(packageJson.dependencies[packageRegistration.packageName] === `file:/artifacts/${packageRegistration.id}.tgz`, `Consumer dependency is not a tarball: ${packageRegistration.id}`);
  assert(lockfile.includes(`${packageRegistration.id}.tgz`), `Consumer lockfile omits tarball: ${packageRegistration.id}`);
  artifacts.push(await inspectArtifact(packageRegistration));
  for (const specifier of packageRegistration.allowedImportSpecifiers) publicImports.push(await probeAllowedImport(packageRegistration, specifier));
  for (const specifier of packageRegistration.privateImportSpecifiers) privateImports.push(await probePrivateImport(specifier));
  const resolved = await realpath(`/consumer/node_modules/${packageRegistration.packageName}`);
  assert(resolved.startsWith('/consumer/node_modules/.pnpm/'), `First-party package resolves outside consumer: ${packageRegistration.id}/${resolved}`);
  packageRealpaths.push({ packageName: packageRegistration.packageName, realpath: resolved });
}

const tx = await import('@firsttx/tx');
const publicTraces = [
  await nightmare01(tx.startTransaction),
  await nightmare03(tx.startTransaction, tx.TransactionStateError),
  await nightmare04(tx.startTransaction),
  await nightmare07(tx.startTransaction),
];

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'bug-dreamer/phase1-probe/v1',
  registrationId: registration.registrationId,
  targetRevision: registration.targetRevision,
  packageManager: registration.packageManager,
  isolationObserved: {
    targetSourceAbsent,
    dockerSocketAbsent,
    rootWriteRejected,
  },
  artifacts,
  consumer: {
    packageJsonSha256: sha256(`${JSON.stringify(packageJson, null, 2)}\n`),
    packageJson,
    workspacePolicySha256: sha256(workspacePolicy),
    workspacePolicy,
    lockfileSha256: sha256(lockfile),
    lockfile,
    forbiddenTokensAbsent: true,
    packageRealpaths,
  },
  publicImports,
  privateImports,
  publicTraces,
})}\n`);
