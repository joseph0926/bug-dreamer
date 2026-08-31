import assert from 'node:assert/strict';
import test from 'node:test';

import { relativeScenarioPath } from '../src/scenario-file.mjs';

test('returns a repository-relative scenario path', () => {
  assert.equal(
    relativeScenarioPath('/workspace/bug-dreamer', '/workspace/bug-dreamer/scenarios/pass.test.ts'),
    'scenarios/pass.test.ts',
  );
});

test('rejects a scenario outside the repository', () => {
  assert.throws(
    () => relativeScenarioPath('/workspace/bug-dreamer', '/workspace/private.test.ts'),
    /inside the Bug Dreamer repository/u,
  );
});

test('rejects the repository root as a scenario', () => {
  assert.throws(
    () => relativeScenarioPath('/workspace/bug-dreamer', '/workspace/bug-dreamer'),
    /inside the Bug Dreamer repository/u,
  );
});
