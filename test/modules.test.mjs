import assert from 'node:assert/strict';
import test from 'node:test';

import { TARGET_REVISION } from '../src/constants.mjs';
import { DEFAULT_MODULE, MODULES, imageTagFor, resolveModule } from '../src/modules.mjs';

test('resolves the default tx module contract', () => {
  const module = resolveModule(DEFAULT_MODULE);

  assert.equal(module.module, 'packages/tx');
  assert.equal(module.filter, '@firsttx/tx');
  assert.deepEqual(module.buildFilters, ['@firsttx/shared']);
  assert.ok(module.archivePaths.includes('packages/tx'));
  assert.ok(module.archivePaths.includes('pnpm-lock.yaml'));
});

test('resolves the local-first module contract', () => {
  const module = resolveModule('packages/local-first');

  assert.equal(module.filter, '@firsttx/local-first');
  assert.ok(module.archivePaths.includes('packages/local-first'));
  assert.equal(module.archivePaths.includes('packages/tx'), false);
});

test('rejects an unregistered module', () => {
  assert.throws(() => resolveModule('packages/devtools'), /no registered execution contract/u);
});

test('rejects an empty module name', () => {
  assert.throws(() => resolveModule(''), /no registered execution contract/u);
});

test('keeps the v0.1 tx image tag unchanged', () => {
  assert.equal(
    imageTagFor('packages/tx'),
    `bug-dreamer/firsttx:v0.1-${TARGET_REVISION.slice(0, 12)}`,
  );
});

test('suffixes non-default module image tags', () => {
  assert.equal(
    imageTagFor('packages/local-first'),
    `bug-dreamer/firsttx:v0.1-${TARGET_REVISION.slice(0, 12)}-local-first`,
  );
});

test('archives no environment files for any module', () => {
  for (const definition of Object.values(MODULES)) {
    assert.equal(definition.archivePaths.some((value) => value.includes('.env')), false);
  }
});
