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

function boundedId(value, label) {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u.test(value)) fail(`${label} is invalid`);
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`);
}

function countRecord(value, label, { invalidAllowed = false } = {}) {
  exactKeys(value, ['count'], label);
  if (invalidAllowed && value.count === 'invalid') return;
  finiteNumber(value.count, `${label}.count`);
}

function validateIndexedDbFixture(value) {
  exactKeys(value, ['schemaVersion', 'database', 'version', 'stores'], 'Local-first IndexedDB fixture argument');
  if (value.schemaVersion !== 'bug-dreamer/local-first-indexeddb-fixture/v1' || value.database !== 'firsttx-local-first' || value.version !== 2 || JSON.stringify(value.stores) !== JSON.stringify(['models', 'tx_journal', 'settings'])) fail('Local-first IndexedDB fixture argument changed');
}

function validateSchemaFixture(value) {
  exactKeys(value, ['schemaVersion', 'schemaId'], 'Local-first schema fixture argument');
  if (value.schemaVersion !== 'bug-dreamer/local-first-schema-fixture/v1' || value.schemaId !== 'local.count-record/v1') fail('Local-first schema fixture argument changed');
}

function validateCallbackFixture(value) {
  exactKeys(value, ['schemaVersion', 'logId'], 'Local-first callback fixture argument');
  if (value.schemaVersion !== 'bug-dreamer/local-first-callback-fixture/v1' || value.logId !== 'primary') fail('Local-first callback fixture argument changed');
}

function validateBroadcastFixture(value) {
  exactKeys(value, ['schemaVersion', 'channel', 'senderSelfDelivery', 'peerInstances', 'retransmitLimit'], 'Local-first broadcast fixture argument');
  if (value.schemaVersion !== 'bug-dreamer/local-first-broadcast-fixture/v1' || value.channel !== 'firsttx:models' || value.senderSelfDelivery !== false || value.peerInstances !== 1 || value.retransmitLimit !== 1) fail('Local-first broadcast fixture argument changed');
}

function binding(bindings, name, expectedType) {
  boundedId(name, 'Binding name');
  const entry = bindings.get(name);
  if (!isPlainObject(entry) || entry.type !== expectedType || !Object.hasOwn(entry, 'value')) fail(`Binding ${name} is not a ${expectedType}`);
}

function actionAdapterId(action) {
  if (typeof action.adapterId === 'string') return action.adapterId;
  const registration = {
    'local.define-model': 'local.define-model/v1',
    'local.storage-set': 'local.storage-set/v1',
    'local.subscribe': 'local.subscribe/v1',
    'local.replace': 'local.replace/v1',
    'local.patch': 'local.patch/v1',
    'local.get-history': 'local.get-history/v1',
    'local.get-cached-history': 'local.get-cached-history/v1',
    'local.get-cached-error': 'local.get-cached-error/v1',
  };
  return registration[action.actionId];
}

function validateBind(action, expected) {
  const value = action.bind ?? null;
  if (expected === null) {
    if (value !== null) fail(`${action.actionId} may not bind a value`);
    return;
  }
  exactKeys(value, ['name', 'type'], `${action.actionId} binding`);
  boundedId(value.name, `${action.actionId} binding name`);
  if (value.type !== expected) fail(`${action.actionId} binding type must be ${expected}`);
}

export function validateActionArguments({ action, bindings, policy }) {
  if (!isPlainObject(action) || !isPlainObject(action.arguments)) fail('Local-first action and arguments must be plain objects');
  if (!(bindings instanceof Map)) fail('Local-first bindings must be a Map');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) fail('Local-first action policy must be an object when supplied');
  const adapterId = actionAdapterId(action);
  const args = action.arguments;
  if (adapterId === 'local.define-model/v1') {
    exactKeys(args, ['name', 'schemaId', 'version', 'ttlMs', 'hasInitialData', 'initialData', 'schemaFixture', 'indexedDbFixture'], 'local.define-model arguments');
    boundedId(args.name, 'Model name');
    if (args.schemaId !== 'local.count-record/v1' || args.version !== 1) fail('Model schema or version is not registered');
    if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs < 0 || args.ttlMs > 86_400_000) fail('Model TTL is outside registered bounds');
    if (typeof args.hasInitialData !== 'boolean') fail('Model initial-data presence flag is invalid');
    if (args.hasInitialData) countRecord(args.initialData, 'Model initial data');
    else if (args.initialData !== null) fail('Absent model initial data must be null');
    validateSchemaFixture(args.schemaFixture);
    validateIndexedDbFixture(args.indexedDbFixture);
    validateBind(action, 'model-handle');
  } else if (adapterId === 'local.storage-set/v1') {
    exactKeys(args, ['modelName', 'record'], 'local.storage-set arguments');
    boundedId(args.modelName, 'Stored model name');
    exactKeys(args.record, ['_v', 'updatedAt', 'data'], 'Stored model record');
    if (args.record._v !== 1 || !Number.isSafeInteger(args.record.updatedAt) || args.record.updatedAt < 0) fail('Stored model metadata is invalid');
    countRecord(args.record.data, 'Stored model data', { invalidAllowed: true });
    validateBind(action, null);
  } else if (adapterId === 'local.subscribe/v1') {
    exactKeys(args, ['modelBinding', 'callbackLogId', 'callbackFixture', 'captureMode'], 'local.subscribe arguments');
    binding(bindings, args.modelBinding, 'model-handle');
    if (args.callbackLogId !== 'primary') fail('Callback log is not registered');
    validateCallbackFixture(args.callbackFixture);
    if (!['count-only', 'cached-history'].includes(args.captureMode)) fail('Subscriber capture mode is not registered');
    validateBind(action, 'unsubscribe-handle');
  } else if (adapterId === 'local.replace/v1') {
    exactKeys(args, ['modelBinding', 'data'], 'local.replace arguments');
    binding(bindings, args.modelBinding, 'model-handle');
    countRecord(args.data, 'Replacement data');
    validateBind(action, null);
  } else if (adapterId === 'local.patch/v1') {
    exactKeys(args, ['modelBinding', 'patchId', 'value', 'callbackLogId', 'broadcastFixture'], 'local.patch arguments');
    binding(bindings, args.modelBinding, 'model-handle');
    if (args.patchId !== 'local.increment-count/v1' || args.value !== 1 || args.callbackLogId !== 'primary') fail('Patch operation is not registered');
    validateBroadcastFixture(args.broadcastFixture);
    validateBind(action, null);
  } else if (adapterId === 'local.get-history/v1') {
    exactKeys(args, ['modelBinding', 'ttlMs'], 'local.get-history arguments');
    binding(bindings, args.modelBinding, 'model-handle');
    if (!Number.isSafeInteger(args.ttlMs) || args.ttlMs < 0 || args.ttlMs > 86_400_000) fail('Observed TTL is outside registered bounds');
    validateBind(action, null);
  } else if (adapterId === 'local.get-cached-history/v1') {
    exactKeys(args, ['modelBinding', 'callbackLogId', 'ttlMs'], 'local.get-cached-history arguments');
    binding(bindings, args.modelBinding, 'model-handle');
    if (args.callbackLogId !== 'primary' || !Number.isSafeInteger(args.ttlMs) || args.ttlMs < 0 || args.ttlMs > 86_400_000) fail('Cached-history observation arguments are invalid');
    validateBind(action, null);
  } else if (adapterId === 'local.get-cached-error/v1') {
    exactKeys(args, ['modelBinding', 'callbackLogId'], 'local.get-cached-error arguments');
    binding(bindings, args.modelBinding, 'model-handle');
    if (args.callbackLogId !== 'primary') fail('Callback log is not registered');
    validateBind(action, null);
  } else fail(`Unregistered local-first action: ${adapterId ?? action.actionId}`);
}
