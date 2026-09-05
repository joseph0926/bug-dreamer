import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import localDescriptor from '../registrations/v0.3/benchmark/local-first.json' with { type: 'json' };
import prepaintDescriptor from '../registrations/v0.3/benchmark/prepaint.json' with { type: 'json' };
import txDescriptor from '../registrations/v0.3/benchmark/tx.json' with { type: 'json' };

import {
  V03BenchmarkPreparationError,
  applyExactSingleEdit,
  assertTwentyOneArtifactPlan,
  benchmarkSourceClosures,
  benchmarkImportClosures,
  chargePreparation,
  createPreparationLedger,
  digestTreeClosure,
  freezeTargetTarballIntegrity,
  moduleImportSpecifiers,
  publicPreparationLedger,
  stopPreparationOnFailure,
  tarballIntegrity,
  validateBenchmarkDefects,
} from '../src/v03-benchmark-preparation.mjs';
import { assertPinnedYamlLockEntry, deriveFixtureLock, factoryDigestTree } from '../harness-v0.3/benchmark-build/materialize-artifacts.mjs';
import { runBoundedCommand, syntheticSmokeInputs, validateSyntheticSmokeEnvelope } from '../scripts/prepare-v03-benchmark.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

const targetKey = '@firsttx/tx@file:../artifacts/tx.tgz';
const lockfile = `lockfileVersion: '9.0'\n\npackages:\n\n  '${targetKey}':\n    resolution: {integrity: sha512-AAAAAAAA==}\n\n  zod@1.0.0:\n    resolution: {integrity: sha512-ZZZZZZZZ==}\n\nsnapshots:\n\n  '${targetKey}': {}\n`;

test('exact edit rejects zero and multiple matches', () => {
  const edit = { file: 'packages/tx/src/a.ts', find: 'old', replace: 'new' };
  assert.equal(applyExactSingleEdit('before old after', edit), 'before new after');
  assert.throws(() => applyExactSingleEdit('none', edit), V03BenchmarkPreparationError);
  assert.throws(() => applyExactSingleEdit('old old', edit), V03BenchmarkPreparationError);
});

test('frozen lock changes exactly the selected first-party integrity line', () => {
  const tarball = Buffer.from('defect tarball');
  const frozen = freezeTargetTarballIntegrity(lockfile, targetKey, tarball);
  assert.equal(frozen.integritySha512, tarballIntegrity(tarball));
  assert.equal(frozen.changedLine, 6);
  const changed = frozen.bytes.toString('utf8').split('\n');
  const original = lockfile.split('\n');
  assert.deepEqual(changed.flatMap((line, index) => line === original[index] ? [] : [index + 1]), [6]);
  assert.equal(changed[9], original[9]);
});

test('manifest requires 20 inventory-aligned single edits inside registered modules', () => {
  const defects = Array.from({ length: 20 }, (_, index) => ({
    id: `row-${index}`,
    module: index < 10 ? 'packages/tx' : index < 16 ? 'packages/local-first' : 'packages/prepaint',
    edits: [{ file: `${index < 10 ? 'packages/tx' : index < 16 ? 'packages/local-first' : 'packages/prepaint'}/src/a.ts`, find: 'a', replace: 'b' }],
  }));
  const inventory = { rows: defects.map(({ id, module }) => ({ id, module })) };
  assert.equal(validateBenchmarkDefects({ defects }, inventory).length, 20);
  assert.deepEqual(assertTwentyOneArtifactPlan(defects), {
    artifactFactoryBuilds: 1,
    finalImageBuilds: 21,
    totalBuilds: 22,
    spareBuilds: 2,
    artifactSetIds: ['clean', ...defects.map(({ id }) => id)],
  });
  const invalid = structuredClone(defects);
  invalid[0].edits.push(invalid[0].edits[0]);
  assert.throws(() => validateBenchmarkDefects({ defects: invalid }, inventory), /exactly one edit/u);
});

