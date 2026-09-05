import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

import { firstPartyEntryBlocks, lockfileSection } from './v03-contracts.mjs';
import { PHASE4_APPROVED_BUDGETS, PHASE4_MODULES } from './v03-benchmark-contract.mjs';
import { canonicalJson, domainDigest } from './v03-wire.mjs';

export const BENCHMARK_PREPARATION_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-preparation/v1';
export const BENCHMARK_IMAGE_CONTRACT_DOMAIN = 'bug-dreamer/v03-benchmark-image-contract/v1';
export const BENCHMARK_ARTIFACT_SET_IDS = Object.freeze(['clean']);

export class V03BenchmarkPreparationError extends Error {}

function fail(message) {
  throw new V03BenchmarkPreparationError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} is missing`);
  assert(!path.posix.isAbsolute(value) && !value.includes('\\') && !value.includes('\0'), `${label} is unsafe`);
  const normalized = path.posix.normalize(value);
  assert(normalized === value && normalized !== '..' && !normalized.startsWith('../'), `${label} escapes its root`);
  return value;
}

export function applyExactSingleEdit(source, edit) {
  assert(typeof source === 'string', 'Edited source must be text');
  assert(isObject(edit), 'Defect edit must be an object');
  safeRelativePath(edit.file, 'Defect edit file');
  assert(typeof edit.find === 'string' && edit.find.length > 0 && typeof edit.replace === 'string', 'Defect edit text is invalid');
  const first = source.indexOf(edit.find);
  const second = first < 0 ? -1 : source.indexOf(edit.find, first + edit.find.length);
  assert(first >= 0 && second < 0, `Defect edit for ${edit.file} must match exactly once`);
  return `${source.slice(0, first)}${edit.replace}${source.slice(first + edit.find.length)}`;
}

export function validateBenchmarkDefects(manifest, inventory) {
  assert(isObject(manifest) && Array.isArray(manifest.defects), 'Benchmark manifest defects are missing');
  assert(isObject(inventory) && Array.isArray(inventory.rows), 'Benchmark inventory rows are missing');
  assert(manifest.defects.length === 20 && inventory.rows.length === 20, 'Benchmark preparation requires exactly 20 registered rows');
  const inventoryById = new Map(inventory.rows.map((row) => [row.id, row]));
  assert(inventoryById.size === 20, 'Benchmark inventory row IDs are duplicated');
  const seen = new Set();
  for (const defect of manifest.defects) {
    assert(isObject(defect) && typeof defect.id === 'string' && !seen.has(defect.id), 'Benchmark defect identity is invalid or duplicated');
    seen.add(defect.id);
    const row = inventoryById.get(defect.id);
    assert(row !== undefined, `Benchmark defect is outside the registered inventory: ${defect.id}`);
    assert(typeof defect.module === 'string' && row.module === defect.module, `Benchmark defect module mismatch: ${defect.id}`);
    const moduleId = defect.module.replace(/^packages\//u, '');
    assert(Object.hasOwn(PHASE4_MODULES, moduleId), `Benchmark defect module is not registered: ${defect.module}`);
    assert(Array.isArray(defect.edits) && defect.edits.length === 1, `Benchmark defect must contain exactly one edit: ${defect.id}`);
    const [edit] = defect.edits;
    safeRelativePath(edit.file, `Benchmark defect ${defect.id} edit file`);
    assert(edit.file.startsWith(`${defect.module}/`), `Benchmark defect edit leaves its module: ${defect.id}`);
    assert(typeof edit.find === 'string' && edit.find.length > 0 && typeof edit.replace === 'string', `Benchmark defect edit is invalid: ${defect.id}`);
  }
  assert(inventory.rows.every((row) => seen.has(row.id)), 'Benchmark manifest does not cover the registered inventory');
  return manifest.defects;
}

function targetEntry(lockfileText, targetKey) {
  const section = lockfileSection(lockfileText, 'packages:', 'snapshots:');
  const block = firstPartyEntryBlocks(section).find((entry) => entry.key === targetKey);
  assert(block !== undefined, `Consumer lockfile target entry is missing: ${targetKey}`);
  return block;
}

export function tarballIntegrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function freezeTargetTarballIntegrity(lockfileText, targetKey, tarballBytes) {
  assert(typeof lockfileText === 'string' && Buffer.isBuffer(tarballBytes), 'Lockfile or tarball bytes are invalid');
  const block = targetEntry(lockfileText, targetKey);
  const followingEntry = /^ {2}\S.*$/gmu;
  followingEntry.lastIndex = block.body.indexOf('\n') + 1;
  const nextEntry = followingEntry.exec(block.body);
  const targetBody = nextEntry === null ? block.body : block.body.slice(0, nextEntry.index);
  const integrityPattern = /^( {4}resolution: \{integrity: )(sha512-[A-Za-z0-9+/=]+)([^\n]*)$/gmu;
  const matches = [...targetBody.matchAll(integrityPattern)];
  assert(matches.length === 1, `Consumer lockfile target must have one integrity line: ${targetKey}`);
  const nextIntegrity = tarballIntegrity(tarballBytes);
  const changedTargetBody = targetBody.replace(integrityPattern, `$1${nextIntegrity}$3`);
  const changed = lockfileText.replace(targetBody, changedTargetBody);
  const beforeLines = lockfileText.split('\n');
  const afterLines = changed.split('\n');
  assert(beforeLines.length === afterLines.length, 'Frozen lockfile line count changed');
  const differences = beforeLines.flatMap((line, index) => line === afterLines[index] ? [] : [index]);
  assert(differences.length <= 1, 'Frozen lockfile changed more than one line');
  if (matches[0][2] !== nextIntegrity) assert(differences.length === 1, 'Frozen lockfile did not change the target integrity line');
  return Object.freeze({ bytes: Buffer.from(changed), targetKey, integritySha512: nextIntegrity, changedLine: differences.length === 0 ? null : differences[0] + 1 });
}

async function listRegularFiles(root, prefix = '') {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, relative));
    else if (entry.isFile()) files.push(relative.split(path.sep).join('/'));
    else fail(`Closure contains a non-regular entry: ${relative}`);
  }
  return files.sort();
}

export async function digestFileClosure(root, relativePaths) {
  assert(Array.isArray(relativePaths) && relativePaths.length > 0, 'File closure must be non-empty');
  const files = [...relativePaths].sort();
  assert(new Set(files).size === files.length, 'File closure contains duplicates');
  const digest = createHash('sha256');
  const entries = [];
  for (const relative of files) {
    safeRelativePath(relative, 'Closure file');
    const bytes = await readFile(path.join(root, relative));
    const fileSha256 = sha256(bytes);
    entries.push(Object.freeze({ path: relative, sha256: fileSha256 }));
    digest.update(relative); digest.update('\0'); digest.update(bytes); digest.update('\0');
  }
  return Object.freeze({ files: Object.freeze(entries), aggregateSha256: digest.digest('hex') });
}

export async function digestTreeClosure(root, prefix = '') {
  const entries = [];
  async function visit(relativeDirectory) {
    for (const entry of (await readdir(path.join(root, relativeDirectory), { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const relative = path.join(relativeDirectory, entry.name).split(path.sep).join('/');
      const absolute = path.join(root, relative);
      const info = await lstat(absolute);
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) entries.push({ path: relative, kind: 'file', bytes: await readFile(absolute) });
      else if (info.isSymbolicLink()) entries.push({ path: relative, kind: 'symlink', bytes: Buffer.from(await readlink(absolute)) });
      else fail(`Tree closure contains unsupported entry: ${relative}`);
    }
  }
  await visit(prefix);
  assert(entries.length > 0, 'Tree closure must be non-empty');
  const digest = createHash('sha256');
  const files = entries.map((entry) => {
    digest.update(entry.path); digest.update('\0'); digest.update(entry.kind); digest.update('\0'); digest.update(entry.bytes); digest.update('\0');
    return Object.freeze({ path: entry.path, kind: entry.kind, sha256: sha256(entry.bytes) });
  });
  return Object.freeze({ files: Object.freeze(files), aggregateSha256: digest.digest('hex') });
}

export function moduleImportSpecifiers(source) {
  assert(typeof source === 'string', 'Module source must be text');
  const staticSpecifiers = [];
  const dynamicSpecifiers = [];
  const isIdentifierStart = (character) => character !== undefined && /[A-Za-z_$]/u.test(character);
  const isIdentifierPart = (character) => character !== undefined && /[A-Za-z0-9_$]/u.test(character);
  function skipTrivia(start) {
    let index = start;
    while (index < source.length) {
      if (/\s/u.test(source[index])) { index += 1; continue; }
      if (source.startsWith('//', index)) { index = source.indexOf('\n', index + 2); if (index < 0) return source.length; continue; }
      if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); assert(end >= 0, 'Unterminated block comment in module source'); index = end + 2; continue; }
      break;
    }
    return index;
  }
  function readQuoted(start) {
    const quote = source[start];
    assert(quote === "'" || quote === '"', 'Module specifier must be a quoted string literal');
    let value = '';
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      assert(character !== '\\' && character !== '\n' && character !== '\r' && character >= ' ', 'Escaped or control characters are forbidden in module specifiers');
      if (character === quote) return { value, end: index + 1 };
      value += character;
    }
    fail('Unterminated module specifier');
  }
  function skipLiteral(start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === quote) return index + 1;
      index += 1;
    }
    fail('Unterminated literal in module source');
  }
  function fromSpecifier(start) {
    let index = start;
    while (index < source.length && source[index] !== ';') {
      index = skipTrivia(index);
      if (source[index] === "'" || source[index] === '"' || source[index] === '`') { index = skipLiteral(index); continue; }
      if (isIdentifierStart(source[index])) {
        const wordStart = index;
        index += 1;
        while (isIdentifierPart(source[index])) index += 1;
        if (source.slice(wordStart, index) === 'from') {
          index = skipTrivia(index);
          const literal = readQuoted(index);
          return literal.value;
        }
        continue;
      }
      index += 1;
    }
    return null;
  }
  let index = 0;
  while (index < source.length) {
    index = skipTrivia(index);
    if (source[index] === "'" || source[index] === '"' || source[index] === '`') { index = skipLiteral(index); continue; }
    if (!isIdentifierStart(source[index])) { index += 1; continue; }
    const wordStart = index;
    index += 1;
    while (isIdentifierPart(source[index])) index += 1;
    const word = source.slice(wordStart, index);
    const next = skipTrivia(index);
    if (word === 'require' && source[next] === '(') fail('Module source uses an untracked require call');
    if (word !== 'import' && word !== 'export') continue;
    if (word === 'import' && source[next] === '.') continue;
    if (word === 'import' && source[next] === '(') {
      let argument = skipTrivia(next + 1);
      assert(source[argument] === "'" || source[argument] === '"', 'Dynamic import must use a registered string literal');
      const literal = readQuoted(argument);
      argument = skipTrivia(literal.end);
      assert(source[argument] === ')', 'Dynamic import must contain only one registered string literal');
      dynamicSpecifiers.push(literal.value);
      index = argument + 1;
      continue;
    }
    if (word === 'import' && (source[next] === "'" || source[next] === '"')) {
      const literal = readQuoted(next);
      staticSpecifiers.push(literal.value);
      index = literal.end;
      continue;
    }
    if (word === 'export' && source[next] !== '{' && source[next] !== '*') continue;
    const specifier = fromSpecifier(next);
    if (specifier !== null) staticSpecifiers.push(specifier);
  }
  return Object.freeze({ staticSpecifiers: Object.freeze(staticSpecifiers), dynamicSpecifiers: Object.freeze(dynamicSpecifiers) });
}

