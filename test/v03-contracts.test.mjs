import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ContractValidationError,
  validateContracts,
  validateEvidence,
  validateFirstPartyLockfile,
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
