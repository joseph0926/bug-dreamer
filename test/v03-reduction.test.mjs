import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadPhase3Catalog, REQUEST_SCHEMA_VERSION } from '../src/v03-operators.mjs';
import { buildReductionSpec, reduceSpec, reductionSelectors, removeDependencyClosure } from '../src/v03-reduction.mjs';
import { RESULT_SCHEMA_VERSION, RESULT_DIGEST_DOMAIN, classifyTrustedResult } from '../src/v03-trust.mjs';
import { domainDigest } from '../src/v03-wire.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (file) => JSON.parse(await readFile(path.join(repositoryRoot, file), 'utf8'));

async function context() {
  const { catalog: cleanCatalog, operatorCatalog } = await loadPhase3Catalog(repositoryRoot);
  const seed = await readJson('contracts/v0.3/seeds/pass.json');
  const defectCatalog = { ...cleanCatalog, target: { ...cleanCatalog.target, artifactSha256: 'd'.repeat(64) } };
  return {
    input: { seed, request: { schemaVersion: REQUEST_SCHEMA_VERSION, transformations: [] } },
    cleanCatalog, defectCatalog, operatorCatalog,
    expectedIdentity: { invariantRegistrationId: seed.invariantId, normalizedObservedKind: 'returned-value', normalizedObservedFields: { value: 'violation' }, targetArtifactDigest: defectCatalog.target.artifactSha256 },
    registration: await readJson('benchmark/v0.3/phase3-reduction.json'),
  };
}

// A trusted test double for reducer decisions, never an execution of the target.
function record(request, execution = request.artifact === 'clean' ? 'pass' : 'candidate-failure', value = 'violation') {
  const observation = { value };
  const violationIdentity = execution === 'pass' ? null : {
    invariantRegistrationId: request.plan.invariantRegistrationId, normalizedObservedKind: 'returned-value',
    normalizedObservedFields: observation, targetArtifactDigest: request.plan.targetArtifactDigest,
  };
  const payload = {
    schemaVersion: RESULT_SCHEMA_VERSION, specDigest: request.specDigest, planDigest: request.planDigest,
    targetArtifactDigest: request.plan.targetArtifactDigest, invariantRegistrationId: request.plan.invariantRegistrationId,
    evaluatorStatus: 'evaluated', execution, observedKind: 'returned-value', observedFields: observation, violationIdentity,
  };
  const rawResult = JSON.stringify({ ...payload, payloadDigest: domainDigest(RESULT_DIGEST_DOMAIN, payload) });
  const run = {
    exitCode: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
    timedOut: false, outputTruncated: false, cleanupError: null,
    resultEntries: [{ name: 'result.json', type: 'regular', size: Buffer.byteLength(rawResult) }], rawResult,
  };
  return { ...run, classification: classifyTrustedResult({ ...request, ...run, resultBytes: Buffer.from(rawResult) }) };
}

test('removes an irrelevant commit, restarts scanning, and requires clean plus five defect runs', async () => {
  const ctx = await context();
  const result = await reduceSpec({ ...ctx, evaluate: async (request) => record(request) });
  assert.equal(result.status, 'one-minimal');
  assert.equal(result.counts.acceptedRemovals, 1);
  assert.equal(result.final.spec.transformedActions.length, 2);
  const acceptedIndex = result.attempts.findIndex((attempt) => attempt.preserved);
  assert.deepEqual(result.attempts[acceptedIndex].selector, { kind: 'action', id: 'action-0003' });
  assert.equal(result.attempts[acceptedIndex + 1].selector.kind, 'actor');
  assert.equal(result.runs.filter((run) => run.phase === 'replay').length, 5);
  assert.equal(result.runs.find((run) => run.phase === 'clean-check').record.classification.execution.status, 'pass');
  assert.equal(ctx.input.seed.actions.length, 3);
});

for (const [name, execution, value] of [['pass', 'pass', 'violation'], ['different violation', 'candidate-failure', 'different']]) {
  test(`keeps a removal that produces ${name} out of the accepted chain`, async () => {
    const result = await reduceSpec({ ...await context(), evaluate: async (request) => request.phase === 'candidate' ? record(request, execution, value) : record(request) });
    assert.equal(result.status, 'one-minimal');
    assert.equal(result.counts.acceptedRemovals, 0);
    assert.equal(result.final.spec.transformedActions.length, 3);
    assert.ok(result.attempts.some((attempt) => attempt.status === 'executed' && attempt.preserved === false));
  });
}

test('records invalid reductions separately without executing them', async () => {
  const result = await reduceSpec({ ...await context(), evaluate: async (request) => record(request) });
  assert.ok(result.counts.invalidAttempts > 0);
  assert.equal(result.counts.evaluations, result.counts.validAttempts + 7);
  assert.ok(result.attempts.filter((attempt) => attempt.status === 'invalid').every((attempt) => !Object.hasOwn(attempt, 'runIndex')));
});

