import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildExactReplayArgs, classifyImageInspection } from '../scripts/replay-v02-frozen.mjs';
import {
  HistoryValidationError,
  extractLocalImports,
  parseDockerCopySources,
  partitionPaths,
  readJsonPointer,
  replayStatus,
  sha256,
  targetArchiveTree,
  unregisteredLegacyPaths,
  validateAudit,
  validateDirectoryChain,
  validateHistory,
  validateImages,
  validateRecordedReplayResult,
  validateRegistrationTemplateShape,
} from '../src/v03-history.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));
}

test('validates the current v0.2 history ledger and path universe', async () => {
  const result = await validateHistory(repositoryRoot);
  assert.deepEqual(result.pathCounts, {
    frozenRuntimeInputs: 152,
    frozenHistoricalOutputs: 39,
    baselineSnapshotOnly: 22,
  });
  assert.equal(result.nightmareCount, 7);
  assert.equal(result.imageCount, 4);
});

test('partitions an empty baseline universe', () => {
  const manifest = {
    frozenRuntimeInputs: { explicitPaths: [], prefixes: [], excludePaths: [] },
    frozenHistoricalOutputs: { explicitPaths: [], prefixes: [], excludePaths: [] },
  };
  assert.deepEqual(partitionPaths([], manifest), { runtime: [], historical: [], snapshot: [] });
});

test('rejects a path assigned to both frozen sets', () => {
  const manifest = {
    frozenRuntimeInputs: { explicitPaths: ['same'], prefixes: [], excludePaths: [] },
    frozenHistoricalOutputs: { explicitPaths: ['same'], prefixes: [], excludePaths: [] },
  };
  assert.throws(() => partitionPaths(['same'], manifest), HistoryValidationError);
});

test('extracts relative static imports only', () => {
  const source = "import './side.mjs';\nimport { value } from '../value.mjs';\nimport fs from 'node:fs';\n";
  assert.deepEqual(extractLocalImports(source).sort(), ['../value.mjs', './side.mjs']);
});

test('extracts Docker COPY sources without destinations', () => {
  const source = 'COPY target/ ./\nCOPY --chown=1000 harness other /workspace\n';
  assert.deepEqual(parseDockerCopySources(source), ['target/', 'harness', 'other']);
});

test('reads array positions through JSON pointers and rejects a missing pointer', () => {
  const value = { results: [{ ok: false }] };
  assert.equal(readJsonPointer(value, '/results/0/ok'), false);
  assert.throws(() => readJsonPointer(value, '/results/1'), HistoryValidationError);
});

test('builds frozen replay arguments with the exact image ID', () => {
  const image = {
    module: 'packages/tx',
    tag: 'mutable:tag',
    imageId: `sha256:${'a'.repeat(64)}`,
  };
  const args = buildExactReplayArgs({
    scenarioPath: '/tmp/scenario.test.ts',
    containerName: 'replay-test',
    image,
  });
  assert.equal(args.at(-1), image.imageId);
  assert.equal(args.includes(image.tag), false);
});

test('distinguishes a missing image from a Docker permission failure', () => {
  assert.equal(classifyImageInspection({ exitCode: 1, stdout: '[]', stderr: 'No such image: missing' }), false);
  assert.throws(
    () => classifyImageInspection({ exitCode: 1, stdout: '', stderr: 'permission denied while connecting to the Docker socket' }),
    /Docker image inspection failed/,
  );
});

test('keeps a replay mismatch as an auditable result state', () => {
  assert.equal(replayStatus([{ status: 'pass' }, { status: 'mismatch' }]), 'mismatch');
});

