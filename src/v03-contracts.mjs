import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REGISTRATION_PATH = 'registrations/v0.3/packages.json';
const CONSUMER_LOCKFILE_PATH = 'registrations/v0.3/consumer-lock.yaml';
const EVIDENCE_PATH = 'evidence/v0.3/phase1-contracts.json';
const AUDIT_PATH = 'history/v0.3-public-boundary.json';
const TARGET_REVISION = 'f624b09f148c3368a51807f48d3237db20cef9c6';
const PACKAGE_NAMES = ['@firsttx/local-first', '@firsttx/prepaint', '@firsttx/shared', '@firsttx/tx'];
const PUBLIC_TRACE_IDS = ['nightmare-01', 'nightmare-03', 'nightmare-04', 'nightmare-07'];
const HISTORICAL_IDS = Array.from({ length: 7 }, (_, index) => `nightmare-0${index + 1}`);
const EXPECTED_DOCKER_RUN_ARGS = [
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
  '<image>',
];

export class ContractValidationError extends Error {}

function fail(message) {
  throw new ContractValidationError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function strictKeys(value, keys, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} fields changed`);
}

function unique(values, label) {
  assert(new Set(values).size === values.length, `Duplicate ${label}`);
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function lockfileSection(source, start, end) {
  const startIndex = source.indexOf(`${start}\n`);
  const endIndex = end === undefined ? source.length : source.indexOf(`${end}\n`, startIndex + start.length);
  assert(startIndex >= 0 && endIndex >= 0, `Lockfile section missing: ${start}`);
  return source.slice(startIndex, endIndex);
}

function firstPartyEntryBlocks(source) {
  const matches = [...source.matchAll(/^  '(@firsttx\/[^']+)':(?: \{\})?\n/gm)];
  return matches.map((match, index) => ({
    key: match[1],
    body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

function expectedWorkspacePolicy(registration) {
  const allowBuilds = registration.consumerBuildPolicy.allowBuilds.map((name) => `  ${name}: true`);
  const overrides = registration.packages.map((item) => `  '${item.packageName}': file:/artifacts/${item.id}.tgz`);
  return `allowBuilds:\n${allowBuilds.join('\n')}\noverrides:\n${overrides.join('\n')}\n`;
}

function isTarballRealpath(value, packageRegistration) {
  if (typeof value !== 'string') return false;
  const prefix = '/consumer/node_modules/.pnpm/';
  const suffix = `/node_modules/${packageRegistration.packageName}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const storeEntry = value.slice(prefix.length, -suffix.length);
  const tarballLocator = `@firsttx+${packageRegistration.id}@file+..+artifacts+${packageRegistration.id}.tgz`;
  return storeEntry === tarballLocator || storeEntry.startsWith(`${tarballLocator}_`);
}

export function validateFirstPartyLockfile(lockfile, registration) {
  assert(typeof lockfile === 'string' && lockfile.length > 0, 'Consumer lockfile is empty');
  assert(!lockfile.includes('workspace:'), 'Consumer lockfile contains workspace protocol');
  assert(!lockfile.includes('link:'), 'Consumer lockfile contains link protocol');
  assert(!lockfile.includes('/target'), 'Consumer lockfile contains target source path');
  const importer = lockfileSection(lockfile, 'importers:', 'packages:');
  const packages = firstPartyEntryBlocks(lockfileSection(lockfile, 'packages:', 'snapshots:'));
  const snapshots = firstPartyEntryBlocks(lockfileSection(lockfile, 'snapshots:'));
  const expectedKeys = registration.packages.map((item) => `${item.packageName}@file:../artifacts/${item.id}.tgz`).sort();
  assert(JSON.stringify(packages.map((item) => item.key).sort()) === JSON.stringify(expectedKeys), 'Consumer lockfile contains a non-tarball first-party package');

  for (const packageRegistration of registration.packages) {
    const absoluteLocator = `file:/artifacts/${packageRegistration.id}.tgz`;
    const locator = `file:../artifacts/${packageRegistration.id}.tgz`;
    assert(importer.includes(`specifier: ${absoluteLocator}`) && importer.includes(`version: ${locator}`), `Consumer importer is not tarball-pinned: ${packageRegistration.id}`);
    const packageEntry = packages.find((item) => item.key === `${packageRegistration.packageName}@${locator}`);
    assert(packageEntry?.body.includes(`tarball: ${locator}`), `First-party tarball resolution missing: ${packageRegistration.id}`);
    const snapshot = snapshots.find((item) => item.key.startsWith(`${packageRegistration.packageName}@${locator}`));
    assert(snapshot !== undefined, `First-party snapshot missing: ${packageRegistration.id}`);
    for (const dependencyName of packageRegistration.firstPartyDependencies) {
      const dependency = registration.packages.find((item) => item.packageName === dependencyName);
      assert(dependency !== undefined, `First-party dependency registration missing: ${dependencyName}`);
      assert(snapshot.body.includes(`'${dependencyName}': file:../artifacts/${dependency.id}.tgz`), `Transitive first-party tarball missing: ${packageRegistration.id}/${dependencyName}`);
    }
  }
  return true;
}

