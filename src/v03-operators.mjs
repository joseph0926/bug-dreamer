import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  TRANSFORMATION_LIMIT,
  V03SpecError,
  VIRTUAL_TIME_ADVANCE_LIMITS,
  composeNightmareSpec,
  fixtureRecord,
  loadPhase2Catalog,
  stateDigest,
  validateNightmareSpec,
} from './v03-spec.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

export const PHASE3_OPERATORS_PATH = 'registrations/v0.3/phase3-operators.json';
export const REQUEST_SCHEMA_VERSION = 'bug-dreamer/transformation-request/v1';
export const OPERATOR_REGISTRATION_DOMAIN = 'bug-dreamer/operator-registration/v1';

const OPERATOR_CONTRACTS = Object.freeze({
  'time.advance/v1': {
    kind: 'schedule-control',
    argumentSchemaId: 'time.advance-args/v1',
    bounds: { advanceMsMin: VIRTUAL_TIME_ADVANCE_LIMITS.minMs, advanceMsMax: VIRTUAL_TIME_ADVANCE_LIMITS.maxMs },
  },
  'schedule.release-order/v1': {
    kind: 'schedule-control',
    argumentSchemaId: 'schedule.release-order-args/v1',
    bounds: { minInstanceIds: 2 },
  },
  'fault.step-outcome/v1': {
    kind: 'action-transformation',
    argumentSchemaId: 'fault.step-outcome-args/v1',
    bounds: { policy: 'tx.run argument schema and policy limits' },
  },
});

const INVARIANT_EXTENSION = Object.freeze({
  id: 'tx.total-timeout',
  evaluatorId: 'tx.total-timeout/v1',
  sourceKind: 'documentation',
  sourceRef: 'packages/tx/README.md#timeout-protection',
  sourceCommit: 'f624b09f148c3368a51807f48d3237db20cef9c6',
  authoredBeforeGeneration: true,
  visibility: 'public',
  strength: 'normative',
  corroboratingRefs: [
    'packages/tx/tests/transaction.test.ts#should-timeout-during-execution',
    'packages/tx/tests/transaction.test.ts#should-include-elapsed-time-in-timeout-error',
  ],
  normalizedObservedKind: 'thrown-error',
  observedFields: [
    { name: 'name', type: 'string' },
    { name: 'message', type: 'string' },
  ],
  applicability: {
    finalRunOutcome: 'return',
    requires: 'virtual-advance-past-timeout',
  },
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
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), kind, `${label} fields changed`);
}

export function validatePhase3OperatorCatalog(registration) {
  strictKeys(registration, ['schemaVersion', 'catalogVersion', 'extendsCatalogVersion', 'operators', 'invariants'], 'Phase 3 operator catalog', 'rejected-catalog');
  assert(registration.schemaVersion === 'bug-dreamer/phase3-operators/v1', 'rejected-catalog', 'Unexpected Phase 3 operator catalog schemaVersion');
  assert(registration.catalogVersion === 'firsttx-phase3-f624b09-v1', 'rejected-catalog', 'Unexpected Phase 3 operator catalogVersion');
  assert(registration.extendsCatalogVersion === 'firsttx-phase2-f624b09-v1', 'rejected-catalog', 'Phase 3 operator catalog extends an unexpected base catalog');
  assert(Array.isArray(registration.operators) && registration.operators.length === 3, 'rejected-catalog', 'Phase 3 operator universe changed');
  assert(JSON.stringify(registration.operators.map((item) => item.id).sort()) === JSON.stringify(Object.keys(OPERATOR_CONTRACTS).sort()), 'rejected-catalog', 'Phase 3 operator universe changed');
  for (const operator of registration.operators) {
    strictKeys(operator, ['id', 'kind', 'argumentSchemaId', 'bounds'], `Operator ${operator.id}`, 'rejected-catalog');
    const expected = OPERATOR_CONTRACTS[operator.id];
    assert(canonicalJson(operator) === canonicalJson({ id: operator.id, ...expected }), 'rejected-catalog', `Operator registration changed: ${operator.id}`);
  }
  assert(Array.isArray(registration.invariants) && registration.invariants.length === 1, 'rejected-catalog', 'Phase 3 invariant extension changed');
  assert(canonicalJson(registration.invariants[0]) === canonicalJson(INVARIANT_EXTENSION), 'rejected-catalog', 'Phase 3 invariant registration changed');
  return registration;
}

