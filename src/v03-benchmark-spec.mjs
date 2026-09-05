import {
  PLAN_DIGEST_DOMAIN,
  PLAN_SCHEMA_VERSION,
  SEED_SCHEMA_VERSION,
  SPEC_DIGEST_DOMAIN,
  SPEC_SCHEMA_VERSION,
  TRANSFORMATION_LIMIT,
  TRANSFORMATION_STATE_DOMAIN,
  V03SpecError,
  VIRTUAL_TIME_ORIGIN_MS,
} from './v03-spec.mjs';
import { validateTrustedModuleDescriptor } from './v03-benchmark-contract.mjs';
import { WIRE_LIMITS, canonicalJson, domainDigest, parseJsonBytes, validateJsonValueLimits } from './v03-wire.mjs';
import { validateActionArguments as validateLocalFirstActionArguments } from '../harness-v0.3/benchmark/local-first-schema.mjs';
import { validateActionArguments as validatePrepaintActionArguments } from '../harness-v0.3/benchmark/prepaint-schema.mjs';
import { validateActionArguments as validateTxActionArguments } from '../harness-v0.3/benchmark/tx-schema.mjs';

export const BENCHMARK_SEED_DIGEST_DOMAIN = 'bug-dreamer/nightmare-seed/v1';
export const BENCHMARK_FIXTURE_REGISTRATION_DOMAIN = 'bug-dreamer/fixture-registration/v1';
export const BENCHMARK_FIXTURE_STATE_DOMAIN = 'bug-dreamer/fixture-state/v1';
export const BENCHMARK_OPERATOR_REGISTRATION_DOMAIN = 'bug-dreamer/operator-registration/v1';
export const BENCHMARK_REQUEST_SCHEMA_VERSION = 'bug-dreamer/transformation-request/v1';

const RESERVED_ACTORS = new Set(['system', 'host', 'evaluator', 'target', 'result']);
const SHA_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const CANONICALIZER = Object.freeze({ standard: 'RFC 8785 JCS', package: 'canonicalize', version: '4.0.0' });
const ARGUMENT_VALIDATORS = Object.freeze({
  tx: validateTxActionArguments,
  'local-first': validateLocalFirstActionArguments,
  prepaint: validatePrepaintActionArguments,
});
const OPERATORS = Object.freeze({
  'time.advance/v1': Object.freeze({ id: 'time.advance/v1', kind: 'schedule-control', argumentSchemaId: 'time.advance-args/v1', bounds: Object.freeze({ advanceMsMin: 1, advanceMsMax: 86_400_000 }) }),
  'schedule.release-order/v1': Object.freeze({ id: 'schedule.release-order/v1', kind: 'schedule-control', argumentSchemaId: 'schedule.release-order-args/v1', bounds: Object.freeze({ minInstanceIds: 2 }) }),
  'fault.step-outcome/v1': Object.freeze({ id: 'fault.step-outcome/v1', kind: 'action-transformation', argumentSchemaId: 'fault.step-outcome-args/v1', bounds: Object.freeze({ policy: 'tx.run argument schema and policy limits' }) }),
});

function fail(kind, message) {
  throw new V03SpecError(kind, message);
}

