const RETURNED_FIELDS = Object.freeze([{ name: 'value', type: 'json' }]);

export const TX_INVARIANT_PROJECTIONS = Object.freeze({
  'tx.rollback-reverse-order/v1': Object.freeze(['kind', 'compensations']),
  'tx.total-timeout/v1': Object.freeze(['kind', 'name']),
  'tx.no-run-after-rollback/v1': Object.freeze(['kind', 'name', 'currentState', 'attemptedAction', 'attemptCount']),
  'tx.compensation-failure/v1': Object.freeze(['kind', 'name', 'failureCount', 'failureMessages', 'completedSteps', 'compensations']),
  'tx.preaborted-signal/v1': Object.freeze(['kind', 'name', 'message', 'attemptCount']),
  'tx.no-commit-after-rollback/v1': Object.freeze(['kind', 'name', 'currentState', 'attemptedAction']),
  'tx.retry-error-history/v1': Object.freeze(['kind', 'name', 'attempts', 'errorMessages', 'attemptCount']),
  'tx.completed-steps-compensated/v1': Object.freeze(['kind', 'compensations']),
  'tx.retry-final-attempt/v1': Object.freeze(['kind', 'value', 'attemptCount']),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function sameJson(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function finalAction(plan, adapterId) {
  return [...plan.actions].reverse().find((action) => action.adapterId === adapterId);
}

function runActionsBefore(plan, instanceId) {
  const end = plan.actions.findIndex((action) => action.instanceId === instanceId);
  assert(end >= 0, `Invariant action is absent from plan: ${instanceId}`);
  return plan.actions.slice(0, end).filter((action) => action.adapterId === 'tx.run-scripted/v2');
}

function scriptedErrorMessages(action) {
  const attempts = action.arguments.retry?.maxAttempts ?? 1;
  return action.arguments.attemptOutcomes.slice(0, attempts)
    .filter((outcome) => outcome.kind === 'throw')
    .map((outcome) => outcome.errorMessage);
}

function expectedCompensations(plan, failedInstanceId) {
  return runActionsBefore(plan, failedInstanceId)
    .filter((action) => action.arguments.compensation !== null)
    .reverse()
    .map((action) => ({
      instanceId: action.instanceId,
      kind: action.arguments.compensation.kind,
      errorMessage: action.arguments.compensation.kind === 'throw'
        ? action.arguments.compensation.errorMessage
        : null,
    }));
}

function requireReturnedObservation(observation) {
  assert(isPlainObject(observation), 'Observation must be an object');
  assert(sameJson(Object.keys(observation).sort(), ['normalizedObservedFields', 'normalizedObservedKind']), 'Observation fields changed');
  assert(observation.normalizedObservedKind === 'returned-value', 'tx benchmark observations use the returned-value envelope');
  assert(isPlainObject(observation.normalizedObservedFields)
    && sameJson(Object.keys(observation.normalizedObservedFields), ['value']), 'tx benchmark observation fields changed');
  assert(isPlainObject(observation.normalizedObservedFields.value), 'tx benchmark observation value must be an object');
  return observation.normalizedObservedFields.value;
}

export function returnedObservation(value) {
  return {
    normalizedObservedKind: 'returned-value',
    normalizedObservedFields: { value },
  };
}

export function normalizeThrownError(error, details = {}) {
  const normalized = {
    kind: 'thrown-error',
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message : String(error),
    ...details,
  };
  if (Array.isArray(error?.failures)) {
    normalized.failureCount = error.failures.length;
    normalized.failureMessages = error.failures.map((failure) => failure instanceof Error ? failure.message : String(failure));
  }
  if (Number.isSafeInteger(error?.completedSteps)) normalized.completedSteps = error.completedSteps;
  if (Number.isSafeInteger(error?.attempts)) normalized.attempts = error.attempts;
  if (Array.isArray(error?.errors)) {
    normalized.errorMessages = error.errors.map((failure) => failure instanceof Error ? failure.message : String(failure));
  }
  if (typeof error?.currentState === 'string') normalized.currentState = error.currentState;
  if (typeof error?.attemptedAction === 'string') normalized.attemptedAction = error.attemptedAction;
  return normalized;
}

export function projectTxObservation(invariantId, observation) {
  const value = requireReturnedObservation(observation);
  const fields = TX_INVARIANT_PROJECTIONS[invariantId];
  assert(fields !== undefined, `Unregistered tx observation projection: ${invariantId}`);
  const projected = {};
  for (const field of fields) {
    projected[field] = Object.hasOwn(value, field) ? value[field] : null;
  }
  return returnedObservation(projected);
}

export function evaluateTxInvariant(invariantId, observation, plan) {
  const value = requireReturnedObservation(observation);
  const finalRun = finalAction(plan, 'tx.run-scripted/v2');
  let passed = false;

  if (invariantId === 'tx.rollback-reverse-order/v1' || invariantId === 'tx.completed-steps-compensated/v1') {
    assert(finalRun !== undefined, `${invariantId} requires tx.run-scripted/v2`);
    const expected = expectedCompensations(plan, finalRun.instanceId);
    passed = value.kind === 'thrown-error' && sameJson(value.compensations, expected);
  } else if (invariantId === 'tx.total-timeout/v1') {
    passed = value.kind === 'thrown-error' && value.name === 'TransactionTimeoutError';
  } else if (invariantId === 'tx.no-run-after-rollback/v1') {
    passed = value.kind === 'thrown-error'
      && value.name === 'TransactionStateError'
      && value.currentState === 'rolled-back'
      && value.attemptedAction === 'add step'
      && value.attemptCount === 0;
  } else if (invariantId === 'tx.compensation-failure/v1') {
    assert(finalRun !== undefined, `${invariantId} requires tx.run-scripted/v2`);
    const failures = expectedCompensations(plan, finalRun.instanceId)
      .filter((item) => item.kind === 'throw')
      .map((item) => item.errorMessage);
    passed = value.kind === 'thrown-error'
      && value.name === 'CompensationFailedError'
      && value.failureCount === failures.length
      && sameJson(value.failureMessages, failures);
  } else if (invariantId === 'tx.preaborted-signal/v1') {
    const abortAction = finalAction(plan, 'env.abort-controller/v1');
    assert(abortAction !== undefined, `${invariantId} requires env.abort-controller/v1`);
    passed = abortAction.arguments.abortBeforeUse === true
      && value.kind === 'thrown-error'
      && value.name === abortAction.arguments.reasonName
      && value.message === abortAction.arguments.reasonMessage
      && value.attemptCount === 0;
  } else if (invariantId === 'tx.no-commit-after-rollback/v1') {
    passed = value.kind === 'thrown-error'
      && value.name === 'TransactionStateError'
      && value.currentState === 'rolled-back'
      && value.attemptedAction === 'commit';
  } else if (invariantId === 'tx.retry-error-history/v1') {
    assert(finalRun !== undefined, `${invariantId} requires tx.run-scripted/v2`);
    const messages = scriptedErrorMessages(finalRun);
    passed = value.kind === 'thrown-error'
      && value.name === 'RetryExhaustedError'
      && value.attempts === (finalRun.arguments.retry?.maxAttempts ?? 1)
      && sameJson(value.errorMessages, messages);
  } else if (invariantId === 'tx.retry-final-attempt/v1') {
    assert(finalRun !== undefined, `${invariantId} requires tx.run-scripted/v2`);
    const firstReturn = finalRun.arguments.attemptOutcomes.findIndex((outcome) => outcome.kind === 'return');
    assert(firstReturn >= 0, `${invariantId} requires a scripted return`);
    passed = value.kind === 'returned-value'
      && value.attemptCount === firstReturn + 1
      && sameJson(value.value, finalRun.arguments.attemptOutcomes[firstReturn].value);
  } else {
    throw new Error(`Unregistered tx invariant: ${invariantId}`);
  }
  return { passed, value };
}

export function evaluateTxResult(invariantRegistration, observation, plan) {
  assert(invariantRegistration?.id === plan.invariantRegistrationId, 'Invariant registration differs from the plan');
  assert(invariantRegistration.evaluatorId === plan.evaluatorId, 'Invariant evaluator differs from the plan');
  assert(plan.normalizedObservedKind === 'returned-value' && sameJson(plan.observedFields, RETURNED_FIELDS), 'Plan observation contract differs from tx');
  const { passed } = evaluateTxInvariant(invariantRegistration.id, observation, plan);
  const projected = projectTxObservation(invariantRegistration.id, observation);
  return {
    execution: passed ? 'pass' : 'candidate-failure',
    observedKind: projected.normalizedObservedKind,
    observedFields: projected.normalizedObservedFields,
  };
}
