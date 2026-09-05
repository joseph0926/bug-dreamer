import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { phase4RegistrationReadiness, phase4StaticPolicyDigest, validatePhase4Registration, validateTrustedModuleDescriptor } from './v03-benchmark-contract.mjs';
import { benchmarkSeedDigest, validateBenchmarkSeed } from './v03-benchmark-spec.mjs';
import { WIRE_LIMITS, canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

const execFileAsync = promisify(execFile);
export const AUTHORING_POLICY_PATH = 'contracts/v0.3/benchmark-authoring-policy.json';
export const AUTHORING_POLICY_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-authoring-policy/v1';
export const AUTHORING_CONTEXT_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-authoring-context/v1';
export const OPERATOR_SELECTION_DOMAIN = 'bug-dreamer/v03-benchmark-operator-request-selection/v1';
const MODULE_IDS = Object.freeze(['tx', 'local-first', 'prepaint']);
const ARM_IDS = Object.freeze(['A', 'B', 'C']);

export class V03BenchmarkAuthoringError extends Error {}
function fail(message) { throw new V03BenchmarkAuthoringError(message); }
function assert(value, message) { if (!value) fail(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function strict(value, keys, label) {
  assert(object(value), `${label} must be an object`);
  assert(canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `${label} fields changed`);
}
function safeRelative(value, label) {
  assert(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0'), `${label} is unsafe`);
  assert(path.posix.normalize(value) === value && value !== '..' && !value.startsWith('../'), `${label} escapes its root`);
}

export function validateAuthoringPolicy(policy) {
  strict(policy, ['schemaVersion', 'status', 'registrationStaticPolicyDigest', 'targetRevision', 'generation', 'bundleOutputPath', 'bundlePolicy', 'context', 'prompts', 'operatorSelection'], 'Authoring policy');
  assert(policy.schemaVersion === AUTHORING_POLICY_SCHEMA_VERSION && policy.status === 'prepared-before-checkpoint-a', 'Authoring policy identity changed');
  assert(/^[0-9a-f]{64}$/u.test(policy.registrationStaticPolicyDigest) && /^[0-9a-f]{40}$/u.test(policy.targetRevision), 'Authoring policy digest or target revision is invalid');
  strict(policy.generation, ['model', 'reasoningEffort', 'freshSessions', 'submittedTaskTurnsPerSession', 'seedMaximumPerModulePerArm', 'seedMaximumPerArm', 'replacementAfterRejection', 'unavailableCounters', 'unavailableCounterReason'], 'Authoring generation policy');
  assert(policy.generation.model === 'gpt-5.6-sol' && policy.generation.reasoningEffort === 'medium', 'Authoring model policy changed');
  assert(canonicalJson(policy.generation.freshSessions) === canonicalJson({ G: 1, P: 1 }) && policy.generation.submittedTaskTurnsPerSession === 1, 'Authoring session policy changed');
  assert(policy.generation.seedMaximumPerModulePerArm === 2 && policy.generation.seedMaximumPerArm === 6 && policy.generation.replacementAfterRejection === false, 'Authoring seed budget changed');
  strict(policy.generation.unavailableCounters, ['internalModelCalls', 'inputTokens', 'outputTokens'], 'Unavailable authoring counters');
  assert(Object.values(policy.generation.unavailableCounters).every((item) => item === null) && typeof policy.generation.unavailableCounterReason === 'string', 'Unavailable counters must stay null with a reason');
  safeRelative(policy.bundleOutputPath, 'Author bundle output');
  strict(policy.bundlePolicy, ['writeTiming', 'unavailableCountersSource', 'unavailableCounterReasonSource'], 'Author bundle policy');
  assert(policy.bundlePolicy.writeTiming === 'after-both-fresh-sessions-only' && policy.bundlePolicy.unavailableCountersSource === 'generation.unavailableCounters' && policy.bundlePolicy.unavailableCounterReasonSource === 'generation.unavailableCounterReason', 'Author bundle timing or unavailable-counter source changed');
  strict(policy.context, ['mustBeOutsideRepository', 'sourceMode', 'repoInputs', 'checkpointAInputs', 'targetAllowlist', 'deniedPathFragments', 'deniedContentClasses'], 'Authoring context policy');
  assert(policy.context.mustBeOutsideRepository === true && policy.context.sourceMode === 'git-show-pinned-clean-revision', 'Authoring source boundary changed');
  assert(Array.isArray(policy.context.repoInputs) && policy.context.repoInputs.length === 6, 'Authoring repo input allowlist changed');
  policy.context.repoInputs.forEach((item) => safeRelative(item, 'Authoring repo input'));
  assert(Array.isArray(policy.context.checkpointAInputs) && policy.context.checkpointAInputs.length === 10 && new Set(policy.context.checkpointAInputs).size === 10, 'Checkpoint A input closure changed');
  policy.context.checkpointAInputs.forEach((item) => safeRelative(item, 'Checkpoint A input'));
  strict(policy.context.targetAllowlist, MODULE_IDS, 'Authoring target allowlist');
  for (const moduleId of MODULE_IDS) {
    const files = policy.context.targetAllowlist[moduleId];
    assert(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length, `Authoring target allowlist is invalid: ${moduleId}`);
    files.forEach((item) => { safeRelative(item, 'Authoring target file'); assert(item.startsWith(`packages/${moduleId}/`), `Authoring target file crosses module boundary: ${item}`); });
  }
  assert(Array.isArray(policy.context.deniedPathFragments) && policy.context.deniedPathFragments.includes('.env'), 'Authoring denied paths lost .env');
  assert(Array.isArray(policy.context.deniedContentClasses) && policy.context.deniedContentClasses.length > 0, 'Authoring denied content classes are empty');
  const allowedPaths = [...policy.context.repoInputs, ...policy.context.checkpointAInputs, ...MODULE_IDS.flatMap((moduleId) => policy.context.targetAllowlist[moduleId])];
  for (const allowedPath of allowedPaths) {
    assert(!policy.context.deniedPathFragments.some((fragment) => allowedPath.includes(fragment)), `Authoring allowlist contains a denied path: ${allowedPath}`);
  }
  strict(policy.prompts, ['G', 'P'], 'Authoring prompts');
  for (const arm of ['G', 'P']) {
    strict(policy.prompts[arm], ['method', 'instruction'], `Authoring ${arm} prompt`);
    assert(typeof policy.prompts[arm].instruction === 'string' && policy.prompts[arm].instruction.includes('exactly one JSON array') && policy.prompts[arm].instruction.includes('Do not execute or import any code') && policy.prompts[arm].instruction.includes('do not run the target'), `Authoring ${arm} prompt lost its output or safety boundary`);
  }
  assert(policy.prompts.G.method === 'generic-data-only-seed-authoring' && policy.prompts.P.method === 'invariant-first-data-only-seed-authoring', 'G/P authoring methods changed');
  strict(policy.operatorSelection, ['inputArm', 'requestsPerSeedPerArm', 'armOrder', 'A', 'B', 'C', 'resultDependentSelectionForbidden'], 'Operator selection policy');
  assert(policy.operatorSelection.inputArm === 'P' && policy.operatorSelection.requestsPerSeedPerArm === 1 && canonicalJson(policy.operatorSelection.armOrder) === canonicalJson(ARM_IDS) && policy.operatorSelection.resultDependentSelectionForbidden === true, 'Operator selection order or budget changed');
  for (const armId of ARM_IDS) strict(policy.operatorSelection[armId], ['operatorId', 'rule'], `Operator arm ${armId}`);
  assert(policy.operatorSelection.A.operatorId === 'time.advance/v1' && policy.operatorSelection.B.operatorId === 'schedule.release-order/v1' && policy.operatorSelection.C.operatorId === 'fault.step-outcome/v1', 'Operator mapping changed');
  return policy;
}

export async function loadAuthoringPolicy(repositoryRoot) {
  return validateAuthoringPolicy(parseJsonBytes(await readFile(path.join(repositoryRoot, AUTHORING_POLICY_PATH))));
}

function assertDeclaredAuthoringReady(registration, policy) {
  validatePhase4Registration(registration);
  validateAuthoringPolicy(policy);
  assert(phase4StaticPolicyDigest(registration) === policy.registrationStaticPolicyDigest, 'Authoring policy does not bind the approved registration');
  assert(registration.target.revision === policy.targetRevision, 'Authoring policy target revision changed');
  const readiness = phase4RegistrationReadiness(registration);
  assert(readiness.authoringReady && registration.checkpoints.commitA !== null, `Authoring context is blocked before Checkpoint A: ${readiness.blockers.join(',')}`);
  assert(Object.values(registration.images).every((value) => value !== null), 'Authoring context is blocked until evaluator image identities are prepared');
}

function checkpointProjection(registration) {
  return {
    universe: {
      metricEligibleRowIds: registration.universe.metricEligibleRowIds,
      retentionDenominatorRowIds: registration.universe.retentionDenominatorRowIds,
      adapterRegistrationIds: registration.universe.adapterRegistrationIds,
      truthCommitmentRef: registration.universe.truthCommitmentRef,
    },
    images: registration.images,
  };
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function gitShow(repositoryRoot, revision, sourcePath, maximum = 4 * 1024 * 1024) {
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'show', `${revision}:${sourcePath}`], { encoding: null, maxBuffer: maximum });
  return Buffer.from(stdout);
}

export async function assertAuthoringReady({ repositoryRoot, registration, policy }) {
  assertDeclaredAuthoringReady(registration, policy);
  const checkpointA = registration.checkpoints.commitA;
  const { stdout: type } = await execFileAsync('git', ['-C', repositoryRoot, 'cat-file', '-t', checkpointA], { encoding: 'utf8', maxBuffer: 1024 });
  assert(type.trim() === 'commit', 'Checkpoint A does not resolve to a Git commit');
  const checkpointRegistration = parseJsonBytes(await gitShow(repositoryRoot, checkpointA, 'benchmark/v0.3/registration.json'));
  validatePhase4Registration(checkpointRegistration);
  assert(checkpointRegistration.checkpoints.commitA === null, 'Checkpoint A registration must use the non-self-referential null commitA form');
  assert(phase4StaticPolicyDigest(checkpointRegistration) === phase4StaticPolicyDigest(registration), 'Checkpoint A approved static policy differs from current registration');
  assert(canonicalJson(checkpointProjection(checkpointRegistration)) === canonicalJson(checkpointProjection(registration)), 'Checkpoint A frozen universe, truth commitment, or images differ from current registration');
  const checkpointBytes = new Map();
  for (const sourcePath of policy.context.checkpointAInputs) {
    const [sealed, current] = await Promise.all([gitShow(repositoryRoot, checkpointA, sourcePath), readFile(path.join(repositoryRoot, sourcePath))]);
    assert(sealed.equals(current), `Checkpoint A input differs from current bytes: ${sourcePath}`);
    checkpointBytes.set(sourcePath, sealed);
  }
  const truthRef = registration.universe.truthCommitmentRef;
  const [sealedTruth, currentTruth] = await Promise.all([gitShow(repositoryRoot, checkpointA, truthRef.path), readFile(path.join(repositoryRoot, truthRef.path))]);
  assert(sealedTruth.equals(currentTruth) && sha256(sealedTruth) === truthRef.sha256, 'Checkpoint A truth commitment bytes or digest differ');
  return Object.freeze({ checkpointA, checkpointRegistration, checkpointBytes });
}

function catalogProjection(descriptor) {
  validateTrustedModuleDescriptor(descriptor);
  return {
    schemaVersion: descriptor.schemaVersion,
    id: descriptor.id,
    moduleId: descriptor.moduleId,
    packageName: descriptor.packageName,
    importSpecifier: descriptor.importSpecifier,
    catalogVersion: descriptor.catalogVersion,
    actions: descriptor.actions,
    fixtures: descriptor.fixtures,
    invariants: descriptor.invariants,
  };
}

function seedSchema() {
  return {
    schemaVersion: 'bug-dreamer/nightmare-seed/v1',
    exactFields: ['schemaVersion', 'catalogVersion', 'id', 'invariantId', 'actors', 'actions'],
    actionExactFields: ['actionId', 'actor', 'arguments', 'bind'],
    bindingDeclaration: { name: '<lower-case-id>', type: '<registered-binding-output-type>' },
    bindingReference: { $binding: '<earlier-binding-name>' },
    limits: { actors: WIRE_LIMITS.actors, actions: WIRE_LIMITS.actions, inputBytes: WIRE_LIMITS.inputBytes, depth: WIRE_LIMITS.depth, stringBytes: WIRE_LIMITS.stringBytes, collectionEntries: WIRE_LIMITS.collectionEntries },
    reservedActors: ['system', 'host', 'evaluator', 'target', 'result', '__*'],
    argumentValidatorNotice: 'Reference-only source for understanding exact action arguments. Do not import or execute it in an authoring session; tx-schema.mjs has a repository-relative v03-wire import that is intentionally absent from the clean context.',
  };
}

export function planAuthoringContext({ registration, policy, descriptors, armId }) {
  assertDeclaredAuthoringReady(registration, policy);
  assert(['G', 'P'].includes(armId), 'Authoring context arm must be G or P');
  strict(descriptors, MODULE_IDS, 'Authoring descriptors');
  const modules = MODULE_IDS.map((moduleId) => {
    const descriptor = descriptors[moduleId];
    assert(descriptor.moduleId === moduleId, `Authoring descriptor module mismatch: ${moduleId}`);
    return { moduleId, catalog: catalogProjection(descriptor), validatorSourcePath: `harness-v0.3/benchmark/${moduleId}-schema.mjs`, targetFiles: policy.context.targetAllowlist[moduleId] };
  });
  return {
    schemaVersion: AUTHORING_CONTEXT_SCHEMA_VERSION,
    armId,
    checkpointA: registration.checkpoints.commitA,
    targetRevision: policy.targetRevision,
    generation: policy.generation,
    prompt: policy.prompts[armId],
    seedSchema: seedSchema(),
    modules,
    deniedPathFragments: policy.context.deniedPathFragments,
    deniedContentClasses: policy.context.deniedContentClasses,
  };
}

async function assertNewExternalDirectory(repositoryRoot, outputRoot) {
  const repo = await realpath(repositoryRoot);
  const parent = await realpath(path.dirname(outputRoot));
  const resolved = path.join(parent, path.basename(outputRoot));
  assert(resolved !== repo && !resolved.startsWith(`${repo}${path.sep}`), 'Authoring context output must be outside the repository');
  try { await stat(resolved); fail('Authoring context output already exists'); } catch (error) { if (error instanceof V03BenchmarkAuthoringError) throw error; if (error.code !== 'ENOENT') throw error; }
  return resolved;
}

async function gitBlob(targetRoot, revision, sourcePath) {
  const { stdout: type } = await execFileAsync('git', ['-C', targetRoot, 'cat-file', '-t', `${revision}:${sourcePath}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert(type.trim() === 'blob', `Authoring target input is not a regular Git blob: ${sourcePath}`);
  const { stdout } = await execFileAsync('git', ['-C', targetRoot, 'show', `${revision}:${sourcePath}`], { encoding: null, maxBuffer: 4 * 1024 * 1024 });
  return Buffer.from(stdout);
}

export async function materializeAuthoringContext({ repositoryRoot, targetRoot, outputRoot, armId }) {
  const policy = await loadAuthoringPolicy(repositoryRoot);
  const registration = parseJsonBytes(await readFile(path.join(repositoryRoot, 'benchmark/v0.3/registration.json')));
  const checkpoint = await assertAuthoringReady({ repositoryRoot, registration, policy });
  const descriptors = {};
  for (const moduleId of MODULE_IDS) descriptors[moduleId] = parseJsonBytes(checkpoint.checkpointBytes.get(`registrations/v0.3/benchmark/${moduleId}.json`));
  const plan = planAuthoringContext({ registration, policy, descriptors, armId });
  const destination = await assertNewExternalDirectory(repositoryRoot, outputRoot);
  const writes = [];
  const add = (relativePath, bytes) => { safeRelative(relativePath, 'Authoring output'); writes.push({ relativePath, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8') }); };
  add('context.json', `${canonicalJson(plan)}\n`);
  add('seed-schema.json', `${canonicalJson(plan.seedSchema)}\n`);
  add('prompt.md', `${policy.prompts[armId].instruction}\n`);
  for (const module of plan.modules) {
    add(`modules/${module.moduleId}/catalog.json`, `${canonicalJson(module.catalog)}\n`);
    add(`modules/${module.moduleId}/argument-validator.mjs`, checkpoint.checkpointBytes.get(module.validatorSourcePath));
    for (const sourcePath of module.targetFiles) add(`target/${sourcePath}`, await gitBlob(targetRoot, policy.targetRevision, sourcePath));
  }
  await mkdir(destination);
  for (const item of writes) {
    const outputPath = path.join(destination, item.relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, item.bytes, { flag: 'wx' });
  }
  const files = writes.map((item) => ({ path: item.relativePath, sha256: createHash('sha256').update(item.bytes).digest('hex') }));
  const manifest = { schemaVersion: AUTHORING_CONTEXT_SCHEMA_VERSION, armId, checkpointA: plan.checkpointA, targetRevision: plan.targetRevision, files, contextDigest: domainDigest('bug-dreamer/v03-authoring-context/v1', { armId, files }) };
  await writeFile(path.join(destination, 'manifest.json'), `${canonicalJson(manifest)}\n`, { flag: 'wx' });
  return { destination, manifest };
}

function instanceId(index) { return `action-${String(index + 1).padStart(4, '0')}`; }
function requestRecord(seed, descriptor, armId, applicable, reasonCode, transformationRequest) {
  const value = { requestId: `${seed.id}-${armId.toLowerCase()}`, inputId: seed.id, seedDigest: benchmarkSeedDigest(seed, descriptor), armId, moduleId: descriptor.moduleId, applicable, reasonCode, transformationRequest };
  return { ...value, selectionDigest: domainDigest(OPERATOR_SELECTION_DOMAIN, value) };
}

function transformation(operatorId, args) {
  return { schemaVersion: 'bug-dreamer/transformation-request/v1', transformations: [{ operatorId, arguments: args }] };
}

export function selectPhase4OperatorRequests(seed, descriptor) {
  validateBenchmarkSeed(seed, descriptor);
  if (descriptor.moduleId !== 'tx') return ARM_IDS.map((armId) => requestRecord(seed, descriptor, armId, false, 'operator-not-supported-by-module', null));
  const starts = seed.actions.map((action, index) => ({ action, index })).filter(({ action }) => action.actionId === 'tx.start' && action.bind !== null);
  let selectedStart = null;
  for (const candidate of starts) {
    const used = seed.actions.slice(candidate.index + 1).some((action) => action.actionId === 'tx.run-scripted' && action.arguments.tx?.$binding === candidate.action.bind.name);
    if (used) { selectedStart = candidate; break; }
  }
  const a = selectedStart === null
    ? requestRecord(seed, descriptor, 'A', false, 'no-timeout-producing-run', null)
    : requestRecord(seed, descriptor, 'A', true, null, transformation('time.advance/v1', { afterInstanceId: instanceId(selectedStart.index), advanceMs: selectedStart.action.arguments.timeoutMs + 1 }));
  const gated = seed.actions.map((action, index) => ({ action, index })).filter(({ action }) => action.actionId === 'tx.run-scripted' && action.arguments.gate !== null);
  const b = gated.length < 2
    ? requestRecord(seed, descriptor, 'B', false, 'fewer-than-two-gated-runs', null)
    : requestRecord(seed, descriptor, 'B', true, null, transformation('schedule.release-order/v1', { instanceIds: [instanceId(gated[1].index), instanceId(gated[0].index)] }));
  const runs = seed.actions.map((action, index) => ({ action, index })).filter(({ action }) => action.actionId === 'tx.run-scripted');
  let c;
  if (runs.length === 0) c = requestRecord(seed, descriptor, 'C', false, 'no-scripted-step', null);
  else {
    const selected = runs.at(-1);
    const firstOutcome = selected.action.arguments.attemptOutcomes[0];
    const args = firstOutcome.kind === 'return'
      ? { targetInstanceId: instanceId(selected.index), outcome: 'throw', value: null, errorName: 'Error', errorMessage: 'bug-dreamer-fixed-step-fault' }
      : { targetInstanceId: instanceId(selected.index), outcome: 'return', value: null, errorName: null, errorMessage: null };
    c = requestRecord(seed, descriptor, 'C', true, null, transformation('fault.step-outcome/v1', args));
  }
  return [a, b, c];
}
