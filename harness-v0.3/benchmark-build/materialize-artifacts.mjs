import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const targetRoot = '/target';
const preparedRoot = '/prepared';
const PINNED_YAML_VERSION = '2.9.0';
const PINNED_YAML_INTEGRITY = 'sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function run(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: targetRoot, stdio: ['ignore', 'inherit', 'inherit'], ...options });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Command failed (${code}): ${argv.join(' ')}`)));
  });
}

function exactEdit(source, edit) {
  const first = source.indexOf(edit.find);
  const second = first < 0 ? -1 : source.indexOf(edit.find, first + edit.find.length);
  if (first < 0 || second >= 0) fail(`Edit must match exactly once: ${edit.file}`);
  return `${source.slice(0, first)}${edit.replace}${source.slice(first + edit.find.length)}`;
}

async function packSet(destination, packages) {
  await mkdir(destination, { recursive: true });
  for (const packageRegistration of packages) {
    const argv = [...packageRegistration.packArgv];
    argv[argv.length - 1] = path.join(destination, `${packageRegistration.id}.tgz`);
    await run(argv);
  }
}

async function artifactDigests(directory, packages) {
  return Object.fromEntries(await Promise.all(packages.map(async ({ id }) => [id, sha256(await readFile(path.join(directory, `${id}.tgz`)))])));
}

function resolvedVersion(record, label) {
  const version = typeof record === 'string' ? record : record?.version;
  if (typeof version !== 'string' || version.length === 0) fail(`Pinned target lock has no resolution for ${label}`);
  return version;
}

export function assertPinnedYamlLockEntry(lockfileText) {
  if (typeof lockfileText !== 'string') fail('Pinned target lock must be text');
  const escapedIntegrity = PINNED_YAML_INTEGRITY.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const entry = new RegExp(`^  yaml@${PINNED_YAML_VERSION}:\\r?\\n    resolution: \\{integrity: ${escapedIntegrity}\\}$`, 'mu');
  if (!entry.test(lockfileText)) fail(`Pinned yaml@${PINNED_YAML_VERSION} integrity changed`);
  return { version: PINNED_YAML_VERSION, integrity: PINNED_YAML_INTEGRITY };
}

async function packageManifestFromEntry(entryPath, expectedName) {
  let directory = path.dirname(entryPath);
  for (let depth = 0; depth < 8 && directory.startsWith(`${targetRoot}${path.sep}`); depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === expectedName) return { directory, manifest };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  fail(`Cannot locate ${expectedName} package metadata from ${entryPath}`);
}

async function loadPinnedTargetLockParser(lockfileText) {
  const targetRequire = createRequire(path.join(targetRoot, 'package.json'));
  const viteEntry = targetRequire.resolve('vite');
  const viteRequire = createRequire(viteEntry);
  const yamlEntry = viteRequire.resolve('yaml');
  const { manifest } = await packageManifestFromEntry(yamlEntry, 'yaml');
  const lockIdentity = assertPinnedYamlLockEntry(lockfileText);
  if (manifest.version !== lockIdentity.version) fail(`Resolved yaml version differs from pinned target lock: ${manifest.version}`);
  const YAML = targetRequire(yamlEntry);
  if (typeof YAML?.parse !== 'function' || typeof YAML?.stringify !== 'function') fail('Resolved yaml parser API changed');
  return { YAML, identity: { ...lockIdentity, resolutionAnchor: 'vite@7.3.6 optional peer' } };
}

