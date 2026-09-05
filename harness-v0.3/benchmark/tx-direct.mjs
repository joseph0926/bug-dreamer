import { startTransaction } from '@firsttx/tx';

import descriptorRegistration from '../../registrations/v0.3/benchmark/tx.json' with { type: 'json' };
import { canonicalJson, domainDigest, validateJsonValueLimits } from '../../src/v03-wire.mjs';
import { normalizeThrownError, returnedObservation } from './tx-oracle.mjs';
import { applyVirtualAdvances, failInfrastructure, rethrowInfrastructureError, settleTxPromise } from './tx-environment.mjs';

export const descriptor = descriptorRegistration;

const ERROR_CLASSES = Object.freeze({ Error, TypeError, RangeError, SyntaxError });
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

function directBinding(reference, bindings, type, label) {
  strictKeys(reference, ['$binding'], label);
  const binding = bindings.get(reference.$binding);
  assert(isPlainObject(binding) && binding.type === type, `${label} is unavailable or has the wrong type`);
  return binding.value;
}

function validateErrorData(value, label) {
  assert(typeof value.errorName === 'string' && Object.hasOwn(ERROR_CLASSES, value.errorName), `${label}.errorName is not allow-listed`);
  assert(typeof value.errorMessage === 'string' && value.errorMessage.length <= 1024, `${label}.errorMessage is invalid`);
}

function validateDirectAction(action, bindings) {
  strictKeys(action, ['instanceId', 'actionId', 'adapterId', 'actor', 'arguments', 'bind'], 'Direct tx action');
  assert(validIdentifier(action.instanceId) && validIdentifier(action.actor), 'Direct tx action identity is invalid');
  if (action.adapterId === 'tx.start/v2') {
    assert(action.actionId === 'tx.start', 'Direct tx.start action ID changed');
    strictKeys(action.arguments, ['transactionId', 'timeoutMs', 'transition'], 'Direct tx.start arguments');
    assert(typeof action.arguments.transactionId === 'string' && action.arguments.transactionId.length >= 1 && action.arguments.transactionId.length <= 128, 'Direct tx.start transactionId is invalid');
    assert(Number.isSafeInteger(action.arguments.timeoutMs) && action.arguments.timeoutMs >= 1 && action.arguments.timeoutMs <= 10000, 'Direct tx.start timeoutMs is invalid');
    assert(action.arguments.transition === false, 'Direct tx.start transition must be false');
    strictKeys(action.bind, ['name', 'type'], 'Direct tx.start binding');
    assert(validIdentifier(action.bind.name) && action.bind.type === 'tx-handle' && !bindings.has(action.bind.name), 'Direct tx.start binding is invalid');
    return;
  }
  if (action.adapterId === 'env.abort-controller/v1') {
    assert(action.actionId === 'env.abort-controller', 'Direct abort action ID changed');
    strictKeys(action.arguments, ['reasonName', 'reasonMessage', 'abortBeforeUse'], 'Direct abort arguments');
    validateErrorData({ errorName: action.arguments.reasonName, errorMessage: action.arguments.reasonMessage }, 'Direct abort');
    assert(typeof action.arguments.abortBeforeUse === 'boolean', 'Direct abortBeforeUse is invalid');
    strictKeys(action.bind, ['name', 'type'], 'Direct abort binding');
    assert(validIdentifier(action.bind.name) && action.bind.type === 'abort-signal' && !bindings.has(action.bind.name), 'Direct abort binding is invalid');
    return;
  }
  if (action.adapterId === 'tx.run-scripted/v2') {
    assert(action.actionId === 'tx.run-scripted' && action.bind === null, 'Direct tx.run-scripted identity changed');
    strictKeys(action.arguments, ['tx', 'attemptOutcomes', 'retry', 'compensation', 'externalSignal', 'gate'], 'Direct tx.run-scripted arguments');
    directBinding(action.arguments.tx, bindings, 'tx-handle', 'Direct tx.run-scripted tx');
    assert(Array.isArray(action.arguments.attemptOutcomes) && action.arguments.attemptOutcomes.length >= 1 && action.arguments.attemptOutcomes.length <= 5, 'Direct scripted outcomes length is invalid');
    for (const [index, outcome] of action.arguments.attemptOutcomes.entries()) {
      if (outcome.kind === 'return') {
        strictKeys(outcome, ['kind', 'value'], `Direct scripted outcome ${index}`);
        validateJsonValueLimits(outcome.value);
      } else if (outcome.kind === 'throw') {
        strictKeys(outcome, ['kind', 'errorName', 'errorMessage'], `Direct scripted outcome ${index}`);
        validateErrorData(outcome, `Direct scripted outcome ${index}`);
      } else throw new Error(`Direct scripted outcome ${index} kind is invalid`);
    }
    if (action.arguments.retry === null) assert(action.arguments.attemptOutcomes.length === 1, 'Direct non-retry run requires one outcome');
    else {
      strictKeys(action.arguments.retry, ['maxAttempts', 'delayMs', 'backoff'], 'Direct retry');
      assert(Number.isSafeInteger(action.arguments.retry.maxAttempts) && action.arguments.retry.maxAttempts >= 1 && action.arguments.retry.maxAttempts <= 5, 'Direct maxAttempts is invalid');
      assert(Number.isSafeInteger(action.arguments.retry.delayMs) && action.arguments.retry.delayMs >= 0 && action.arguments.retry.delayMs <= 1000, 'Direct delayMs is invalid');
      assert(['linear', 'exponential'].includes(action.arguments.retry.backoff), 'Direct backoff is invalid');
      assert(action.arguments.attemptOutcomes.length === action.arguments.retry.maxAttempts, 'Direct outcomes do not cover all attempts');
    }
    if (action.arguments.compensation !== null) {
      if (action.arguments.compensation.kind === 'return') strictKeys(action.arguments.compensation, ['kind'], 'Direct compensation');
      else if (action.arguments.compensation.kind === 'throw') {
        strictKeys(action.arguments.compensation, ['kind', 'errorName', 'errorMessage'], 'Direct compensation');
        validateErrorData(action.arguments.compensation, 'Direct compensation');
      } else throw new Error('Direct compensation kind is invalid');
    }
    if (action.arguments.externalSignal !== null) directBinding(action.arguments.externalSignal, bindings, 'abort-signal', 'Direct externalSignal');
    assert(action.arguments.gate === null, 'Direct comparison does not admit completion gates');
    return;
  }
  if (action.adapterId === 'tx.commit/v2') {
    assert(action.actionId === 'tx.commit' && action.bind === null, 'Direct tx.commit identity changed');
    strictKeys(action.arguments, ['tx'], 'Direct tx.commit arguments');
    directBinding(action.arguments.tx, bindings, 'tx-handle', 'Direct tx.commit tx');
    return;
  }
  throw new Error(`Unregistered direct tx adapter: ${action.adapterId}`);
}