function assert(condition, kind, message) {
  if (!condition) fail(kind, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictKeys(value, keys, label, kind = 'rejected-schema') {
  assert(isPlainObject(value), kind, `${label} must be an object`);
  assert(canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), kind, `${label} fields changed`);
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function validSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function unique(values, label, kind = 'rejected-schema') {
  assert(new Set(values).size === values.length, kind, `Duplicate ${label}`);
}

function validateDescriptor(descriptor) {
  try {
    return validateTrustedModuleDescriptor(descriptor);
  } catch (error) {
    fail('rejected-catalog', `Trusted module descriptor is invalid: ${error.message}`);
  }
}

function validateArtifact(artifact) {
  strictKeys(artifact, ['role', 'targetArtifactDigest', 'evaluationContractKey'], 'Artifact', 'rejected-catalog');
  assert(['clean', 'single-patch-defect'].includes(artifact.role), 'rejected-catalog', 'Artifact role is invalid');
  assert(validSha(artifact.targetArtifactDigest) && validSha(artifact.evaluationContractKey), 'rejected-catalog', 'Artifact digest or evaluation contract key is invalid');
  return artifact;
}

function actionValidator(descriptor) {
  const validator = ARGUMENT_VALIDATORS[descriptor.moduleId];
  assert(typeof validator === 'function', 'rejected-catalog', `No pure argument validator is registered for module: ${descriptor.moduleId}`);
  return validator;
}

function validateAction(action, descriptor, bindings, label, { instance = false } = {}) {
  const keys = instance
    ? ['instanceId', 'actionId', 'adapterId', 'argumentSchemaId', 'actor', 'arguments', 'bind']
    : ['actionId', 'actor', 'arguments', 'bind'];
  strictKeys(action, keys, label);
  const registration = descriptor.actions.find((item) => item.id === action.actionId);
  assert(registration !== undefined, 'rejected-catalog', `${label} action is not registered: ${action.actionId}`);
  if (instance) {
    assert(validId(action.instanceId), 'rejected-schema', `${label} instanceId is invalid`);
    assert(action.adapterId === registration.adapterId && action.argumentSchemaId === registration.argumentSchemaId, 'rejected-policy', `${label} adapter binding changed`);
  }
  assert(validId(action.actor), 'rejected-schema', `${label} actor is invalid`);
  validateJsonValueLimits(action.arguments);
  const adapterAction = instance ? action : { ...action, adapterId: registration.adapterId };
  try {
    actionValidator(descriptor)({ action: adapterAction, bindings, policy: null });
  } catch (error) {
    fail('rejected-policy', `${label} arguments violate ${registration.argumentSchemaId}: ${error.message}`);
  }
  if (registration.bindingOutputType === null) {
    assert(action.bind === null, 'rejected-policy', `${label} cannot declare a binding`);
  } else {
    strictKeys(action.bind, ['name', 'type'], `${label} binding`);
    assert(validId(action.bind.name), 'rejected-schema', `${label} binding name is invalid`);
    assert(action.bind.type === registration.bindingOutputType, 'rejected-policy', `${label} binding type mismatch`);
    assert(!bindings.has(action.bind.name), 'rejected-policy', `${label} binding is duplicated`);
    bindings.set(action.bind.name, { type: action.bind.type, value: null });
  }
  return registration;
}

export function validateBenchmarkSeed(seed, descriptor) {
  validateDescriptor(descriptor);
  strictKeys(seed, ['schemaVersion', 'catalogVersion', 'id', 'invariantId', 'actors', 'actions'], 'NightmareSeed');
  assert(seed.schemaVersion === SEED_SCHEMA_VERSION, 'rejected-schema', 'Unexpected NightmareSeed schemaVersion');
  assert(seed.catalogVersion === descriptor.catalogVersion, 'rejected-catalog', 'NightmareSeed catalogVersion mismatch');
  assert(validId(seed.id), 'rejected-schema', 'NightmareSeed id is invalid');
  assert(descriptor.invariants.some((item) => item.id === seed.invariantId), 'rejected-catalog', `Unknown invariant: ${seed.invariantId}`);
  assert(Array.isArray(seed.actors) && seed.actors.length > 0 && seed.actors.length <= WIRE_LIMITS.actors, 'rejected-schema', 'NightmareSeed actor count is invalid');
  unique(seed.actors, 'actor');
  for (const actor of seed.actors) {
    assert(validId(actor), 'rejected-schema', `Actor is invalid: ${actor}`);
    assert(!RESERVED_ACTORS.has(actor) && !actor.startsWith('__'), 'rejected-policy', `Actor is reserved: ${actor}`);
  }
  assert(Array.isArray(seed.actions) && seed.actions.length > 0 && seed.actions.length <= WIRE_LIMITS.actions, 'rejected-schema', 'NightmareSeed action count is invalid');
  const bindings = new Map();
  for (const [index, action] of seed.actions.entries()) {
    const registration = validateAction(action, descriptor, bindings, `Action ${index}`);
    assert(seed.actors.includes(action.actor), 'rejected-policy', `Action actor is not declared: ${action.actor}`);
    assert(registration.importSpecifier === descriptor.actions.find((item) => item.id === action.actionId).importSpecifier, 'rejected-catalog', `Action public import changed: ${action.actionId}`);
  }
  return seed;
}

export function parseBenchmarkSeed(bytes, descriptor) {
  try {
    return validateBenchmarkSeed(parseJsonBytes(bytes), descriptor);
  } catch (error) {
    if (error instanceof V03SpecError) throw error;
    fail('rejected-schema', error.message);
  }
}

export function benchmarkSeedDigest(seed, descriptor) {
  validateBenchmarkSeed(seed, descriptor);
  return domainDigest(BENCHMARK_SEED_DIGEST_DOMAIN, seed);
}

function pointerValue(value, pointer, label) {
  if (pointer === '') return structuredClone(value);
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    assert(isPlainObject(current) || Array.isArray(current), 'rejected-policy', `${label} does not resolve`);
    assert(Object.hasOwn(current, token), 'rejected-policy', `${label} does not resolve`);
    current = current[token];
  }
  return structuredClone(current);
}

function fixturePayload(descriptor, fixture, action) {
  if (Object.hasOwn(fixture, 'payloadArgumentPointer')) {
    return pointerValue(action.arguments, fixture.payloadArgumentPointer, `Fixture ${fixture.id} payloadArgumentPointer`);
  }
  fail('rejected-catalog', `Fixture has no trusted data materialization: ${fixture.id}`);
}

function fixtureDomains(moduleId) {
  return moduleId === 'tx'
    ? { registration: BENCHMARK_FIXTURE_REGISTRATION_DOMAIN, state: BENCHMARK_FIXTURE_STATE_DOMAIN, registrationIncludesPayload: false }
    : { registration: 'bug-dreamer/v03-benchmark-fixture-registration/v1', state: 'bug-dreamer/v03-benchmark-fixture-state/v1', registrationIncludesPayload: true };
}

function fixtureRecords(actions, descriptor, artifact) {
  const records = [];
  const domains = fixtureDomains(descriptor.moduleId);
  for (const action of actions) {
    for (const fixture of descriptor.fixtures.filter((item) => item.consumerActionId === action.actionId)) {
      const payload = fixturePayload(descriptor, fixture, action);
      validateJsonValueLimits(payload);
      const registrationValue = domains.registrationIncludesPayload ? { ...fixture, canonicalWirePayload: payload } : fixture;
      records.push({
        registrationId: fixture.id,
        registrationDigest: domainDigest(domains.registration, registrationValue),
        kind: fixture.kind,
        producerArtifact: { moduleRegistrationId: descriptor.moduleId, targetArtifactDigest: artifact.targetArtifactDigest },
        publicActionTrace: Object.hasOwn(fixture, 'publicActionTrace') ? structuredClone(fixture.publicActionTrace) : [],
        canonicalWirePayload: payload,
        materializerId: fixture.materializerId,
        stateDigest: domainDigest(domains.state, payload),
        consumerActionInstanceId: action.instanceId,
      });
    }
  }
  assert(records.length <= WIRE_LIMITS.fixtures, 'rejected-schema', 'NightmareSpec fixture count is invalid');
  return records;
}

function baseActions(seed, descriptor) {
  return seed.actions.map((action, index) => {
    const registration = descriptor.actions.find((item) => item.id === action.actionId);
    return {
      instanceId: `action-${String(index + 1).padStart(4, '0')}`,
      actionId: action.actionId,
      adapterId: registration.adapterId,
      argumentSchemaId: registration.argumentSchemaId,
      actor: action.actor,
      arguments: structuredClone(action.arguments),
      bind: structuredClone(action.bind),
    };
  });
}

function transformationStateDigest(state) {
  return domainDigest(TRANSFORMATION_STATE_DOMAIN, { actions: state.actions, scheduleControls: state.scheduleControls });
}

function applyBenchmarkOperator(registration, args, state, descriptor) {
  assert(descriptor.moduleId === 'tx', 'rejected-policy', `${registration.id} is not applicable to module ${descriptor.moduleId}`);
  if (registration.id === 'time.advance/v1') {
    strictKeys(args, ['afterInstanceId', 'advanceMs'], 'time.advance arguments');
    assert(Number.isSafeInteger(args.advanceMs), 'rejected-schema', 'time.advance advanceMs must be a safe integer');
    assert(args.advanceMs >= registration.bounds.advanceMsMin && args.advanceMs <= registration.bounds.advanceMsMax, 'rejected-policy', 'time.advance advanceMs is outside the registered bounds');
    assert(state.actions.some((item) => item.instanceId === args.afterInstanceId), 'rejected-policy', 'time.advance references an unknown action instance');
    state.scheduleControls.push({ kind: 'virtual-time-advance', afterInstanceId: args.afterInstanceId, advanceMs: args.advanceMs });
    return;
  }
  if (registration.id === 'schedule.release-order/v1') {
    strictKeys(args, ['instanceIds'], 'schedule.release-order arguments');
    assert(Array.isArray(args.instanceIds) && args.instanceIds.length >= 2, 'rejected-schema', 'schedule.release-order requires at least two instance IDs');
    unique(args.instanceIds, 'release-order instance');
    for (const instanceId of args.instanceIds) {
      const action = state.actions.find((item) => item.instanceId === instanceId);
      assert(action?.adapterId === 'tx.run-scripted/v2' && action.arguments.gate !== null, 'rejected-policy', `schedule.release-order references an ungated action: ${instanceId}`);
    }
    state.scheduleControls.push({ kind: 'completion-release-order', instanceIds: structuredClone(args.instanceIds) });
    return;
  }
  strictKeys(args, ['targetInstanceId', 'outcome', 'value', 'errorName', 'errorMessage'], 'fault.step-outcome arguments');
  const action = state.actions.find((item) => item.instanceId === args.targetInstanceId);
  assert(action?.adapterId === 'tx.run-scripted/v2', 'rejected-policy', 'fault.step-outcome must target tx.run-scripted');
  assert(['return', 'throw'].includes(args.outcome), 'rejected-schema', 'fault.step-outcome outcome is invalid');
  const outcome = args.outcome === 'return'
    ? { kind: 'return', value: args.value }
    : { kind: 'throw', errorName: args.errorName, errorMessage: args.errorMessage };
  if (args.outcome === 'return') {
    validateJsonValueLimits(args.value);
    assert(args.errorName === null && args.errorMessage === null, 'rejected-policy', 'fault.step-outcome return cannot define an error');
  } else {
    assert(args.value === null, 'rejected-policy', 'fault.step-outcome throw cannot define a return value');
  }
  action.arguments = { ...action.arguments, attemptOutcomes: [outcome], retry: null };
}

export function validateBenchmarkTransformationRequest(request) {
  strictKeys(request, ['schemaVersion', 'transformations'], 'Transformation request');
  assert(request.schemaVersion === BENCHMARK_REQUEST_SCHEMA_VERSION, 'rejected-schema', 'Unexpected transformation request schemaVersion');
  assert(Array.isArray(request.transformations) && request.transformations.length >= 1 && request.transformations.length <= TRANSFORMATION_LIMIT, 'rejected-schema', 'Transformation request length is invalid');
  for (const [index, entry] of request.transformations.entries()) {
    strictKeys(entry, ['operatorId', 'arguments'], `Transformation request entry ${index}`);
    assert(Object.hasOwn(OPERATORS, entry.operatorId), 'rejected-catalog', `Operator is not registered: ${entry.operatorId}`);
    validateJsonValueLimits(entry.arguments);
  }
  return request;
}

function composeSpec(seed, descriptor, artifact, request) {
  validateBenchmarkSeed(seed, descriptor);
  validateArtifact(artifact);
  const base = baseActions(seed, descriptor);
  const state = { actions: structuredClone(base), scheduleControls: [] };
  const transformations = [];
  if (request !== null) {
    validateBenchmarkTransformationRequest(request);
    let beforeDigest = transformationStateDigest(state);
    for (const entry of request.transformations) {
      const registration = OPERATORS[entry.operatorId];
      applyBenchmarkOperator(registration, entry.arguments, state, descriptor);
      const afterDigest = transformationStateDigest(state);
      transformations.push({ operatorId: registration.id, operatorRegistrationDigest: domainDigest(BENCHMARK_OPERATOR_REGISTRATION_DOMAIN, registration), arguments: structuredClone(entry.arguments), beforeDigest, afterDigest });
      beforeDigest = afterDigest;
    }
  }
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    seedDigest: benchmarkSeedDigest(seed, descriptor),
    targetRegistrationId: descriptor.id,
    invariantRegistrationId: seed.invariantId,
    catalogVersion: descriptor.catalogVersion,
    actors: structuredClone(seed.actors),
    baseActions: base,
    transformedActions: state.actions,
    transformations,
    scheduleControls: state.scheduleControls,
    fixtures: fixtureRecords(state.actions, descriptor, artifact),
    canonicalizer: CANONICALIZER,
  };
}

