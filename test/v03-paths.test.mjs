import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PathContainmentError, assertNoSymlinkAncestors, resolveContainedPath } from '../src/v03-paths.mjs';

const root = '/repo/root';

test('resolves a contained relative path to an absolute path', () => {
  assert.equal(resolveContainedPath(root, 'evidence/v0.3/phase3-spike.json'), path.join(root, 'evidence/v0.3/phase3-spike.json'));
  assert.equal(resolveContainedPath(root, './contracts/v0.3/spec-cases.json'), path.join(root, 'contracts/v0.3/spec-cases.json'));
  assert.equal(resolveContainedPath(root, 'a/b/../c.json'), path.join(root, 'a/c.json'));
});

test('rejects an empty relative path', () => {
  assert.throws(() => resolveContainedPath(root, ''), PathContainmentError);
});

test('rejects a non-string relative path', () => {
  for (const value of [null, undefined, 0, false, [], {}]) {
    assert.throws(() => resolveContainedPath(root, value), PathContainmentError);
  }
});

test('rejects a parent traversal', () => {
  assert.throws(() => resolveContainedPath(root, '../outside.json'), PathContainmentError);
  assert.throws(() => resolveContainedPath(root, '..'), PathContainmentError);
});

test('rejects a nested parent traversal that escapes the root', () => {
  assert.throws(() => resolveContainedPath(root, 'evidence/../../outside.json'), PathContainmentError);
  assert.throws(() => resolveContainedPath(root, 'a/b/../../../c'), PathContainmentError);
});

test('rejects an absolute path', () => {
  assert.throws(() => resolveContainedPath(root, '/etc/passwd'), PathContainmentError);
});

test('rejects a NUL byte', () => {
  assert.throws(() => resolveContainedPath(root, 'evidence/\0.json'), PathContainmentError);
});

test('rejects a backslash separator', () => {
  assert.throws(() => resolveContainedPath(root, 'evidence\\v0.3\\spike.json'), PathContainmentError);
});

test('rejects a path that resolves to the root itself', () => {
  assert.throws(() => resolveContainedPath(root, '.'), PathContainmentError);
  assert.throws(() => resolveContainedPath(root, 'evidence/..'), PathContainmentError);
});

test('rejects an empty containment root', () => {
  assert.throws(() => resolveContainedPath('', 'evidence.json'), PathContainmentError);
});

test('accepts a symlink-free path and rejects symlinked ancestors and leaves', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'v03-paths-'));
  try {
    await mkdir(path.join(base, 'root/real/inner'), { recursive: true });
    await writeFile(path.join(base, 'root/real/inner/file.json'), '{}');
    await writeFile(path.join(base, 'outside.json'), '{}');
    await symlink(path.join(base, 'root/real'), path.join(base, 'root/linked'));
    await symlink(path.join(base, 'outside.json'), path.join(base, 'root/real/inner/leaf.json'));
    const repoRoot = path.join(base, 'root');

    assert.equal(
      await assertNoSymlinkAncestors(repoRoot, resolveContainedPath(repoRoot, 'real/inner/file.json')),
      path.join(repoRoot, 'real/inner/file.json'),
    );
    await assert.rejects(
      assertNoSymlinkAncestors(repoRoot, resolveContainedPath(repoRoot, 'linked/inner/file.json')),
      PathContainmentError,
    );
    await assert.rejects(
      assertNoSymlinkAncestors(repoRoot, resolveContainedPath(repoRoot, 'real/inner/leaf.json')),
      PathContainmentError,
    );
    await assert.rejects(assertNoSymlinkAncestors(repoRoot, repoRoot), PathContainmentError);
    await assert.rejects(assertNoSymlinkAncestors(repoRoot, path.join(base, 'outside.json')), PathContainmentError);
    await assert.rejects(assertNoSymlinkAncestors(repoRoot, 'real/inner/file.json'), PathContainmentError);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
