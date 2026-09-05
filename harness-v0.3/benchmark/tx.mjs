import { startTransaction } from '@firsttx/tx';

import descriptorRegistration from '../../registrations/v0.3/benchmark/tx.json' with { type: 'json' };
import { canonicalJson, domainDigest } from '../../src/v03-wire.mjs';
import { evaluateTxResult, normalizeThrownError, returnedObservation } from './tx-oracle.mjs';
import { failInfrastructure, rethrowInfrastructureError, settleTxPromise } from './tx-environment.mjs';
import { validateActionArguments as validateSchemaActionArguments } from './tx-schema.mjs';

export const descriptor = descriptorRegistration;

const ERROR_CLASSES = Object.freeze({ Error, TypeError, RangeError, SyntaxError });
const FIXTURE_REGISTRATION_DOMAIN = 'bug-dreamer/fixture-registration/v1';
const FIXTURE_STATE_DOMAIN = 'bug-dreamer/fixture-state/v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function strictKeys(value, keys, label) {
  assert(isPlainObject(value), `${label} must be an object`);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields changed`);
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u.test(value);
}

function bindingValue(reference, bindings, expectedType, label) {
  strictKeys(reference, ['$binding'], label);
  assert(validIdentifier(reference.$binding), `${label} name is invalid`);
  const binding = bindings.get(reference.$binding);
  assert(isPlainObject(binding)
    && JSON.stringify(Object.keys(binding).sort()) === JSON.stringify(['type', 'value'])
    && binding.type === expectedType, `${label} is unavailable or has the wrong type`);
  return binding.value;
}

export function validateActionArguments({ action, bindings, policy }) {
  validateSchemaActionArguments({ action, bindings, policy });
}

function scriptedFixtureState(actionInstance) {
  return actionInstance.arguments;
}

function abortFixtureState(actionInstance) {
  return actionInstance.arguments;
}

export async function materializeFixture({ fixtureRecord, actionInstance, artifact, policy }) {
  assert(isPlainObject(fixtureRecord), 'Fixture record must be an object');
  assert(isPlainObject(actionInstance), 'Fixture consumer action must be an object');
  assert(isPlainObject(artifact)
    && ['clean', 'single-patch-defect'].includes(artifact.role)
    && /^[0-9a-f]{64}$/u.test(artifact.targetArtifactDigest)
    && /^[0-9a-f]{64}$/u.test(artifact.evaluationContractKey), 'Artifact binding is invalid');
  assert(policy === undefined || policy === null || isPlainObject(policy), 'Fixture policy must be an object when present');
  const fixtureRegistration = descriptor.fixtures.find((item) => item.id === fixtureRecord.registrationId);
  assert(fixtureRegistration !== undefined && fixtureRegistration.consumerActionId === actionInstance.actionId, 'Fixture record is not registered for this action');
  let state;
  if (fixtureRegistration.id === 'tx.scripted-step-state/v1' && actionInstance.adapterId === 'tx.run-scripted/v2') {
    state = scriptedFixtureState(actionInstance);
  } else if (fixtureRegistration.id === 'env.abort-signal-state/v1' && actionInstance.adapterId === 'env.abort-controller/v1') {
    state = abortFixtureState(actionInstance);
  } else {
    throw new Error(`Fixture ${fixtureRegistration.id} cannot serve ${actionInstance.adapterId}`);
  }
  const expected = {
    registrationId: fixtureRegistration.id,
    registrationDigest: domainDigest(FIXTURE_REGISTRATION_DOMAIN, fixtureRegistration),
    kind: fixtureRegistration.kind,
    producerArtifact: {
      moduleRegistrationId: descriptor.moduleId,
      targetArtifactDigest: artifact.targetArtifactDigest,
    },
    publicActionTrace: fixtureRegistration.publicActionTrace,
    canonicalWirePayload: state,
    materializerId: fixtureRegistration.materializerId,
    stateDigest: domainDigest(FIXTURE_STATE_DOMAIN, state),
    consumerActionInstanceId: actionInstance.instanceId,
  };
  assert(canonicalJson(fixtureRecord) === canonicalJson(expected), `Fixture record changed: ${fixtureRecord.registrationId}`);
  return fixtureRecord;
}

function createScriptedError(outcome) {
  const ErrorClass = ERROR_CLASSES[outcome.errorName];
  return new ErrorClass(outcome.errorMessage);
}

function runtimeState(runtime) {
  assert(runtime !== null && typeof runtime === 'object', 'tx runtime is required');
  if (runtime.txState === undefined) runtime.txState = { compensations: [] };
  assert(isPlainObject(runtime.txState) && Array.isArray(runtime.txState.compensations), 'tx runtime state is invalid');
  return runtime.txState;
}

function fixtureForAction(fixtures, actionInstance, registrationId, expectedState, runtime) {
  const values = fixtures instanceof Map ? [...fixtures.values()] : fixtures;
  assert(Array.isArray(values), 'fixtures must be a Map or array');
  const fixture = values.find((item) => item.consumerActionInstanceId === actionInstance.instanceId
    && item.registrationId === registrationId);
  assert(fixture !== undefined, `tx fixture is missing: ${actionInstance.instanceId}`);
  const registration = descriptor.fixtures.find((item) => item.id === registrationId);
  assert(registration !== undefined
    && fixture.registrationDigest === domainDigest(FIXTURE_REGISTRATION_DOMAIN, registration)
    && fixture.kind === registration.kind
    && fixture.materializerId === registration.materializerId
    && canonicalJson(fixture.publicActionTrace) === canonicalJson(registration.publicActionTrace), `tx fixture registration changed: ${actionInstance.instanceId}`);
  assert(isPlainObject(runtime?.artifact)
    && fixture.producerArtifact.moduleRegistrationId === descriptor.moduleId
    && fixture.producerArtifact.targetArtifactDigest === runtime.artifact.targetArtifactDigest, `tx fixture provenance changed: ${actionInstance.instanceId}`);
  assert(fixture.stateDigest === domainDigest(FIXTURE_STATE_DOMAIN, expectedState), `tx fixture state digest changed: ${actionInstance.instanceId}`);
  assert(canonicalJson(fixture.canonicalWirePayload) === canonicalJson(expectedState), `tx fixture payload changed: ${actionInstance.instanceId}`);
}

function bindActionValue(actionInstance, bindings, type, value) {
  strictKeys(actionInstance.bind, ['name', 'type'], `${actionInstance.adapterId} binding`);
  assert(actionInstance.bind.type === type && validIdentifier(actionInstance.bind.name), `${actionInstance.adapterId} binding is invalid`);
  assert(!bindings.has(actionInstance.bind.name), `Duplicate binding: ${actionInstance.bind.name}`);
  bindings.set(actionInstance.bind.name, { type, value });
}

function validateScheduleControls(scheduleControls) {
  assert(Array.isArray(scheduleControls), 'scheduleControls must be an array');
  for (const [index, control] of scheduleControls.entries()) {
    if (control?.kind === 'virtual-time-advance') {
      strictKeys(control, ['kind', 'afterInstanceId', 'advanceMs'], `Schedule control ${index}`);
      assert(validIdentifier(control.afterInstanceId)
        && Number.isSafeInteger(control.advanceMs)
        && control.advanceMs >= 1
        && control.advanceMs <= 86400000, `Schedule control ${index} is invalid`);
    } else if (control?.kind === 'completion-release-order') {
      strictKeys(control, ['kind', 'instanceIds'], `Schedule control ${index}`);
      assert(Array.isArray(control.instanceIds)
        && control.instanceIds.length >= 2
        && control.instanceIds.every(validIdentifier)
        && new Set(control.instanceIds).size === control.instanceIds.length, `Schedule control ${index} is invalid`);
    } else throw new Error(`Unregistered schedule control: ${control?.kind}`);
  }
}

async function executeRun(actionInstance, bindings, fixtures, runtime) {
  fixtureForAction(fixtures, actionInstance, 'tx.scripted-step-state/v1', scriptedFixtureState(actionInstance), runtime);
  const tx = bindingValue(actionInstance.arguments.tx, bindings, 'tx-handle', 'tx.run-scripted tx');
  const signal = actionInstance.arguments.externalSignal === null
    ? undefined
    : bindingValue(actionInstance.arguments.externalSignal, bindings, 'abort-signal', 'tx.run-scripted externalSignal');
  const state = runtimeState(runtime);
  let attemptCount = 0;
  const step = async () => {
    if (actionInstance.arguments.gate !== null) {
      if (typeof runtime.waitForGate !== 'function') failInfrastructure(`Registered completion gate is unavailable: ${actionInstance.arguments.gate}`);
      await runtime.waitForGate(actionInstance.arguments.gate, actionInstance.instanceId);
    }
    const outcome = actionInstance.arguments.attemptOutcomes[attemptCount];
    if (outcome === undefined) failInfrastructure(`Scripted outcome exhausted: ${actionInstance.instanceId}`);
    attemptCount += 1;
    if (outcome.kind === 'throw') throw createScriptedError(outcome);
    return outcome.value;
  };
  let compensation;
  if (actionInstance.arguments.compensation !== null) {
    compensation = async () => {
      const item = actionInstance.arguments.compensation;
      state.compensations.push({
        instanceId: actionInstance.instanceId,
        kind: item.kind,
        errorMessage: item.kind === 'throw' ? item.errorMessage : null,
      });
      if (item.kind === 'throw') throw createScriptedError(item);
    };
  }
  const options = {};
  if (actionInstance.arguments.retry !== null) options.retry = actionInstance.arguments.retry;
  if (compensation !== undefined) options.compensate = compensation;
  if (signal !== undefined) options.signal = signal;
  try {
    const promise = Object.keys(options).length === 0 ? tx.run(step) : tx.run(step, options);
    const value = await settleTxPromise(promise, runtime, actionInstance.instanceId);
    return returnedObservation({ kind: 'returned-value', value, attemptCount, compensations: [...state.compensations] });
  } catch (error) {
    rethrowInfrastructureError(error);
    return returnedObservation(normalizeThrownError(error, { attemptCount, compensations: [...state.compensations] }));
  }
}

export async function executeAction({ actionInstance, bindings, fixtures, scheduleControls, runtime }) {
  validateActionArguments({ action: actionInstance, bindings, policy: runtime?.policy });
  validateScheduleControls(scheduleControls);
  if (actionInstance.adapterId === 'tx.start/v2') {
    const tx = startTransaction({
      id: actionInstance.arguments.transactionId,
      timeout: actionInstance.arguments.timeoutMs,
      transition: false,
    });
    bindActionValue(actionInstance, bindings, 'tx-handle', tx);
    return returnedObservation({ kind: 'transaction-created', transactionId: actionInstance.arguments.transactionId });
  }
  if (actionInstance.adapterId === 'env.abort-controller/v1') {
    fixtureForAction(fixtures, actionInstance, 'env.abort-signal-state/v1', abortFixtureState(actionInstance), runtime);
    const controller = new AbortController();
    if (actionInstance.arguments.abortBeforeUse) {
      controller.abort(createScriptedError({
        errorName: actionInstance.arguments.reasonName,
        errorMessage: actionInstance.arguments.reasonMessage,
      }));
    }
    bindActionValue(actionInstance, bindings, 'abort-signal', controller.signal);
    return returnedObservation({ kind: 'abort-signal-created', aborted: controller.signal.aborted });
  }
  if (actionInstance.adapterId === 'tx.run-scripted/v2') {
    assert(actionInstance.bind === null, 'tx.run-scripted cannot declare a binding');
    return executeRun(actionInstance, bindings, fixtures, runtime);
  }
  if (actionInstance.adapterId === 'tx.commit/v2') {
    assert(actionInstance.bind === null, 'tx.commit cannot declare a binding');
    const tx = bindingValue(actionInstance.arguments.tx, bindings, 'tx-handle', 'tx.commit tx');
    try {
      await settleTxPromise(tx.commit(), runtime, actionInstance.instanceId);
      return returnedObservation({ kind: 'returned-value', value: null });
    } catch (error) {
      rethrowInfrastructureError(error);
      return returnedObservation(normalizeThrownError(error));
    }
  }
  throw new Error(`Unregistered tx adapter: ${actionInstance.adapterId}`);
}

export function evaluateInvariant({ invariantRegistration, observation, plan }) {
  return evaluateTxResult(invariantRegistration, observation, plan);
}