test('the frozen manifest and Phase 4 inventory form the 21-set plan', async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'benchmark/manifest.json'), 'utf8'));
  const inventory = JSON.parse(await readFile(path.join(repositoryRoot, 'benchmark/v0.3/phase4-inventory.draft.json'), 'utf8'));
  const defects = validateBenchmarkDefects(manifest, inventory);
  assert.equal(assertTwentyOneArtifactPlan(defects).totalBuilds, 22);
});

test('D and E caller closures are disjoint and shared primitives are explicit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-benchmark-closure-'));
  try {
    await mkdir(path.join(root, 'caller'), { recursive: true });
    await writeFile(path.join(root, 'caller/direct.mjs'), 'direct\n');
    await writeFile(path.join(root, 'caller/interpreter.mjs'), 'interpreter\n');
    await writeFile(path.join(root, 'caller/shared.mjs'), 'shared\n');
    const closure = await benchmarkSourceClosures(root, {
      directFiles: ['caller/direct.mjs'],
      interpreterFiles: ['caller/interpreter.mjs'],
      sharedFiles: ['caller/shared.mjs'],
    });
    assert.notEqual(closure.direct.aggregateSha256, closure.interpreter.aggregateSha256);
    await assert.rejects(() => benchmarkSourceClosures(root, {
      directFiles: ['caller/shared.mjs'],
      interpreterFiles: ['caller/interpreter.mjs'],
      sharedFiles: ['caller/shared.mjs'],
    }), /overlaps/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('import closure separates callers and derives shared primitives from both graphs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-benchmark-imports-'));
  try {
    await mkdir(path.join(root, 'harness-v0.3/benchmark'), { recursive: true });
    await writeFile(path.join(root, 'harness-v0.3/benchmark/direct.mjs'), "import {\n  shared\n} from './shared.mjs';\nexport const direct = shared;\n");
    await writeFile(path.join(root, 'harness-v0.3/benchmark/interpreter.mjs'), "export { shared } from './shared.mjs';\n");
    await writeFile(path.join(root, 'harness-v0.3/benchmark/shared.mjs'), 'export const shared = true;\n');
    const closure = await benchmarkImportClosures(root, {
      directEntrypoints: ['harness-v0.3/benchmark/direct.mjs'],
      interpreterEntrypoints: ['harness-v0.3/benchmark/interpreter.mjs'],
    });
    assert.deepEqual(closure.shared.files.map((file) => file.path), ['harness-v0.3/benchmark/shared.mjs']);
    assert.deepEqual(closure.direct.files.map((file) => file.path), ['harness-v0.3/benchmark/direct.mjs']);
    assert.deepEqual(closure.interpreter.files.map((file) => file.path), ['harness-v0.3/benchmark/interpreter.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('import closure permits only literal registered dynamic package imports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-benchmark-loader-'));
  try {
    await writeFile(path.join(root, 'shared.mjs'), 'export const shared = true;\n');
    await writeFile(path.join(root, 'direct.mjs'), "import './shared.mjs'; export const load = () => import('@firsttx/tx');\n");
    await writeFile(path.join(root, 'interpreter.mjs'), "import './shared.mjs'; export const load = () => import('@firsttx/prepaint/plugin/vite');\n");
    await benchmarkImportClosures(root, { directEntrypoints: ['direct.mjs'], interpreterEntrypoints: ['interpreter.mjs'] });
    await writeFile(path.join(root, 'direct.mjs'), "import './shared.mjs'; const name = '@firsttx/tx'; export const load = () => import(name);\n");
    await assert.rejects(() => benchmarkImportClosures(root, { directEntrypoints: ['direct.mjs'], interpreterEntrypoints: ['interpreter.mjs'] }), /registered string literal/u);
    await writeFile(path.join(root, 'direct.mjs'), "import './shared.mjs'; export const load = () => import('@firsttx/tx/private');\n");
    await assert.rejects(() => benchmarkImportClosures(root, { directEntrypoints: ['direct.mjs'], interpreterEntrypoints: ['interpreter.mjs'] }), /unregistered specifier/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('module import scanner ignores comments and strings and rejects private literals', () => {
  const scanned = moduleImportSpecifiers(`
    // import('@firsttx/tx/private')
    const text = "import('@firsttx/tx/private')";
    import('@firsttx/tx');
    export { value } from './shared.mjs';
  `);
  assert.deepEqual(scanned.dynamicSpecifiers, ['@firsttx/tx']);
  assert.deepEqual(scanned.staticSpecifiers, ['./shared.mjs']);
  assert.throws(() => moduleImportSpecifiers('import(`@firsttx/${name}`);'), /registered string literal/u);
});

test('module import scanner handles the shared v03 wire implementation', async () => {
  const scanned = moduleImportSpecifiers(await readFile(path.join(repositoryRoot, 'src/v03-wire.mjs'), 'utf8'));
  assert.deepEqual(scanned.staticSpecifiers, ['node:crypto', 'canonicalize']);
  assert.deepEqual(scanned.dynamicSpecifiers, []);
});

test('tree closure binds symlink targets as well as regular bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-benchmark-tree-'));
  try {
    await writeFile(path.join(root, 'value.txt'), 'value\n');
    await symlink('value.txt', path.join(root, 'link.txt'));
    const first = await digestTreeClosure(root);
    await rm(path.join(root, 'link.txt'));
    await symlink('./value.txt', path.join(root, 'link.txt'));
    const second = await digestTreeClosure(root);
    assert.notEqual(first.aggregateSha256, second.aggregateSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host and artifact factory use identical code-unit tree ordering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-benchmark-order-'));
  try {
    for (const relative of ['.bin/tool', '@scope/pkg', 'Alpha', 'a-b', 'a_b', 'zeta']) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), `${relative}\n`);
    }
    await symlink('../Alpha', path.join(root, '.bin/alpha-link'));
    const host = await digestTreeClosure(root);
    const factory = await factoryDigestTree(root);
    assert.equal(factory.aggregateSha256, host.aggregateSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fixture lock is a deterministic transitive slice of the pinned target graph', () => {
  const targetLock = {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: true },
    importers: { '.': { devDependencies: {
      'fake-indexeddb': { specifier: '^6.2.2', version: '6.2.5' },
      jsdom: { specifier: '^29.1.1', version: '29.1.1' },
    } } },
    packages: {
      'fake-indexeddb@6.2.5': { resolution: { integrity: 'sha512-fake' } },
      'jsdom@29.1.1': { resolution: { integrity: 'sha512-jsdom' } },
      'transitive@1.0.0': { resolution: { integrity: 'sha512-transitive' } },
      'unrelated@9.0.0': { resolution: { integrity: 'sha512-unrelated' } },
    },
    snapshots: {
      'fake-indexeddb@6.2.5': {},
      'jsdom@29.1.1': { dependencies: { transitive: '1.0.0' } },
      'transitive@1.0.0': {},
      'unrelated@9.0.0': {},
    },
  };
  const sliced = deriveFixtureLock(targetLock, { 'fake-indexeddb': '^6.2.2', jsdom: '^29.1.1' });
  assert.deepEqual(Object.keys(sliced.packages), ['fake-indexeddb@6.2.5', 'jsdom@29.1.1', 'transitive@1.0.0']);
  assert.deepEqual(Object.keys(sliced.snapshots), ['fake-indexeddb@6.2.5', 'jsdom@29.1.1', 'transitive@1.0.0']);
  assert.equal(sliced.packages['unrelated@9.0.0'], undefined);
});

test('artifact factory binds its YAML parser to the pinned target lock entry', async () => {
  const integrity = 'sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==';
  const lock = `lockfileVersion: '9.0'\n\npackages:\n\n  yaml@2.9.0:\n    resolution: {integrity: ${integrity}}\n`;
  assert.deepEqual(assertPinnedYamlLockEntry(lock), { version: '2.9.0', integrity });
  assert.throws(() => assertPinnedYamlLockEntry(lock.replace('2.9.0', '2.8.0')), /integrity changed/u);
  assert.throws(() => assertPinnedYamlLockEntry(lock.replace(integrity, 'sha512-forged')), /integrity changed/u);

  const materializer = await readFile(path.join(repositoryRoot, 'harness-v0.3/benchmark-build/materialize-artifacts.mjs'), 'utf8');
  assert.match(materializer, /const viteEntry = targetRequire\.resolve\('vite'\)/u);
  assert.match(materializer, /const viteRequire = createRequire\(viteEntry\)/u);
  assert.match(materializer, /const yamlEntry = viteRequire\.resolve\('yaml'\)/u);
  assert.doesNotMatch(materializer, /targetRequire\('yaml'\)/u);
});

test('preparation ledger charges before attempts and stops at the first failure', () => {
  const ledger = createPreparationLedger(1000);
  chargePreparation(ledger, 'builds', 1000);
  chargePreparation(ledger, 'inspects', 2000);
  chargePreparation(ledger, 'probeContainers', 3000);
  stopPreparationOnFailure(ledger, 'docker-build-failed');
  assert.deepEqual(publicPreparationLedger(ledger, 4000), {
    schemaVersion: 'bug-dreamer/v03-benchmark-preparation/v1',
    builds: 1,
    inspects: 1,
    probeContainers: 1,
    failures: 1,
    cleanups: 0,
    cleanupFailures: 0,
    elapsedSeconds: 3,
    stoppedBy: 'docker-build-failed',
  });
  assert.throws(() => chargePreparation(ledger, 'builds', 4000), /already stopped/u);
  chargePreparation(ledger, 'cleanups', 7_300_000);
  assert.equal(ledger.cleanups, 1);
});

test('preparation ledger reserves two builds and never spends them as retries', () => {
  const ledger = createPreparationLedger(0);
  for (let index = 0; index < 22; index += 1) chargePreparation(ledger, 'builds', index);
  assert.equal(ledger.builds, 22);
  // The orchestrator's plan is capped at 22. The approved ceiling remains independently enforced at 24.
  chargePreparation(ledger, 'builds', 23);
  chargePreparation(ledger, 'builds', 24);
  assert.throws(() => chargePreparation(ledger, 'builds', 25), /build budget exhausted/u);
});

test('bounded command terminates on deadline and output overflow', async () => {
  const timeout = await runBoundedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 25, maxOutputBytes: 1024 });
  assert.equal(timeout.timedOut, true);
  const overflow = await runBoundedCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], { timeoutMs: 1000, maxOutputBytes: 1024 });
  assert.equal(overflow.outputTruncated, true);
  assert.ok(Buffer.byteLength(overflow.stdout) <= 1024);
});

