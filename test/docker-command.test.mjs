import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDockerRunArgs } from '../src/docker-command.mjs';
import { imageTagFor } from '../src/modules.mjs';

const baseInput = {
  scenarioPath: '/tmp/scenario.test.ts',
  containerName: 'bug-dreamer-test',
  moduleDir: 'packages/tx',
  imageTag: imageTagFor('packages/tx'),
};

test('builds a fixed isolated Docker invocation', () => {
  const args = buildDockerRunArgs(baseInput);

  assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--name', 'bug-dreamer-test']);
  assert.ok(args.includes('none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('512m'));
  assert.ok(args.includes('64'));
  assert.ok(args.some((value) => value.includes('packages/tx/node_modules/.vite-temp')));
  assert.ok(args.some((value) => value.includes('size=16m')));
  assert.ok(args.some((value) => value.includes('uid=1000,gid=1000')));
  assert.ok(args.some((value) => value.includes('packages/tx/.bug-dreamer/generated.test.ts')));
  assert.equal(args.at(-1), imageTagFor('packages/tx'));
  assert.equal(args.some((value) => value === '--privileged'), false);
});

test('mounts scenario and tmpfs under the requested module', () => {
  const args = buildDockerRunArgs({
    ...baseInput,
    moduleDir: 'packages/local-first',
    imageTag: imageTagFor('packages/local-first'),
  });

  assert.ok(args.some((value) => value.includes('packages/local-first/node_modules/.vite-temp')));
  assert.ok(
    args.some((value) => value.includes('packages/local-first/.bug-dreamer/generated.test.ts')),
  );
  assert.equal(args.at(-1), imageTagFor('packages/local-first'));
  assert.equal(args.some((value) => value.includes('packages/tx')), false);
});

test('rejects an ambiguous mount path', () => {
  assert.throws(
    () =>
      buildDockerRunArgs({
        ...baseInput,
        scenarioPath: '/tmp/scenario,other.test.ts',
      }),
    /commas/u,
  );
});
