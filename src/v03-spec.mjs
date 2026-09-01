import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  WIRE_LIMITS,
  canonicalJson,
  domainDigest,
  parseJsonBytes,
  validateJsonValueLimits,
} from './v03-wire.mjs';

export const PHASE2_CATALOG_PATH = 'registrations/v0.3/phase2-catalog.json';
export const SEED_SCHEMA_VERSION = 'bug-dreamer/nightmare-seed/v1';
export const SPEC_SCHEMA_VERSION = 'bug-dreamer/nightmare-spec/v1';
export const PLAN_SCHEMA_VERSION = 'bug-dreamer/execution-plan/v1';
export const SPEC_DIGEST_DOMAIN = 'bug-dreamer/nightmare-spec/v1';
export const PLAN_DIGEST_DOMAIN = 'bug-dreamer/execution-plan/v1';
const SEED_DIGEST_DOMAIN = 'bug-dreamer/nightmare-seed/v1';
const FIXTURE_DIGEST_DOMAIN = 'bug-dreamer/fixture-state/v1';
const TARGET_REVISION = 'f624b09f148c3368a51807f48d3237db20cef9c6';
const RESERVED_ACTORS = new Set(['system', 'host', 'evaluator', 'target', 'result']);
const ACTION_IDS = ['tx.commit', 'tx.run', 'tx.start'];
const INVARIANT_CONTRACTS = Object.freeze({
  'tx.original-error-propagation': {
    evaluatorId: 'tx.original-error-propagation/v1',
    sourceKind: 'documentation',
    sourceRef: 'packages/tx/README.md#automatic-rollback',
    normalizedObservedKind: 'thrown-error',
    observedFields: [{ name: 'name', type: 'string' }, { name: 'message', type: 'string' }],
  },
  'tx.successful-step-return': {
    evaluatorId: 'tx.successful-step-return/v1',
    sourceKind: 'existing-test',
    sourceRef: 'packages/tx/tests/transaction.test.ts#should-execute-a-single-step-successfully',
    normalizedObservedKind: 'returned-value',
    observedFields: [{ name: 'value', type: 'json' }],
  },
});
const INVARIANT_IDS = Object.keys(INVARIANT_CONTRACTS);
const OUTCOME_BY_OBSERVED_KIND = Object.freeze({
  'thrown-error': 'throw',
  'returned-value': 'return',
});
export const ACTION_POLICY_LIMITS = Object.freeze({
  startTimeoutMs: 10000,
  retryMaxAttempts: 5,
  retryDelayMs: 1000,
});
export const TRANSFORMATION_STATE_DOMAIN = 'bug-dreamer/transformation-state/v1';
export const VIRTUAL_TIME_ORIGIN_MS = 1000000000000;
export const TRANSFORMATION_LIMIT = 16;
export const VIRTUAL_TIME_ADVANCE_LIMITS = Object.freeze({ minMs: 1, maxMs: 86400000 });

export class V03SpecError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function fail(kind, message) {
  throw new V03SpecError(kind, message);
}

