import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { inspectTarballMembers, parseTarListing } from '../harness-v0.3/probe-contracts.mjs';
import {
  ContractValidationError,
  validateContracts,
  validateEvidence,
  validateFirstPartyLockfile,
  validateForbiddenTokenReceipt,
  validatePublicBoundaryAudit,
  validateRegistration,
} from '../src/v03-contracts.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

test('validates packed artifacts, clean imports, and all seven provisional audits', async () => {
  const result = await validateContracts(repositoryRoot);
  assert.deepEqual(result, {
    registrationId: 'firsttx-public-packages-f624b09-v1',
    packageCount: 4,
    publicImportCount: 5,
    rejectedPrivateImportCount: 12,
    provisionalAuditCount: 7,
  });
});

test('rejects an empty package registration', async () => {
  const registration = await readJson('registrations/v0.3/packages.json');
  registration.packages = [];
  assert.throws(() => validateRegistration(registration), ContractValidationError);
});

test('rejects duplicate package identities', async () => {
  const registration = await readJson('registrations/v0.3/packages.json');
  registration.packages[1].packageName = registration.packages[0].packageName;
  assert.throws(() => validateRegistration(registration), /Duplicate package name/);
});

test('rejects an unregistered or wildcard export', async () => {
  const registration = await readJson('registrations/v0.3/packages.json');
  registration.packages.find((item) => item.id === 'tx').allowedImportSpecifiers.push('@firsttx/tx/*');
  assert.throws(() => validateRegistration(registration), /Wildcard export/);
});

test('rejects an artifact receipt with an invalid tarball digest', async () => {
  const [registration, evidence] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
  ]);
  evidence.probe.artifacts[0].sha256 = '0';
  await assert.rejects(validateEvidence(repositoryRoot, validateRegistration(registration), evidence), /Artifact digest invalid/);
});

test('rejects a registry-like first-party realpath', async () => {
  const [registration, evidence] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
  ]);
  evidence.probe.consumer.packageRealpaths[0].realpath = '/registry/node_modules/@firsttx/shared';
  await assert.rejects(validateEvidence(repositoryRoot, validateRegistration(registration), evidence), /outside clean consumer/);
});

test('rejects workspace protocol in a first-party lockfile', async () => {
  const registration = validateRegistration(await readJson('registrations/v0.3/packages.json'));
  const lockfile = await readFile(path.join(repositoryRoot, 'registrations/v0.3/consumer-lock.yaml'), 'utf8');
  assert.throws(() => validateFirstPartyLockfile(`${lockfile}\nworkspace:packages/tx\n`, registration), /workspace protocol/);
});

test('rejects a registry-resolved first-party package', async () => {
  const registration = validateRegistration(await readJson('registrations/v0.3/packages.json'));
  const lockfile = await readFile(path.join(repositoryRoot, 'registrations/v0.3/consumer-lock.yaml'), 'utf8');
  const tampered = lockfile.replace(
    '\nsnapshots:\n',
    "\n  '@firsttx/shared@0.3.2':\n    resolution: {integrity: sha512-invalid}\n\nsnapshots:\n",
  );
  assert.throws(() => validateFirstPartyLockfile(tampered, registration), /non-tarball first-party package/);
});

test('rejects a target snapshot that resolves shared by version', async () => {
  const registration = validateRegistration(await readJson('registrations/v0.3/packages.json'));
  const lockfile = await readFile(path.join(repositoryRoot, 'registrations/v0.3/consumer-lock.yaml'), 'utf8');
  const tampered = lockfile.replace(
    "      '@firsttx/shared': file:../artifacts/shared.tgz",
    "      '@firsttx/shared': 0.3.2",
  );
  assert.throws(() => validateFirstPartyLockfile(tampered, registration), /Transitive first-party tarball missing/);
});

test('rejects an extra clean-consumer dependency', async () => {
  const [registration, evidence] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
  ]);
  evidence.probe.consumer.packageJson.dependencies.unregistered = '1.0.0';
  evidence.probe.consumer.packageJsonSha256 = createHash('sha256')
    .update(`${JSON.stringify(evidence.probe.consumer.packageJson, null, 2)}\n`)
    .digest('hex');
  await assert.rejects(validateEvidence(repositoryRoot, validateRegistration(registration), evidence), /Consumer dependency set differs/);
});

