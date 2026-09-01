import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { MODULES } from './modules.mjs';
import { PathContainmentError, assertNoSymlinkAncestors, resolveContainedPath } from './v03-paths.mjs';

const execFileAsync = promisify(execFile);

const AXIS_NAMES = Object.freeze([
  'specAcceptance',
  'plan',
  'evaluator',
  'batch',
  'execution',
  'repeatReproduction',
  'independentReproduction',
  'reachability',
  'oracle',
  'minimization',
  'humanVerdict',
  'publication',
]);

const PRESERVATION_STATES = new Set([
  'exact-replayable',
  'best-effort-rebuilt',
  'evidence-preserved',
  'unrecoverable',
]);

const REPLAY_STATES = new Set(['not-attempted', 'pass', 'mismatch', 'unavailable', 'error']);

export const V02_COMPLETION = Object.freeze({
  commit: '45106d9df9c8d9b68fb327311e767a10e114959f',
  tree: 'ed4e6171eea3a2c43708e0ee6f2ff77441e27ff0',
});

export class HistoryValidationError extends Error {}

function assert(condition, message) {
  if (!condition) throw new HistoryValidationError(message);
}

function assertExactKeys(value, expectedKeys, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort()), `${label} fields changed`);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function immutableAuditProjection(audit) {
  return {
    schemaVersion: audit.schemaVersion,
    nightmareReport: audit.nightmareReport,
    records: audit.records.map((record) => ({
      id: record.id,
      ordinal: record.ordinal,
      title: record.title,
      scenario: record.scenario,
      evidenceRefs: record.evidenceRefs,
      independentReproductionRefs: record.independentReproductionRefs,
      imageRef: record.imageRef,
      historicalHumanVerdict: record.axes.humanVerdict,
      historicalPublication: record.axes.publication,
      staticHypothesis: record.staticHypothesis,
      dataGaps: record.dataGaps,
    })),
    globalDataGaps: audit.globalDataGaps,
  };
}

async function containedPath(repositoryRoot, relativePath) {
  try {
    const absolute = resolveContainedPath(repositoryRoot, relativePath);
    await assertNoSymlinkAncestors(repositoryRoot, absolute);
    return absolute;
  } catch (error) {
    if (error instanceof PathContainmentError) throw new HistoryValidationError(error.message);
    throw error;
  }
}

async function readJson(repositoryRoot, relativePath) {
  const source = await readFile(await containedPath(repositoryRoot, relativePath), 'utf8');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new HistoryValidationError(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

async function git(repositoryRoot, args, options = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd: repositoryRoot,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new HistoryValidationError(`git ${args.join(' ')} failed: ${error.stderr?.toString().trim() || error.message}`);
  }
}

async function baselineTreeEntries(repositoryRoot, commit) {
  const { stdout } = await git(repositoryRoot, ['ls-tree', '-r', '--full-tree', '-z', commit], {
    encoding: 'buffer',
  });
  const entries = stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/.exec(record);
      assert(match !== null, `Invalid baseline tree record: ${record}`);
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function matchesSelection(filePath, selection) {
  if ((selection.excludePaths ?? []).includes(filePath)) return false;
  return selection.explicitPaths.includes(filePath) || selection.prefixes.some((prefix) => filePath.startsWith(prefix));
}

export function partitionPaths(paths, pathManifest) {
  const runtime = [];
  const historical = [];
  const snapshot = [];

  for (const filePath of paths) {
    const runtimeMatch = matchesSelection(filePath, pathManifest.frozenRuntimeInputs);
    const historicalMatch = matchesSelection(filePath, pathManifest.frozenHistoricalOutputs);
    assert(!(runtimeMatch && historicalMatch), `Path belongs to two frozen sets: ${filePath}`);
    if (runtimeMatch) runtime.push(filePath);
    else if (historicalMatch) historical.push(filePath);
    else snapshot.push(filePath);
  }

  return { runtime, historical, snapshot };
}

export function unregisteredLegacyPaths(currentPaths, frozenPaths) {
  const frozen = frozenPaths instanceof Set ? frozenPaths : new Set(frozenPaths);
  return currentPaths.filter((filePath) => !frozen.has(filePath));
}

export async function validateDirectoryChain(repositoryRoot, relativePath) {
  let current = repositoryRoot;
  for (const segment of path.posix.dirname(relativePath).split('/').filter(Boolean)) {
    current = path.join(current, segment);
    const currentStat = await lstat(current);
    assert(currentStat.isDirectory() && !currentStat.isSymbolicLink(), `Frozen path ancestor is not a real directory: ${relativePath}`);
  }
}

async function compareWithBaseline(repositoryRoot, commit, relativePath, baselineMode) {
  const currentPath = path.join(repositoryRoot, relativePath);
  let current;
  try {
    await validateDirectoryChain(repositoryRoot, relativePath);
    const currentStat = await lstat(currentPath);
    assert(currentStat.isFile(), `Frozen path type changed: ${relativePath}`);
    const baselineExecutable = baselineMode === '100755';
    assert(((currentStat.mode & 0o111) !== 0) === baselineExecutable, `Frozen path executable mode changed: ${relativePath}`);
    current = await readFile(currentPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HistoryValidationError(`Frozen path is missing: ${relativePath}`);
    throw error;
  }
  const { stdout: baseline } = await git(repositoryRoot, ['show', `${commit}:${relativePath}`], {
    encoding: 'buffer',
  });
  assert(current.equals(baseline), `Frozen path changed from ${commit}: ${relativePath}`);
}

async function listFiles(root, relativePrefix) {
  const start = path.join(root, relativePrefix);
  try {
    const startStat = await lstat(start);
    if (startStat.isFile()) return [relativePrefix];
    assert(startStat.isDirectory() && !startStat.isSymbolicLink(), `Legacy namespace is not a real directory: ${relativePrefix}`);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const results = [];
  async function visit(absoluteDirectory) {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else results.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  await visit(start);
  return results.sort();
}

export function extractLocalImports(source) {
  const imports = [];
  const patterns = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.')) imports.push(match[1]);
    }
  }
  return [...new Set(imports)];
}

async function importClosure(repositoryRoot, entrypoint) {
  const visited = new Set();
  const pending = [entrypoint];

  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = await readFile(await containedPath(repositoryRoot, current), 'utf8');
    for (const specifier of extractLocalImports(source)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(current), specifier));
      pending.push(resolved);
    }
  }

  return [...visited].sort();
}