export function deriveFixtureLock(targetLock, requested) {
  const rootImporter = targetLock.importers?.['.'];
  if (rootImporter === undefined || targetLock.packages === undefined || targetLock.snapshots === undefined) fail('Pinned target lock is missing required sections');
  const roots = {};
  for (const name of Object.keys(requested).sort()) {
    const record = rootImporter.devDependencies?.[name];
    if (record === undefined) fail(`Fixture dependency is not a root devDependency: ${name}`);
    roots[name] = record;
  }
  const snapshotKeys = new Set();
  const packageKeys = new Set();
  const pending = Object.entries(roots).map(([name, record]) => [name, resolvedVersion(record, name)]);
  while (pending.length > 0) {
    const [name, version] = pending.pop();
    if (/^(?:link:|workspace:|file:)/u.test(version)) fail(`Fixture closure contains a local resolution: ${name}`);
    const snapshotKey = `${name}@${version}`;
    if (snapshotKeys.has(snapshotKey)) continue;
    const snapshot = targetLock.snapshots[snapshotKey];
    if (snapshot === undefined) fail(`Pinned fixture snapshot is missing: ${snapshotKey}`);
    snapshotKeys.add(snapshotKey);
    const packageVersion = version.split('(')[0];
    const packageKey = `${name}@${packageVersion}`;
    if (targetLock.packages[packageKey] === undefined) fail(`Pinned fixture package is missing: ${packageKey}`);
    packageKeys.add(packageKey);
    for (const dependencies of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [dependencyName, dependencyRecord] of Object.entries(dependencies ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
        pending.push([dependencyName, resolvedVersion(dependencyRecord, dependencyName)]);
      }
    }
  }
  const pick = (source, keys) => Object.fromEntries([...keys].sort().map((key) => [key, source[key]]));
  return {
    lockfileVersion: targetLock.lockfileVersion,
    settings: targetLock.settings,
    importers: { '.': { dependencies: roots } },
    packages: pick(targetLock.packages, packageKeys),
    snapshots: pick(targetLock.snapshots, snapshotKeys),
  };
}

export async function factoryDigestTree(root) {
  const entries = [];
  async function visit(prefix = '') {
    for (const name of (await readdir(path.join(root, prefix))).sort()) {
      const relative = path.join(prefix, name);
      const info = await lstat(path.join(root, relative));
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) entries.push({ path: relative.split(path.sep).join('/'), kind: 'file', bytes: await readFile(path.join(root, relative)) });
      else if (info.isSymbolicLink()) entries.push({ path: relative.split(path.sep).join('/'), kind: 'symlink', bytes: Buffer.from(await readlink(path.join(root, relative))) });
      else fail(`Fixture closure contains unsupported entry: ${relative}`);
    }
  }
  await visit();
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.path); digest.update('\0'); digest.update(entry.kind); digest.update('\0'); digest.update(entry.bytes); digest.update('\0');
  }
  return { aggregateSha256: digest.digest('hex') };
}

