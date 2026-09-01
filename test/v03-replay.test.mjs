import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PathContainmentError } from '../src/v03-paths.mjs';
import { ReplayValidationError, validateSpikeReplay } from '../src/v03-replay-validation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPIKE_EVIDENCE = 'evidence/v0.3/phase3-spike.json';

async function mirrorDirectory(relativeDirectory, targetRoot, skip) {
  const source = path.join(repositoryRoot, relativeDirectory);
  const destination = path.join(targetRoot, relativeDirectory);
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    if (name === skip) continue;
    await symlink(path.join(source, name), path.join(destination, name));
  }
}

async function mirroredRoot(mutate) {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-replay-'));
  for (const name of await readdir(repositoryRoot)) {
    if (name === 'evidence') continue;
    await symlink(path.join(repositoryRoot, name), path.join(root, name));
  }
  await mirrorDirectory('evidence', root, 'v0.3');
  await mirrorDirectory('evidence/v0.3', root, 'phase3-spike.json');
  const evidence = JSON.parse(await readFile(path.join(repositoryRoot, SPIKE_EVIDENCE), 'utf8'));
  mutate(evidence);
  await writeFile(path.join(root, SPIKE_EVIDENCE), `${JSON.stringify(evidence, null, 2)}\n`);
  return root;
}

async function withMirroredRoot(mutate, run) {
  const root = await mirroredRoot(mutate);
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejectsReplay(mutate, expected = ReplayValidationError) {
  await withMirroredRoot(mutate, async (root) => {
    await assert.rejects(validateSpikeReplay(root), expected);
  });
}

test('accepts the recorded spike evidence through the mirrored repository root', async () => {
  await withMirroredRoot(() => {}, async (root) => {
    assert.deepEqual(await validateSpikeReplay(root), {
      verdict: 'adopt',
      adoptedOperatorId: 'time.advance/v1',
      armCount: 3,
      baselineRunCount: 6,
      evaluatedSpecs: { baseline: 7, operator: 11 },
      defectId: 'tx-total-timeout-resets-per-step',
    });
  });
});

test('rejects a baseline run that records no result file', async () => {
  await rejectsReplay((evidence) => {
    evidence.baseline.identityRuns[0].run.resultEntries = [];
  });
});

test('rejects a result entry that is not a regular file', async () => {
  await rejectsReplay((evidence) => {
    evidence.arms[0].cleanRun.resultEntries[0].type = 'symbolic-link';
  });
});

test('rejects a result entry whose size disagrees with the raw result', async () => {
  await rejectsReplay((evidence) => {
    evidence.arms[0].defectRun.resultEntries[0].size += 1;
  });
});

test('rejects an overflowing byte count that is not marked truncated', async () => {
  await rejectsReplay((evidence) => {
    evidence.baseline.identityRuns[0].run.stdoutBytes = 1048577;
  });
});

test('rejects an unknown run record field', async () => {
  await rejectsReplay((evidence) => {
    evidence.arms[0].repeatRuns[0].containerId = 'extra';
  });
});

test('rejects a missing run record field', async () => {
  await rejectsReplay((evidence) => {
    delete evidence.baseline.identityRuns[1].run.stderrBytes;
  });
});

test('rejects a run that reports both a timeout and a truncation', async () => {
  await rejectsReplay((evidence) => {
    const { run } = evidence.baseline.identityRuns[2];
    run.timedOut = true;
    run.outputTruncated = true;
  });
});

test('rejects an evidence path that escapes the repository root', async () => {
  await rejectsReplay((evidence) => {
    evidence.phase1Evidence.path = '../../outside.json';
  }, PathContainmentError);
});
