import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function section(source, start, end) {
  const startIndex = source.indexOf(`${start}\n`);
  const endIndex = end === undefined ? source.length : source.indexOf(`${end}\n`, startIndex + start.length);
  assert(startIndex >= 0 && endIndex >= 0, `Lockfile section missing: ${start}`);
  return source.slice(startIndex, endIndex);
}

function entryBlocks(source) {
  const matches = [...source.matchAll(/^  '(@firsttx\/[^']+)':(?: \{\})?\n/gm)];
  return matches.map((match, index) => ({
    key: match[1],
    body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

function assertFirstPartyLockfile(lockfile, registration) {
  const packages = entryBlocks(section(lockfile, 'packages:', 'snapshots:'));
  const snapshots = entryBlocks(section(lockfile, 'snapshots:'));
  const expectedPackageKeys = registration.packages.map((item) => `${item.packageName}@file:../artifacts/${item.id}.tgz`).sort();
  assert(JSON.stringify(packages.map((item) => item.key).sort()) === JSON.stringify(expectedPackageKeys), 'Lockfile contains a non-tarball first-party package');
  for (const packageRegistration of registration.packages) {
    const locator = `file:../artifacts/${packageRegistration.id}.tgz`;
    const packageEntry = packages.find((item) => item.key === `${packageRegistration.packageName}@${locator}`);
    assert(packageEntry?.body.includes(`tarball: ${locator}`), `First-party tarball resolution missing: ${packageRegistration.id}`);
    const snapshot = snapshots.find((item) => item.key.startsWith(`${packageRegistration.packageName}@${locator}`));
    assert(snapshot !== undefined, `First-party snapshot missing: ${packageRegistration.id}`);
    for (const dependencyName of packageRegistration.firstPartyDependencies) {
      const dependency = registration.packages.find((item) => item.packageName === dependencyName);
      assert(snapshot.body.includes(`'${dependencyName}': file:../artifacts/${dependency.id}.tgz`), `Transitive first-party tarball missing: ${packageRegistration.id}/${dependencyName}`);
    }
  }
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

export const TEXT_MEMBER_EXTENSIONS = ['.js', '.mjs', '.cjs', '.d.ts', '.map', '.json', '.md'];

export function parseTarListing(listing) {
  return listing.split('\n').filter((line) => line.trim().length > 0).map((line) => {
    const [entry] = line.split(' -> ');
    const fields = entry.trim().split(/\s+/u);
    const name = fields.at(-1);
    assert(/^[-dlbcpsD]/u.test(line) && fields.length >= 6 && name.length > 0, `Unreadable tar listing entry: ${line}`);
    return { type: line[0], name };
  });
}

export async function inspectTarballMembers({ artifactId, tarballPath, workspacePath }) {
  const tokens = [...new Set(['/target/', `/target/${workspacePath}/`])];
  const members = parseTarListing((await execFileAsync('tar', ['-tvzf', tarballPath])).stdout);
  const offenders = [];
  for (const member of members) {
    if (member.type !== '-' && member.type !== 'd') {
      offenders.push({ artifact: artifactId, member: member.name, token: `member-type:${member.type}` });
      continue;
    }
    if (!member.name.startsWith('package/')) {
      offenders.push({ artifact: artifactId, member: member.name, token: 'outside-package' });
      continue;
    }
    if (member.type === 'd') continue;
    if (member.name.endsWith('.ts') && !member.name.endsWith('.d.ts')) {
      offenders.push({ artifact: artifactId, member: member.name, token: 'typescript-source' });
      continue;
    }
    if (!TEXT_MEMBER_EXTENSIONS.some((extension) => member.name.endsWith(extension))) continue;
    const { stdout } = await execFileAsync('tar', ['-xOf', tarballPath, member.name], { maxBuffer: 64 * 1024 * 1024 });
    for (const token of tokens) {
      if (stdout.includes(token)) offenders.push({ artifact: artifactId, member: member.name, token });
    }
  }
  return { checkedMembers: members.length, offenders };
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

async function absent(filePath) {
  try {
    await stat(filePath);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function main() {
  const registration = JSON.parse(await readFile('/registration/packages.json', 'utf8'));
  const lockfile = await readFile('/consumer/pnpm-lock.yaml', 'utf8');
  const workspacePolicy = await readFile('/consumer/pnpm-workspace.yaml', 'utf8');
  const packageJson = JSON.parse(await readFile('/consumer/package.json', 'utf8'));
  const processStatus = await readFile('/proc/self/status', 'utf8');
  const effectiveCapabilities = /^CapEff:\s+(\S+)$/m.exec(processStatus)?.[1];
  const noNewPrivileges = /^NoNewPrivs:\s+(\S+)$/m.exec(processStatus)?.[1];
  const assignedNetworkInterfaces = Object.keys(networkInterfaces()).sort();
  const [pidsMax, memoryMax, cpuMax] = await Promise.all([
    readFile('/sys/fs/cgroup/pids.max', 'utf8').then((value) => value.trim()),
    readFile('/sys/fs/cgroup/memory.max', 'utf8').then((value) => value.trim()),
    readFile('/sys/fs/cgroup/cpu.max', 'utf8').then((value) => value.trim()),
  ]);

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
  assert(JSON.stringify(assignedNetworkInterfaces) === JSON.stringify(['lo']), 'Container has a non-loopback assigned network interface');
  assert(effectiveCapabilities === '0000000000000000', 'Container has effective Linux capabilities');
  assert(noNewPrivileges === '1', 'Container allows new privileges');
  assert(pidsMax === '128', 'Container process limit differs from policy');
  assert(memoryMax === '536870912', 'Container memory limit differs from policy');
  assert(cpuMax === '100000 100000', 'Container CPU quota differs from policy');

  assert(!lockfile.includes('workspace:'), 'Consumer lockfile contains workspace protocol');
  assert(!lockfile.includes('link:'), 'Consumer lockfile contains link protocol');
  assert(!lockfile.includes('/target'), 'Consumer lockfile contains target source path');
  assert(!lockfile.includes('registry.npmjs.org/@firsttx/'), 'Consumer lockfile resolves a first-party registry package');
  assert(sha256(lockfile) === registration.consumerLockfile.sha256, 'Consumer lockfile differs from registration');
  assertFirstPartyLockfile(lockfile, registration);

  const artifacts = [];
  const forbiddenTokens = { absent: true, checkedMembers: 0, offenders: [] };
  const publicImports = [];
  const privateImports = [];
  const packageRealpaths = [];
  const dependencyRealpaths = [];
  for (const packageRegistration of registration.packages) {
    assert(packageJson.dependencies[packageRegistration.packageName] === `file:/artifacts/${packageRegistration.id}.tgz`, `Consumer dependency is not a tarball: ${packageRegistration.id}`);
    assert(lockfile.includes(`${packageRegistration.id}.tgz`), `Consumer lockfile omits tarball: ${packageRegistration.id}`);
    artifacts.push(await inspectArtifact(packageRegistration));
    const scan = await inspectTarballMembers({
      artifactId: packageRegistration.id,
      tarballPath: `/artifacts/${packageRegistration.id}.tgz`,
      workspacePath: packageRegistration.workspacePath,
    });
    forbiddenTokens.checkedMembers += scan.checkedMembers;
    forbiddenTokens.offenders.push(...scan.offenders);
    for (const specifier of packageRegistration.allowedImportSpecifiers) publicImports.push(await probeAllowedImport(packageRegistration, specifier));
    for (const specifier of packageRegistration.privateImportSpecifiers) privateImports.push(await probePrivateImport(specifier));
    const resolved = await realpath(`/consumer/node_modules/${packageRegistration.packageName}`);
    assert(resolved.startsWith('/consumer/node_modules/.pnpm/'), `First-party package resolves outside consumer: ${packageRegistration.id}/${resolved}`);
    packageRealpaths.push({ packageName: packageRegistration.packageName, realpath: resolved });
    for (const dependencyName of packageRegistration.firstPartyDependencies) {
      const dependencyPath = path.join(resolved, '..', '..', ...dependencyName.split('/'));
      const dependencyRealpath = await realpath(dependencyPath);
      const dependency = registration.packages.find((item) => item.packageName === dependencyName);
      assert(dependencyRealpath.includes(`@firsttx+${dependency.id}@file+..+artifacts+${dependency.id}.tgz/`), `Target resolves a non-tarball first-party dependency: ${packageRegistration.id}/${dependencyName}`);
      dependencyRealpaths.push({ ownerPackageName: packageRegistration.packageName, dependencyPackageName: dependencyName, realpath: dependencyRealpath });
    }
  }

  forbiddenTokens.absent = forbiddenTokens.offenders.length === 0;

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
      assignedNetworkInterfaces,
      effectiveCapabilities,
      noNewPrivileges,
      pidsMax,
      memoryMax,
      cpuMax,
    },
    artifacts,
    consumer: {
      packageJsonSha256: sha256(`${JSON.stringify(packageJson, null, 2)}\n`),
      packageJson,
      workspacePolicySha256: sha256(workspacePolicy),
      workspacePolicy,
      lockfileSha256: sha256(lockfile),
      lockfile,
      forbiddenTokens,
      forbiddenTokensAbsent: forbiddenTokens.absent,
      packageRealpaths,
      dependencyRealpaths,
    },
    publicImports,
    privateImports,
    publicTraces,
  })}\n`);
}

if (import.meta.main) await main();