async function main() {
  const [manifest, inventory, registration] = await Promise.all([
    readFile('/preparation/manifest.json', 'utf8').then(JSON.parse),
    readFile('/preparation/inventory.json', 'utf8').then(JSON.parse),
    readFile('/preparation/packages.json', 'utf8').then(JSON.parse),
  ]);
  if (manifest.defects?.length !== 20 || inventory.rows?.length !== 20 || registration.packages?.length !== 4) fail('Preparation registration cardinality changed');
  const rowById = new Map(inventory.rows.map((row) => [row.id, row]));
  if (rowById.size !== 20) fail('Inventory IDs are duplicated');
  for (const defect of manifest.defects) {
    if (defect.edits?.length !== 1 || rowById.get(defect.id)?.module !== defect.module) fail(`Invalid single-edit defect: ${defect.id}`);
    if (!defect.edits[0].file.startsWith(`${defect.module}/`)) fail(`Defect edit leaves module: ${defect.id}`);
  }

  for (const packageRegistration of registration.packages) await run(packageRegistration.buildArgv);
  const cleanDirectory = path.join(preparedRoot, 'artifact-sets/clean');
  await packSet(cleanDirectory, registration.packages);
  const cleanDigests = await artifactDigests(cleanDirectory, registration.packages);
  const sets = [{ id: 'clean', moduleId: null, artifactDigests: cleanDigests }];

  for (const defect of manifest.defects) {
    const edit = defect.edits[0];
    const sourcePath = path.join(targetRoot, edit.file);
    const original = await readFile(sourcePath, 'utf8');
    const moduleId = defect.module.slice('packages/'.length);
    const targetPackage = registration.packages.find((item) => item.id === moduleId);
    if (targetPackage === undefined) fail(`Defect module is not registered: ${defect.module}`);
    const destination = path.join(preparedRoot, 'artifact-sets', defect.id);
    await cp(cleanDirectory, destination, { recursive: true });
    try {
      await writeFile(sourcePath, exactEdit(original, edit));
      await run(targetPackage.buildArgv);
      const output = path.join(destination, `${targetPackage.id}.tgz.next`);
      const argv = [...targetPackage.packArgv];
      argv[argv.length - 1] = output;
      await run(argv);
      await rename(output, path.join(destination, `${targetPackage.id}.tgz`));
    } finally {
      await writeFile(sourcePath, original);
    }
    const digests = await artifactDigests(destination, registration.packages);
    if (digests[moduleId] === cleanDigests[moduleId]) fail(`Defect tarball equals clean tarball: ${defect.id}`);
    for (const packageRegistration of registration.packages) {
      if (packageRegistration.id !== moduleId && digests[packageRegistration.id] !== cleanDigests[packageRegistration.id]) fail(`Defect changed non-target artifact: ${defect.id}/${packageRegistration.id}`);
    }
    sets.push({ id: defect.id, moduleId, edit, artifactDigests: digests });
  }

  const fixtureRoot = path.join(preparedRoot, 'fixture-tools');
  await mkdir(fixtureRoot, { recursive: true });
  const targetLockBytes = await readFile(path.join(targetRoot, 'pnpm-lock.yaml'));
  const targetLockText = targetLockBytes.toString('utf8');
  const { YAML, identity: yamlParser } = await loadPinnedTargetLockParser(targetLockText);
  const targetLock = YAML.parse(targetLockText);
  const rootDevDependencies = JSON.parse(await readFile(path.join(targetRoot, 'package.json'), 'utf8')).devDependencies;
  const requested = { 'fake-indexeddb': rootDevDependencies?.['fake-indexeddb'], jsdom: rootDevDependencies?.jsdom };
  if (requested['fake-indexeddb'] !== '^6.2.2' || requested.jsdom !== '^29.1.1') fail('Pinned fixture dependency declarations changed');
  const fixtureLock = deriveFixtureLock(targetLock, requested);
  if (resolvedVersion(fixtureLock.importers['.'].dependencies['fake-indexeddb'], 'fake-indexeddb') !== '6.2.5'
    || resolvedVersion(fixtureLock.importers['.'].dependencies.jsdom, 'jsdom') !== '29.1.1') fail('Pinned fixture resolutions changed');
  const fixtureLockBytes = Buffer.from(YAML.stringify(fixtureLock, { lineWidth: 0 }));
  await writeFile(path.join(fixtureRoot, 'package.json'), `${JSON.stringify({ private: true, dependencies: requested }, null, 2)}\n`);
  await writeFile(path.join(fixtureRoot, 'pnpm-lock.yaml'), fixtureLockBytes);
  await run(['pnpm', '--dir', fixtureRoot, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'], { cwd: fixtureRoot });
  if (!fixtureLockBytes.equals(await readFile(path.join(fixtureRoot, 'pnpm-lock.yaml')))) fail('Frozen fixture install changed the derived target-lock closure');
  await rm(path.join(fixtureRoot, 'node_modules/.cache'), { recursive: true, force: true });
  const fixtureClosure = await factoryDigestTree(fixtureRoot);
  await writeFile(path.join(preparedRoot, 'receipt.json'), `${JSON.stringify({
    schemaVersion: 'bug-dreamer/v03-benchmark-artifact-factory/v1',
    sets,
    fixtureTools: {
      dependencies: { 'fake-indexeddb': '6.2.5', jsdom: '29.1.1' },
      targetLockfileSha256: sha256(targetLockBytes),
      lockfileSha256: sha256(fixtureLockBytes),
      aggregateSha256: fixtureClosure.aggregateSha256,
      yamlParser,
      resolutionRule: 'the fixture lock is a deterministic transitive graph slice of the pinned target lockfile and is installed frozen offline',
    },
  }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
