import assert from 'node:assert/strict';
import test from 'node:test';

import { IMAGE_TAG, TARGET_ARCHIVE_PATHS } from '../src/constants.mjs';
import { buildDockerRunArgs } from '../src/docker-command.mjs';

test('builds a fixed isolated Docker invocation', () => {
  const args = buildDockerRunArgs({
    scenarioPath: '/tmp/scenario.test.ts',
    containerName: 'bug-dreamer-test',
  });

  assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--name', 'bug-dreamer-test']);
  assert.ok(args.includes('none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('512m'));
  assert.ok(args.includes('64'));
  assert.ok(args.some((value) => value.includes('node_modules/.vite-temp')));
  assert.ok(args.some((value) => value.includes('size=16m')));
  assert.ok(args.some((value) => value.includes('uid=1000,gid=1000')));
  assert.ok(args.some((value) => value.includes('.bug-dreamer/generated.test.ts')));
  assert.equal(args.at(-1), IMAGE_TAG);
  assert.equal(args.some((value) => value === '--privileged'), false);
});

test('rejects an ambiguous mount path', () => {
  assert.throws(
    () =>
      buildDockerRunArgs({
        scenarioPath: '/tmp/scenario,other.test.ts',
        containerName: 'bug-dreamer-test',
      }),
    /commas/u,
  );
});

test('archives only the target workspace files required by the runner', () => {
  assert.deepEqual(TARGET_ARCHIVE_PATHS, [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'packages/shared',
    'packages/tx',
  ]);
  assert.equal(TARGET_ARCHIVE_PATHS.some((value) => value.includes('.env')), false);
});
