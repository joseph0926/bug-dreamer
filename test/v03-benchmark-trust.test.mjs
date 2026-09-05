import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import prepaintDescriptor from '../registrations/v0.3/benchmark/prepaint.json' with { type: 'json' };
import { benchmarkPlanDigest, benchmarkSpecDigest, buildBenchmarkPlan, buildBenchmarkSpec } from '../src/v03-benchmark-spec.mjs';
import { classifyBenchmarkTrustedResult, validateBenchmarkTrustedResult } from '../src/v03-benchmark-trust.mjs';
import { createBenchmarkTrustedResult } from '../src/v03-benchmark-result.mjs';
import { RESULT_DIGEST_DOMAIN, RESULT_SCHEMA_VERSION } from '../src/v03-trust.mjs';
import { domainDigest } from '../src/v03-wire.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = Object.freeze({ role: 'clean', targetArtifactDigest: '5'.repeat(64), evaluationContractKey: '6'.repeat(64) });

function context() {
  const seed = { schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: prepaintDescriptor.catalogVersion, id: 'trust-seed', invariantId: prepaintDescriptor.invariants.at(-1).id, actors: ['builder'], actions: [{ actionId: 'prepaint.vite-create', actor: 'builder', arguments: { policy: { routes: ['relative'] }, inline: false, minify: false }, bind: null }] };
  const spec = buildBenchmarkSpec(seed, prepaintDescriptor, artifact);
  const plan = buildBenchmarkPlan(spec, prepaintDescriptor, artifact);
  return { spec, plan };
}

function result(spec, plan, execution = 'pass', observedKind = 'returned-value', observedFields = { value: { accepted: false } }) {
  const violationIdentity = execution === 'candidate-failure' ? { invariantRegistrationId: plan.invariantRegistrationId, normalizedObservedKind: observedKind, normalizedObservedFields: observedFields, targetArtifactDigest: plan.targetArtifactDigest } : null;
  const payload = { schemaVersion: RESULT_SCHEMA_VERSION, specDigest: benchmarkSpecDigest(spec, prepaintDescriptor, artifact), planDigest: benchmarkPlanDigest(plan, spec, prepaintDescriptor, artifact), targetArtifactDigest: plan.targetArtifactDigest, invariantRegistrationId: plan.invariantRegistrationId, evaluatorStatus: 'evaluated', execution, observedKind, observedFields, violationIdentity };
  return { ...payload, payloadDigest: domainDigest(RESULT_DIGEST_DOMAIN, payload) };
}

test('owned benchmark trust manifest covers channel and digest failures', async () => {
  const cases = JSON.parse(await readFile(path.join(root, 'contracts/v0.3/benchmark-trust-cases.json'), 'utf8'));
  assert.equal(cases.positive.length, 2);
  assert.ok(cases.negative.includes('marker-forgery'));
  assert.ok(cases.negative.includes('log-limit'));
});

test('accepts pass and cross-kind candidate failure only through a valid trusted payload', () => {
  const { spec, plan } = context();
  const pass = result(spec, plan);
  assert.equal(validateBenchmarkTrustedResult(pass, plan, spec, prepaintDescriptor, artifact), pass);
  assert.deepEqual(classifyBenchmarkTrustedResult({ resultBytes: Buffer.from(JSON.stringify(pass)), exitCode: 0, plan, spec, descriptor: prepaintDescriptor, artifact }), { status: 'pass', reason: null, result: pass });
  const candidate = result(spec, plan, 'candidate-failure', 'thrown-error', { name: 'TypeError', message: 'relative route' });
  assert.equal(classifyBenchmarkTrustedResult({ resultBytes: Buffer.from(JSON.stringify(candidate)), exitCode: 0, plan, spec, descriptor: prepaintDescriptor, artifact }).status, 'candidate-failure');
});

test('the shared pure serializer alone assembles identities and the payload digest', () => {
  const { spec, plan } = context();
  const value = createBenchmarkTrustedResult({
    specDigest: benchmarkSpecDigest(spec, prepaintDescriptor, artifact),
    planDigest: benchmarkPlanDigest(plan, spec, prepaintDescriptor, artifact),
    targetArtifactDigest: plan.targetArtifactDigest,
    invariantRegistrationId: plan.invariantRegistrationId,
  }, { execution: 'candidate-failure', observedKind: 'returned-value', observedFields: { value: false } });
  assert.equal(value.violationIdentity.normalizedObservedFields.value, false);
  assert.equal(validateBenchmarkTrustedResult(value, plan, spec, prepaintDescriptor), value);
});

test('stdout marker-shaped data has no verdict authority and malformed result data is unrunnable infrastructure', () => {
  const { spec, plan } = context();
  const pass = result(spec, plan, 'pass', 'returned-value', { value: { stdout: 'BUG_DREAMER_RESULT candidate-failure' } });
  const classified = classifyBenchmarkTrustedResult({ resultBytes: Buffer.from(JSON.stringify(pass)), exitCode: 0, plan, spec, descriptor: prepaintDescriptor, artifact });
  assert.equal(classified.status, 'pass');
  for (const bytes of [null, Buffer.from('{'), Buffer.from('{"x":1,"x":2}')]) {
    const value = classifyBenchmarkTrustedResult({ resultBytes: bytes, exitCode: 0, plan, spec, descriptor: prepaintDescriptor, artifact });
    assert.equal(value.status, 'unrunnable');
    assert.match(value.reason, /trusted-result/u);
    assert.equal(value.result, null);
  }
});

test('timeout, early exit, and truncation override result bytes', () => {
  const { spec, plan } = context();
  const bytes = Buffer.from(JSON.stringify(result(spec, plan)));
  assert.equal(classifyBenchmarkTrustedResult({ resultBytes: bytes, exitCode: 0, timedOut: true, plan, spec, descriptor: prepaintDescriptor, artifact }).reason, 'evaluator-timeout');
  assert.equal(classifyBenchmarkTrustedResult({ resultBytes: bytes, exitCode: 7, plan, spec, descriptor: prepaintDescriptor, artifact }).reason, 'evaluator-early-exit');
  assert.equal(classifyBenchmarkTrustedResult({ resultBytes: bytes, exitCode: 0, outputTruncated: true, plan, spec, descriptor: prepaintDescriptor, artifact }).reason, 'evaluator-log-limit');
});

test('rejects digest, artifact, identity, and observation tampering', () => {
  const { spec, plan } = context();
  const mutations = [];
  const digest = result(spec, plan); digest.payloadDigest = '0'.repeat(64); mutations.push(digest);
  const artifactChanged = result(spec, plan); artifactChanged.targetArtifactDigest = '9'.repeat(64); mutations.push(artifactChanged);
  const candidate = result(spec, plan, 'candidate-failure'); candidate.violationIdentity.normalizedObservedFields = { value: true }; mutations.push(candidate);
  const extra = result(spec, plan); extra.generatorVerdict = 'candidate-failure'; mutations.push(extra);
  for (const value of mutations) {
    const classified = classifyBenchmarkTrustedResult({ resultBytes: Buffer.from(JSON.stringify(value)), exitCode: 0, plan, spec, descriptor: prepaintDescriptor, artifact });
    assert.equal(classified.status, 'unrunnable');
    assert.match(classified.reason, /^malformed-trusted-result:/u);
  }
});