export function validateRegistration(registration) {
  strictKeys(registration, [
    'schemaVersion',
    'registrationId',
    'repository',
    'targetRevision',
    'nodeVersion',
    'packageManager',
    'baseImage',
    'consumerDependencies',
    'consumerBuildPolicy',
    'consumerLockfile',
    'packages',
  ], 'Registration');
  assert(registration.schemaVersion === 'bug-dreamer/public-package-registration/v1', 'Unexpected registration schemaVersion');
  assert(registration.registrationId === 'firsttx-public-packages-f624b09-v1', 'Unexpected registrationId');
  assert(registration.repository === 'https://github.com/joseph0926/firsttx.git', 'Unexpected target repository');
  assert(registration.targetRevision === TARGET_REVISION, 'Unexpected target revision');
  assert(registration.nodeVersion === '24.16.0', 'Unexpected Node.js version');
  assert(registration.packageManager === 'pnpm@11.17.0', 'Unexpected package manager');
  assert(/^node:24\.16\.0-bookworm-slim@sha256:[0-9a-f]{64}$/.test(registration.baseImage), 'Base image is not digest-pinned');
  strictKeys(registration.consumerDependencies, ['esbuild', 'react', 'react-dom', 'vite', 'zod'], 'Consumer dependencies');
  for (const [name, version] of Object.entries(registration.consumerDependencies)) {
    assert(/^\d+\.\d+\.\d+$/.test(version), `Consumer dependency is not exact: ${name}`);
  }
  assert(JSON.stringify(registration.consumerBuildPolicy) === JSON.stringify({ allowBuilds: ['esbuild'] }), 'Consumer build policy changed');
  strictKeys(registration.consumerLockfile, ['path', 'sha256'], 'Consumer lockfile registration');
  assert(registration.consumerLockfile.path === CONSUMER_LOCKFILE_PATH, 'Consumer lockfile path changed');
  assert(validSha(registration.consumerLockfile.sha256), 'Consumer lockfile digest is invalid');
  assert(Array.isArray(registration.packages) && registration.packages.length === 4, 'Registration must contain four packages');
  unique(registration.packages.map((item) => item.id), 'package id');
  unique(registration.packages.map((item) => item.packageName), 'package name');
  unique(registration.packages.map((item) => item.workspacePath), 'workspace path');
  assert(JSON.stringify(registration.packages.map((item) => item.packageName).sort()) === JSON.stringify(PACKAGE_NAMES), 'Registered package universe changed');
  assert(registration.packages.filter((item) => item.role === 'target-module').length === 3, 'Exactly three target modules are required');

  for (const packageRegistration of registration.packages) {
    strictKeys(packageRegistration, [
      'id',
      'role',
      'workspacePath',
      'packageName',
      'version',
      'sourceManifestSha256',
      'firstPartyDependencies',
      'allowedImportSpecifiers',
      'requiredRuntimeExports',
      'buildArgv',
      'packArgv',
      'privateImportSpecifiers',
    ], `Package registration ${packageRegistration.id}`);
    assert(['first-party-dependency', 'target-module'].includes(packageRegistration.role), `Invalid package role: ${packageRegistration.id}`);
    assert(packageRegistration.workspacePath === `packages/${packageRegistration.id}`, `Unexpected workspace path: ${packageRegistration.id}`);
    assert(validSha(packageRegistration.sourceManifestSha256), `Invalid source manifest digest: ${packageRegistration.id}`);
    assert(/^\d+\.\d+\.\d+$/.test(packageRegistration.version), `Invalid package version: ${packageRegistration.id}`);
    assert(Array.isArray(packageRegistration.firstPartyDependencies), `First-party dependencies missing: ${packageRegistration.id}`);
    assert(Array.isArray(packageRegistration.allowedImportSpecifiers) && packageRegistration.allowedImportSpecifiers.length > 0, `Allowed imports missing: ${packageRegistration.id}`);
    unique(packageRegistration.allowedImportSpecifiers, `allowed import for ${packageRegistration.id}`);
    for (const specifier of packageRegistration.allowedImportSpecifiers) {
      assert(specifier === packageRegistration.packageName || specifier.startsWith(`${packageRegistration.packageName}/`), `Foreign allowed import: ${packageRegistration.id}/${specifier}`);
      assert(!specifier.includes('*'), `Wildcard export is forbidden: ${packageRegistration.id}/${specifier}`);
    }
    assert(packageRegistration.allowedImportSpecifiers.includes(packageRegistration.packageName), `Root import is missing: ${packageRegistration.id}`);
    assert(Array.isArray(packageRegistration.requiredRuntimeExports) && packageRegistration.requiredRuntimeExports.length > 0, `Runtime exports missing: ${packageRegistration.id}`);
    unique(packageRegistration.requiredRuntimeExports, `runtime export for ${packageRegistration.id}`);
    assert(JSON.stringify(packageRegistration.buildArgv) === JSON.stringify(['pnpm', '--filter', packageRegistration.packageName, 'build']), `Build argv changed: ${packageRegistration.id}`);
    assert(JSON.stringify(packageRegistration.packArgv) === JSON.stringify(['pnpm', '--filter', packageRegistration.packageName, 'pack', '--out', `/artifacts/${packageRegistration.id}.tgz`]), `Pack argv changed: ${packageRegistration.id}`);
    assert(Array.isArray(packageRegistration.privateImportSpecifiers) && packageRegistration.privateImportSpecifiers.length > 0, `Private import probes missing: ${packageRegistration.id}`);
    unique(packageRegistration.privateImportSpecifiers, `private import for ${packageRegistration.id}`);
    assert(packageRegistration.privateImportSpecifiers.every((specifier) => specifier.startsWith(`${packageRegistration.packageName}/`)), `Foreign private import probe: ${packageRegistration.id}`);
    assert(packageRegistration.privateImportSpecifiers.every((specifier) => !packageRegistration.allowedImportSpecifiers.includes(specifier)), `Allowed import is also private: ${packageRegistration.id}`);
    if (packageRegistration.id === 'shared') assert(packageRegistration.firstPartyDependencies.length === 0, 'Shared cannot depend on another first-party package');
    else assert(JSON.stringify(packageRegistration.firstPartyDependencies) === JSON.stringify(['@firsttx/shared']), `Target module must depend on shared: ${packageRegistration.id}`);
  }
  const prepaint = registration.packages.find((item) => item.id === 'prepaint');
  assert(JSON.stringify(prepaint.allowedImportSpecifiers) === JSON.stringify(['@firsttx/prepaint', '@firsttx/prepaint/plugin/vite']), 'Prepaint export registration changed');
  for (const packageRegistration of registration.packages.filter((item) => item.id !== 'prepaint')) {
    assert(JSON.stringify(packageRegistration.allowedImportSpecifiers) === JSON.stringify([packageRegistration.packageName]), `Unregistered subpath: ${packageRegistration.id}`);
  }
  return registration;
}