export async function loadPhase3Catalog(repositoryRoot) {
  const { catalog, catalogBytes } = await loadPhase2Catalog(repositoryRoot);
  const operatorBytes = await readFile(path.join(repositoryRoot, PHASE3_OPERATORS_PATH));
  const operatorCatalog = validatePhase3OperatorCatalog(parseJsonBytes(operatorBytes));
  return {
    catalog: { ...catalog, invariants: [...catalog.invariants, ...operatorCatalog.invariants] },
    catalogBytes,
    operatorCatalog,
    operatorBytes,
  };
}

export function validateTransformationRequest(request, operatorCatalog) {
  strictKeys(request, ['schemaVersion', 'transformations'], 'Transformation request');
  assert(request.schemaVersion === REQUEST_SCHEMA_VERSION, 'rejected-schema', 'Unexpected transformation request schemaVersion');
  assert(Array.isArray(request.transformations) && request.transformations.length >= 1 && request.transformations.length <= TRANSFORMATION_LIMIT, 'rejected-schema', 'Transformation request length is invalid');
  for (const [index, entry] of request.transformations.entries()) {
    strictKeys(entry, ['operatorId', 'arguments'], `Transformation request entry ${index}`);
    assert(operatorCatalog.operators.some((item) => item.id === entry.operatorId), 'rejected-catalog', `Operator is not registered: ${entry.operatorId}`);
  }
  return request;
}

function applyOperator(registration, args, state) {
  if (registration.id === 'time.advance/v1') {
    strictKeys(args, ['afterInstanceId', 'advanceMs'], 'time.advance arguments');
    assert(Number.isSafeInteger(args.advanceMs), 'rejected-schema', 'time.advance advanceMs must be a safe integer');
    assert(args.advanceMs >= registration.bounds.advanceMsMin && args.advanceMs <= registration.bounds.advanceMsMax, 'rejected-policy', 'time.advance advanceMs is outside the registered bounds');
    assert(state.actions.some((action) => action.instanceId === args.afterInstanceId), 'rejected-policy', `time.advance references an unknown action instance: ${args.afterInstanceId}`);
    state.scheduleControls.push({ kind: 'virtual-time-advance', afterInstanceId: args.afterInstanceId, advanceMs: args.advanceMs });
    return;
  }
  if (registration.id === 'schedule.release-order/v1') {
    strictKeys(args, ['instanceIds'], 'schedule.release-order arguments');
    assert(Array.isArray(args.instanceIds) && args.instanceIds.length >= registration.bounds.minInstanceIds, 'rejected-schema', 'schedule.release-order requires at least two instance IDs');
    assert(new Set(args.instanceIds).size === args.instanceIds.length, 'rejected-schema', 'schedule.release-order instance IDs must be distinct');
    for (const instanceId of args.instanceIds) {
      assert(state.actions.some((action) => action.instanceId === instanceId && action.actionId === 'tx.run'), 'rejected-policy', `schedule.release-order references a non-run action instance: ${instanceId}`);
    }
    state.scheduleControls.push({ kind: 'completion-release-order', instanceIds: args.instanceIds });
    return;
  }
  strictKeys(args, ['targetInstanceId', 'outcome', 'value', 'errorName', 'errorMessage'], 'fault.step-outcome arguments');
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
}

export function buildTransformedSpec(seed, request, catalog, operatorCatalog) {
  validateTransformationRequest(request, operatorCatalog);
  const spec = composeNightmareSpec(seed, catalog);
  const state = { actions: structuredClone(spec.baseActions), scheduleControls: [] };
  const records = [];
  let beforeDigest = stateDigest(state.actions, state.scheduleControls);
  for (const entry of request.transformations) {
    const registration = operatorCatalog.operators.find((item) => item.id === entry.operatorId);
    applyOperator(registration, entry.arguments, state);
    const afterDigest = stateDigest(state.actions, state.scheduleControls);
    records.push({
      operatorId: entry.operatorId,
      operatorRegistrationDigest: domainDigest(OPERATOR_REGISTRATION_DOMAIN, registration),
      arguments: entry.arguments,
      beforeDigest,
      afterDigest,
    });
    beforeDigest = afterDigest;
  }
  spec.transformedActions = state.actions;
  spec.scheduleControls = state.scheduleControls;
  spec.transformations = records;
  spec.fixtures = state.actions
    .filter((action) => action.actionId === 'tx.run')
    .map((action) => fixtureRecord(action, action.instanceId, catalog));
  return validateNightmareSpec(spec, catalog);
}
