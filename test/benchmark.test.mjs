import assert from 'node:assert/strict';
import test from 'node:test';

import { applyEdit, benchImageTagFor, loadManifest, resolveDefect } from '../src/benchmark.mjs';
import { TARGET_REVISION } from '../src/constants.mjs';

test('applies an edit that matches exactly once', () => {
  const edited = applyEdit('const a = 1;\nconst b = 2;\n', {
    file: 'sample.ts',
    find: 'const b = 2;',
    replace: 'const b = 3;',
  });

  assert.equal(edited, 'const a = 1;\nconst b = 3;\n');
});

test('rejects an edit that matches zero times', () => {
  assert.throws(
    () => applyEdit('const a = 1;', { file: 'sample.ts', find: 'missing', replace: 'x' }),
    /matched 0 times/u,
  );
});

test('rejects an edit that matches more than once', () => {
  assert.throws(
    () => applyEdit('x x', { file: 'sample.ts', find: 'x', replace: 'y' }),
    /matched 2 times/u,
  );
});

test('rejects an edit on empty source', () => {
  assert.throws(
    () => applyEdit('', { file: 'sample.ts', find: 'x', replace: 'y' }),
    /matched 0 times/u,
  );
});

test('loads the manifest and resolves planted defects', async () => {
  const manifest = await loadManifest();

  assert.equal(manifest.target_revision, TARGET_REVISION);
  for (const defect of manifest.defects) {
    const resolved = resolveDefect(manifest, defect.id);
    assert.equal(resolved.id, defect.id);
    assert.ok(resolved.edits.length > 0);
    for (const edit of resolved.edits) {
      assert.ok(resolved.module && edit.file.startsWith(resolved.module));
    }
  }
});

test('rejects an unknown defect id', async () => {
  const manifest = await loadManifest();

  assert.throws(() => resolveDefect(manifest, 'no-such-defect'), /not in the benchmark manifest/u);
});

test('builds a distinct bench image tag per defect', () => {
  assert.equal(
    benchImageTagFor('tx-rollback-forward-order'),
    `bug-dreamer/firsttx:bench-${TARGET_REVISION.slice(0, 12)}-tx-rollback-forward-order`,
  );
});