test('rejects a receipt produced by an unbound preparation runner', async () => {
  const [registration, evidence] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
  ]);
  evidence.buildInputs.prepareScriptSha256 = '0'.repeat(64);
  await assert.rejects(validateEvidence(repositoryRoot, validateRegistration(registration), evidence), /Prepare runner digest mismatch/);
});

test('rejects isolation arguments that differ from the receipt contract', async () => {
  const [registration, evidence] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
  ]);
  evidence.isolation.dockerRunArgs.splice(2, 2);
  await assert.rejects(validateEvidence(repositoryRoot, validateRegistration(registration), evidence), /Isolation receipt changed/);
});

test('rejects a private import that unexpectedly succeeds', async () => {
  const [registration, evidence] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
  ]);
  evidence.probe.privateImports[0].status = 'imported';
  await assert.rejects(validateEvidence(repositoryRoot, validateRegistration(registration), evidence), /not rejected/);
});

test('rejects an unreviewed or missing historical result', async () => {
  const [registration, evidence, audit] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
    readJson('history/v0.3-public-boundary.json'),
  ]);
  audit.records[0].reachability.value = 'unreviewed';
  await assert.rejects(validatePublicBoundaryAudit(repositoryRoot, validateRegistration(registration), evidence, audit), /Invalid provisional reachability/);
});

test('rejects a public classification without its matching packed trace', async () => {
  const [registration, evidence, audit] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
    readJson('history/v0.3-public-boundary.json'),
  ]);
  audit.records[0].evidenceJsonPointer = '/probe/publicTraces/1';
  await assert.rejects(validatePublicBoundaryAudit(repositoryRoot, validateRegistration(registration), evidence, audit), /Public trace evidence mismatch/);
});

test('rejects an internal audit pointer bound to another module', async () => {
  const [registration, evidence, audit] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
    readJson('history/v0.3-public-boundary.json'),
  ]);
  const record = audit.records.find((item) => item.id === 'nightmare-05');
  record.importSpecifier = '@firsttx/tx/errors';
  record.evidenceJsonPointer = '/probe/privateImports/2';
  await assert.rejects(validatePublicBoundaryAudit(repositoryRoot, validateRegistration(registration), evidence, audit), /Internal import is not registered for module/);
});

test('rejects a public trace whose observed behavior no longer matches the audit', async () => {
  const [registration, evidence, audit] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
    readJson('history/v0.3-public-boundary.json'),
  ]);
  evidence.probe.publicTraces[0].observed.events = [];
  await assert.rejects(validatePublicBoundaryAudit(repositoryRoot, validateRegistration(registration), evidence, audit), /Public trace observation mismatch/);
});

test('contracts CLI succeeds and arbitrary options remain invalid usage', async () => {
  const success = await execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'contracts'], { cwd: repositoryRoot });
  assert.match(success.stdout, /"status":"ok"/);
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'contracts', '--target', 'elsewhere'], { cwd: repositoryRoot }),
    (error) => error.code === 2 && error.stderr.includes('Usage:'),
  );
});

function consumerReceipt(forbiddenTokens) {
  return { forbiddenTokens, forbiddenTokensAbsent: forbiddenTokens.absent };
}

test('accepts a forbidden token receipt that inspected members and found no offender', () => {
  const receipt = consumerReceipt({ absent: true, checkedMembers: 42, offenders: [] });
  assert.deepEqual(validateForbiddenTokenReceipt(receipt).offenders, []);
});

test('rejects a forbidden token receipt that records an offender', () => {
  const receipt = consumerReceipt({
    absent: false,
    checkedMembers: 42,
    offenders: [{ artifact: 'tx', member: 'package/dist/index.js.map', token: 'sourcesContent' }],
  });
  assert.throws(() => validateForbiddenTokenReceipt(receipt), /Consumer forbidden token check failed/);
});