export function buildBenchmarkSpec(seed, descriptor, artifact) {
  return validateBenchmarkSpec(composeSpec(seed, descriptor, artifact, null), descriptor, artifact);
}

export function buildTransformedBenchmarkSpec(seed, request, descriptor, artifact) {
  return validateBenchmarkSpec(composeSpec(seed, descriptor, artifact, request), descriptor, artifact);
}

function validateScheduleControl(control, actions, index) {
  assert(isPlainObject(control) && typeof control.kind === 'string', 'rejected-schema', `Schedule control ${index} is invalid`);
  if (control.kind === 'virtual-time-advance') {
    strictKeys(control, ['kind', 'afterInstanceId', 'advanceMs'], `Schedule control ${index}`);
    assert(actions.some((item) => item.instanceId === control.afterInstanceId) && Number.isSafeInteger(control.advanceMs) && control.advanceMs >= 1 && control.advanceMs <= 86_400_000, 'rejected-policy', `Schedule control ${index} is outside policy`);
    return;
  }
  if (control.kind === 'completion-release-order') {
    strictKeys(control, ['kind', 'instanceIds'], `Schedule control ${index}`);
    assert(Array.isArray(control.instanceIds) && control.instanceIds.length >= 2, 'rejected-schema', `Schedule control ${index} is invalid`);
    unique(control.instanceIds, 'release-order instance');
    for (const id of control.instanceIds) assert(actions.some((item) => item.instanceId === id && item.adapterId === 'tx.run-scripted/v2' && item.arguments.gate !== null), 'rejected-policy', `Schedule control ${index} references an ungated action`);
    return;
  }
  fail('rejected-catalog', `Schedule control kind is not registered: ${control.kind}`);
}