export function parseDockerCopySources(source) {
  const copySources = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*COPY\s+(?!\[)(.+?)\s+\S+\s*$/.exec(line);
    if (!match) continue;
    const tokens = match[1].split(/\s+/).filter((token) => !token.startsWith('--'));
    copySources.push(...tokens);
  }
  return copySources;
}

export function readJsonPointer(value, pointer) {
  assert(typeof pointer === 'string' && pointer.startsWith('/'), `Invalid JSON pointer: ${pointer}`);
  let current = value;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    assert(current !== null && typeof current === 'object' && Object.hasOwn(current, token), `JSON pointer not found: ${pointer}`);
    current = current[token];
  }
  return current;
}

function valuesForKey(value, key, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) valuesForKey(item, key, output);
    return output;
  }
  if (value === null || typeof value !== 'object') return output;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) output.push(entryValue);
    valuesForKey(entryValue, key, output);
  }
  return output;
}

async function validateEvidenceRef(repositoryRoot, reference) {
  assert(typeof reference.path === 'string', 'Evidence reference path is required');
  assert(typeof reference.jsonPointer === 'string', `Evidence JSON pointer is required: ${reference.path}`);
  assert(/^[0-9a-f]{64}$/.test(reference.sha256), `Evidence sha256 is invalid: ${reference.path}`);
  const bytes = await readFile(await containedPath(repositoryRoot, reference.path));
  assert(sha256(bytes) === reference.sha256, `Evidence hash mismatch: ${reference.path}`);
  const document = JSON.parse(bytes.toString('utf8'));
  return readJsonPointer(document, reference.jsonPointer);
}

function validateAxes(record) {
  assert(record.axes !== null && typeof record.axes === 'object', `Audit axes are missing: ${record.id}`);
  assert(JSON.stringify(Object.keys(record.axes).sort()) === JSON.stringify([...AXIS_NAMES].sort()), `Audit axes are incomplete: ${record.id}`);
  for (const axis of AXIS_NAMES) {
    const state = record.axes[axis];
    assert(state !== null && typeof state === 'object', `Audit axis wrapper is invalid: ${record.id}/${axis}`);
    if (axis === 'humanVerdict') {
      assert(state.status === 'historical', `Historical human verdict status is invalid: ${record.id}`);
      assert(['real-bug-worth-fixing', 'real-bug-not-worth-fixing'].includes(state.value), `Historical human verdict is invalid: ${record.id}`);
    } else if (axis === 'publication') {
      assert(state.status === 'historical' && state.value === 'legacy', `Historical publication state is invalid: ${record.id}`);
    } else {
      assert(state.status === 'unassessed' && state.value === null, `Phase 0 axis must remain unassessed: ${record.id}/${axis}`);
    }
  }
}