test('rejects a forbidden token verdict that contradicts its offenders', () => {
  const receipt = consumerReceipt({
    absent: true,
    checkedMembers: 42,
    offenders: [{ artifact: 'tx', member: 'package/src/transaction.ts', token: 'typescript-source' }],
  });
  receipt.forbiddenTokensAbsent = true;
  assert.throws(() => validateForbiddenTokenReceipt(receipt), /not derived from its offenders/);
});

test('rejects a forbidden token receipt that inspected no member', () => {
  const receipt = consumerReceipt({ absent: true, checkedMembers: 0, offenders: [] });
  assert.throws(() => validateForbiddenTokenReceipt(receipt), /inspected no packed member/);
});

test('reads the member type and name from either tar listing format', () => {
  const gnu = '-rw-r--r-- 0/0            1234 2026-01-01 00:00 package/index.js\n'
    + 'drwxr-xr-x 0/0               0 2026-01-01 00:00 package/dist/\n'
    + 'lrwxrwxrwx 0/0               0 2026-01-01 00:00 package/link.js -> /etc/passwd\n';
  const bsd = '-rw-r--r--  0 user   staff      1234 Jan  1 00:00 package/index.js\n';
  assert.deepEqual(parseTarListing(gnu), [
    { type: '-', name: 'package/index.js' },
    { type: 'd', name: 'package/dist/' },
    { type: 'l', name: 'package/link.js' },
  ]);
  assert.deepEqual(parseTarListing(bsd), [{ type: '-', name: 'package/index.js' }]);
  assert.deepEqual(parseTarListing(''), []);
});

async function packTarball(root, files, extraRoots = []) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  const tarballPath = path.join(root, 'artifact.tgz');
  await execFileAsync('tar', ['-czf', tarballPath, '-C', root, 'package', ...extraRoots], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return tarballPath;
}

async function withTemporaryRoot(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-tarball-'));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('accepts a packed tarball whose members are contained regular files', async () => {
  const scan = await withTemporaryRoot(async (root) => {
    const tarballPath = await packTarball(root, {
      'package/package.json': '{"name":"@firsttx/tx"}\n',
      'package/dist/index.js': 'export const run = () => 1;\n',
      'package/dist/index.d.ts': 'export declare const run: () => number;\n',
      'package/README.md': '# tx\n',
    });
    return inspectTarballMembers({ artifactId: 'tx', tarballPath, workspacePath: 'packages/tx' });
  });
  assert.deepEqual(scan.offenders, []);
  assert.ok(scan.checkedMembers >= 4);
});

test('rejects packed members that leak build paths, sources, or link entries', async () => {
  const offenders = await withTemporaryRoot(async (root) => {
    await mkdir(path.join(root, 'package/dist'), { recursive: true });
    await symlink('/etc/passwd', path.join(root, 'package/dist/link.js'));
    const tarballPath = await packTarball(root, {
      'package/package.json': '{"name":"@firsttx/tx"}\n',
      'package/dist/index.js.map': '{"sources":["/target/packages/tx/src/transaction.ts"],"sourcesContent":["export {}"]}\n',
      'package/src/transaction.ts': 'export const run = () => 1;\n',
      'outside/notes.md': 'not part of the package\n',
    }, ['outside']);
    const scan = await inspectTarballMembers({ artifactId: 'tx', tarballPath, workspacePath: 'packages/tx' });
    return scan.offenders;
  });
  const tokensFor = (member) => offenders.filter((item) => item.member.startsWith(member)).map((item) => item.token).sort();
  assert.deepEqual(tokensFor('package/dist/index.js.map'), ['/target/', '/target/packages/tx/']);
  assert.deepEqual(tokensFor('package/src/transaction.ts'), ['typescript-source']);
  assert.deepEqual(tokensFor('package/dist/link.js'), ['member-type:l']);
  assert.ok(tokensFor('outside/').length > 0 && tokensFor('outside/').every((token) => token === 'outside-package'));
  assert.ok(offenders.every((item) => item.artifact === 'tx'));
});
