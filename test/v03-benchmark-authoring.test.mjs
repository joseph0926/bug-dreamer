import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import localDescriptor from '../registrations/v0.3/benchmark/local-first.json' with { type: 'json' };
import prepaintDescriptor from '../registrations/v0.3/benchmark/prepaint.json' with { type: 'json' };
import txDescriptor from '../registrations/v0.3/benchmark/tx.json' with { type: 'json' };
import {
  loadAuthoringPolicy,
  planAuthoringContext,
  selectPhase4OperatorRequests,
  validateAuthoringPolicy,
} from '../src/v03-benchmark-authoring.mjs';
import { buildTransformedBenchmarkSpec } from '../src/v03-benchmark-spec.mjs';
import { phase4RegistrationReadiness } from '../src/v03-benchmark-contract.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = { role: 'clean', targetArtifactDigest: 'a'.repeat(64), evaluationContractKey: 'b'.repeat(64) };

async function registration() {
  return JSON.parse(await readFile(path.join(root, 'benchmark/v0.3/registration.json'), 'utf8'));
}

function txSeed() {
  return {
    schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: txDescriptor.catalogVersion, id: 'p-tx-one', invariantId: txDescriptor.invariants[0].id, actors: ['client'], actions: [
      { actionId: 'tx.start', actor: 'client', arguments: { transactionId: 'author', timeoutMs: 100, transition: false }, bind: { name: 'tx', type: 'tx-handle' } },
      { actionId: 'tx.run-scripted', actor: 'client', arguments: { tx: { $binding: 'tx' }, attemptOutcomes: [{ kind: 'return', value: 1 }], retry: null, compensation: null, externalSignal: null, gate: 'one' }, bind: null },
      { actionId: 'tx.run-scripted', actor: 'client', arguments: { tx: { $binding: 'tx' }, attemptOutcomes: [{ kind: 'throw', errorName: 'Error', errorMessage: 'original' }], retry: null, compensation: null, externalSignal: null, gate: 'two' }, bind: null },
    ],
  };
}

test('authoring policy fixes clean allowlists, G/P separation, budgets, and unavailable counters', async () => {
  const policy = await loadAuthoringPolicy(root);
  assert.equal(validateAuthoringPolicy(policy), policy);
  assert.equal(policy.generation.model, 'gpt-5.6-sol');
  assert.equal(policy.generation.reasoningEffort, 'medium');
  assert.notEqual(policy.prompts.G.instruction, policy.prompts.P.instruction);
  assert.match(policy.prompts.P.instruction, /reason backward/u);
  assert.match(policy.prompts.G.instruction, /exactly one JSON array/u);
  assert.deepEqual(policy.generation.unavailableCounters, { internalModelCalls: null, inputTokens: null, outputTokens: null });
  assert.deepEqual(policy.bundlePolicy, { writeTiming: 'after-both-fresh-sessions-only', unavailableCountersSource: 'generation.unavailableCounters', unavailableCounterReasonSource: 'generation.unavailableCounterReason' });
  for (const required of ['contracts/v0.3/benchmark-authoring-policy.json', 'src/v03-benchmark-authoring.mjs', 'scripts/prepare-v03-authoring.mjs', 'src/v03-benchmark-spec.mjs']) assert.ok(policy.context.checkpointAInputs.includes(required));
  const allowlist = [...policy.context.repoInputs, ...Object.values(policy.context.targetAllowlist).flat()];
  for (const item of allowlist) assert.ok(!policy.context.deniedPathFragments.some((fragment) => item.includes(fragment)));
  assert.equal(policy.bundleOutputPath, 'benchmark/v0.3/authoring/bundle.json');
});

test('current approved-unsealed registration refuses authoring context before Checkpoint A', async () => {
  const policy = await loadAuthoringPolicy(root);
  const current = await registration();
  assert.throws(() => planAuthoringContext({ registration: current, policy, descriptors: { tx: txDescriptor, 'local-first': localDescriptor, prepaint: prepaintDescriptor }, armId: 'G' }), /blocked before Checkpoint A/u);
  await assert.rejects(execFileAsync(process.execPath, ['scripts/prepare-v03-authoring.mjs', '--arm', 'G', '--target', '/does/not/matter', '--out', path.join('/tmp', 'must-not-be-created-by-authoring-test')], { cwd: root }), (error) => error.code === 1 && /blocked before Checkpoint A/u.test(error.stderr));
});