export function validateBenchmarkSpec(spec, descriptor, artifact = { role: 'clean', targetArtifactDigest: spec?.fixtures?.[0]?.producerArtifact?.targetArtifactDigest ?? '0'.repeat(64), evaluationContractKey: '0'.repeat(64) }) {
  validateDescriptor(descriptor);
  validateArtifact(artifact);
  strictKeys(spec, ['schemaVersion', 'seedDigest', 'targetRegistrationId', 'invariantRegistrationId', 'catalogVersion', 'actors', 'baseActions', 'transformedActions', 'transformations', 'scheduleControls', 'fixtures', 'canonicalizer'], 'NightmareSpec');
  assert(spec.schemaVersion === SPEC_SCHEMA_VERSION && validSha(spec.seedDigest), 'rejected-schema', 'NightmareSpec identity is invalid');
  assert(spec.targetRegistrationId === descriptor.id && spec.catalogVersion === descriptor.catalogVersion, 'rejected-catalog', 'NightmareSpec registration mismatch');
  assert(descriptor.invariants.some((item) => item.id === spec.invariantRegistrationId), 'rejected-catalog', 'NightmareSpec invariant is not registered');
  assert(Array.isArray(spec.actors) && spec.actors.length > 0 && spec.actors.length <= WIRE_LIMITS.actors, 'rejected-schema', 'NightmareSpec actors are invalid');
  unique(spec.actors, 'spec actor');
  for (const actor of spec.actors) assert(validId(actor) && !RESERVED_ACTORS.has(actor) && !actor.startsWith('__'), 'rejected-policy', `Spec actor is invalid or reserved: ${actor}`);
  assert(Array.isArray(spec.baseActions) && spec.baseActions.length > 0 && spec.baseActions.length <= WIRE_LIMITS.actions, 'rejected-schema', 'NightmareSpec base actions are invalid');
  assert(Array.isArray(spec.transformedActions) && spec.transformedActions.length === spec.baseActions.length, 'rejected-schema', 'NightmareSpec transformed actions are invalid');
  const baseBindings = new Map();
  for (const [index, action] of spec.baseActions.entries()) {
    assert(action.instanceId === `action-${String(index + 1).padStart(4, '0')}`, 'rejected-policy', `Spec action instanceId is unstable: ${action.instanceId}`);
    assert(spec.actors.includes(action.actor), 'rejected-policy', `Spec action actor is not declared: ${action.actor}`);
    validateAction(action, descriptor, baseBindings, `Spec action ${index}`, { instance: true });
  }
  assert(Array.isArray(spec.transformations) && spec.transformations.length <= TRANSFORMATION_LIMIT, 'rejected-schema', 'NightmareSpec transformations are invalid');
  assert(Array.isArray(spec.scheduleControls) && spec.scheduleControls.length <= WIRE_LIMITS.scheduleControls, 'rejected-schema', 'NightmareSpec schedule controls are invalid');
  if (spec.transformations.length === 0) {
    assert(canonicalJson(spec.transformedActions) === canonicalJson(spec.baseActions) && spec.scheduleControls.length === 0, 'rejected-policy', 'Identity transformation state changed');
  } else {
    const replay = { actions: structuredClone(spec.baseActions), scheduleControls: [] };
    let beforeDigest = transformationStateDigest(replay);
    for (const [index, record] of spec.transformations.entries()) {
      strictKeys(record, ['operatorId', 'operatorRegistrationDigest', 'arguments', 'beforeDigest', 'afterDigest'], `Transformation ${index}`);
      const registration = OPERATORS[record.operatorId];
      assert(registration !== undefined, 'rejected-catalog', `Transformation operator is not registered: ${record.operatorId}`);
      assert(record.operatorRegistrationDigest === domainDigest(BENCHMARK_OPERATOR_REGISTRATION_DOMAIN, registration), 'rejected-policy', `Transformation ${index} registration digest mismatch`);
      assert(record.beforeDigest === beforeDigest && validSha(record.afterDigest), 'rejected-policy', `Transformation ${index} breaks the digest chain`);
      applyBenchmarkOperator(registration, record.arguments, replay, descriptor);
      beforeDigest = transformationStateDigest(replay);
      assert(record.afterDigest === beforeDigest, 'rejected-policy', `Transformation ${index} state digest mismatch`);
    }
    assert(canonicalJson(replay.actions) === canonicalJson(spec.transformedActions) && canonicalJson(replay.scheduleControls) === canonicalJson(spec.scheduleControls), 'rejected-policy', 'Transformed state does not replay');
  }
  const transformedBindings = new Map();
  for (const [index, action] of spec.transformedActions.entries()) {
    const base = spec.baseActions[index];
    assert(action.instanceId === base.instanceId && action.actionId === base.actionId && action.actor === base.actor && canonicalJson(action.bind) === canonicalJson(base.bind), 'rejected-policy', `Transformed action ${index} changes identity or binding`);
    validateAction(action, descriptor, transformedBindings, `Transformed action ${index}`, { instance: true });
  }
  for (const [index, control] of spec.scheduleControls.entries()) validateScheduleControl(control, spec.transformedActions, index);
  const expectedFixtures = fixtureRecords(spec.transformedActions, descriptor, artifact);
  assert(canonicalJson(spec.fixtures) === canonicalJson(expectedFixtures), 'rejected-policy', 'NightmareSpec fixture provenance or state changed');
  assert(canonicalJson(spec.canonicalizer) === canonicalJson(CANONICALIZER), 'rejected-policy', 'NightmareSpec canonicalizer changed');
  return spec;
}