export async function validateAudit(repositoryRoot, manifest, audit, images) {
  assert(audit.schemaVersion === 'bug-dreamer/v02-audit/v1', 'Unexpected audit schemaVersion');
  assert(Array.isArray(audit.records) && audit.records.length === 7, 'Audit ledger must contain seven records');
  assert(audit.nightmareReport.path === manifest.nightmareReport.path, 'Audit report path differs from history manifest');
  assert(audit.nightmareReport.sha256 === manifest.nightmareReport.sha256, 'Audit report hash differs from history manifest');
  const report = await readFile(await containedPath(repositoryRoot, audit.nightmareReport.path));
  assert(sha256(report) === audit.nightmareReport.sha256, 'Nightmare report hash mismatch');

  const imageById = new Map(images.images.map((image) => [image.id, image]));
  const ids = new Set();
  const ordinals = new Set();

  for (const record of audit.records) {
    assert(!ids.has(record.id), `Duplicate audit id: ${record.id}`);
    assert(!ordinals.has(record.ordinal), `Duplicate audit ordinal: ${record.ordinal}`);
    ids.add(record.id);
    ordinals.add(record.ordinal);
    assert(record.auditStatus === 'unassessed', `Phase 0 audit status must be unassessed: ${record.id}`);
    assert(typeof record.title === 'string' && record.title.length > 0, `Audit title is missing: ${record.id}`);
    assert(typeof record.scenario.originalCommand === 'string' && record.scenario.originalCommand.length > 0, `Original command is missing: ${record.id}`);
    const scenario = await readFile(await containedPath(repositoryRoot, record.scenario.path));
    assert(sha256(scenario) === record.scenario.sha256, `Scenario hash mismatch: ${record.id}`);
    assert(imageById.has(record.imageRef), `Unknown image reference: ${record.id}/${record.imageRef}`);
    assert(Array.isArray(record.evidenceRefs) && record.evidenceRefs.length > 0, `Primary evidence is missing: ${record.id}`);
    validateAxes(record);
    assert(record.staticHypothesis !== null && typeof record.staticHypothesis === 'object', `Static audit hypothesis is missing: ${record.id}`);

    const expectedHash = `sha256:${record.scenario.sha256}`;
    const primaryMessages = [];
    for (const reference of record.evidenceRefs) {
      const node = await validateEvidenceRef(repositoryRoot, reference);
      const testHashes = valuesForKey(node, 'test_hash');
      const commands = valuesForKey(node, 'command');
      const imageStrings = valuesForKey(node, 'image_or_os');
      const messages = valuesForKey(node, 'failure_signature').filter(Boolean).map((signature) => signature.message);
      assert(testHashes.length > 0 && testHashes.every((value) => value === expectedHash), `Evidence pointer is broader than the scenario hash: ${record.id}`);
      assert(commands.length > 0 && commands.every((value) => value === record.scenario.originalCommand), `Evidence pointer is broader than the original command: ${record.id}`);
      assert(imageStrings.length > 0 && imageStrings.every((item) => typeof item === 'string' && item.endsWith(`@${imageById.get(record.imageRef).imageId}`)), `Evidence pointer does not identify one recorded image: ${record.id}`);
      primaryMessages.push(...messages);
    }
    assert(primaryMessages.length > 0, `Primary failure signature is missing: ${record.id}`);
    for (const reference of record.independentReproductionRefs) {
      const node = await validateEvidenceRef(repositoryRoot, reference);
      assert(node.command === record.scenario.originalCommand, `Independent reproduction command mismatch: ${record.id}`);
      assert(node.observed_outcome === 'candidate-failure', `Independent reproduction outcome mismatch: ${record.id}`);
      assert(node.signature_match === true, `Independent reproduction signature was not accepted: ${record.id}`);
      assert(primaryMessages.includes(node.observed_message), `Independent reproduction message does not match primary evidence: ${record.id}`);
    }
  }

  assert([...ordinals].sort((a, b) => a - b).every((value, index) => value === index + 1), 'Audit ordinals must be 1 through 7');
}

async function validateArchiveVerification(repositoryRoot, manifest, image) {
  const reference = image.archive.verificationRef;
  assert(reference && typeof reference.path === 'string' && /^[0-9a-f]{64}$/.test(reference.sha256), `Archive verification ref is incomplete: ${image.id}`);
  const bytes = await readFile(await containedPath(repositoryRoot, reference.path));
  assert(sha256(bytes) === reference.sha256, `Archive verification hash mismatch: ${image.id}`);
  const verification = JSON.parse(bytes.toString('utf8'));
  assert(verification.schemaVersion === 'bug-dreamer/v02-image-archive-verification/v1', `Archive verification schema mismatch: ${image.id}`);
  assert(verification.archiveLocator === image.archive.locator, `Archive verification locator mismatch: ${image.id}`);
  assert(verification.archiveSha256 === image.archive.sha256, `Verified archive digest mismatch: ${image.id}`);
  assert(verification.archiveByteLength === image.archive.byteLength, `Verified archive byte length mismatch: ${image.id}`);
  assert(verification.platform === image.platform, `Verified archive platform mismatch: ${image.id}`);
  assert(verification.targetRevision === image.targetRevision, `Archive target revision mismatch: ${image.id}`);
  assert(verification.dependenciesRef === image.dependenciesRef, `Archive dependency ref mismatch: ${image.id}`);
  assert(verification.frozenInputs?.baselineCommit === manifest.baselineCommit, `Archive baseline commit attestation mismatch: ${image.id}`);
  assert(verification.frozenInputs?.pathManifestSha256 === manifest.anchors.pathManifestSha256, `Archive path manifest attestation mismatch: ${image.id}`);
  assert(verification.digestVerified === true && verification.identityVerified === true, `Archive verification checks are incomplete: ${image.id}`);
  assert(typeof verification.verificationCommand === 'string' && verification.verificationCommand.length > 0, `Archive verification command is missing: ${image.id}`);
  assert(typeof verification.verifiedAt === 'string' && !Number.isNaN(Date.parse(verification.verifiedAt)), `Archive verification time is invalid: ${image.id}`);
  if (image.preservation.status === 'exact-replayable') {
    assert(verification.restoredImageId === image.imageId, `Archive restored a different exact image ID: ${image.id}`);
    assert(verification.ociDigest === image.ociDigest, `Archive OCI digest mismatch: ${image.id}`);
  } else {
    assert(verification.restoredImageId === image.archive.restoredImageId, `Rebuilt archive image ID mismatch: ${image.id}`);
    assert(verification.restoredImageId !== image.imageId, `Best-effort rebuild cannot claim the historical image ID: ${image.id}`);
    assert(verification.ociDigest === image.ociDigest, `Rebuilt archive OCI digest mismatch: ${image.id}`);
    assert(verification.rebuildInputs?.targetRevision === manifest.target.revision, `Rebuilt archive target revision mismatch: ${image.id}`);
    assert(verification.rebuildInputs?.dependenciesRef === manifest.target.dependenciesRef, `Rebuilt archive dependency ref mismatch: ${image.id}`);
    assert(verification.rebuildInputs?.baselineCommit === manifest.baselineCommit, `Rebuilt archive baseline commit mismatch: ${image.id}`);
    assert(verification.rebuildInputs?.pathManifestSha256 === manifest.anchors.pathManifestSha256, `Rebuilt archive path manifest mismatch: ${image.id}`);
  }
}