function createScriptedError(value) {
  const ErrorClass = ERROR_CLASSES[value.errorName];
  return new ErrorClass(value.errorMessage);
}

function assertFixture(input, action, artifact, registrationId) {
  const fixture = input.fixtureSetup.find((item) => item.consumerActionInstanceId === action.instanceId
    && item.registrationId === registrationId);
  assert(fixture !== undefined, `Direct fixture is missing: ${action.instanceId}`);
  const registration = descriptor.fixtures.find((item) => item.id === fixture.registrationId);
  assert(fixture.registrationDigest === domainDigest('bug-dreamer/fixture-registration/v1', registration)
    && fixture.kind === registration.kind
    && fixture.materializerId === registration.materializerId
    && canonicalJson(fixture.publicActionTrace) === canonicalJson(registration.publicActionTrace), `Direct fixture registration changed: ${action.instanceId}`);
  assert(fixture.producerArtifact.moduleRegistrationId === descriptor.moduleId
    && fixture.producerArtifact.targetArtifactDigest === artifact.targetArtifactDigest, `Direct fixture producer changed: ${action.instanceId}`);
  const state = action.arguments;
  assert(fixture.stateDigest === domainDigest(FIXTURE_STATE_DOMAIN, state), `Direct fixture digest changed: ${action.instanceId}`);
  assert(canonicalJson(fixture.canonicalWirePayload) === canonicalJson(state), `Direct fixture payload changed: ${action.instanceId}`);
}