test('rejects a replay result reference for a different scenario', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-replay-test-'));
  try {
    const recorded = {
      schemaVersion: 'bug-dreamer/v02-replay-result/v1',
      results: [{
        id: 'case-1',
        historicalImageId: `sha256:${'a'.repeat(64)}`,
        executedImageId: `sha256:${'a'.repeat(64)}`,
        replayKind: 'exact-image-id',
        scenario: 'different.test.ts',
        status: 'pass',
      }],
    };
    const bytes = `${JSON.stringify(recorded)}\n`;
    await writeFile(path.join(temporaryRoot, 'result.json'), bytes);
    const image = {
      id: 'image-1',
      imageId: `sha256:${'a'.repeat(64)}`,
      replay: { resultRef: { path: 'result.json', sha256: sha256(bytes) } },
    };
    const live = [{ ...recorded.results[0], scenario: 'expected.test.ts' }];
    await assert.rejects(validateRecordedReplayResult(temporaryRoot, image, live), /differs from the live replay/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects a symlink in a frozen path directory chain', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-symlink-test-'));
  try {
    await mkdir(path.join(temporaryRoot, 'real-harness'));
    await symlink(path.join(temporaryRoot, 'real-harness'), path.join(temporaryRoot, 'harness'), 'dir');
    await assert.rejects(validateDirectoryChain(temporaryRoot, 'harness/entrypoint.mjs'), /not a real directory/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects a primary evidence pointer that covers multiple scenarios', async () => {
  const [manifest, audit, images] = await Promise.all([
    readJson('history/v0.2-manifest.json'),
    readJson('history/v0.2-audit.json'),
    readJson('history/v0.2-images.json'),
  ]);
  audit.records[3].evidenceRefs[0].jsonPointer = '/batch';
  await assert.rejects(validateAudit(repositoryRoot, manifest, audit, images), /broader than the scenario hash/);
});

test('rejects an independent reproduction pointer for a different scenario', async () => {
  const [manifest, audit, images] = await Promise.all([
    readJson('history/v0.2-manifest.json'),
    readJson('history/v0.2-audit.json'),
    readJson('history/v0.2-images.json'),
  ]);
  audit.records[2].independentReproductionRefs[0].jsonPointer = '/results/1';
  await assert.rejects(validateAudit(repositoryRoot, manifest, audit, images), /Independent reproduction command mismatch/);
});

test('finds files added outside the frozen legacy path universe', () => {
  const frozenPaths = new Set(['harness/existing.mjs']);
  assert.deepEqual(unregisteredLegacyPaths(['harness/existing.mjs', 'harness/new.mjs'], frozenPaths), ['harness/new.mjs']);
});

test('recomputes the pinned target archive tree digest from captured entries', async () => {
  const [snapshot, paths] = await Promise.all([
    readJson('history/firsttx-v0.2-tree.json'),
    readJson('history/v0.2-paths.json'),
  ]);
  const contract = paths.frozenRuntimeInputs.dockerBuildContract;
  const archivePaths = [...contract.targetArchiveCommonPaths, contract.targetArchiveModulePaths['packages/tx']];
  const expected = targetArchiveTree(snapshot.entries, archivePaths);
  assert.equal(expected.entries.length, contract.targetArchiveTrees['packages/tx'].pathCount);
  assert.equal(expected.sha256, contract.targetArchiveTrees['packages/tx'].gitLsTreeSha256);
  const changed = structuredClone(snapshot.entries);
  changed.find((entry) => archivePaths.some((archivePath) => entry.path === archivePath || entry.path.startsWith(`${archivePath}/`))).oid = '0'.repeat(40);
  assert.notEqual(targetArchiveTree(changed, archivePaths).sha256, expected.sha256);
});

test('rejects incomplete archive identity metadata', async () => {
  const [manifest, images] = await Promise.all([
    readJson('history/v0.2-manifest.json'),
    readJson('history/v0.2-images.json'),
  ]);
  const image = images.images[0];
  image.preservation.status = 'exact-replayable';
  image.archive = {
    verified: true,
    locator: 'artifact://archive',
    sha256: 'a'.repeat(64),
    byteLength: 1,
    restoredImageId: image.imageId,
  };
  image.ociDigest = `sha256:${'b'.repeat(64)}`;
  image.platform = null;
  await assert.rejects(validateImages(repositoryRoot, manifest, images), /platform identity is incomplete/);
});

test('rejects benchmark registration policy before its checkpoint', async () => {
  const registration = await readJson('benchmark/v0.3/registration.template.json');
  registration.budgets = { modelCalls: 1 };
  assert.throws(() => validateRegistrationTemplateShape(registration), /cannot claim benchmark policy values/);
});

test('rejects unknown benchmark registration fields', async () => {
  const registration = await readJson('benchmark/v0.3/registration.template.json');
  registration.unregisteredFinalVerdict = 'pass';
  assert.throws(() => validateRegistrationTemplateShape(registration), /fields changed/);
});

test('returns exit 2 for an unknown validator subcommand', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'unknown'], { cwd: repositoryRoot }),
    (error) => error.code === 2 && error.stderr.includes('Usage:'),
  );
});

test('returns exit 1 instead of succeeding for a later unimplemented phase', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/validate-v03.mjs', 'benchmark'], { cwd: repositoryRoot }),
    (error) => error.code === 1 && error.stderr.includes('not implemented yet'),
  );
});
