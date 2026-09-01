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
  planDigest,
  specDigest,
} from '../src/v03-spec.mjs';
import {
  RESULT_DIGEST_DOMAIN,
  RESULT_SCHEMA_VERSION,
  classifyTrustedResult,
  readTrustedResultChannel,
  validateTrustedResult,
} from '../src/v03-trust.mjs';
import { validateTrustContracts } from '../src/v03-trust-validation.mjs';
import { WIRE_LIMITS, domainDigest, parseJsonBytes } from '../src/v03-wire.mjs';

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
  assert.equal(result.caseCount, 10);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.evaluatorErrorCount, 6);
});

function trustedResult(plan, spec, catalog, { execution, observedKind, observedFields }) {
  const violationIdentity = execution === 'candidate-failure' ? {
    invariantRegistrationId: plan.invariantRegistrationId,
    normalizedObservedKind: observedKind,
    normalizedObservedFields: observedFields,
    targetArtifactDigest: plan.targetArtifactDigest,
  } : null;
  const payload = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    specDigest: specDigest(spec, catalog),
    planDigest: planDigest(plan, spec, catalog),
    targetArtifactDigest: plan.targetArtifactDigest,
    invariantRegistrationId: plan.invariantRegistrationId,
    evaluatorStatus: 'evaluated',
    execution,
    observedKind,
    observedFields,
    violationIdentity,
  };
  return { ...payload, payloadDigest: domainDigest(RESULT_DIGEST_DOMAIN, payload) };
}

test('classifies observation kind flips as candidate failures in both directions', async () => {
  const expectedReturn = await context('contracts/v0.3/seeds/pass.json');
  const threwInstead = trustedResult(expectedReturn.plan, expectedReturn.spec, expectedReturn.catalog, {
    execution: 'candidate-failure',
    observedKind: 'thrown-error',
    observedFields: { name: 'TransactionTimeoutError', message: '' },
  });
  const threwClassification = classifyTrustedResult({
    resultBytes: Buffer.from(JSON.stringify(threwInstead)),
    exitCode: 0,
    ...expectedReturn,
  });
  assert.equal(threwClassification.evaluator, 'evaluated');
  assert.equal(threwClassification.execution.status, 'candidate-failure');
  assert.equal(threwClassification.violationIdentity.normalizedObservedKind, 'thrown-error');

  const expectedThrow = await context('contracts/v0.3/seeds/candidate.json');
  const returnedInstead = trustedResult(expectedThrow.plan, expectedThrow.spec, expectedThrow.catalog, {
    execution: 'candidate-failure',
    observedKind: 'returned-value',
    observedFields: { value: null },
  });
  const returnedClassification = classifyTrustedResult({
    resultBytes: Buffer.from(JSON.stringify(returnedInstead)),
    exitCode: 0,
    ...expectedThrow,
  });
  assert.equal(returnedClassification.evaluator, 'evaluated');
  assert.equal(returnedClassification.execution.status, 'candidate-failure');
  assert.equal(returnedClassification.violationIdentity.normalizedObservedKind, 'returned-value');
});

test('a passing result cannot claim a different observation kind', async () => {
  const { catalog, spec, plan } = await context('contracts/v0.3/seeds/pass.json');
  const mismatchedPass = trustedResult(plan, spec, catalog, {
    execution: 'pass',
    observedKind: 'thrown-error',
    observedFields: { name: 'Error', message: 'boom' },
  });
  const classification = classifyTrustedResult({
    resultBytes: Buffer.from(JSON.stringify(mismatchedPass)),
    exitCode: 0,
    plan,
    spec,
    catalog,
  });
  assert.equal(classification.evaluator, 'evaluator-error');
  assert.match(classification.execution.reason, /observed kind mismatch/u);
});

test('timeout and log overflow override even a valid trusted result', async () => {
  const receipt = await evidence();
  const recorded = receipt.cases.find((item) => item.id === 'pass');
  const { catalog, spec, plan } = await context(recorded.seedPath);
  const resultBytes = Buffer.from(recorded.rawResult);
  const timeout = classifyTrustedResult({ resultBytes, exitCode: 0, timedOut: true, plan, spec, catalog });
  assert.equal(timeout.evaluator, 'evaluator-error');
  assert.equal(timeout.execution.status, 'unrunnable');
  assert.equal(timeout.execution.kind, 'infrastructure');
  assert.equal(timeout.execution.reason, 'evaluator-timeout');
  assert.equal(timeout.violationIdentity, null);
  const overflow = classifyTrustedResult({ resultBytes, exitCode: 0, outputTruncated: true, plan, spec, catalog });
  assert.equal(overflow.execution.reason, 'evaluator-log-limit');
  assert.equal(overflow.execution.kind, 'infrastructure');
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