test('an unrunnable removal blocks minimality rather than counting as a failed removal', async () => {
  const result = await reduceSpec({ ...await context(), evaluate: async (request) => {
    const run = record(request);
    if (request.phase !== 'candidate') return run;
    run.timedOut = true;
    run.exitCode = 137;
    run.classification = classifyTrustedResult({ ...request, ...run, resultBytes: Buffer.from(run.rawResult) });
    return run;
  } });
  assert.equal(result.status, 'reduced-not-one-minimal');
  assert.equal(result.blocker, 'unrunnable');
  assert.equal(result.attempts.at(-1).status, 'blocked');
  assert.equal(result.runs.filter((run) => run.phase === 'replay').length, 0);
});

for (const [phase, blocker] of [['initial', 'initial-violation-mismatch'], ['clean-check', 'clean-check-failed'], ['replay', 'replay-violation-mismatch']]) {
  test(`${phase} mismatch blocks one-minimal`, async () => {
    const result = await reduceSpec({ ...await context(), evaluate: async (request) => request.phase === phase
      ? record(request, request.artifact === 'clean' ? 'candidate-failure' : 'pass') : record(request) });
    assert.equal(result.status, 'reduced-not-one-minimal');
    assert.equal(result.blocker, blocker);
  });
}

test('failed container cleanup blocks minimality even with a valid verdict', async () => {
  const result = await reduceSpec({ ...await context(), evaluate: async (request) => ({ ...record(request), cleanupError: 'docker rm failed' }) });
  assert.equal(result.blocker, 'container-cleanup-failed');
  assert.equal(result.status, 'reduced-not-one-minimal');
});

for (const [field, blocker] of [['maxCandidateAttempts', 'candidate-budget-exhausted'], ['maxEvaluations', 'evaluation-budget-exhausted']]) {
  test(`${field} is enforced before the next attempt or execution`, async () => {
    const ctx = await context();
    ctx.registration = { ...ctx.registration, [field]: 1 };
    const result = await reduceSpec({ ...ctx, evaluate: async (request) => record(request) });
    assert.equal(result.status, 'reduced-not-one-minimal');
    assert.equal(result.blocker, blocker);
    if (field === 'maxEvaluations') assert.equal(result.runs.length, 1);
    else assert.equal(result.attempts.length, 1);
  });
}

test('dependency closure removes handle consumers and paired controls, not binding-shaped payload data', async () => {
  const { input } = await context();
  input.seed.actors.push('other');
  input.seed.actions.unshift({ actionId: 'tx.start', actor: 'other', arguments: { transactionId: 'other', timeoutMs: 5, transition: false }, bind: { name: 'other', type: 'tx-handle' } });
  input.seed.actions[2].arguments.value = { $binding: 'other' };
  input.seed.actions[3] = structuredClone(input.seed.actions[2]);
  input.request.transformations = [
    { operatorId: 'time.advance/v1', arguments: { afterInstanceId: 'action-0003', advanceMs: 10 } },
    { operatorId: 'schedule.release-order/v1', arguments: { instanceIds: ['action-0003', 'action-0004'] } },
    { operatorId: 'fault.step-outcome/v1', arguments: { targetInstanceId: 'action-0003', outcome: 'return', value: 'fault', errorName: null, errorMessage: null } },
  ];
  const unrelated = removeDependencyClosure(input, { kind: 'binding', id: 'other' });
  assert.deepEqual(unrelated.removed.actions, ['action-0001']);
  assert.deepEqual(unrelated.removed.actors, ['other']);
  assert.equal(unrelated.input.request.transformations[0].arguments.afterInstanceId, 'action-0002');
  assert.deepEqual(unrelated.input.request.transformations[1].arguments.instanceIds, ['action-0002', 'action-0003']);
  assert.equal(unrelated.input.request.transformations[2].arguments.targetInstanceId, 'action-0002');
  const consumer = removeDependencyClosure(input, { kind: 'fixture', id: 'action-0003' });
  assert.deepEqual(consumer.removed.transformations, [0, 1, 2]);
  assert.deepEqual(consumer.removed.fixtures, ['action-0003']);
  const producer = removeDependencyClosure(input, { kind: 'action', id: 'action-0002' });
  assert.deepEqual(producer.removed.actions, ['action-0002', 'action-0003', 'action-0004']);
});

test('removing a fault rebuilds the original registered fixture from the surviving chain', async () => {
  const { catalog, operatorCatalog } = await loadPhase3Catalog(repositoryRoot);
  const input = { seed: await readJson('contracts/v0.3/seeds/two-steps.json'), request: await readJson('contracts/v0.3/requests/fault-nonfinal.json') };
  assert.equal(buildReductionSpec(input, catalog, operatorCatalog).fixtures[0].canonicalWirePayload.outcome, 'throw');
  const fault = reductionSelectors(input).find((selector) => selector.kind === 'fault');
  const reduced = removeDependencyClosure(input, fault);
  assert.equal(buildReductionSpec(reduced.input, catalog, operatorCatalog).fixtures[0].canonicalWirePayload.outcome, 'return');
});