export async function benchmarkImportClosures(repositoryRoot, { directEntrypoints, interpreterEntrypoints }) {
  const registeredRuntimeImports = new Set(Object.values(PHASE4_MODULES).flatMap((module) => module.allowedImportSpecifiers ?? [module.importSpecifier]));
  async function closure(entrypoints, label) {
    const pending = [...entrypoints];
    const visited = new Set();
    while (pending.length > 0) {
      const relative = pending.pop();
      safeRelativePath(relative, `${label} source`);
      if (visited.has(relative)) continue;
      visited.add(relative);
      const source = await readFile(path.join(repositoryRoot, relative), 'utf8');
      const imports = moduleImportSpecifiers(source);
      for (const specifier of imports.dynamicSpecifiers) assert(registeredRuntimeImports.has(specifier), `${label} source dynamically imports an unregistered specifier: ${specifier}`);
      for (const specifier of imports.staticSpecifiers) {
        if (!specifier.startsWith('.')) {
          assert(specifier.startsWith('node:') || specifier === 'canonicalize' || registeredRuntimeImports.has(specifier), `${label} source imports an unregistered external specifier: ${specifier}`);
          continue;
        }
        let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
        if (path.posix.extname(resolved) === '') resolved = `${resolved}.mjs`;
        safeRelativePath(resolved, `${label} import`);
        pending.push(resolved);
      }
    }
    return visited;
  }
  const direct = await closure(directEntrypoints, 'Direct caller');
  const interpreter = await closure(interpreterEntrypoints, 'Interpreter caller');
  const registeredDirectModules = new Set(Object.keys(PHASE4_MODULES).map((id) => `harness-v0.3/benchmark/${id}-direct.mjs`));
  for (const file of direct) {
    assert(file !== 'src/v03-benchmark-spec.mjs' && !file.endsWith('/v03-benchmark-spec.mjs'), `Direct caller reaches the benchmark spec builder: ${file}`);
    assert(!file.startsWith('harness-v0.3/benchmark/') || directEntrypoints.includes(file) || registeredDirectModules.has(file) || interpreter.has(file), `Direct-only closure contains an unclassified benchmark module: ${file}`);
  }
  for (const file of interpreter) assert(!file.endsWith('-direct.mjs'), `Interpreter caller reaches a direct materializer: ${file}`);
  const sharedFiles = [...direct].filter((file) => interpreter.has(file)).sort();
  const directFiles = [...direct].filter((file) => !interpreter.has(file)).sort();
  const interpreterFiles = [...interpreter].filter((file) => !direct.has(file)).sort();
  assert(sharedFiles.length > 0, 'Direct and interpreter callers have no explicit shared primitive closure');
  return benchmarkSourceClosures(repositoryRoot, { directFiles, interpreterFiles, sharedFiles });
}

