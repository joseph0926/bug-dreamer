const EXPECTATIONS = Object.freeze({
  'prepaint.exact-route/v1': Object.freeze({ overlayMounted: false, dataPrepaint: false }),
  'prepaint.expired-pruned/v1': Object.freeze({ present: false }),
  'prepaint.utf8-size-pruned/v1': Object.freeze({ present: false }),
  'prepaint.absolute-routes/v1': Object.freeze({ kind: 'thrown', name: 'Error', messageClass: 'absolute-pathname' }),
});

function fail(message) {
  throw new TypeError(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  return value;
}

function exactKeys(value, keys, label) {
  plainObject(value, label);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} fields changed`);
}

function equalFields(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function expectedFromPlan(invariantId, plan) {
  plainObject(plan, 'Prepaint invariant plan');
  if (!Array.isArray(plan.actions)) fail('Prepaint invariant plan actions are missing');
  if (invariantId === 'prepaint.absolute-routes/v1') {
    const action = [...plan.actions].reverse().find((item) => item.actionId === 'prepaint.vite-create');
    if (action === undefined) fail('Absolute-route invariant requires prepaint.vite-create');
    const hasRelativeRoute = action.arguments.policy.routes.some((route) => !route.startsWith('/'));
    return hasRelativeRoute
      ? { kind: 'thrown', name: 'Error', messageClass: 'absolute-pathname' }
      : { kind: 'returned', name: 'vite-plugin-firsttx', messageClass: null };
  }
  const action = [...plan.actions].reverse().find((item) => item.actionId === 'prepaint.boot');
  if (action === undefined) fail(`${invariantId} requires prepaint.boot`);
  const { policy, browser, indexeddb } = action.arguments;
  const pathname = new URL(browser.url).pathname;
  const snapshot = indexeddb.records.find((record) => record.route === pathname);
  const ttlMs = policy.ttlMs ?? 604_800_000;
  const maxSnapshotBytes = policy.maxSnapshotBytes ?? 1_048_576;
  const includeStyles = policy.includeStyles ?? true;
  const payloadBytes = snapshot === undefined ? 0 : Buffer.byteLength(JSON.stringify({ body: snapshot.body, styles: snapshot.styles }), 'utf8');
  const eligible = snapshot !== undefined
    && policy.routes.includes(pathname)
    && browser.clockMs - snapshot.timestamp <= ttlMs
    && payloadBytes <= maxSnapshotBytes
    && (includeStyles || snapshot.styles.length === 0);
  if (invariantId === 'prepaint.exact-route/v1') return { overlayMounted: eligible, dataPrepaint: eligible };
  if (invariantId === 'prepaint.expired-pruned/v1' || invariantId === 'prepaint.utf8-size-pruned/v1') return { present: eligible };
  fail(`Unregistered prepaint invariant: ${invariantId}`);
}

export function classifyPrepaintError(error) {
  const name = error instanceof Error && typeof error.name === 'string' ? error.name : 'Error';
  const message = error instanceof Error && typeof error.message === 'string' ? error.message : String(error);
  let messageClass = 'other';
  if (message.includes('absolute pathname')) messageClass = 'absolute-pathname';
  else if (message.includes('ttlMs')) messageClass = 'ttl-limit';
  else if (message.includes('maxSnapshotBytes')) messageClass = 'snapshot-byte-limit';
  else if (message.includes('includeStyles')) messageClass = 'include-styles';
  return { kind: 'thrown', name, messageClass };
}

export function normalizeReturnedValue(value) {
  plainObject(value, 'Prepaint returned value');
  return { normalizedObservedKind: 'returned-value', normalizedObservedFields: { value } };
}

export function evaluatePrepaintObservation(invariantId, observation, plan) {
  const expected = plan === undefined ? EXPECTATIONS[invariantId] : expectedFromPlan(invariantId, plan);
  if (expected === undefined) fail(`Unregistered prepaint invariant: ${invariantId}`);
  exactKeys(observation, ['normalizedObservedKind', 'normalizedObservedFields'], 'Prepaint observation');
  if (observation.normalizedObservedKind !== 'returned-value') return { execution: 'candidate-failure', observedKind: observation.normalizedObservedKind, observedFields: observation.normalizedObservedFields };
  exactKeys(observation.normalizedObservedFields, ['value'], 'Prepaint observed fields');
  const value = plainObject(observation.normalizedObservedFields.value, 'Prepaint observation value');
  return {
    execution: equalFields(value, expected) ? 'pass' : 'candidate-failure',
    observedKind: observation.normalizedObservedKind,
    observedFields: observation.normalizedObservedFields,
  };
}

export function evaluateRegisteredPrepaintInvariant(invariantRegistration, observation, plan) {
  exactKeys(invariantRegistration, ['id', 'evaluatorId', 'sourceKind', 'sourceRef', 'sourceCommit', 'authoredBeforeGeneration', 'visibility', 'strength', 'corroboratingRefs', 'normalizedObservedKind', 'observedFields'], 'Prepaint invariant registration');
  if (invariantRegistration.evaluatorId !== invariantRegistration.id) fail('Prepaint invariant evaluator binding changed');
  return evaluatePrepaintObservation(invariantRegistration.id, observation, plan);
}
