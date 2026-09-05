import { readFileSync } from 'node:fs';

export const localFirstDescriptor = Object.freeze(JSON.parse(readFileSync(new URL('../../registrations/v0.3/benchmark/local-first.json', import.meta.url), 'utf8')));

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} fields changed`);
}

export function normalizeReturnedValue(value) {
  if (!isPlainObject(value)) fail('Local-first returned value must be a plain object');
  return { normalizedObservedKind: 'returned-value', normalizedObservedFields: { value: structuredClone(value) } };
}

function observe(observation) {
  exactKeys(observation, ['normalizedObservedKind', 'normalizedObservedFields'], 'Local-first observation');
  if (observation.normalizedObservedKind !== 'returned-value') return null;
  exactKeys(observation.normalizedObservedFields, ['value'], 'Local-first observed fields');
  if (!isPlainObject(observation.normalizedObservedFields.value)) fail('Local-first observation value must be a plain object');
  return observation.normalizedObservedFields.value;
}

function stalenessPass(value) {
  exactKeys(value, ['updatedAt', 'age', 'isStale', 'isConflicted', 'ttlMs'], 'Staleness observation');
  if (![value.updatedAt, value.age, value.ttlMs].every(Number.isSafeInteger)) fail('Staleness numeric fields are invalid');
  if (value.age < 0 || value.ttlMs < 0 || value.age === value.ttlMs) fail('Staleness observation reached the excluded TTL equality boundary');
  if (typeof value.isStale !== 'boolean' || typeof value.isConflicted !== 'boolean') fail('Staleness flags are invalid');
  return value.isStale === (value.age > value.ttlMs) && value.isConflicted === false;
}

function errorTransitionPass(value) {
  exactKeys(value, ['notified', 'errorName'], 'Error-transition observation');
  if (typeof value.notified !== 'boolean') fail('Error-transition notification flag is invalid');
  if (value.errorName !== null && typeof value.errorName !== 'string') fail('Error-transition error name is invalid');
  return value.notified === true && value.errorName === 'ValidationError';
}

function selfBroadcastPass(value) {
  exactKeys(value, ['localMutationCallbacks', 'callbackCountAfterPeerRelay', 'senderSelfDeliveries', 'peerReceipts', 'peerRetransmissions'], 'Self-broadcast observation');
  for (const key of Object.keys(value)) if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(`Self-broadcast ${key} is invalid`);
  return value.localMutationCallbacks === 1
    && value.callbackCountAfterPeerRelay === 0
    && value.senderSelfDeliveries === 0
    && value.peerReceipts === 1
    && value.peerRetransmissions === 1;
}

export function evaluateLocalFirstObservation(invariantId, observation) {
  const value = observe(observation);
  let passed = false;
  if (value !== null && invariantId === 'local.staleness-from-age-and-ttl/proposed-v1') passed = stalenessPass(value);
  else if (value !== null && invariantId === 'local.error-transition-notifies/proposed-v1') passed = errorTransitionPass(value);
  else if (value !== null && invariantId === 'local.ignore-self-broadcast/proposed-v1') passed = selfBroadcastPass(value);
  else if (![
    'local.staleness-from-age-and-ttl/proposed-v1',
    'local.error-transition-notifies/proposed-v1',
    'local.ignore-self-broadcast/proposed-v1',
  ].includes(invariantId)) fail(`Unregistered local-first invariant: ${invariantId}`);
  return {
    execution: passed ? 'pass' : 'candidate-failure',
    observedKind: observation.normalizedObservedKind,
    observedFields: observation.normalizedObservedFields,
  };
}
