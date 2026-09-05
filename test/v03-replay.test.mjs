import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PathContainmentError } from '../src/v03-paths.mjs';
import { ReplayValidationError, validateSpikeReplay } from '../src/v03-replay-validation.mjs';
import { TrustValidationError, validateTrustContracts } from '../src/v03-trust-validation.mjs';

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

async function mirroredRoot(mutate, evidencePath) {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-replay-'));
  for (const name of await readdir(repositoryRoot)) {
    if (name === 'evidence') continue;
    await symlink(path.join(repositoryRoot, name), path.join(root, name));
  }
  await mirrorDirectory('evidence', root, 'v0.3');
  await mirrorDirectory('evidence/v0.3', root, path.basename(evidencePath));
  const evidence = JSON.parse(await readFile(path.join(repositoryRoot, evidencePath), 'utf8'));
  mutate(evidence);
  await writeFile(path.join(root, evidencePath), `${JSON.stringify(evidence, null, 2)}\n`);
  return root;
}

async function withMirroredRoot(mutate, run, evidencePath = SPIKE_EVIDENCE) {
  const root = await mirroredRoot(mutate, evidencePath);
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function rejectsReplay(mutate, expected = ReplayValidationError) {
  await withMirroredRoot(mutate, async (root) => {
    await assert.rejects(validateSpikeReplay(root), expected);
  });
}

test('accepts the recorded spike evidence through the mirrored repository root', async () => {
  await withMirroredRoot(() => {}, async (root) => {
    const { reduction, ...spike } = await validateSpikeReplay(root);
    assert.deepEqual(spike, {
      verdict: 'adopt',
      adoptedOperatorId: 'time.advance/v1',
      armCount: 3,
      baselineRunCount: 6,
      evaluatedSpecs: { baseline: 7, operator: 10 },
      defectId: 'tx-total-timeout-resets-per-step',
    });
    assert.equal(reduction.status, 'one-minimal');
    assert.equal(reduction.actionCount, 3);
    assert.equal(reduction.evaluations, 7);
    assert.equal(reduction.acceptedRemovals, 0);
  });
});

for (const [name, mutate] of [
  ['missing structural attempt', (evidence) => evidence.result.attempts.pop()],
  ['reordered attempts', (evidence) => evidence.result.attempts.reverse()],
  ['forged dependency closure', (evidence) => { evidence.result.attempts[0].removed.actions = []; }],
  ['changed final input', (evidence) => { evidence.result.final.input.seed.actors.push('forged'); }],
  ['missing replay', (evidence) => evidence.result.runs.pop()],
  ['extra replay', (evidence) => evidence.result.runs.push(structuredClone(evidence.result.runs.at(-1)))],
  ['wrong artifact binding', (evidence) => { evidence.result.runs[0].artifact = 'clean'; }],
  ['malformed replay payload', (evidence) => { evidence.result.runs.at(-1).record.rawResult = '{}'; }],
  ['changed image identity', (evidence) => { evidence.bindings.images.defect.imageId = `sha256:${'f'.repeat(64)}`; }],
  ['changed host source digest', (evidence) => { evidence.bindings.sources[0].sha256 = 'f'.repeat(64); }],
  ['blocked minimization', (evidence) => { evidence.result.status = 'reduced-not-one-minimal'; }],
]) {
  test(`replay rejects reduction evidence with ${name}`, async () => {
    await withMirroredRoot(mutate, async (root) => {
      await assert.rejects(validateSpikeReplay(root), ReplayValidationError);
    }, 'evidence/v0.3/phase3-reduction.json');
  });
}

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

test('trust rejects unmarked output overflow even when the recorded verdict passes', async () => {
  await withMirroredRoot((evidence) => {
    const run = evidence.cases.find((item) => item.id === 'pass');
    run.stdoutBytes = 1048577;
  }, async (root) => {
    await assert.rejects(validateTrustContracts(root), TrustValidationError);
  }, 'evidence/v0.3/phase2-trust.json');
});

test('trust rejects a malformed exit code even when timeout overrides classification', async () => {
  await withMirroredRoot((evidence) => {
    evidence.cases.find((item) => item.id === 'timeout').exitCode = '137';
  }, async (root) => {
    await assert.rejects(validateTrustContracts(root), TrustValidationError);
  }, 'evidence/v0.3/phase2-trust.json');
});

test('rejects a defect consumer lockfile digest that does not match the reconstruction', async () => {
  await rejectsReplay((evidence) => {
    evidence.defectConsumerLockfile.sha256 = 'f'.repeat(64);
  });
});

test('rejects a defect consumer lockfile change outside the target tarball entry', async () => {
  const registeredLockfile = await readFile(path.join(repositoryRoot, 'registrations/v0.3/consumer-lock.yaml'), 'utf8');
  const lines = registeredLockfile.split('\n');
  let thirdPartyLine = 0;
  let header = '';
  for (const [index, line] of lines.entries()) {
    if (/^ {2}\S/u.test(line)) header = line;
    else if (/^ {4}resolution: \{integrity: sha512-/u.test(line) && !header.includes('@firsttx/')) {
      thirdPartyLine = index + 1;
      break;
    }
  }
  assert.ok(thirdPartyLine > 0, 'expected a third-party resolution line in the registered lockfile');
  await rejectsReplay((evidence) => {
    evidence.defectConsumerLockfile.changedIntegrity.line = thirdPartyLine;
  });
});

test('rejects a tampered defect integrity value', async () => {
  await rejectsReplay((evidence) => {
    const { changedIntegrity } = evidence.defectConsumerLockfile;
    changedIntegrity.defect = `sha512-${'A'.repeat(86)}==`;
  });
});

test('rejects a tampered defect evaluator canonicalizer aggregate', async () => {
  await rejectsReplay((evidence) => {
    evidence.defectBuildInputs.canonicalizer.aggregateSha256 = 'f'.repeat(64);
  });
});

test('rejects a tampered defect evaluator canonicalizer lockfile integrity', async () => {
  await rejectsReplay((evidence) => {
    evidence.defectBuildInputs.canonicalizer.integritySha512 = 'sha512-forged';
  });
});

test('rejects canonicalizer package bytes that differ from the recorded defect evaluator input', async () => {
  const root = await mirroredRoot(() => {}, SPIKE_EVIDENCE);
  try {
    await rm(path.join(root, 'node_modules'), { force: true });
    const canonicalizeRoot = path.join(root, 'node_modules/canonicalize');
    const installedCanonicalizeRoot = await realpath(path.join(repositoryRoot, 'node_modules/canonicalize'));
    await cp(installedCanonicalizeRoot, canonicalizeRoot, { recursive: true });
    const implementationPath = path.join(canonicalizeRoot, 'lib/canonicalize.js');
    await writeFile(implementationPath, `${await readFile(implementationPath, 'utf8')}\n// tampered\n`);
    await assert.rejects(validateSpikeReplay(root), ReplayValidationError);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('rejects an evidence path that escapes the repository root', async () => {
  await rejectsReplay((evidence) => {
    evidence.phase1Evidence.path = '../../outside.json';
  }, PathContainmentError);
});