test('three synthetic smoke envelopes are clean-only, development-only, and exact', async () => {
  const smokes = await Promise.all(['tx', 'local-first', 'prepaint'].map(async (moduleId) => validateSyntheticSmokeEnvelope(
    JSON.parse(await readFile(path.join(repositoryRoot, `contracts/v0.3/benchmark-smoke-${moduleId}.json`), 'utf8')),
  )));
  assert.deepEqual(smokes.map((smoke) => smoke.moduleId), ['tx', 'local-first', 'prepaint']);
  assert.equal(smokes.reduce((total, smoke) => total + smoke.preparationProbeRuns, 0), 6);
  assert.ok(smokes.every((smoke) => smoke.artifactRole === 'clean'
    && smoke.developmentOnly === true
    && smoke.measurementEligible === false
    && smoke.historicalTruthId === null
    && Object.keys(smoke.expectedClean).sort().join(',') === 'execution,observedFields,observedKind'));
});

test('synthetic smoke inputs project host image identity and rebind only fixture provenance', async () => {
  const descriptors = new Map([
    ['tx', txDescriptor],
    ['local-first', localDescriptor],
    ['prepaint', prepaintDescriptor],
  ]);
  const artifact = {
    role: 'clean',
    targetArtifactDigest: '1'.repeat(64),
    evaluationContractKey: '2'.repeat(64),
    imageId: `sha256:${'3'.repeat(64)}`,
  };
  for (const moduleId of ['tx', 'local-first', 'prepaint']) {
    const smoke = validateSyntheticSmokeEnvelope(JSON.parse(await readFile(path.join(repositoryRoot, `contracts/v0.3/benchmark-smoke-${moduleId}.json`), 'utf8')));
    const original = structuredClone(smoke.comparisonInput);
    const inputs = syntheticSmokeInputs(smoke, descriptors.get(moduleId), artifact);
    assert.deepEqual(Object.keys(inputs.direct.artifact).sort(), ['evaluationContractKey', 'role', 'targetArtifactDigest']);
    assert.deepEqual(inputs.interpreter.artifact, inputs.direct.artifact);
    assert.deepEqual(smoke.comparisonInput, original);
    if (moduleId === 'tx') {
      assert.ok(inputs.direct.row.comparisonInput.fixtureSetup.every((fixture) => fixture.producerArtifact.targetArtifactDigest === artifact.targetArtifactDigest));
      assert.equal(original.fixtureSetup[0].producerArtifact.targetArtifactDigest === artifact.targetArtifactDigest, false);
    }
  }
});