async function executeDirectRun(action, bindings, input, runtime, state, artifact) {
  assertFixture(input, action, artifact, 'tx.scripted-step-state/v1');
  const tx = directBinding(action.arguments.tx, bindings, 'tx-handle', 'Direct tx.run-scripted tx');
  const signal = action.arguments.externalSignal === null
    ? undefined
    : directBinding(action.arguments.externalSignal, bindings, 'abort-signal', 'Direct externalSignal');
  let attemptCount = 0;
  const step = async () => {
    const outcome = action.arguments.attemptOutcomes[attemptCount];
    if (outcome === undefined) failInfrastructure(`Direct scripted outcome exhausted: ${action.instanceId}`);
    attemptCount += 1;
    if (outcome.kind === 'throw') throw createScriptedError(outcome);
    return outcome.value;
  };
  let compensate;
  if (action.arguments.compensation !== null) {
    compensate = async () => {
      const item = action.arguments.compensation;
      state.compensations.push({
        instanceId: action.instanceId,
        kind: item.kind,
        errorMessage: item.kind === 'throw' ? item.errorMessage : null,
      });
      if (item.kind === 'throw') throw createScriptedError(item);
    };
  }
  const options = {};
  if (action.arguments.retry !== null) options.retry = action.arguments.retry;
  if (compensate !== undefined) options.compensate = compensate;
  if (signal !== undefined) options.signal = signal;
  try {
    const promise = Object.keys(options).length === 0 ? tx.run(step) : tx.run(step, options);
    const value = await settleTxPromise(promise, runtime, action.instanceId);
    return returnedObservation({ kind: 'returned-value', value, attemptCount, compensations: [...state.compensations] });
  } catch (error) {
    rethrowInfrastructureError(error);
    return returnedObservation(normalizeThrownError(error, { attemptCount, compensations: [...state.compensations] }));
  }
}

async function runDirectInput(input, runtime, artifact) {
  const bindings = new Map();
  const state = { compensations: [] };
  let observation = null;
  for (const action of input.actions) {
    validateDirectAction(action, bindings);
    if (action.adapterId === 'tx.start/v2') {
      const tx = startTransaction({ id: action.arguments.transactionId, timeout: action.arguments.timeoutMs, transition: false });
      bindings.set(action.bind.name, { type: 'tx-handle', value: tx });
      observation = returnedObservation({ kind: 'transaction-created', transactionId: action.arguments.transactionId });
    } else if (action.adapterId === 'env.abort-controller/v1') {
      assertFixture(input, action, artifact, 'env.abort-signal-state/v1');
      const controller = new AbortController();
      if (action.arguments.abortBeforeUse) controller.abort(createScriptedError({ errorName: action.arguments.reasonName, errorMessage: action.arguments.reasonMessage }));
      bindings.set(action.bind.name, { type: 'abort-signal', value: controller.signal });
      observation = returnedObservation({ kind: 'abort-signal-created', aborted: controller.signal.aborted });
    } else if (action.adapterId === 'tx.run-scripted/v2') {
      observation = await executeDirectRun(action, bindings, input, runtime, state, artifact);
    } else if (action.adapterId === 'tx.commit/v2') {
      const tx = directBinding(action.arguments.tx, bindings, 'tx-handle', 'Direct tx.commit tx');
      try {
        await settleTxPromise(tx.commit(), runtime, action.instanceId);
        observation = returnedObservation({ kind: 'returned-value', value: null });
      } catch (error) {
        rethrowInfrastructureError(error);
        observation = returnedObservation(normalizeThrownError(error));
      }
    }
    await applyVirtualAdvances(input.scheduleControls, action.instanceId, runtime);
  }
  assert(observation !== null, 'Direct comparison produced no observation');
  return observation;
}

export async function materializeComparison({ comparisonRegistration, row, artifact, policy, runtime }) {
  assert(descriptor.comparisons.some((item) => item.id === comparisonRegistration?.id
    && item.materializerId === comparisonRegistration.materializerId), 'Direct comparison registration is not registered');
  assert(isPlainObject(artifact)
    && ['clean', 'single-patch-defect'].includes(artifact.role)
    && /^[0-9a-f]{64}$/u.test(artifact.targetArtifactDigest)
    && /^[0-9a-f]{64}$/u.test(artifact.evaluationContractKey), 'Direct artifact binding is invalid');
  assert(isPlainObject(row) && isPlainObject(row.comparisonInput), 'Direct comparisonInput is missing');
  const input = row.comparisonInput;
  strictKeys(input, ['actions', 'fixtureSetup', 'virtualTime', 'scheduleControls'], 'Direct comparisonInput');
  assert(Array.isArray(input.actions) && input.actions.length > 0, 'Direct comparison actions are empty');
  assert(Array.isArray(input.fixtureSetup), 'Direct comparison fixtures are invalid');
  strictKeys(input.virtualTime, ['originMs'], 'Direct virtualTime');
  assert(input.virtualTime.originMs === 1000000000000, 'Direct virtual-time origin changed');
  assert(Array.isArray(input.scheduleControls)
    && input.scheduleControls.every((control) => control.kind === 'virtual-time-advance'), 'Direct comparison admits only virtual-time advances');
  assert(policy === undefined || policy === null || isPlainObject(policy), 'Direct comparison policy is invalid');
  assert(isPlainObject(runtime), 'Direct comparison runtime is missing');
  return runDirectInput(input, runtime, artifact);
}