export async function canonicalizerClosure(repositoryRoot) {
  const packageRoot = await import('node:fs/promises').then(({ realpath }) => realpath(path.join(repositoryRoot, 'node_modules/canonicalize')));
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert(packageJson.name === 'canonicalize' && packageJson.version === '4.0.0', 'Canonicalizer package identity changed');
  const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const match = lockfile.match(/^ {2}canonicalize@4\.0\.0:\r?\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/mu);
  assert(match !== null, 'canonicalize@4.0.0 integrity is missing from pnpm-lock.yaml');
  const files = (await listRegularFiles(packageRoot)).filter((file) => !file.startsWith('node_modules/'));
  const closure = await digestFileClosure(packageRoot, files);
  return Object.freeze({ package: packageJson.name, version: packageJson.version, integritySha512: match[1], ...closure });
}

export async function benchmarkSourceClosures(repositoryRoot, { directFiles, interpreterFiles, sharedFiles }) {
  for (const [name, files] of Object.entries({ directFiles, interpreterFiles, sharedFiles })) {
    assert(Array.isArray(files) && files.length > 0, `${name} must be explicit and non-empty`);
  }
  const directSet = new Set(directFiles);
  const interpreterSet = new Set(interpreterFiles);
  const sharedSet = new Set(sharedFiles);
  for (const file of directSet) assert(!interpreterSet.has(file) && !sharedSet.has(file), `Direct caller closure overlaps another closure: ${file}`);
  for (const file of interpreterSet) assert(!sharedSet.has(file), `Interpreter caller closure overlaps shared primitives: ${file}`);
  return Object.freeze({
    direct: await digestFileClosure(repositoryRoot, directFiles),
    interpreter: await digestFileClosure(repositoryRoot, interpreterFiles),
    shared: await digestFileClosure(repositoryRoot, sharedFiles),
  });
}