export function benchmarkSpecDigest(spec, descriptor, artifact) {
  validateBenchmarkSpec(spec, descriptor, artifact);
  return domainDigest(SPEC_DIGEST_DOMAIN, spec);
}

export function buildBenchmarkPlan(spec, descriptor, artifact) {
  validateBenchmarkSpec(spec, descriptor, artifact);
  const invariant = descriptor.invariants.find((item) => item.id === spec.invariantRegistrationId);
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    specDigest: benchmarkSpecDigest(spec, descriptor, artifact),
    targetRegistrationId: descriptor.id,
    invariantRegistrationId: invariant.id,
    targetArtifactDigest: artifact.targetArtifactDigest,
    evaluatorId: invariant.evaluatorId,
    normalizedObservedKind: invariant.normalizedObservedKind,
    observedFields: structuredClone(invariant.observedFields),
    actions: spec.transformedActions.map((action) => ({ instanceId: action.instanceId, actionId: action.actionId, adapterId: action.adapterId, actor: action.actor, arguments: structuredClone(action.arguments), bind: structuredClone(action.bind) })),
    bindings: spec.transformedActions.filter((item) => item.bind !== null).map((item) => ({ name: item.bind.name, type: item.bind.type, producerActionInstanceId: item.instanceId })),
    fixtureSetup: structuredClone(spec.fixtures),
    virtualTime: { originMs: VIRTUAL_TIME_ORIGIN_MS },
    scheduleControls: structuredClone(spec.scheduleControls),
  };
  return validateBenchmarkPlan(plan, spec, descriptor, artifact);
}