test('an authoring-ready projection contains only sanitized catalogs and exact clean source files', async () => {
  const policy = await loadAuthoringPolicy(root);
  const ready = await registration();
  ready.universe.metricEligibleRowIds = ['eligible-one'];
  ready.universe.retentionDenominatorRowIds = ['retention-one'];
  ready.universe.adapterRegistrationIds = ['adapter-one'];
  ready.universe.truthCommitmentRef = { path: 'benchmark/v0.3/truth-commitments.json', sha256: 'c'.repeat(64) };
  ready.checkpoints.commitA = 'd'.repeat(40);
  ready.images = { artifactFactoryImageId: 'e'.repeat(64), evaluatorImageManifestDigest: 'f'.repeat(64), evaluationContractKeysDigest: '1'.repeat(64) };
  ready.readiness = phase4RegistrationReadiness(ready);
  const context = planAuthoringContext({ registration: ready, policy, descriptors: { tx: txDescriptor, 'local-first': localDescriptor, prepaint: prepaintDescriptor }, armId: 'P' });
  assert.equal(context.checkpointA, ready.checkpoints.commitA);
  assert.equal(context.armId, 'P');
  assert.equal(context.prompt.method, 'invariant-first-data-only-seed-authoring');
  assert.equal(Object.hasOwn(context, 'prompts'), false);
  assert.deepEqual(context.modules.map((item) => item.moduleId), ['tx', 'local-first', 'prepaint']);
  for (const module of context.modules) {
    assert.equal(Object.hasOwn(module.catalog, 'comparisons'), false);
    assert.ok(module.targetFiles.every((item) => item.startsWith(`packages/${module.moduleId}/`)));
  }
  assert.doesNotMatch(JSON.stringify(context), /tx-rollback-forward-order|prepaint-route-prefix-overcapture|local-first-stale-flag-inverted/u);
  assert.deepEqual(context.seedSchema.reservedActors, ['system', 'host', 'evaluator', 'target', 'result', '__*']);
  assert.match(context.seedSchema.argumentValidatorNotice, /Reference-only/u);
});

test('A/B/C requests are deterministic, one per arm, result-independent, and executable by the registered transformer', async () => {
  const seed = txSeed();
  const first = selectPhase4OperatorRequests(seed, txDescriptor);
  const second = selectPhase4OperatorRequests(structuredClone(seed), txDescriptor);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.armId), ['A', 'B', 'C']);
  assert.ok(first.every((item) => item.applicable && item.reasonCode === null && item.transformationRequest.transformations.length === 1));
  assert.deepEqual(first[0].transformationRequest.transformations[0].arguments, { afterInstanceId: 'action-0001', advanceMs: 101 });
  assert.deepEqual(first[1].transformationRequest.transformations[0].arguments.instanceIds, ['action-0003', 'action-0002']);
  assert.equal(first[2].transformationRequest.transformations[0].arguments.outcome, 'return');
  for (const request of first) assert.doesNotThrow(() => buildTransformedBenchmarkSpec(seed, request.transformationRequest, txDescriptor, artifact));
});

test('every non-tx P seed still receives three preserved not-applicable request records', () => {
  const seed = { schemaVersion: 'bug-dreamer/nightmare-seed/v1', catalogVersion: prepaintDescriptor.catalogVersion, id: 'p-prepaint', invariantId: prepaintDescriptor.invariants.at(-1).id, actors: ['builder'], actions: [{ actionId: 'prepaint.vite-create', actor: 'builder', arguments: { policy: { routes: ['relative'] }, inline: false, minify: false }, bind: null }] };
  const requests = selectPhase4OperatorRequests(seed, prepaintDescriptor);
  assert.deepEqual(requests.map((item) => [item.armId, item.applicable, item.reasonCode]), [
    ['A', false, 'operator-not-supported-by-module'], ['B', false, 'operator-not-supported-by-module'], ['C', false, 'operator-not-supported-by-module'],
  ]);
  assert.ok(requests.every((item) => item.transformationRequest === null && /^[0-9a-f]{64}$/u.test(item.selectionDigest)));
});
