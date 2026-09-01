import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildExecutionPlan,
  buildNightmareSpec,
  loadPhase2Catalog,
  parseNightmareSeed,
} from '../src/v03-spec.mjs';
import { classifyTrustedResult, readTrustedResultChannel, validateTrustedResult } from '../src/v03-trust.mjs';
import { validateTrustContracts } from '../src/v03-trust-validation.mjs';
import { WIRE_LIMITS, parseJsonBytes } from '../src/v03-wire.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function evidence() {
  return JSON.parse(await readFile(path.join(repositoryRoot, 'evidence/v0.3/phase2-trust.json'), 'utf8'));
}

async function context(seedPath) {
  const { catalog } = await loadPhase2Catalog(repositoryRoot);
  const seed = parseNightmareSeed(await readFile(path.join(repositoryRoot, seedPath)), catalog);
  const spec = buildNightmareSpec(seed, catalog);
  const plan = buildExecutionPlan(spec, catalog);
  return { catalog, spec, plan };
}

test('validates all recorded isolated trust cases and their immutable inputs', async () => {
  const result = await validateTrustContracts(repositoryRoot);
  assert.equal(result.caseCount, 7);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.evaluatorErrorCount, 4);
});

test('accepts pass and candidate results only with a valid payload digest and identity', async () => {
  const receipt = await evidence();
  for (const caseId of ['pass', 'candidate']) {
    const recorded = receipt.cases.find((item) => item.id === caseId);
    const { catalog, spec, plan } = await context(recorded.seedPath);
    const result = validateTrustedResult(parseJsonBytes(recorded.rawResult), plan, spec, catalog);
    assert.equal(result.execution, caseId === 'pass' ? 'pass' : 'candidate-failure');
    assert.equal(result.violationIdentity === null, caseId === 'pass');
  }
});

test('marker-shaped seed data and stdout cannot change a passing trusted result', async () => {
  const receipt = await evidence();
  const recorded = receipt.cases.find((item) => item.id === 'marker-forgery');
  const { catalog, spec, plan } = await context(recorded.seedPath);
  assert.match(recorded.stdout, /BUG_DREAMER_RESULT/u);
  const classification = classifyTrustedResult({
    resultBytes: Buffer.from(recorded.rawResult),
    exitCode: recorded.exitCode,
    plan,
    spec,
    catalog,
  });
  assert.equal(classification.evaluator, 'evaluated');
  assert.equal(classification.execution.status, 'pass');
});

test('missing, malformed, duplicate-key, and wrong-digest results are infrastructure errors', async () => {
  const receipt = await evidence();
  const recorded = receipt.cases.find((item) => item.id === 'pass');
  const { catalog, spec, plan } = await context(recorded.seedPath);
  const inputs = [
    null,
    Buffer.from('{"schemaVersion":'),
    Buffer.from('{"schemaVersion":"a","schemaVersion":"b"}'),
  ];
  for (const resultBytes of inputs) {
    const classification = classifyTrustedResult({ resultBytes, exitCode: 0, plan, spec, catalog });
    assert.equal(classification.evaluator, 'evaluator-error');
    assert.deepEqual(classification.execution.status, 'unrunnable');
    assert.equal(classification.execution.kind, 'infrastructure');
  }

  const wrongDigest = receipt.cases.find((item) => item.id === 'wrong-digest');
  const classification = classifyTrustedResult({
    resultBytes: Buffer.from(wrongDigest.rawResult),
    exitCode: wrongDigest.exitCode,
    plan,
    spec,
    catalog,
  });
  assert.equal(classification.evaluator, 'evaluator-error');
  assert.match(classification.execution.reason, /payload digest mismatch/u);
});

test('rejects extra result fields and incomplete violation identities', async () => {
  const receipt = await evidence();
  const passRecord = receipt.cases.find((item) => item.id === 'pass');
  const passContext = await context(passRecord.seedPath);
  const extra = JSON.parse(passRecord.rawResult);
  extra.generatorVerdict = 'candidate-failure';
  const extraClassification = classifyTrustedResult({
    resultBytes: Buffer.from(JSON.stringify(extra)),
    exitCode: 0,
    ...passContext,
  });
  assert.equal(extraClassification.evaluator, 'evaluator-error');

  const candidateRecord = receipt.cases.find((item) => item.id === 'candidate');
  const candidateContext = await context(candidateRecord.seedPath);
  const incomplete = JSON.parse(candidateRecord.rawResult);
  delete incomplete.violationIdentity.targetArtifactDigest;
  const incompleteClassification = classifyTrustedResult({
    resultBytes: Buffer.from(JSON.stringify(incomplete)),
    exitCode: 0,
    ...candidateContext,
  });
  assert.equal(incompleteClassification.evaluator, 'evaluator-error');
});

test('an evaluator early exit cannot produce a candidate failure', async () => {
  const receipt = await evidence();
  const recorded = receipt.cases.find((item) => item.id === 'early-exit');
  const { catalog, spec, plan } = await context(recorded.seedPath);
  const classification = classifyTrustedResult({ resultBytes: null, exitCode: recorded.exitCode, plan, spec, catalog });
  assert.equal(classification.evaluator, 'evaluator-error');
  assert.equal(classification.execution.status, 'unrunnable');
  assert.equal(classification.violationIdentity, null);
});

test('reads only one bounded regular result.json from the trusted result channel', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'v03-result-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = path.join(root, 'empty');
  const valid = path.join(root, 'valid');
  const extra = path.join(root, 'extra');
  const linked = path.join(root, 'linked');
  const oversized = path.join(root, 'oversized');
  await Promise.all([empty, valid, extra, linked, oversized].map((directory) => mkdir(directory)));
  await writeFile(path.join(valid, 'result.json'), '{}');
  await Promise.all([
    writeFile(path.join(extra, 'result.json'), '{}'),
    writeFile(path.join(extra, 'other.json'), '{}'),
    symlink(path.join(valid, 'result.json'), path.join(linked, 'result.json')),
    writeFile(path.join(oversized, 'result.json'), Buffer.alloc(WIRE_LIMITS.inputBytes + 1)),
  ]);

  assert.equal((await readTrustedResultChannel(empty)).resultBytes, null);
  assert.equal((await readTrustedResultChannel(valid)).resultBytes.toString('utf8'), '{}');
  assert.equal((await readTrustedResultChannel(extra)).resultBytes, null);
  assert.equal((await readTrustedResultChannel(linked)).resultBytes, null);
  assert.equal((await readTrustedResultChannel(oversized)).resultBytes, null);
});