export function benchmarkImageContractKey(inputs) {
  assert(isObject(inputs), 'Benchmark image contract inputs are missing');
  for (const key of ['artifactSetId', 'artifactDigests', 'lockfileSha256', 'registrationSha256', 'dockerfileSha256', 'sourceClosures', 'canonicalizer']) {
    assert(inputs[key] !== undefined, `Benchmark image contract input is missing: ${key}`);
  }
  return domainDigest(BENCHMARK_IMAGE_CONTRACT_DOMAIN, inputs);
}

export function createPreparationLedger(nowMs = 0) {
  assert(Number.isSafeInteger(nowMs) && nowMs >= 0, 'Preparation start time is invalid');
  return { builds: 0, inspects: 0, probeContainers: 0, failures: 0, cleanups: 0, cleanupFailures: 0, elapsedSeconds: 0, startedAtMs: nowMs, stoppedBy: null };
}

function assertRunning(ledger) {
  assert(ledger.stoppedBy === null, `Preparation already stopped: ${ledger.stoppedBy}`);
}

export function chargePreparation(ledger, kind, nowMs) {
  assert(['builds', 'inspects', 'probeContainers', 'cleanups'].includes(kind), `Unknown preparation counter: ${kind}`);
  if (kind !== 'cleanups') assertRunning(ledger);
  ledger.elapsedSeconds = Math.ceil((nowMs - ledger.startedAtMs) / 1000);
  if (kind !== 'cleanups') assert(ledger.elapsedSeconds <= PHASE4_APPROVED_BUDGETS.preparation.monotonicWallClockSecondsMaximum, 'Preparation wall-clock budget exhausted');
  if (kind === 'builds') assert(ledger.builds + 1 <= PHASE4_APPROVED_BUDGETS.preparation.dockerBuildMaximum, 'Preparation Docker build budget exhausted');
  if (kind === 'inspects' || kind === 'probeContainers') {
    assert(ledger.inspects + ledger.probeContainers + 1 <= PHASE4_APPROVED_BUDGETS.preparation.dockerInspectOrProbeMaximum, 'Preparation inspect/probe budget exhausted');
  }
  ledger[kind] += 1;
  return ledger;
}