function assert(condition, kind, message) {
  if (!condition) fail(kind, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictKeys(value, required, optional, label, kind = 'rejected-schema') {
  assert(isPlainObject(value), kind, `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) assert(allowed.has(key), kind, `${label} has unknown field: ${key}`);
  for (const key of required) assert(Object.hasOwn(value, key), kind, `${label} is missing field: ${key}`);
}

function unique(values, label, kind = 'rejected-catalog') {
  assert(new Set(values).size === values.length, kind, `Duplicate ${label}`);
}

function validId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value);
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateBindingReference(value, bindings, expectedType, label) {
  strictKeys(value, ['$binding'], [], label);
  assert(validId(value.$binding), 'rejected-schema', `${label} binding name is invalid`);
  const binding = bindings.get(value.$binding);
  assert(binding !== undefined, 'rejected-policy', `${label} binding is missing or forward-referenced`);
  assert(binding === expectedType, 'rejected-policy', `${label} binding type mismatch`);
}

function validateRetry(value) {
  if (value === null) return;
  strictKeys(value, ['maxAttempts', 'delayMs', 'backoff'], [], 'tx.run retry');
  assert(Number.isSafeInteger(value.maxAttempts) && value.maxAttempts >= 0, 'rejected-schema', 'tx.run maxAttempts must be a safe non-negative integer');
  assert(Number.isSafeInteger(value.delayMs) && value.delayMs >= 0, 'rejected-schema', 'tx.run delayMs must be a safe non-negative integer');
  assert(value.maxAttempts <= ACTION_POLICY_LIMITS.retryMaxAttempts, 'rejected-policy', 'tx.run maxAttempts exceeds the retry budget');
  assert(value.delayMs <= ACTION_POLICY_LIMITS.retryDelayMs, 'rejected-policy', 'tx.run delayMs exceeds the retry budget');
  assert(['linear', 'exponential'].includes(value.backoff), 'rejected-schema', 'tx.run backoff is invalid');
}

function validateActionArguments(actionId, args, bindings) {
  if (actionId === 'tx.start') {
    strictKeys(args, ['transactionId', 'timeoutMs', 'transition'], [], 'tx.start arguments');
    assert(typeof args.transactionId === 'string', 'rejected-schema', 'tx.start transactionId must be a string');
    assert(Number.isSafeInteger(args.timeoutMs) && args.timeoutMs >= 0, 'rejected-schema', 'tx.start timeoutMs must be a safe non-negative integer');
    assert(args.timeoutMs <= ACTION_POLICY_LIMITS.startTimeoutMs, 'rejected-policy', 'tx.start timeoutMs exceeds the policy limit');
    assert(typeof args.transition === 'boolean', 'rejected-schema', 'tx.start transition must be boolean');
    return;
  }
  if (actionId === 'tx.run') {
    strictKeys(args, ['tx', 'outcome', 'value', 'errorName', 'errorMessage', 'log', 'retry'], [], 'tx.run arguments');
    validateBindingReference(args.tx, bindings, 'tx-handle', 'tx.run tx');
    assert(['return', 'throw'].includes(args.outcome), 'rejected-schema', 'tx.run outcome is invalid');
    assert(args.log === null || typeof args.log === 'string', 'rejected-schema', 'tx.run log must be null or string');
    validateRetry(args.retry);
    if (args.outcome === 'return') {
      validateJsonValueLimits(args.value);
      assert(args.errorName === null && args.errorMessage === null, 'rejected-policy', 'return action cannot define an error');
    } else {
      assert(args.value === null, 'rejected-policy', 'throw action cannot define a return value');
      assert(['Error', 'TypeError'].includes(args.errorName), 'rejected-schema', 'tx.run errorName is invalid');
      assert(typeof args.errorMessage === 'string', 'rejected-schema', 'tx.run errorMessage must be a string');
    }
    return;
  }
  if (actionId === 'tx.commit') {
    strictKeys(args, ['tx'], [], 'tx.commit arguments');
    validateBindingReference(args.tx, bindings, 'tx-handle', 'tx.commit tx');
    return;
  }
  fail('rejected-catalog', `Unknown action: ${actionId}`);
}

function validateInvariantApplicability(invariant, actions, scheduleControls, label) {
  const finalRun = actions.findLast((action) => action.actionId === 'tx.run');
  assert(finalRun !== undefined, 'rejected-policy', `${label} invariant requires a tx.run action: ${invariant.id}`);
  const expectedOutcome = invariant.applicability === undefined
    ? OUTCOME_BY_OBSERVED_KIND[invariant.normalizedObservedKind]
    : invariant.applicability.finalRunOutcome;
  assert(finalRun.arguments.outcome === expectedOutcome, 'rejected-policy', `${label} invariant is not applicable to the final tx.run outcome: ${invariant.id}`);
  if (scheduleControls === null || invariant.applicability?.requires !== 'virtual-advance-past-timeout') return;
  const totalAdvanceMs = scheduleControls
    .filter((control) => control.kind === 'virtual-time-advance')
    .reduce((sum, control) => sum + control.advanceMs, 0);
  const producer = actions.find((action) => action.actionId === 'tx.start' && action.bind !== null && action.bind.name === finalRun.arguments.tx.$binding);
  assert(producer !== undefined, 'rejected-policy', `${label} invariant requires the final tx.run transaction producer: ${invariant.id}`);
  assert(totalAdvanceMs > producer.arguments.timeoutMs, 'rejected-policy', `${label} total virtual-time advance must exceed the transaction timeout: ${invariant.id}`);
}

export function stateDigest(actions, scheduleControls) {
  return domainDigest(TRANSFORMATION_STATE_DOMAIN, { actions, scheduleControls });
}

function validateScheduleControl(control, actions, index) {
  const label = `Schedule control ${index}`;
  assert(isPlainObject(control) && typeof control.kind === 'string', 'rejected-schema', `${label} must declare a kind`);
  const instanceIds = new Set(actions.map((action) => action.instanceId));
  if (control.kind === 'virtual-time-advance') {
    strictKeys(control, ['kind', 'afterInstanceId', 'advanceMs'], [], label);
    assert(Number.isSafeInteger(control.advanceMs), 'rejected-schema', `${label} advanceMs must be a safe integer`);
    assert(control.advanceMs >= VIRTUAL_TIME_ADVANCE_LIMITS.minMs && control.advanceMs <= VIRTUAL_TIME_ADVANCE_LIMITS.maxMs, 'rejected-policy', `${label} advanceMs is outside the registered bounds`);
    assert(instanceIds.has(control.afterInstanceId), 'rejected-policy', `${label} references an unknown action instance`);
    return;
  }
  if (control.kind === 'completion-release-order') {
    strictKeys(control, ['kind', 'instanceIds'], [], label);
    assert(Array.isArray(control.instanceIds) && control.instanceIds.length >= 2, 'rejected-schema', `${label} requires at least two instance IDs`);
    unique(control.instanceIds, 'release-order instance', 'rejected-schema');
    const runIds = new Set(actions.filter((action) => action.actionId === 'tx.run').map((action) => action.instanceId));
    for (const instanceId of control.instanceIds) {
      assert(runIds.has(instanceId), 'rejected-policy', `${label} references a non-run action instance: ${instanceId}`);
    }
    return;
  }
  fail('rejected-catalog', `${label} kind is not registered: ${control.kind}`);
}

export const OPERATOR_REGISTRATION_DOMAIN = 'bug-dreamer/operator-registration/v1';

export function applyOperatorRecord(registration, args, state) {
  if (registration.id === 'time.advance/v1') {
    strictKeys(args, ['afterInstanceId', 'advanceMs'], [], 'time.advance arguments');
    assert(Number.isSafeInteger(args.advanceMs), 'rejected-schema', 'time.advance advanceMs must be a safe integer');
    assert(args.advanceMs >= registration.bounds.advanceMsMin && args.advanceMs <= registration.bounds.advanceMsMax, 'rejected-policy', 'time.advance advanceMs is outside the registered bounds');
    assert(state.actions.some((action) => action.instanceId === args.afterInstanceId), 'rejected-policy', `time.advance references an unknown action instance: ${args.afterInstanceId}`);
    state.scheduleControls.push({ kind: 'virtual-time-advance', afterInstanceId: args.afterInstanceId, advanceMs: args.advanceMs });
    return;
  }
  if (registration.id === 'schedule.release-order/v1') {
    strictKeys(args, ['instanceIds'], [], 'schedule.release-order arguments');
    assert(Array.isArray(args.instanceIds) && args.instanceIds.length >= registration.bounds.minInstanceIds, 'rejected-schema', 'schedule.release-order requires at least two instance IDs');
    assert(new Set(args.instanceIds).size === args.instanceIds.length, 'rejected-schema', 'schedule.release-order instance IDs must be distinct');
    for (const instanceId of args.instanceIds) {
      assert(state.actions.some((action) => action.instanceId === instanceId && action.actionId === 'tx.run'), 'rejected-policy', `schedule.release-order references a non-run action instance: ${instanceId}`);
    }
    state.scheduleControls.push({ kind: 'completion-release-order', instanceIds: args.instanceIds });
    return;
  }
  if (registration.id === 'fault.step-outcome/v1') {
    strictKeys(args, ['targetInstanceId', 'outcome', 'value', 'errorName', 'errorMessage'], [], 'fault.step-outcome arguments');
    const target = state.actions.find((action) => action.instanceId === args.targetInstanceId);
    assert(target !== undefined && target.actionId === 'tx.run', 'rejected-policy', `fault.step-outcome must target a tx.run instance: ${args.targetInstanceId}`);
    assert(['return', 'throw'].includes(args.outcome), 'rejected-schema', 'fault.step-outcome outcome is invalid');
    target.arguments = {
      tx: target.arguments.tx,
      outcome: args.outcome,
      value: args.value,
      errorName: args.errorName,
      errorMessage: args.errorMessage,
      log: target.arguments.log,
      retry: target.arguments.retry,
    };
    return;
  }
  fail('rejected-catalog', `Operator has no registered application: ${registration.id}`);
}

export function validatePhase2Catalog(catalog) {
  strictKeys(catalog, ['schemaVersion', 'catalogVersion', 'target', 'actions', 'invariants', 'fixtures'], [], 'Phase 2 catalog', 'rejected-catalog');
  assert(catalog.schemaVersion === 'bug-dreamer/phase2-catalog/v1', 'rejected-catalog', 'Unexpected Phase 2 catalog schemaVersion');
  assert(catalog.catalogVersion === 'firsttx-phase2-f624b09-v1', 'rejected-catalog', 'Unexpected Phase 2 catalogVersion');
  strictKeys(catalog.target, ['registrationId', 'registrationPath', 'registrationSha256', 'moduleId', 'packageName', 'importSpecifier', 'targetRevision', 'artifactSha256'], [], 'Catalog target', 'rejected-catalog');
  assert(catalog.target.registrationId === 'firsttx-public-packages-f624b09-v1', 'rejected-catalog', 'Catalog target registration changed');
  assert(catalog.target.registrationPath === 'registrations/v0.3/packages.json', 'rejected-catalog', 'Catalog registration path changed');
  assert(validSha(catalog.target.registrationSha256) && validSha(catalog.target.artifactSha256), 'rejected-catalog', 'Catalog target digest is invalid');
  assert(catalog.target.moduleId === 'tx' && catalog.target.packageName === '@firsttx/tx' && catalog.target.importSpecifier === '@firsttx/tx', 'rejected-catalog', 'Catalog target module changed');
  assert(catalog.target.targetRevision === TARGET_REVISION, 'rejected-catalog', 'Catalog target revision changed');

  assert(Array.isArray(catalog.actions) && catalog.actions.length === 3, 'rejected-catalog', 'Phase 2 catalog must contain three actions');
  unique(catalog.actions.map((item) => item.id), 'action id');
  assert(JSON.stringify(catalog.actions.map((item) => item.id).sort()) === JSON.stringify(ACTION_IDS), 'rejected-catalog', 'Phase 2 action universe changed');
  for (const action of catalog.actions) {
    strictKeys(action, ['id', 'actorKind', 'adapterId', 'argumentSchemaId', 'bindingOutputType'], [], `Action ${action.id}`, 'rejected-catalog');
    assert(action.actorKind === 'transaction' && validId(action.id), 'rejected-catalog', `Action registration is invalid: ${action.id}`);
    assert(typeof action.adapterId === 'string' && action.adapterId === `${action.id}/v1`, 'rejected-catalog', `Action adapter is invalid: ${action.id}`);
    assert(typeof action.argumentSchemaId === 'string' && action.argumentSchemaId === `${action.id}-args/v1`, 'rejected-catalog', `Action argument schema is invalid: ${action.id}`);
    assert(action.bindingOutputType === (action.id === 'tx.start' ? 'tx-handle' : null), 'rejected-catalog', `Action binding output changed: ${action.id}`);
  }

  assert(Array.isArray(catalog.invariants) && catalog.invariants.length === 2, 'rejected-catalog', 'Phase 2 catalog must contain two invariants');
  unique(catalog.invariants.map((item) => item.id), 'invariant id');
  assert(JSON.stringify(catalog.invariants.map((item) => item.id).sort()) === JSON.stringify(INVARIANT_IDS), 'rejected-catalog', 'Phase 2 invariant universe changed');
  for (const invariant of catalog.invariants) {
    strictKeys(invariant, ['id', 'evaluatorId', 'sourceKind', 'sourceRef', 'sourceCommit', 'authoredBeforeGeneration', 'visibility', 'strength', 'corroboratingRefs', 'normalizedObservedKind', 'observedFields'], [], `Invariant ${invariant.id}`, 'rejected-catalog');
    const expected = INVARIANT_CONTRACTS[invariant.id];
    assert(expected !== undefined, 'rejected-catalog', `Invariant is not registered: ${invariant.id}`);
    assert(invariant.evaluatorId === expected.evaluatorId, 'rejected-catalog', `Invariant evaluator is invalid: ${invariant.id}`);
    assert(invariant.sourceKind === expected.sourceKind && invariant.sourceRef === expected.sourceRef, 'rejected-catalog', `Invariant source changed: ${invariant.id}`);
    assert(invariant.sourceCommit === TARGET_REVISION && invariant.authoredBeforeGeneration === true, 'rejected-catalog', `Invariant provenance is invalid: ${invariant.id}`);
    assert(invariant.visibility === 'public' && invariant.strength === 'normative', 'rejected-catalog', `Phase 2 invariant is not a normative public oracle: ${invariant.id}`);
    assert(Array.isArray(invariant.corroboratingRefs) && invariant.corroboratingRefs.length === 0, 'rejected-catalog', `Invariant corroborating references changed: ${invariant.id}`);
    assert(invariant.normalizedObservedKind === expected.normalizedObservedKind && canonicalJson(invariant.observedFields) === canonicalJson(expected.observedFields), 'rejected-catalog', `Invariant observed contract changed: ${invariant.id}`);
  }

  assert(Array.isArray(catalog.fixtures) && catalog.fixtures.length === 1, 'rejected-catalog', 'Phase 2 catalog must contain one fixture');
  const fixture = catalog.fixtures[0];
  strictKeys(fixture, ['id', 'kind', 'materializerId', 'consumerActionId'], [], 'Fixture registration', 'rejected-catalog');
  assert(fixture.id === 'tx.step-outcome/v1' && fixture.kind === 'public-test-seam' && fixture.materializerId === fixture.id && fixture.consumerActionId === 'tx.run', 'rejected-catalog', 'Phase 2 fixture registration changed');
  return catalog;
}

export async function loadPhase2Catalog(repositoryRoot) {
  const catalogBytes = await readFile(path.join(repositoryRoot, PHASE2_CATALOG_PATH));
  const catalog = validatePhase2Catalog(parseJsonBytes(catalogBytes));
  const [registrationBytes, contractEvidenceBytes] = await Promise.all([
    readFile(path.join(repositoryRoot, catalog.target.registrationPath)),
    readFile(path.join(repositoryRoot, 'evidence/v0.3/phase1-contracts.json')),
  ]);
  assert(sha256(registrationBytes) === catalog.target.registrationSha256, 'rejected-catalog', 'Package registration digest mismatch');
  const packageRegistration = JSON.parse(registrationBytes.toString('utf8')).packages.find((item) => item.id === catalog.target.moduleId);
  assert(packageRegistration?.packageName === catalog.target.packageName && packageRegistration.allowedImportSpecifiers.includes(catalog.target.importSpecifier), 'rejected-catalog', 'Catalog target is not a registered public package import');
  const artifact = JSON.parse(contractEvidenceBytes.toString('utf8')).probe.artifacts.find((item) => item.id === catalog.target.moduleId);
  assert(artifact?.sha256 === catalog.target.artifactSha256 && artifact.packageName === catalog.target.packageName, 'rejected-catalog', 'Catalog target artifact differs from Phase 1 evidence');
  return { catalog, catalogBytes };
}

export function validateNightmareSeed(seed, catalog) {
  strictKeys(seed, ['schemaVersion', 'catalogVersion', 'id', 'invariantId', 'actors', 'actions'], [], 'NightmareSeed');
  assert(seed.schemaVersion === SEED_SCHEMA_VERSION, 'rejected-schema', 'Unexpected NightmareSeed schemaVersion');
  assert(seed.catalogVersion === catalog.catalogVersion, 'rejected-catalog', 'NightmareSeed catalogVersion mismatch');
  assert(validId(seed.id), 'rejected-schema', 'NightmareSeed id is invalid');
  const invariant = catalog.invariants.find((item) => item.id === seed.invariantId);
  assert(invariant !== undefined, 'rejected-catalog', `Unknown invariant: ${seed.invariantId}`);
  assert(Array.isArray(seed.actors) && seed.actors.length > 0 && seed.actors.length <= WIRE_LIMITS.actors, 'rejected-schema', 'NightmareSeed actor count is invalid');
  unique(seed.actors, 'actor', 'rejected-schema');
  for (const actor of seed.actors) {
    assert(validId(actor), 'rejected-schema', `Actor is invalid: ${actor}`);
    assert(!RESERVED_ACTORS.has(actor) && !actor.startsWith('__'), 'rejected-policy', `Actor is reserved: ${actor}`);
  }
  assert(Array.isArray(seed.actions) && seed.actions.length > 0 && seed.actions.length <= WIRE_LIMITS.actions, 'rejected-schema', 'NightmareSeed action count is invalid');
  const bindings = new Map();
  for (const [index, action] of seed.actions.entries()) {
    strictKeys(action, ['actionId', 'actor', 'arguments', 'bind'], [], `Action ${index}`);
    const registration = catalog.actions.find((item) => item.id === action.actionId);
    assert(registration !== undefined, 'rejected-catalog', `Unknown action: ${action.actionId}`);
    assert(seed.actors.includes(action.actor), 'rejected-policy', `Action actor is not declared: ${action.actor}`);
    validateActionArguments(action.actionId, action.arguments, bindings);
    if (registration.bindingOutputType === null) {
      assert(action.bind === null, 'rejected-policy', `Action cannot declare a binding: ${action.actionId}`);
    } else {
      strictKeys(action.bind, ['name', 'type'], [], `Action binding ${index}`);
      assert(validId(action.bind.name), 'rejected-schema', `Binding name is invalid: ${action.bind.name}`);
      assert(action.bind.type === registration.bindingOutputType, 'rejected-policy', `Binding type mismatch: ${action.bind.name}`);
      assert(!bindings.has(action.bind.name), 'rejected-policy', `Duplicate binding: ${action.bind.name}`);
      bindings.set(action.bind.name, action.bind.type);
    }
  }
  validateInvariantApplicability(invariant, seed.actions, null, 'NightmareSeed');
  return seed;
}

export function parseNightmareSeed(bytes, catalog) {
  return validateNightmareSeed(parseJsonBytes(bytes), catalog);
}

export function fixtureRecord(action, instanceId, catalog) {
  const registration = catalog.fixtures[0];
  const state = {
    outcome: action.arguments.outcome,
    value: action.arguments.value,
    errorName: action.arguments.errorName,
    errorMessage: action.arguments.errorMessage,
    log: action.arguments.log,
    retry: action.arguments.retry,
  };
  return {
    registrationId: registration.id,
    registrationDigest: domainDigest('bug-dreamer/fixture-registration/v1', registration),
    kind: registration.kind,
    producerArtifact: {
      moduleRegistrationId: catalog.target.moduleId,
      targetArtifactDigest: catalog.target.artifactSha256,
    },
    publicActionTrace: [action.actionId],
    canonicalWirePayload: state,
    materializerId: registration.materializerId,
    stateDigest: domainDigest(FIXTURE_DIGEST_DOMAIN, state),
    consumerActionInstanceId: instanceId,
  };
}

export function composeNightmareSpec(seed, catalog) {
  validateNightmareSeed(seed, catalog);
  const baseActions = seed.actions.map((action, index) => {
    const registration = catalog.actions.find((item) => item.id === action.actionId);
    return {
      instanceId: `action-${String(index + 1).padStart(4, '0')}`,
      actionId: action.actionId,
      adapterId: registration.adapterId,
      argumentSchemaId: registration.argumentSchemaId,
      actor: action.actor,
      arguments: action.arguments,
      bind: action.bind,
    };
  });
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    seedDigest: domainDigest(SEED_DIGEST_DOMAIN, seed),
    targetRegistrationId: catalog.target.registrationId,
    invariantRegistrationId: seed.invariantId,
    catalogVersion: catalog.catalogVersion,
    actors: seed.actors,
    baseActions,
    transformedActions: structuredClone(baseActions),
    transformations: [],
    scheduleControls: [],
    fixtures: baseActions
      .filter((action) => action.actionId === 'tx.run')
      .map((action) => fixtureRecord(action, action.instanceId, catalog)),
    canonicalizer: {
      standard: 'RFC 8785 JCS',
      package: 'canonicalize',
      version: '4.0.0',
    },
  };
}

export function buildNightmareSpec(seed, catalog) {
  return validateNightmareSpec(composeNightmareSpec(seed, catalog), catalog);
}

function validateSpecAction(action, catalog, label) {
  strictKeys(action, ['instanceId', 'actionId', 'adapterId', 'argumentSchemaId', 'actor', 'arguments', 'bind'], [], label);
  const registration = catalog.actions.find((item) => item.id === action.actionId);
  assert(registration !== undefined, 'rejected-catalog', `${label} action is not registered`);
  assert(action.adapterId === registration.adapterId && action.argumentSchemaId === registration.argumentSchemaId, 'rejected-policy', `${label} adapter binding changed`);
}

export function validateNightmareSpec(spec, catalog) {
  strictKeys(spec, ['schemaVersion', 'seedDigest', 'targetRegistrationId', 'invariantRegistrationId', 'catalogVersion', 'actors', 'baseActions', 'transformedActions', 'transformations', 'scheduleControls', 'fixtures', 'canonicalizer'], [], 'NightmareSpec');
  assert(spec.schemaVersion === SPEC_SCHEMA_VERSION, 'rejected-schema', 'Unexpected NightmareSpec schemaVersion');
  assert(validSha(spec.seedDigest), 'rejected-schema', 'NightmareSpec seedDigest is invalid');
  assert(spec.targetRegistrationId === catalog.target.registrationId && spec.catalogVersion === catalog.catalogVersion, 'rejected-catalog', 'NightmareSpec registration mismatch');
  const invariant = catalog.invariants.find((item) => item.id === spec.invariantRegistrationId);
  assert(invariant !== undefined, 'rejected-catalog', 'NightmareSpec invariant is not registered');
  assert(Array.isArray(spec.actors) && spec.actors.length > 0 && spec.actors.length <= WIRE_LIMITS.actors, 'rejected-schema', 'NightmareSpec actor count is invalid');
  unique(spec.actors, 'spec actor', 'rejected-schema');
  for (const actor of spec.actors) {
    assert(validId(actor), 'rejected-schema', `Spec actor is invalid: ${actor}`);
    assert(!RESERVED_ACTORS.has(actor) && !actor.startsWith('__'), 'rejected-policy', `Spec actor is reserved: ${actor}`);
  }
  assert(Array.isArray(spec.baseActions) && spec.baseActions.length > 0 && spec.baseActions.length <= WIRE_LIMITS.actions, 'rejected-schema', 'NightmareSpec action count is invalid');
  assert(Array.isArray(spec.transformedActions) && spec.transformedActions.length === spec.baseActions.length, 'rejected-schema', 'NightmareSpec transformed action count is invalid');
  assert(Array.isArray(spec.transformations) && spec.transformations.length <= TRANSFORMATION_LIMIT, 'rejected-schema', 'NightmareSpec transformation count is invalid');
  assert(Array.isArray(spec.scheduleControls) && spec.scheduleControls.length <= WIRE_LIMITS.scheduleControls, 'rejected-schema', 'NightmareSpec schedule control count is invalid');
  unique(spec.baseActions.map((item) => item.instanceId), 'action instanceId', 'rejected-schema');
  const bindings = new Map();
  for (const [index, action] of spec.baseActions.entries()) {
    validateSpecAction(action, catalog, `Spec action ${index}`);
    assert(action.instanceId === `action-${String(index + 1).padStart(4, '0')}`, 'rejected-policy', `Spec action instanceId is unstable: ${action.instanceId}`);
    const registration = catalog.actions.find((item) => item.id === action.actionId);
    assert(spec.actors.includes(action.actor), 'rejected-policy', `Spec action actor is not declared: ${action.actor}`);
    validateActionArguments(action.actionId, action.arguments, bindings);
    if (registration.bindingOutputType === null) {
      assert(action.bind === null, 'rejected-policy', `Spec action cannot declare a binding: ${action.actionId}`);
    } else {
      strictKeys(action.bind, ['name', 'type'], [], `Spec action binding ${index}`);
      assert(action.bind.type === registration.bindingOutputType && !bindings.has(action.bind.name), 'rejected-policy', `Spec action binding is invalid: ${action.bind.name}`);
      bindings.set(action.bind.name, action.bind.type);
    }
  }
  if (spec.transformations.length === 0) {
    assert(canonicalJson(spec.transformedActions) === canonicalJson(spec.baseActions), 'rejected-policy', 'Identity transformation requires byte-equal transformed actions');
    assert(spec.scheduleControls.length === 0, 'rejected-policy', 'Identity transformation requires empty schedule controls');
  } else {
    const transformedBindings = new Map();
    for (const [index, action] of spec.transformedActions.entries()) {
      validateSpecAction(action, catalog, `Transformed action ${index}`);
      const base = spec.baseActions[index];
      assert(action.instanceId === base.instanceId && action.actionId === base.actionId && action.actor === base.actor && canonicalJson(action.bind) === canonicalJson(base.bind), 'rejected-policy', `Transformed action ${index} changes non-argument fields`);
      const registration = catalog.actions.find((item) => item.id === action.actionId);
      validateActionArguments(action.actionId, action.arguments, transformedBindings);
      if (registration.bindingOutputType !== null) transformedBindings.set(action.bind.name, action.bind.type);
    }
    for (const [index, control] of spec.scheduleControls.entries()) validateScheduleControl(control, spec.transformedActions, index);
    assert(Array.isArray(catalog.operators) && catalog.operators.length > 0, 'rejected-catalog', 'Transformed spec requires registered operators');
    const replayState = { actions: structuredClone(spec.baseActions), scheduleControls: [] };
    let previousDigest = stateDigest(replayState.actions, replayState.scheduleControls);
    for (const [index, record] of spec.transformations.entries()) {
      strictKeys(record, ['operatorId', 'operatorRegistrationDigest', 'arguments', 'beforeDigest', 'afterDigest'], [], `Transformation ${index}`);
      const registration = catalog.operators.find((item) => item.id === record.operatorId);
      assert(registration !== undefined, 'rejected-catalog', `Transformation operator is not registered: ${record.operatorId}`);
      assert(record.operatorRegistrationDigest === domainDigest(OPERATOR_REGISTRATION_DOMAIN, registration), 'rejected-policy', `Transformation ${index} registration digest mismatch`);
      assert(validSha(record.beforeDigest) && validSha(record.afterDigest), 'rejected-schema', `Transformation ${index} digest is invalid`);
      assert(record.beforeDigest === previousDigest, 'rejected-policy', `Transformation ${index} breaks the transformation digest chain`);
      applyOperatorRecord(registration, record.arguments, replayState);
      const replayedDigest = stateDigest(replayState.actions, replayState.scheduleControls);
      assert(record.afterDigest === replayedDigest, 'rejected-policy', `Transformation ${index} does not reproduce its recorded state`);
      previousDigest = replayedDigest;
    }
    assert(canonicalJson(replayState.actions) === canonicalJson(spec.transformedActions) && canonicalJson(replayState.scheduleControls) === canonicalJson(spec.scheduleControls), 'rejected-policy', 'Transformed state does not match the replayed transformations');
  }
  validateInvariantApplicability(invariant, spec.transformedActions, spec.scheduleControls, 'NightmareSpec');
  assert(Array.isArray(spec.fixtures) && spec.fixtures.length <= WIRE_LIMITS.fixtures, 'rejected-schema', 'NightmareSpec fixture count is invalid');
  const runIds = spec.transformedActions.filter((item) => item.actionId === 'tx.run').map((item) => item.instanceId);
  assert(JSON.stringify(spec.fixtures.map((item) => item.consumerActionInstanceId)) === JSON.stringify(runIds), 'rejected-policy', 'NightmareSpec fixtures do not cover run actions');
  for (const fixture of spec.fixtures) {
    strictKeys(fixture, ['registrationId', 'registrationDigest', 'kind', 'producerArtifact', 'publicActionTrace', 'canonicalWirePayload', 'materializerId', 'stateDigest', 'consumerActionInstanceId'], [], 'Spec fixture');
    assert(fixture.registrationId === 'tx.step-outcome/v1' && fixture.kind === 'public-test-seam' && fixture.materializerId === fixture.registrationId, 'rejected-catalog', 'Spec fixture registration changed');
    assert(validSha(fixture.registrationDigest) && validSha(fixture.stateDigest), 'rejected-schema', 'Spec fixture digest is invalid');
    assert(fixture.stateDigest === domainDigest(FIXTURE_DIGEST_DOMAIN, fixture.canonicalWirePayload), 'rejected-policy', 'Spec fixture state digest mismatch');
    assert(runIds.includes(fixture.consumerActionInstanceId), 'rejected-policy', 'Spec fixture consumer is invalid');
    const consumer = spec.transformedActions.find((action) => action.instanceId === fixture.consumerActionInstanceId);
    assert(canonicalJson(fixture) === canonicalJson(fixtureRecord(consumer, consumer.instanceId, catalog)), 'rejected-policy', 'Spec fixture materialization record changed');
  }
  assert(canonicalJson(spec.canonicalizer) === canonicalJson({ standard: 'RFC 8785 JCS', package: 'canonicalize', version: '4.0.0' }), 'rejected-policy', 'NightmareSpec canonicalizer changed');
  return spec;
}

export function specDigest(spec, catalog) {
  validateNightmareSpec(spec, catalog);
  return domainDigest(SPEC_DIGEST_DOMAIN, spec);
}

export function buildExecutionPlan(spec, catalog) {
  validateNightmareSpec(spec, catalog);
  const invariant = catalog.invariants.find((item) => item.id === spec.invariantRegistrationId);
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    specDigest: specDigest(spec, catalog),
    targetRegistrationId: spec.targetRegistrationId,
    invariantRegistrationId: spec.invariantRegistrationId,
    targetArtifactDigest: catalog.target.artifactSha256,
    evaluatorId: invariant.evaluatorId,
    normalizedObservedKind: invariant.normalizedObservedKind,
    observedFields: invariant.observedFields,
    actions: spec.transformedActions.map((action) => ({
      instanceId: action.instanceId,
      actionId: action.actionId,
      adapterId: action.adapterId,
      actor: action.actor,
      arguments: action.arguments,
      bind: action.bind,
    })),
    bindings: spec.transformedActions.filter((action) => action.bind !== null).map((action) => ({
      name: action.bind.name,
      type: action.bind.type,
      producerActionInstanceId: action.instanceId,
    })),
    fixtureSetup: spec.fixtures,
    virtualTime: { originMs: VIRTUAL_TIME_ORIGIN_MS },
    scheduleControls: spec.scheduleControls,
  };
  return validateExecutionPlan(plan, spec, catalog);
}

export function validateExecutionPlan(plan, spec, catalog) {
  strictKeys(plan, ['schemaVersion', 'specDigest', 'targetRegistrationId', 'invariantRegistrationId', 'targetArtifactDigest', 'evaluatorId', 'normalizedObservedKind', 'observedFields', 'actions', 'bindings', 'fixtureSetup', 'virtualTime', 'scheduleControls'], [], 'ExecutionPlan');
  assert(plan.schemaVersion === PLAN_SCHEMA_VERSION, 'rejected-schema', 'Unexpected ExecutionPlan schemaVersion');
  assert(plan.specDigest === specDigest(spec, catalog), 'rejected-policy', 'ExecutionPlan specDigest mismatch');
  assert(plan.targetRegistrationId === catalog.target.registrationId && plan.targetArtifactDigest === catalog.target.artifactSha256, 'rejected-catalog', 'ExecutionPlan target mismatch');
  const invariant = catalog.invariants.find((item) => item.id === plan.invariantRegistrationId);
  assert(invariant !== undefined && plan.invariantRegistrationId === spec.invariantRegistrationId, 'rejected-catalog', 'ExecutionPlan invariant mismatch');
  assert(plan.evaluatorId === invariant.evaluatorId && plan.normalizedObservedKind === invariant.normalizedObservedKind && canonicalJson(plan.observedFields) === canonicalJson(invariant.observedFields), 'rejected-policy', 'ExecutionPlan evaluator binding changed');
  assert(Array.isArray(plan.actions) && plan.actions.length === spec.transformedActions.length, 'rejected-schema', 'ExecutionPlan action count changed');
  const expectedActions = spec.transformedActions.map((action) => ({
    instanceId: action.instanceId,
    actionId: action.actionId,
    adapterId: action.adapterId,
    actor: action.actor,
    arguments: action.arguments,
    bind: action.bind,
  }));
  assert(canonicalJson(plan.actions) === canonicalJson(expectedActions), 'rejected-policy', 'ExecutionPlan actions changed');
  const bindings = new Map();
  for (const [index, action] of plan.actions.entries()) {
    strictKeys(action, ['instanceId', 'actionId', 'adapterId', 'actor', 'arguments', 'bind'], [], `Plan action ${index}`);
    const expected = spec.transformedActions[index];
    assert(action.instanceId === expected.instanceId && action.actionId === expected.actionId && action.adapterId === expected.adapterId, 'rejected-policy', `ExecutionPlan action ${index} changed`);
    const registration = catalog.actions.find((item) => item.id === action.actionId);
    validateActionArguments(action.actionId, action.arguments, bindings);
    if (registration.bindingOutputType !== null) bindings.set(action.bind.name, action.bind.type);
  }
  const expectedBindings = spec.transformedActions.filter((action) => action.bind !== null).map((action) => ({
    name: action.bind.name,
    type: action.bind.type,
    producerActionInstanceId: action.instanceId,
  }));
  assert(canonicalJson(plan.bindings) === canonicalJson(expectedBindings), 'rejected-policy', 'ExecutionPlan bindings changed');
  assert(canonicalJson(plan.fixtureSetup) === canonicalJson(spec.fixtures), 'rejected-policy', 'ExecutionPlan fixture setup changed');
  strictKeys(plan.virtualTime, ['originMs'], [], 'ExecutionPlan virtualTime');
  assert(plan.virtualTime.originMs === VIRTUAL_TIME_ORIGIN_MS, 'rejected-policy', 'Registered virtual time origin changed');
  assert(Array.isArray(plan.scheduleControls) && canonicalJson(plan.scheduleControls) === canonicalJson(spec.scheduleControls), 'rejected-policy', 'ExecutionPlan schedule controls changed');
  return plan;
}

export function planDigest(plan, spec, catalog) {
  validateExecutionPlan(plan, spec, catalog);
  return domainDigest(PLAN_DIGEST_DOMAIN, plan);
}