test('Docker preparation is build-only and final images exclude target source', async () => {
  const [factory, final, materializer, orchestrator] = await Promise.all([
    readFile(path.join(repositoryRoot, 'docker-v0.3/Dockerfile.benchmark-artifacts'), 'utf8'),
    readFile(path.join(repositoryRoot, 'docker-v0.3/Dockerfile.benchmark'), 'utf8'),
    readFile(path.join(repositoryRoot, 'harness-v0.3/benchmark-build/materialize-artifacts.mjs'), 'utf8'),
    readFile(path.join(repositoryRoot, 'scripts/prepare-v03-benchmark.mjs'), 'utf8'),
  ]);
  assert.match(factory, /RUN pnpm install --frozen-lockfile/u);
  assert.doesNotMatch(factory, /\b(?:test|vitest|run-scenario|run-batch)\b/u);
  assert.doesNotMatch(final, /COPY target\//u);
  assert.match(final, /COPY fixture-tools\/ \/fixture-tools\//u);
  assert.match(final, /RUN node \/harness\/verify-image\.mjs/u);
  assert.match(materializer, /'--offline', '--frozen-lockfile'/u);
  assert.match(orchestrator, /ledger\.builds !== 22/u);
  assert.match(orchestrator, /ledger\.inspects \+ ledger\.probeContainers !== 50/u);
  assert.match(orchestrator, /'docker', \['create'/u);
  assert.match(orchestrator, /'docker', \['cp'/u);
  assert.match(orchestrator, /artifactFactoryImageId/u);
  assert.match(orchestrator, /'src\/v03-benchmark-preparation\.mjs'/u);
  assert.match(orchestrator, /createIsolatedBenchmarkCaseRunner/u);
  assert.match(orchestrator, /for \(const executionPath of \['comparison', 'interpreter'\]\)/u);
  assert.match(orchestrator, /artifact = \{ role: 'clean'/u);
  assert.match(orchestrator, /\.\.\.smokePaths/u);
  assert.match(orchestrator, /\.\.\.frozenExecutionPaths/u);
  assert.match(orchestrator, /partialEvidence\.syntheticSmoke\.results = smokeResults/u);
  assert.match(orchestrator, /bytesBase64: executed\.channel\.resultBytes/u);
  assert.match(orchestrator, /status: 'stopped'.*\.\.\.partialEvidence/su);
  assert.doesNotMatch(orchestrator, /retry/u);
});