export function validateBenchmarkPlan(plan, spec, descriptor, artifact = { role: 'clean', targetArtifactDigest: plan?.targetArtifactDigest, evaluationContractKey: '0'.repeat(64) }) {
  validateBenchmarkSpec(spec, descriptor, artifact);
  strictKeys(plan, ['schemaVersion', 'specDigest', 'targetRegistrationId', 'invariantRegistrationId', 'targetArtifactDigest', 'evaluatorId', 'normalizedObservedKind', 'observedFields', 'actions', 'bindings', 'fixtureSetup', 'virtualTime', 'scheduleControls'], 'ExecutionPlan');
  assert(plan.schemaVersion === PLAN_SCHEMA_VERSION, 'rejected-schema', 'Unexpected ExecutionPlan schemaVersion');
  assert(plan.specDigest === benchmarkSpecDigest(spec, descriptor, artifact), 'rejected-policy', 'ExecutionPlan specDigest mismatch');
  assert(plan.targetRegistrationId === descriptor.id && plan.targetArtifactDigest === artifact.targetArtifactDigest, 'rejected-catalog', 'ExecutionPlan target mismatch');
  const invariant = descriptor.invariants.find((item) => item.id === spec.invariantRegistrationId);
  assert(plan.invariantRegistrationId === invariant.id && plan.evaluatorId === invariant.evaluatorId, 'rejected-catalog', 'ExecutionPlan invariant mismatch');
  assert(plan.normalizedObservedKind === invariant.normalizedObservedKind && canonicalJson(plan.observedFields) === canonicalJson(invariant.observedFields), 'rejected-policy', 'ExecutionPlan observed contract changed');
  const expectedActions = spec.transformedActions.map((action) => ({ instanceId: action.instanceId, actionId: action.actionId, adapterId: action.adapterId, actor: action.actor, arguments: action.arguments, bind: action.bind }));
  assert(canonicalJson(plan.actions) === canonicalJson(expectedActions), 'rejected-policy', 'ExecutionPlan actions changed');
  const expectedBindings = spec.transformedActions.filter((item) => item.bind !== null).map((item) => ({ name: item.bind.name, type: item.bind.type, producerActionInstanceId: item.instanceId }));
  assert(canonicalJson(plan.bindings) === canonicalJson(expectedBindings), 'rejected-policy', 'ExecutionPlan bindings changed');
  assert(canonicalJson(plan.fixtureSetup) === canonicalJson(spec.fixtures), 'rejected-policy', 'ExecutionPlan fixture setup changed');
  strictKeys(plan.virtualTime, ['originMs'], 'ExecutionPlan virtualTime');
  assert(plan.virtualTime.originMs === VIRTUAL_TIME_ORIGIN_MS, 'rejected-policy', 'ExecutionPlan virtual time origin changed');
  assert(canonicalJson(plan.scheduleControls) === canonicalJson(spec.scheduleControls), 'rejected-policy', 'ExecutionPlan schedule controls changed');
  return plan;
}

export function benchmarkPlanDigest(plan, spec, descriptor, artifact) {
  validateBenchmarkPlan(plan, spec, descriptor, artifact);
  return domainDigest(PLAN_DIGEST_DOMAIN, plan);
}