export function stopPreparationOnFailure(ledger, reason = 'preparation-attempt-failed') {
  assertRunning(ledger);
  ledger.failures += 1;
  ledger.stoppedBy = reason;
  return ledger;
}

export function recordCleanupFailure(ledger) {
  ledger.cleanupFailures += 1;
  return ledger;
}

export function publicPreparationLedger(ledger, nowMs) {
  const elapsedSeconds = Math.ceil((nowMs - ledger.startedAtMs) / 1000);
  return Object.freeze({
    schemaVersion: BENCHMARK_PREPARATION_SCHEMA_VERSION,
    builds: ledger.builds,
    inspects: ledger.inspects,
    probeContainers: ledger.probeContainers,
    failures: ledger.failures,
    cleanups: ledger.cleanups,
    cleanupFailures: ledger.cleanupFailures,
    elapsedSeconds,
    stoppedBy: ledger.stoppedBy,
  });
}

export function assertTwentyOneArtifactPlan(defects) {
  assert(Array.isArray(defects) && defects.length === 20, 'Artifact plan requires 20 defects');
  const ids = ['clean', ...defects.map((defect) => defect.id)];
  assert(new Set(ids).size === 21, 'Artifact set IDs are duplicated');
  const plan = { artifactFactoryBuilds: 1, finalImageBuilds: ids.length, totalBuilds: ids.length + 1, spareBuilds: PHASE4_APPROVED_BUDGETS.preparation.dockerBuildMaximum - ids.length - 1, artifactSetIds: ids };
  assert(plan.totalBuilds === 22 && plan.spareBuilds === 2, 'Preparation build plan changed');
  return Object.freeze(plan);
}

export function canonicalPreparationDescriptor(value) {
  assert(isObject(value), 'Preparation descriptor must be an object');
  return `${canonicalJson(value)}\n`;
}