function pointerValue(value, pointer) {
  assert(typeof pointer === 'string' && pointer.startsWith('/'), `Invalid evidence pointer: ${pointer}`);
  let current = value;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    assert(current !== null && typeof current === 'object' && Object.hasOwn(current, token), `Evidence pointer not found: ${pointer}`);
    current = current[token];
  }
  return current;
}

async function aggregateFiles(repositoryRoot, paths) {
  const digest = createHash('sha256');
  for (const relativePath of [...paths].sort()) {
    digest.update(relativePath);
    digest.update('\0');
    digest.update(await readFile(path.join(repositoryRoot, relativePath)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export async function validateEvidence(repositoryRoot, registration, evidence) {
  strictKeys(evidence, ['schemaVersion', 'registration', 'targetRevision', 'sourceManifests', 'image', 'buildInputs', 'isolation', 'probe'], 'Contract evidence');
  assert(evidence.schemaVersion === 'bug-dreamer/phase1-contract-evidence/v1', 'Unexpected contract evidence schemaVersion');
  strictKeys(evidence.registration, ['path', 'sha256', 'registrationId'], 'Evidence registration');
  assert(evidence.registration.path === REGISTRATION_PATH, 'Evidence registration path changed');
  assert(evidence.registration.registrationId === registration.registrationId, 'Evidence registrationId mismatch');
  const registrationBytes = await readFile(path.join(repositoryRoot, REGISTRATION_PATH));
  assert(evidence.registration.sha256 === sha256(registrationBytes), 'Evidence registration digest mismatch');
  assert(evidence.targetRevision === registration.targetRevision, 'Evidence target revision mismatch');
  assert(Array.isArray(evidence.sourceManifests) && evidence.sourceManifests.length === registration.packages.length, 'Source manifest verification is incomplete');
  for (const packageRegistration of registration.packages) {
    const recordedManifest = evidence.sourceManifests.find((item) => item.id === packageRegistration.id);
    assert(recordedManifest !== undefined, `Source manifest verification missing: ${packageRegistration.id}`);
    strictKeys(recordedManifest, ['id', 'workspacePath', 'path', 'sha256'], `Source manifest ${packageRegistration.id}`);
    assert(recordedManifest.workspacePath === packageRegistration.workspacePath && recordedManifest.path === `${packageRegistration.workspacePath}/package.json`, `Source manifest path mismatch: ${packageRegistration.id}`);
    assert(recordedManifest.sha256 === packageRegistration.sourceManifestSha256, `Source manifest digest mismatch: ${packageRegistration.id}`);
  }
  strictKeys(evidence.image, ['tag', 'imageId', 'baseImage'], 'Evidence image');
  assert(/^sha256:[0-9a-f]{64}$/.test(evidence.image.imageId), 'Evidence image ID is invalid');
  assert(evidence.image.baseImage === registration.baseImage, 'Evidence base image mismatch');
  strictKeys(evidence.buildInputs, ['dockerfileSha256', 'harnessSha256', 'prepareScriptSha256', 'consumerLockfileSha256'], 'Evidence build inputs');
  assert(evidence.buildInputs.dockerfileSha256 === sha256(await readFile(path.join(repositoryRoot, 'docker-v0.3/Dockerfile'))), 'Dockerfile digest mismatch');
  assert(evidence.buildInputs.harnessSha256 === await aggregateFiles(repositoryRoot, ['harness-v0.3/create-consumer.mjs', 'harness-v0.3/probe-contracts.mjs']), 'Harness digest mismatch');
  assert(evidence.buildInputs.prepareScriptSha256 === sha256(await readFile(path.join(repositoryRoot, 'scripts/prepare-v03-contracts.mjs'))), 'Prepare runner digest mismatch');
  const registeredLockfile = await readFile(path.join(repositoryRoot, CONSUMER_LOCKFILE_PATH), 'utf8');
  assert(registration.consumerLockfile.sha256 === sha256(registeredLockfile), 'Registered consumer lockfile digest mismatch');
  assert(evidence.buildInputs.consumerLockfileSha256 === registration.consumerLockfile.sha256, 'Evidence consumer lockfile digest mismatch');
  validateFirstPartyLockfile(registeredLockfile, registration);
  assert(JSON.stringify(evidence.isolation) === JSON.stringify({ dockerRunArgs: EXPECTED_DOCKER_RUN_ARGS, network: 'none', readOnlyRoot: true, capabilities: 'none', noNewPrivileges: true, dockerSocket: false, pidsLimit: 128, memory: '512m', cpus: 1 }), 'Isolation receipt changed');

  const probe = evidence.probe;
  strictKeys(probe, ['schemaVersion', 'registrationId', 'targetRevision', 'packageManager', 'isolationObserved', 'artifacts', 'consumer', 'publicImports', 'privateImports', 'publicTraces'], 'Probe result');
  assert(probe.schemaVersion === 'bug-dreamer/phase1-probe/v1', 'Unexpected probe schemaVersion');
  assert(probe.registrationId === registration.registrationId, 'Probe registration mismatch');
  assert(probe.targetRevision === registration.targetRevision, 'Probe target revision mismatch');
  assert(probe.packageManager === registration.packageManager, 'Probe package manager mismatch');
  assert(JSON.stringify(probe.isolationObserved) === JSON.stringify({ targetSourceAbsent: true, dockerSocketAbsent: true, rootWriteRejected: true, assignedNetworkInterfaces: ['lo'], effectiveCapabilities: '0000000000000000', noNewPrivileges: '1', pidsMax: '128', memoryMax: '536870912', cpuMax: '100000 100000' }), 'Observed isolation checks failed');
  assert(Array.isArray(probe.artifacts) && probe.artifacts.length === 4, 'Probe must record four artifacts');
  unique(probe.artifacts.map((item) => item.id), 'artifact id');
  for (const packageRegistration of registration.packages) {
    const artifact = probe.artifacts.find((item) => item.id === packageRegistration.id);
    assert(artifact !== undefined, `Artifact missing: ${packageRegistration.id}`);
    assert(artifact.packageName === packageRegistration.packageName && artifact.version === packageRegistration.version, `Artifact identity mismatch: ${packageRegistration.id}`);
    assert(Number.isInteger(artifact.byteLength) && artifact.byteLength > 0, `Artifact byte length invalid: ${packageRegistration.id}`);
    assert(validSha(artifact.sha256) && validSha(artifact.manifestSha256) && validSha(artifact.exportsSha256) && validSha(artifact.filesSha256), `Artifact digest invalid: ${packageRegistration.id}`);
    assert(!JSON.stringify(artifact).includes('workspace:'), `Artifact receipt contains workspace protocol: ${packageRegistration.id}`);
    const actualSpecifiers = Object.keys(artifact.exports).sort().map((key) => key === '.' ? packageRegistration.packageName : `${packageRegistration.packageName}/${key.slice(2)}`);
    assert(JSON.stringify(actualSpecifiers) === JSON.stringify([...packageRegistration.allowedImportSpecifiers].sort()), `Artifact exports differ from registration: ${packageRegistration.id}`);
  }
  strictKeys(probe.consumer, ['packageJsonSha256', 'packageJson', 'workspacePolicySha256', 'workspacePolicy', 'lockfileSha256', 'lockfile', 'forbiddenTokensAbsent', 'packageRealpaths', 'dependencyRealpaths'], 'Consumer receipt');
  assert(validSha(probe.consumer.packageJsonSha256) && validSha(probe.consumer.workspacePolicySha256) && validSha(probe.consumer.lockfileSha256), 'Consumer digest is invalid');
  assert(probe.consumer.packageJsonSha256 === sha256(`${JSON.stringify(probe.consumer.packageJson, null, 2)}\n`), 'Consumer package.json digest mismatch');
  assert(probe.consumer.workspacePolicySha256 === sha256(probe.consumer.workspacePolicy), 'Consumer workspace policy digest mismatch');
  assert(probe.consumer.workspacePolicy === expectedWorkspacePolicy(registration), 'Consumer workspace policy differs from registration');
  assert(probe.consumer.lockfileSha256 === sha256(probe.consumer.lockfile), 'Consumer lockfile digest mismatch');
  assert(probe.consumer.lockfile === registeredLockfile, 'Consumer lockfile differs from frozen registration');
  validateFirstPartyLockfile(probe.consumer.lockfile, registration);
  const expectedDependencies = Object.fromEntries([
    ...Object.entries(registration.consumerDependencies),
    ...registration.packages.map((item) => [item.packageName, `file:/artifacts/${item.id}.tgz`]),
  ]);
  assert(JSON.stringify(Object.entries(probe.consumer.packageJson.dependencies).sort()) === JSON.stringify(Object.entries(expectedDependencies).sort()), 'Consumer dependency set differs from registration');
  for (const packageRegistration of registration.packages) {
    assert(probe.consumer.packageJson.dependencies[packageRegistration.packageName] === `file:/artifacts/${packageRegistration.id}.tgz`, `Consumer package is not tarball-pinned: ${packageRegistration.id}`);
    assert(probe.consumer.lockfile.includes(`${packageRegistration.id}.tgz`), `Consumer lockfile omits tarball: ${packageRegistration.id}`);
  }
  assert(probe.consumer.forbiddenTokensAbsent === true, 'Consumer forbidden token check failed');
  assert(Array.isArray(probe.consumer.packageRealpaths) && probe.consumer.packageRealpaths.length === 4, 'Consumer realpaths are incomplete');
  for (const packageRegistration of registration.packages) {
    const item = probe.consumer.packageRealpaths.find((entry) => entry.packageName === packageRegistration.packageName);
    assert(item?.realpath.startsWith('/consumer/node_modules/.pnpm/'), `Package resolves outside clean consumer: ${packageRegistration.packageName}`);
    assert(isTarballRealpath(item.realpath, packageRegistration), `Package does not resolve to its tarball: ${packageRegistration.packageName}`);
  }
  const expectedDependencyCount = registration.packages.reduce((count, item) => count + item.firstPartyDependencies.length, 0);
  assert(Array.isArray(probe.consumer.dependencyRealpaths) && probe.consumer.dependencyRealpaths.length === expectedDependencyCount, 'Target dependency realpaths are incomplete');
  for (const packageRegistration of registration.packages) {
    for (const dependencyName of packageRegistration.firstPartyDependencies) {
      const dependency = registration.packages.find((item) => item.packageName === dependencyName);
      const item = probe.consumer.dependencyRealpaths.find((entry) => entry.ownerPackageName === packageRegistration.packageName && entry.dependencyPackageName === dependencyName);
      assert(item?.realpath.startsWith('/consumer/node_modules/.pnpm/'), `Target dependency resolves outside clean consumer: ${packageRegistration.id}/${dependencyName}`);
      assert(isTarballRealpath(item.realpath, dependency), `Target resolves a non-tarball first-party dependency: ${packageRegistration.id}/${dependencyName}`);
    }
  }

  const allowedSpecifiers = registration.packages.flatMap((item) => item.allowedImportSpecifiers).sort();
  const actualPublicSpecifiers = probe.publicImports.map((item) => item.specifier).sort();
  assert(JSON.stringify(actualPublicSpecifiers) === JSON.stringify(allowedSpecifiers), 'Public import evidence is incomplete');
  assert(probe.publicImports.every((item) => item.status === 'imported'), 'A public import failed');
  const privateSpecifiers = registration.packages.flatMap((item) => item.privateImportSpecifiers).sort();
  const actualPrivateSpecifiers = probe.privateImports.map((item) => item.specifier).sort();
  assert(JSON.stringify(actualPrivateSpecifiers) === JSON.stringify(privateSpecifiers), 'Private import evidence is incomplete');
  assert(probe.privateImports.every((item) => item.status === 'rejected' && item.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'), 'A private import was not rejected by exports');
  assert(Array.isArray(probe.publicTraces), 'Public traces are missing');
  unique(probe.publicTraces.map((item) => item.id), 'public trace id');
  assert(JSON.stringify(probe.publicTraces.map((item) => item.id).sort()) === JSON.stringify(PUBLIC_TRACE_IDS), 'Public trace universe changed');
  assert(probe.publicTraces.every((item) => item.status === 'executed' && item.importSpecifier === '@firsttx/tx' && item.actions.length > 0), 'A public trace did not execute through the public package');
  return evidence;
}

export async function validatePublicBoundaryAudit(repositoryRoot, registration, evidence, audit) {
  strictKeys(audit, ['schemaVersion', 'sourceAudit', 'registrationId', 'evidence', 'records'], 'Public boundary audit');
  assert(audit.schemaVersion === 'bug-dreamer/public-boundary-audit/v1', 'Unexpected public boundary audit schemaVersion');
  strictKeys(audit.sourceAudit, ['path', 'sha256'], 'Audit source');
  assert(audit.sourceAudit.path === 'history/v0.2-audit.json', 'Audit source path changed');
  const sourceBytes = await readFile(path.join(repositoryRoot, audit.sourceAudit.path));
  assert(audit.sourceAudit.sha256 === sha256(sourceBytes), 'Audit source digest mismatch');
  const sourceAudit = JSON.parse(sourceBytes.toString('utf8'));
  assert(audit.registrationId === registration.registrationId, 'Audit registration mismatch');
  strictKeys(audit.evidence, ['path', 'sha256'], 'Audit evidence');
  assert(audit.evidence.path === EVIDENCE_PATH, 'Audit evidence path changed');
  const evidenceBytes = await readFile(path.join(repositoryRoot, EVIDENCE_PATH));
  assert(audit.evidence.sha256 === sha256(evidenceBytes), 'Audit evidence digest mismatch');
  assert(Array.isArray(audit.records) && audit.records.length === 7, 'Public boundary audit must contain seven records');
  unique(audit.records.map((item) => item.id), 'audit id');
  assert(JSON.stringify(audit.records.map((item) => item.id).sort()) === JSON.stringify(HISTORICAL_IDS), 'Historical audit universe changed');
  for (const record of audit.records) {
    strictKeys(record, ['id', 'moduleId', 'scenarioPath', 'scenarioSha256', 'reachability', 'reasonCode', 'importSpecifier', 'traceExpectation', 'missingPublicActions', 'evidenceJsonPointer'], `Audit record ${record.id}`);
    const sourceRecord = sourceAudit.records.find((item) => item.id === record.id);
    assert(sourceRecord !== undefined, `Source audit record missing: ${record.id}`);
    assert(record.scenarioPath === sourceRecord.scenario.path && record.scenarioSha256 === sourceRecord.scenario.sha256, `Historical scenario changed: ${record.id}`);
    strictKeys(record.reachability, ['status', 'value'], `Reachability ${record.id}`);
    assert(record.reachability.status === 'provisional', `Reachability is not provisional: ${record.id}`);
    assert(['public-export', 'internal-contract', 'unreachable'].includes(record.reachability.value), `Invalid provisional reachability: ${record.id}`);
    assert(typeof record.reasonCode === 'string' && record.reasonCode.length > 0, `Reason code missing: ${record.id}`);
    assert(Array.isArray(record.missingPublicActions), `Missing public actions must be an array: ${record.id}`);
    const moduleRegistration = registration.packages.find((item) => item.id === record.moduleId && item.role === 'target-module');
    assert(moduleRegistration !== undefined, `Audit module is not registered: ${record.id}/${record.moduleId}`);
    const node = pointerValue(evidence, record.evidenceJsonPointer);
    if (record.reachability.value === 'public-export') {
      assert(record.reasonCode === 'packed-public-trace-executed', `Public reason code mismatch: ${record.id}`);
      assert(record.missingPublicActions.length === 0, `Public result cannot have missing actions: ${record.id}`);
      strictKeys(record.traceExpectation, ['actions', 'observed'], `Trace expectation ${record.id}`);
      assert(node.id === record.id && node.moduleId === record.moduleId && node.status === 'executed' && node.importSpecifier === record.importSpecifier, `Public trace evidence mismatch: ${record.id}`);
      assert(moduleRegistration?.allowedImportSpecifiers.includes(record.importSpecifier), `Audit import is not registered: ${record.id}`);
      assert(JSON.stringify(node.actions) === JSON.stringify(record.traceExpectation.actions) && JSON.stringify(node.observed) === JSON.stringify(record.traceExpectation.observed), `Public trace observation mismatch: ${record.id}`);
    } else if (record.reachability.value === 'internal-contract') {
      assert(record.reasonCode === 'private-import-rejected', `Internal reason code mismatch: ${record.id}`);
      assert(record.missingPublicActions.length > 0, `Internal result must identify missing public actions: ${record.id}`);
      assert(record.traceExpectation === null, `Internal result cannot have a public trace expectation: ${record.id}`);
      assert(moduleRegistration.privateImportSpecifiers.includes(record.importSpecifier), `Internal import is not registered for module: ${record.id}`);
      assert(node.specifier === record.importSpecifier && node.status === 'rejected' && node.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', `Private import evidence mismatch: ${record.id}`);
    } else {
      assert(record.reasonCode === 'no-public-or-internal-trace', `Unreachable reason code mismatch: ${record.id}`);
      assert(record.traceExpectation === null, `Unreachable result cannot have a public trace expectation: ${record.id}`);
    }
  }
  return audit;
}

export async function validateContracts(repositoryRoot) {
  const [registrationBytes, evidenceBytes, auditBytes] = await Promise.all([
    readFile(path.join(repositoryRoot, REGISTRATION_PATH)),
    readFile(path.join(repositoryRoot, EVIDENCE_PATH)),
    readFile(path.join(repositoryRoot, AUDIT_PATH)),
  ]);
  const registration = validateRegistration(JSON.parse(registrationBytes.toString('utf8')));
  const evidence = await validateEvidence(repositoryRoot, registration, JSON.parse(evidenceBytes.toString('utf8')));
  const audit = await validatePublicBoundaryAudit(repositoryRoot, registration, evidence, JSON.parse(auditBytes.toString('utf8')));
  return {
    registrationId: registration.registrationId,
    packageCount: registration.packages.length,
    publicImportCount: evidence.probe.publicImports.length,
    rejectedPrivateImportCount: evidence.probe.privateImports.length,
    provisionalAuditCount: audit.records.length,
  };
}
