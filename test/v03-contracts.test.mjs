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

test('rejects workspace protocol even when the tampered lockfile digest matches', async () => {
  const [registration, evidence] = await Promise.all([
    readJson('registrations/v0.3/packages.json'),
    readJson('evidence/v0.3/phase1-contracts.json'),
  ]);
  evidence.probe.consumer.lockfile += '\nworkspace:packages/tx\n';
  evidence.probe.consumer.lockfileSha256 = createHash('sha256').update(evidence.probe.consumer.lockfile).digest('hex');
  await assert.rejects(validateEvidence(repositoryRoot, validateRegistration(registration), evidence), /workspace protocol/);
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

test('contracts CLI succeeds and arbitrary options remain invalid usage', async () => {
  const success = await execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'contracts'], { cwd: repositoryRoot });
  assert.match(success.stdout, /"status":"ok"/);
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'contracts', '--target', 'elsewhere'], { cwd: repositoryRoot }),
    (error) => error.code === 2 && error.stderr.includes('Usage:'),
  );
});
