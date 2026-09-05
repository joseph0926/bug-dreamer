import { validateJsonValueLimits } from '../../src/v03-wire.mjs';

const ERROR_NAMES = Object.freeze(['Error', 'TypeError', 'RangeError', 'SyntaxError']);

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

function bindingType(reference, bindings, expectedType, label) {
  strictKeys(reference, ['$binding'], label);
  assert(validIdentifier(reference.$binding), `${label} name is invalid`);
  const binding = bindings.get(reference.$binding);
  const actualType = typeof binding === 'string' ? binding : binding?.type;
  assert(actualType === expectedType, `${label} is unavailable or has the wrong type`);
}

function validateErrorData(errorName, errorMessage, label) {
  assert(ERROR_NAMES.includes(errorName), `${label}.errorName is not allow-listed`);
  assert(typeof errorMessage === 'string' && errorMessage.length <= 1024, `${label}.errorMessage is invalid`);
}

function validateOutcomes(outcomes) {
  assert(Array.isArray(outcomes) && outcomes.length >= 1 && outcomes.length <= 5, 'tx.run-scripted attemptOutcomes length is invalid');
  for (const [index, outcome] of outcomes.entries()) {
    assert(isPlainObject(outcome), `tx.run-scripted attempt ${index} must be an object`);
    if (outcome.kind === 'return') {
      strictKeys(outcome, ['kind', 'value'], `tx.run-scripted attempt ${index}`);
      validateJsonValueLimits(outcome.value);
    } else if (outcome.kind === 'throw') {
      strictKeys(outcome, ['kind', 'errorName', 'errorMessage'], `tx.run-scripted attempt ${index}`);
      validateErrorData(outcome.errorName, outcome.errorMessage, `tx.run-scripted attempt ${index}`);
    } else throw new Error(`tx.run-scripted attempt ${index} kind is invalid`);
  }
}

function validateRun(action, bindings) {
  const args = action.arguments;
  strictKeys(args, ['tx', 'attemptOutcomes', 'retry', 'compensation', 'externalSignal', 'gate'], 'tx.run-scripted arguments');
  bindingType(args.tx, bindings, 'tx-handle', 'tx.run-scripted tx');
  validateOutcomes(args.attemptOutcomes);
  if (args.retry === null) assert(args.attemptOutcomes.length === 1, 'tx.run-scripted without retry requires exactly one outcome');
  else {
    strictKeys(args.retry, ['maxAttempts', 'delayMs', 'backoff'], 'tx.run-scripted retry');
    assert(Number.isSafeInteger(args.retry.maxAttempts) && args.retry.maxAttempts >= 1 && args.retry.maxAttempts <= 5, 'tx.run-scripted maxAttempts is invalid');
    assert(Number.isSafeInteger(args.retry.delayMs) && args.retry.delayMs >= 0 && args.retry.delayMs <= 1000, 'tx.run-scripted delayMs is invalid');
    assert(['linear', 'exponential'].includes(args.retry.backoff), 'tx.run-scripted backoff is invalid');
    assert(args.attemptOutcomes.length === args.retry.maxAttempts, 'tx.run-scripted outcomes must cover every registered attempt');
  }
  if (args.compensation !== null) {
    if (args.compensation.kind === 'return') strictKeys(args.compensation, ['kind'], 'tx.run-scripted compensation');
    else if (args.compensation.kind === 'throw') {
      strictKeys(args.compensation, ['kind', 'errorName', 'errorMessage'], 'tx.run-scripted compensation');
      validateErrorData(args.compensation.errorName, args.compensation.errorMessage, 'tx.run-scripted compensation');
    } else throw new Error('tx.run-scripted compensation kind is invalid');
  }
  if (args.externalSignal !== null) bindingType(args.externalSignal, bindings, 'abort-signal', 'tx.run-scripted externalSignal');
  assert(args.gate === null || validIdentifier(args.gate), 'tx.run-scripted gate is invalid');
}

export function validateActionArguments({ action, bindings, policy }) {
  assert(isPlainObject(action), 'Action must be an object');
  assert(bindings instanceof Map, 'bindings must be a Map');
  assert(policy === undefined || policy === null || isPlainObject(policy), 'policy must be an object when present');
  if (action.adapterId === 'tx.start/v2') {
    strictKeys(action.arguments, ['transactionId', 'timeoutMs', 'transition'], 'tx.start arguments');
    assert(typeof action.arguments.transactionId === 'string' && action.arguments.transactionId.length >= 1 && action.arguments.transactionId.length <= 128, 'tx.start transactionId is invalid');
    assert(Number.isSafeInteger(action.arguments.timeoutMs) && action.arguments.timeoutMs >= 1 && action.arguments.timeoutMs <= 10000, 'tx.start timeoutMs is invalid');
    assert(action.arguments.transition === false, 'tx.start transition must be false');
  } else if (action.adapterId === 'tx.run-scripted/v2') validateRun(action, bindings);
  else if (action.adapterId === 'tx.commit/v2') {
    strictKeys(action.arguments, ['tx'], 'tx.commit arguments');
    bindingType(action.arguments.tx, bindings, 'tx-handle', 'tx.commit tx');
  } else if (action.adapterId === 'env.abort-controller/v1') {
    strictKeys(action.arguments, ['reasonName', 'reasonMessage', 'abortBeforeUse'], 'env.abort-controller arguments');
    validateErrorData(action.arguments.reasonName, action.arguments.reasonMessage, 'env.abort-controller');
    assert(typeof action.arguments.abortBeforeUse === 'boolean', 'env.abort-controller abortBeforeUse is invalid');
  } else throw new Error(`Unregistered tx adapter: ${action.adapterId}`);
}