export async function validateImages(repositoryRoot, manifest, images, historicalPaths = []) {
  assert(images.schemaVersion === 'bug-dreamer/v02-images/v1', 'Unexpected image schemaVersion');
  assert(Array.isArray(images.images) && images.images.length === 4, 'Image ledger must contain four distinct images');
  const ids = new Set();
  const imageIds = new Set();
  const expectedBaseTag = `bug-dreamer/firsttx:v0.1-${manifest.target.revision.slice(0, 12)}`;
  const expectedTags = {
    'packages/tx': expectedBaseTag,
    'packages/local-first': `${expectedBaseTag}-local-first`,
    'packages/prepaint': `${expectedBaseTag}-prepaint`,
  };
  for (const image of images.images) {
    assert(!ids.has(image.id), `Duplicate image ledger id: ${image.id}`);
    ids.add(image.id);
    assert(image.tag === expectedTags[image.module], `Historical image tag or module mismatch: ${image.id}`);
    assert(image.targetRevision === manifest.target.revision, `Target revision mismatch: ${image.id}`);
    assert(image.dependenciesRef === manifest.target.dependenciesRef, `Dependency ref mismatch: ${image.id}`);
    assert(PRESERVATION_STATES.has(image.preservation.status), `Invalid preservation state: ${image.id}`);
    assert(REPLAY_STATES.has(image.replay.status), `Invalid replay state: ${image.id}`);
    if (image.preservation.status === 'unrecoverable') {
      assert(image.imageId === null || !Array.isArray(image.evidenceRefs) || image.evidenceRefs.length === 0, `Unrecoverable image must identify the missing evidence or image ID: ${image.id}`);
      assert(image.localAvailability === false && image.replay.status === 'unavailable', `Unrecoverable image cannot claim replay availability: ${image.id}`);
      assert(image.archive.verified === false && image.archive.locator === null && image.archive.sha256 === null, `Unrecoverable image cannot claim an archive: ${image.id}`);
      continue;
    }
    assert(/^sha256:[0-9a-f]{64}$/.test(image.imageId), `Invalid image ID: ${image.id}`);
    assert(!imageIds.has(image.imageId), `Duplicate historical image ID: ${image.imageId}`);
    imageIds.add(image.imageId);
    assert(Array.isArray(image.evidenceRefs) && image.evidenceRefs.length > 0, `Image evidence refs are missing: ${image.id}`);
    assert(Array.isArray(image.replayCases) && image.replayCases.length > 0, `Image replay cases are missing: ${image.id}`);
    let foundImage = false;
    for (const evidencePath of image.evidenceRefs) {
      const source = await readFile(await containedPath(repositoryRoot, evidencePath), 'utf8');
      if (source.includes(image.imageId)) foundImage = true;
    }
    assert(foundImage, `Image ID is absent from its evidence refs: ${image.id}`);

    if (image.preservation.status === 'exact-replayable') {
      assert(image.archive.verified === true && typeof image.archive.locator === 'string' && image.archive.locator.length > 0, `Exact archive locator is incomplete: ${image.id}`);
      assert(/^[0-9a-f]{64}$/.test(image.archive.sha256) && Number.isInteger(image.archive.byteLength) && image.archive.byteLength > 0, `Exact archive digest metadata is incomplete: ${image.id}`);
      assert(image.archive.restoredImageId === image.imageId, `Exact archive restored image ID mismatch: ${image.id}`);
      assert(/^sha256:[0-9a-f]{64}$/.test(image.ociDigest) && /^[^/]+\/[^/]+$/.test(image.platform), `Exact archive platform identity is incomplete: ${image.id}`);
      await validateArchiveVerification(repositoryRoot, manifest, image);
    } else if (image.preservation.status === 'best-effort-rebuilt') {
      assert(image.archive.verified === true && typeof image.archive.locator === 'string' && image.archive.locator.length > 0, `Rebuilt archive locator is incomplete: ${image.id}`);
      assert(/^[0-9a-f]{64}$/.test(image.archive.sha256) && Number.isInteger(image.archive.byteLength) && image.archive.byteLength > 0, `Rebuilt archive digest metadata is incomplete: ${image.id}`);
      assert(/^sha256:[0-9a-f]{64}$/.test(image.archive.restoredImageId) && image.archive.restoredImageId !== image.imageId, `Rebuilt archive image identity is incomplete: ${image.id}`);
      assert(/^sha256:[0-9a-f]{64}$/.test(image.ociDigest) && /^[^/]+\/[^/]+$/.test(image.platform), `Rebuilt archive platform identity is incomplete: ${image.id}`);
      await validateArchiveVerification(repositoryRoot, manifest, image);
    } else if (image.preservation.status === 'evidence-preserved') {
      assert(image.archive.verified === false && image.archive.locator === null && image.archive.sha256 === null, `Evidence-only image cannot claim an archive: ${image.id}`);
      assert(image.localAvailability === false && image.replay.status === 'unavailable', `Evidence-only snapshot must record unavailable replay: ${image.id}`);
    }
  }
  assert(images.currentMutableTags[expectedBaseTag] !== undefined, 'Current tx mutable-tag observation is missing');
  assert(!imageIds.has(images.currentMutableTags[expectedBaseTag]), 'Current tx mutable tag unexpectedly claims a historical image ID');
  assert(images.currentMutableTags[`${expectedBaseTag}-local-first`] === null, 'Local-first mutable-tag observation changed');
  assert(images.currentMutableTags[`${expectedBaseTag}-prepaint`] === null, 'Prepaint mutable-tag observation changed');
  const evidenceImageIds = new Set();
  for (const relativePath of historicalPaths.filter((filePath) => filePath.startsWith('evidence/') && filePath.endsWith('.json'))) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    for (const match of source.matchAll(/bug-dreamer\/firsttx:[^"@]+@(sha256:[0-9a-f]{64})/g)) evidenceImageIds.add(match[1]);
  }
  if (historicalPaths.length > 0) {
    assert(JSON.stringify([...evidenceImageIds].sort()) === JSON.stringify([...imageIds].sort()), 'Image ledger does not match distinct image IDs in frozen evidence');
  }
}

async function validatePackageProjection(repositoryRoot, projection) {
  const packageJson = await readJson(repositoryRoot, 'package.json');
  assert(packageJson.engines?.node === projection.engines.node, 'Legacy package engine projection changed');
  assert(packageJson.packageManager === projection.packageManager, 'Legacy packageManager projection changed');
  for (const [name, command] of Object.entries(projection.scripts)) {
    assert(packageJson.scripts?.[name] === command, `Legacy package script projection changed: ${name}`);
  }
}

async function validateLockProjection(repositoryRoot, projection) {
  const source = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const lockfileVersion = /^lockfileVersion:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(source)?.[1];
  const autoInstallPeers = /^\s*autoInstallPeers:\s*(true|false)\s*$/m.exec(source)?.[1] === 'true';
  const excludeLinksFromLockfile = /^\s*excludeLinksFromLockfile:\s*(true|false)\s*$/m.exec(source)?.[1] === 'true';
  assert(lockfileVersion === projection.lockfileVersion, 'Legacy lockfile format changed');
  assert(autoInstallPeers === projection.autoInstallPeers, 'Legacy autoInstallPeers setting changed');
  assert(excludeLinksFromLockfile === projection.excludeLinksFromLockfile, 'Legacy excludeLinksFromLockfile setting changed');
  assert(Object.keys(projection.legacyRootDependencies).length === 0, 'Unexpected legacy root dependency projection');
}

export function targetArchiveTree(entries, archivePaths) {
  const selected = entries.filter((entry) => archivePaths.some((archivePath) => entry.path === archivePath || entry.path.startsWith(`${archivePath}/`)));
  const bytes = selected.map((entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}\0`).join('');
  return { entries: selected, sha256: sha256(bytes) };
}

async function validateTargetTreeSnapshot(repositoryRoot, manifest, buildContract) {
  const bytes = await readFile(await containedPath(repositoryRoot, manifest.targetTreeSnapshotRef));
  assert(sha256(bytes) === manifest.anchors.targetTreeSnapshotSha256, 'Target tree snapshot anchor mismatch');
  const snapshot = JSON.parse(bytes.toString('utf8'));
  assertExactKeys(snapshot, ['schemaVersion', 'repository', 'revision', 'captureCommand', 'entryEncoding', 'treeSha256', 'entries'], 'target tree snapshot');
  assert(snapshot.schemaVersion === 'bug-dreamer/target-tree-snapshot/v1', 'Unexpected target tree snapshot schemaVersion');
  assert(snapshot.repository === manifest.target.project, 'Target tree snapshot repository mismatch');
  assert(snapshot.revision === manifest.target.revision, 'Target tree snapshot revision mismatch');
  const expectedCaptureCommand = `git ls-tree -r --full-tree -z ${manifest.target.revision} -- package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages/shared packages/tx packages/local-first packages/prepaint`;
  assert(snapshot.captureCommand === expectedCaptureCommand, 'Target tree snapshot capture command mismatch');
  assert(snapshot.entryEncoding === '<mode> <type> <oid>\\t<path>\\0', 'Target tree snapshot encoding changed');
  assert(Array.isArray(snapshot.entries) && snapshot.entries.length > 0, 'Target tree snapshot is empty');
  const paths = new Set();
  for (const entry of snapshot.entries) {
    assertExactKeys(entry, ['mode', 'type', 'oid', 'path'], 'target tree entry');
    assert(/^\d{6}$/.test(entry.mode) && entry.type === 'blob' && /^[0-9a-f]{40}$/.test(entry.oid), `Invalid target tree entry: ${entry.path}`);
    assert(typeof entry.path === 'string' && entry.path.length > 0 && !paths.has(entry.path), `Duplicate or invalid target tree path: ${entry.path}`);
    paths.add(entry.path);
  }
  const completeTree = snapshot.entries.map((entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}\0`).join('');
  assert(sha256(completeTree) === snapshot.treeSha256, 'Complete target tree snapshot digest changed');
  const consumed = new Set();
  for (const [moduleName, modulePath] of Object.entries(buildContract.targetArchiveModulePaths)) {
    const archivePaths = [...buildContract.targetArchiveCommonPaths, modulePath];
    const tree = targetArchiveTree(snapshot.entries, archivePaths);
    const entries = tree.entries;
    for (const entry of entries) consumed.add(entry.path);
    const expected = buildContract.targetArchiveTrees[moduleName];
    assert(entries.length === expected.pathCount, `Target archive tree count changed: ${moduleName}`);
    assert(tree.sha256 === expected.gitLsTreeSha256, `Target archive tree digest changed: ${moduleName}`);
  }
  assert(consumed.size === snapshot.entries.length, 'Target tree snapshot contains paths outside the registered archive inputs');
}

export function validateRegistrationTemplateShape(registration) {
  assertExactKeys(registration, ['schemaVersion', 'status', 'requiresUserCheckpoints', 'phase3', 'checkpoints', 'authorBundle', 'universe', 'pipelineRetentionDefectIds', 'pipelineRetentionRows', 'arms', 'budgets', 'metrics', 'truthTables', 'revisableReasonCodes', 'benchmarkEpochId'], 'registration template');
  assertExactKeys(registration.phase3, ['finalVerdict', 'spikeRegistrationDigest', 'spikeResultDigest'], 'registration phase3');
  assertExactKeys(registration.checkpoints, ['commitA', 'commitB', 'sealedRef'], 'registration checkpoints');
  assertExactKeys(registration.authorBundle, ['manifestDigest', 'sessionRecordDigest'], 'registration author bundle');
  assertExactKeys(registration.universe, ['development', 'existingPublic', 'heldOutTemporal'], 'registration universe');
  assert(registration.schemaVersion === 'bug-dreamer/v03-benchmark-registration/v1', 'Unexpected registration template schemaVersion');
  assert(registration.status === 'template', 'Phase 0 registration must remain a template');
  assert(registration.requiresUserCheckpoints === true, 'Registration template must require user checkpoints');
  assert(registration.phase3.finalVerdict === null && registration.phase3.spikeRegistrationDigest === null && registration.phase3.spikeResultDigest === null, 'Registration template cannot claim a Phase 3 result');
  assert(registration.checkpoints.commitA === null && registration.checkpoints.commitB === null, 'Template cannot claim benchmark checkpoints');
  assert(registration.checkpoints.sealedRef === null, 'Template cannot claim a sealed checkpoint');
  assert(registration.authorBundle.manifestDigest === null && registration.authorBundle.sessionRecordDigest === null, 'Template cannot claim an author bundle');
  assert(['development', 'existingPublic', 'heldOutTemporal'].every((key) => Array.isArray(registration.universe[key]) && registration.universe[key].length === 0), 'Registration template universe must be empty');
  assert(Array.isArray(registration.pipelineRetentionDefectIds) && registration.pipelineRetentionDefectIds.length === 0, 'Template retention defect IDs must be empty');
  assert(Array.isArray(registration.pipelineRetentionRows) && registration.pipelineRetentionRows.length === 0, 'Template retention rows must be empty');
  assert(JSON.stringify(registration.arms) === JSON.stringify(['G', 'P', 'A', 'B', 'C', 'D', 'E']), 'Registration template arm set changed');
  assert(registration.budgets === null && registration.metrics === null && registration.truthTables === null && registration.revisableReasonCodes === null, 'Template cannot claim benchmark policy values');
  assert(registration.benchmarkEpochId === null, 'Template cannot claim a benchmark epoch');
}

async function validateRegistrationTemplate(repositoryRoot) {
  validateRegistrationTemplateShape(await readJson(repositoryRoot, 'benchmark/v0.3/registration.template.json'));
}

export function replayStatus(results) {
  if (results.some((result) => result.status === 'error')) return 'error';
  if (results.some((result) => result.status === 'mismatch')) return 'mismatch';
  if (results.every((result) => result.status === 'unavailable')) return 'unavailable';
  if (results.every((result) => result.status === 'pass')) return 'pass';
  throw new HistoryValidationError('Frozen replay returned mixed availability states');
}

function comparableReplayResult(result) {
  return {
    id: result.id,
    historicalImageId: result.historicalImageId,
    executedImageId: result.executedImageId,
    replayKind: result.replayKind,
    scenario: result.scenario,
    status: result.status,
    observedOutcome: result.observedOutcome ?? null,
    signatureMatch: result.signatureMatch ?? null,
    errorMessage: result.errorMessage ?? null,
  };
}

export async function validateRecordedReplayResult(repositoryRoot, image, results) {
  assert(image.replay.resultRef && typeof image.replay.resultRef.path === 'string' && /^[0-9a-f]{64}$/.test(image.replay.resultRef.sha256), `Available historical image has no hashed replay result reference: ${image.id}`);
  const resultBytes = await readFile(await containedPath(repositoryRoot, image.replay.resultRef.path));
  assert(sha256(resultBytes) === image.replay.resultRef.sha256, `Recorded replay result hash mismatch: ${image.id}`);
  const recorded = JSON.parse(resultBytes.toString('utf8'));
  assert(recorded.schemaVersion === 'bug-dreamer/v02-replay-result/v1' && Array.isArray(recorded.results), `Recorded replay result shape is invalid: ${image.id}`);
  const recordedResults = recorded.results.filter((result) => result.historicalImageId === image.imageId);
  assert(JSON.stringify(recordedResults.map(comparableReplayResult)) === JSON.stringify(results.map(comparableReplayResult)), `Recorded replay result differs from the live replay: ${image.id}`);
}

async function validateReplayAvailability(repositoryRoot, images) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, ['scripts/replay-v02-frozen.mjs', '--all-available'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    throw new HistoryValidationError(`Frozen replay failed: ${error.stderr?.trim() || error.message}`);
  }
  let replay;
  try {
    replay = JSON.parse(stdout);
  } catch (error) {
    throw new HistoryValidationError(`Frozen replay returned invalid JSON: ${error.message}`);
  }
  assert(replay.schemaVersion === 'bug-dreamer/v02-replay-result/v1' && Array.isArray(replay.results), 'Frozen replay result shape is invalid');
  for (const image of images.images) {
    const results = replay.results.filter((result) => result.historicalImageId === image.imageId);
    assert(results.length === image.replayCases.length, `Not every replay case was attempted: ${image.id}`);
    const expectedReplayKind = image.preservation.status === 'best-effort-rebuilt' ? 'best-effort-rebuilt' : 'exact-image-id';
    const expectedExecutedImageId = expectedReplayKind === 'best-effort-rebuilt' ? image.archive.restoredImageId : image.imageId;
    assert(results.every((result) => result.replayKind === expectedReplayKind && result.executedImageId === expectedExecutedImageId), `Replay image identity or mode mismatch: ${image.id}`);
    const observedStatus = replayStatus(results);
    assert(observedStatus === image.replay.status, `Live replay status differs from the ledger: ${image.id}`);
    if (observedStatus !== 'unavailable') {
      assert(image.localAvailability === true, `Replayable image is not marked locally available: ${image.id}`);
      await validateRecordedReplayResult(repositoryRoot, image, results);
    } else {
      assert(image.localAvailability === false, `Unavailable image is marked locally available: ${image.id}`);
      assert(image.replay.resultRef === null, `Unavailable image cannot claim a replay result: ${image.id}`);
    }
  }
  return replay.results;
}

export async function validateHistory(repositoryRoot, options = {}) {
  const manifest = await readJson(repositoryRoot, 'history/v0.2-manifest.json');
  assert(manifest.baselineCommit === V02_COMPLETION.commit, 'History manifest baseline commit is not the frozen v0.2 completion commit');
  assert(manifest.baselineTree === V02_COMPLETION.tree, 'History manifest baseline tree is not the frozen v0.2 completion tree');
  const pathManifest = await readJson(repositoryRoot, manifest.pathUniverseRef);
  const audit = await readJson(repositoryRoot, manifest.auditLedgerRef);
  const images = await readJson(repositoryRoot, manifest.imageLedgerRef);

  assert(manifest.schemaVersion === 'bug-dreamer/history-manifest/v1', 'Unexpected history manifest schemaVersion');
  assert(pathManifest.schemaVersion === 'bug-dreamer/history-paths/v1', 'Unexpected path manifest schemaVersion');
  assert(pathManifest.baseline.commit === manifest.baselineCommit, 'History manifests disagree on baseline commit');
  assert(pathManifest.baseline.tree === manifest.baselineTree, 'History manifests disagree on baseline tree');
  const pathManifestBytes = await readFile(await containedPath(repositoryRoot, manifest.pathUniverseRef));
  const imageLedgerBytes = await readFile(await containedPath(repositoryRoot, manifest.imageLedgerRef));
  const registrationTemplateBytes = await readFile(path.join(repositoryRoot, 'benchmark/v0.3/registration.template.json'));
  assert(sha256(pathManifestBytes) === manifest.anchors.pathManifestSha256, 'Path manifest anchor mismatch');
  assert(sha256(imageLedgerBytes) === manifest.anchors.imageLedgerSha256, 'Image ledger anchor mismatch');
  assert(sha256(JSON.stringify(immutableAuditProjection(audit))) === manifest.anchors.auditImmutableProjectionSha256, 'Audit immutable projection anchor mismatch');
  assert(sha256(registrationTemplateBytes) === manifest.anchors.registrationTemplateSha256, 'Registration template anchor mismatch');

  const { stdout: actualTree } = await git(repositoryRoot, ['rev-parse', `${manifest.baselineCommit}^{tree}`]);
  assert(actualTree.trim() === manifest.baselineTree, 'Baseline commit tree does not match the history manifest');
  const treeEntries = await baselineTreeEntries(repositoryRoot, manifest.baselineCommit);
  const paths = treeEntries.map((entry) => entry.path);
  const baselineModeByPath = new Map(treeEntries.map((entry) => [entry.path, entry.mode]));
  assert(paths.length === pathManifest.baseline.trackedPathCount, 'Baseline tracked path count changed');
  const partition = partitionPaths(paths, pathManifest);
  assert(partition.runtime.length === pathManifest.frozenRuntimeInputs.pathCount, 'Frozen runtime input count mismatch');
  assert(partition.historical.length === pathManifest.frozenHistoricalOutputs.pathCount, 'Frozen historical output count mismatch');
  assert(partition.snapshot.length === pathManifest.baselineSnapshotOnly.pathCount, 'Baseline snapshot-only count mismatch');
  assert(partition.runtime.length + partition.historical.length + partition.snapshot.length === paths.length, 'Path universe is incomplete');

  for (const relativePath of [...partition.runtime, ...partition.historical]) {
    await compareWithBaseline(repositoryRoot, manifest.baselineCommit, relativePath, baselineModeByPath.get(relativePath));
  }

  const frozenSet = new Set([...partition.runtime, ...partition.historical]);
  for (const prefix of pathManifest.reservedLegacyNamespaces) {
    const unexpected = unregisteredLegacyPaths(await listFiles(repositoryRoot, prefix), frozenSet);
    assert(unexpected.length === 0, `Unregistered file added to a legacy namespace: ${unexpected[0]}`);
  }

  for (const [entrypoint, expected] of Object.entries(pathManifest.frozenRuntimeInputs.hostImportClosures)) {
    const actual = await importClosure(repositoryRoot, entrypoint);
    assert(JSON.stringify(actual) === JSON.stringify([...expected].sort()), `Legacy import closure changed: ${entrypoint}`);
  }

  const dockerfile = await readFile(await containedPath(repositoryRoot, pathManifest.frozenRuntimeInputs.dockerBuildContract.dockerfile), 'utf8');
  const copySources = parseDockerCopySources(dockerfile);
  assert(JSON.stringify(copySources) === JSON.stringify(pathManifest.frozenRuntimeInputs.dockerBuildContract.copySources), 'Legacy Docker COPY sources changed');
  for (const contextPath of pathManifest.frozenRuntimeInputs.dockerBuildContract.repositoryContextPaths) {
    const contextFiles = await listFiles(repositoryRoot, contextPath);
    assert(contextFiles.length > 0, `Legacy Docker context path is empty: ${contextPath}`);
    for (const contextFile of contextFiles) {
      assert(partition.runtime.includes(contextFile), `Unregistered legacy Docker context input: ${contextFile}`);
    }
  }
  const buildContract = pathManifest.frozenRuntimeInputs.dockerBuildContract;
  for (const [moduleName, modulePath] of Object.entries(buildContract.targetArchiveModulePaths)) {
    assert(MODULES[moduleName] !== undefined, `Target archive module is not registered: ${moduleName}`);
    const expectedArchivePaths = [...buildContract.targetArchiveCommonPaths.slice(0, 4), buildContract.targetArchiveCommonPaths[4], modulePath];
    assert(JSON.stringify(MODULES[moduleName].archivePaths) === JSON.stringify(expectedArchivePaths), `Target archive path contract changed: ${moduleName}`);
  }
  await validateTargetTreeSnapshot(repositoryRoot, manifest, buildContract);
  await validatePackageProjection(repositoryRoot, pathManifest.baselineSnapshotOnly.packageJsonProjection);
  await validateLockProjection(repositoryRoot, pathManifest.baselineSnapshotOnly.pnpmLockProjection);
  await validateImages(repositoryRoot, manifest, images, partition.historical);
  await validateAudit(repositoryRoot, manifest, audit, images);
  await validateRegistrationTemplate(repositoryRoot);

  if (options.replayAvailable === true) await validateReplayAvailability(repositoryRoot, images);

  return {
    baselineCommit: manifest.baselineCommit,
    pathCounts: {
      frozenRuntimeInputs: partition.runtime.length,
      frozenHistoricalOutputs: partition.historical.length,
      baselineSnapshotOnly: partition.snapshot.length,
    },
    nightmareCount: audit.records.length,
    imageCount: images.images.length,
    replayChecked: options.replayAvailable === true,
  };
}
