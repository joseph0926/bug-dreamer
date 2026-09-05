import { domainDigest } from '../../src/v03-wire.mjs';

export const FIXTURE_REGISTRATION_DOMAIN = 'bug-dreamer/v03-benchmark-fixture-registration/v1';
export const FIXTURE_STATE_DOMAIN = 'bug-dreamer/v03-benchmark-fixture-state/v1';

const SHA_PATTERN = /^[0-9a-f]{64}$/u;
const SCENARIO_IDS = Object.freeze([
  'local-first-stale-flag-inverted',
  'local-first-error-not-notified',
  'local-first-self-broadcast-not-filtered',
  'synthetic-local-first-nominal',
]);
const INDEXEDDB_FIXTURE = Object.freeze({ schemaVersion: 'bug-dreamer/local-first-indexeddb-fixture/v1', database: 'firsttx-local-first', version: 2, stores: Object.freeze(['models', 'tx_journal', 'settings']) });
const SCHEMA_FIXTURE = Object.freeze({ schemaVersion: 'bug-dreamer/local-first-schema-fixture/v1', schemaId: 'local.count-record/v1' });
const CALLBACK_FIXTURE = Object.freeze({ schemaVersion: 'bug-dreamer/local-first-callback-fixture/v1', logId: 'primary' });
const BROADCAST_FIXTURE = Object.freeze({ schemaVersion: 'bug-dreamer/local-first-broadcast-fixture/v1', channel: 'firsttx:models', senderSelfDelivery: false, peerInstances: 1, retransmitLimit: 1 });

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
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u.test(value) || value.length > 128) fail(`${label} is invalid`);
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
}

export function validateFakeIndexedDBNamespace(namespace) {
  if (namespace === null || typeof namespace !== 'object') fail('fake-indexeddb namespace is missing');
  if (namespace.indexedDB === null || typeof namespace.indexedDB !== 'object' || typeof namespace.indexedDB.open !== 'function') fail('fake-indexeddb indexedDB export is invalid');
  if (typeof namespace.IDBKeyRange !== 'function') fail('fake-indexeddb IDBKeyRange export is invalid');
  return namespace;
}

export function createIndexedDBActivityTracker(factory) {
  if (factory === null || typeof factory !== 'object' || typeof factory.open !== 'function') fail('Tracked IndexedDB factory is invalid');
  let generation = 0;
  let pending = 0;
  let idleWaiters = [];
  let activityWaiters = [];
  const databaseProxies = new WeakMap();
  function started() {
    generation += 1;
    pending += 1;
    const ready = activityWaiters.filter((waiter) => generation > waiter.marker);
    activityWaiters = activityWaiters.filter((waiter) => generation <= waiter.marker);
    ready.forEach((waiter) => waiter.resolve());
  }
  function finished() {
    if (pending <= 0) fail('IndexedDB activity tracker underflow');
    pending -= 1;
    if (pending === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }
  function trackEventTarget(target, successEvents, label) {
    if (target === null || typeof target !== 'object' || typeof target.addEventListener !== 'function') fail(`${label} cannot be tracked`);
    started();
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      finished();
    };
    for (const event of successEvents) target.addEventListener(event, complete, { once: true });
    return target;
  }
  function wrapDatabase(database) {
    if (databaseProxies.has(database)) return databaseProxies.get(database);
    const proxy = new Proxy(database, {
      get(target, property) {
        if (property === 'transaction') return (...args) => trackEventTarget(target.transaction(...args), ['complete', 'abort', 'error'], 'IndexedDB transaction');
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) { return Reflect.set(target, property, value, target); },
    });
    databaseProxies.set(database, proxy);
    return proxy;
  }
  function wrapOpenRequest(request) {
    trackEventTarget(request, ['success', 'error'], 'IndexedDB open request');
    return new Proxy(request, {
      get(target, property) {
        if (property === 'result') return wrapDatabase(Reflect.get(target, property, target));
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) { return Reflect.set(target, property, value, target); },
    });
  }
  const indexedDB = new Proxy(factory, {
    get(target, property) {
      if (property === 'open') return (...args) => wrapOpenRequest(target.open(...args));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  async function waitForIdle() {
    while (pending !== 0) await new Promise((resolve) => idleWaiters.push(resolve));
  }
  async function stableIdle() {
    while (true) {
      await waitForIdle();
      const observedGeneration = generation;
      await Promise.resolve();
      await Promise.resolve();
      if (pending === 0 && generation === observedGeneration) return;
    }
  }
  return Object.freeze({
    indexedDB,
    marker() { return generation; },
    async completeAndMark() { await stableIdle(); return generation; },
    async settleAfter(marker) {
      if (!Number.isSafeInteger(marker) || marker < 0) fail('IndexedDB activity marker is invalid');
      if (generation <= marker) await new Promise((resolve) => activityWaiters.push({ marker, resolve }));
      await stableIdle();
      return generation;
    },
    snapshot() { return { generation, pending }; },
  });
}

function validateIndexedDbPayload(payload) {
  exactKeys(payload, ['schemaVersion', 'database', 'version', 'stores'], 'Local-first IndexedDB fixture');
  if (payload.schemaVersion !== 'bug-dreamer/local-first-indexeddb-fixture/v1' || payload.database !== 'firsttx-local-first' || payload.version !== 2) fail('Local-first IndexedDB identity changed');
  if (JSON.stringify(payload.stores) !== JSON.stringify(['models', 'tx_journal', 'settings'])) fail('Local-first IndexedDB stores changed');
}

function validateSchemaPayload(payload) {
  exactKeys(payload, ['schemaVersion', 'schemaId'], 'Local-first schema fixture');
  if (payload.schemaVersion !== 'bug-dreamer/local-first-schema-fixture/v1' || payload.schemaId !== 'local.count-record/v1') fail('Local-first schema fixture changed');
}

function validateCallbackPayload(payload) {
  exactKeys(payload, ['schemaVersion', 'logId'], 'Local-first callback fixture');
  if (payload.schemaVersion !== 'bug-dreamer/local-first-callback-fixture/v1') fail('Unexpected callback fixture schemaVersion');
  boundedId(payload.logId, 'Callback log ID');
}

function validateBroadcastPayload(payload) {
  exactKeys(payload, ['schemaVersion', 'channel', 'senderSelfDelivery', 'peerInstances', 'retransmitLimit'], 'Local-first broadcast fixture');
  if (payload.schemaVersion !== 'bug-dreamer/local-first-broadcast-fixture/v1' || payload.channel !== 'firsttx:models') fail('Local-first broadcast fixture identity changed');
  if (payload.senderSelfDelivery !== false || payload.peerInstances !== 1 || payload.retransmitLimit !== 1) fail('Local-first broadcast fixture must use one separate peer, no sender self-delivery, and one retransmission');
}

function validateFixturePayload(id, payload) {
  if (id === 'local.indexeddb/v1') validateIndexedDbPayload(payload);
  else if (id === 'local.zod-schema/v1') validateSchemaPayload(payload);
  else if (id === 'local.callback-log/v1') validateCallbackPayload(payload);
  else if (id === 'local.broadcast-peer/v1') validateBroadcastPayload(payload);
  else fail(`Unregistered local-first fixture: ${id}`);
}

export function fixtureStateDigest(payload) {
  return domainDigest(FIXTURE_STATE_DOMAIN, payload);
}

export function createFixtureRegistration(staticRegistration, canonicalWirePayload) {
  const projected = Object.hasOwn(staticRegistration, 'payloadArgumentPointer') || Object.hasOwn(staticRegistration, 'publicActionTrace');
  exactKeys(staticRegistration, projected
    ? ['id', 'kind', 'materializerId', 'consumerActionId', 'payloadArgumentPointer', 'publicActionTrace']
    : ['id', 'kind', 'materializerId', 'consumerActionId'], 'Static fixture registration');
  if (projected && (typeof staticRegistration.payloadArgumentPointer !== 'string' || !Array.isArray(staticRegistration.publicActionTrace) || staticRegistration.publicActionTrace.length === 0)) fail('Projected fixture registration is invalid');
  validateFixturePayload(staticRegistration.id, canonicalWirePayload);
  const registration = { ...staticRegistration, canonicalWirePayload: structuredClone(canonicalWirePayload) };
  return { ...registration, registrationDigest: domainDigest(FIXTURE_REGISTRATION_DOMAIN, registration) };
}

function fixtureRegistrationDigest(fixtureRegistration) {
  const { registrationDigest, ...registration } = fixtureRegistration;
  return domainDigest(FIXTURE_REGISTRATION_DOMAIN, registration);
}

export function materializeFixtureRecord({ fixtureRegistration, artifact, moduleRegistrationId, consumerActionInstanceId }) {
  const projected = Object.hasOwn(fixtureRegistration, 'payloadArgumentPointer') || Object.hasOwn(fixtureRegistration, 'publicActionTrace');
  exactKeys(fixtureRegistration, projected
    ? ['id', 'kind', 'materializerId', 'consumerActionId', 'payloadArgumentPointer', 'publicActionTrace', 'canonicalWirePayload', 'registrationDigest']
    : ['id', 'kind', 'materializerId', 'consumerActionId', 'canonicalWirePayload', 'registrationDigest'], 'Fixture registration');
  exactKeys(artifact, ['role', 'targetArtifactDigest', 'evaluationContractKey'], 'Artifact');
  if (!['clean', 'single-patch-defect'].includes(artifact.role) || !SHA_PATTERN.test(artifact.targetArtifactDigest) || !SHA_PATTERN.test(artifact.evaluationContractKey)) fail('Artifact identity is invalid');
  boundedId(moduleRegistrationId, 'Module registration ID');
  boundedId(consumerActionInstanceId, 'Fixture consumer action instance ID');
  validateFixturePayload(fixtureRegistration.id, fixtureRegistration.canonicalWirePayload);
  if (fixtureRegistration.registrationDigest !== fixtureRegistrationDigest(fixtureRegistration)) fail('Fixture registration digest mismatch');
  return {
    registrationId: fixtureRegistration.id,
    registrationDigest: fixtureRegistration.registrationDigest,
    kind: fixtureRegistration.kind,
    producerArtifact: { moduleRegistrationId, targetArtifactDigest: artifact.targetArtifactDigest },
    publicActionTrace: projected ? structuredClone(fixtureRegistration.publicActionTrace) : [],
    canonicalWirePayload: structuredClone(fixtureRegistration.canonicalWirePayload),
    materializerId: fixtureRegistration.materializerId,
    stateDigest: fixtureStateDigest(fixtureRegistration.canonicalWirePayload),
    consumerActionInstanceId,
  };
}

function staticFixtures() {
  return [
    createFixtureRegistration(
      { id: 'local.indexeddb/v1', kind: 'external-environment', materializerId: 'local.indexeddb/v1', consumerActionId: 'local.define-model', payloadArgumentPointer: '/indexedDbFixture', publicActionTrace: ['local.define-model'] },
      INDEXEDDB_FIXTURE,
    ),
    createFixtureRegistration(
      { id: 'local.zod-schema/v1', kind: 'public-test-seam', materializerId: 'local.zod-schema/v1', consumerActionId: 'local.define-model', payloadArgumentPointer: '/schemaFixture', publicActionTrace: ['local.define-model'] },
      SCHEMA_FIXTURE,
    ),
  ];
}

function callbackFixture(logId) {
  return createFixtureRegistration(
    { id: 'local.callback-log/v1', kind: 'public-test-seam', materializerId: 'local.callback-log/v1', consumerActionId: 'local.subscribe', payloadArgumentPointer: '/callbackFixture', publicActionTrace: ['local.subscribe'] },
    { ...CALLBACK_FIXTURE, logId },
  );
}

export function registeredLocalFirstScenario(rowId) {
  if (!SCENARIO_IDS.includes(rowId)) fail(`Unregistered local-first benchmark row: ${rowId}`);
  const clockMs = 1_000_000_000_000;
  const modelName = `benchmark-${rowId}`;
  const define = { instanceId: 'define', actionId: 'local.define-model', adapterId: 'local.define-model/v1', actor: 'main', arguments: { name: modelName, schemaId: 'local.count-record/v1', version: 1, ttlMs: 5000, hasInitialData: false, initialData: null, schemaFixture: SCHEMA_FIXTURE, indexedDbFixture: INDEXEDDB_FIXTURE }, bind: { name: 'model', type: 'model-handle' } };
  const fixtures = staticFixtures();
  if (rowId === 'synthetic-local-first-nominal') {
    define.arguments.name = 'synthetic-profile';
    define.arguments.ttlMs = 7000;
    fixtures.push(callbackFixture('primary'));
    return structuredClone({ rowId, clockMs, actions: [
      define,
      { instanceId: 'store', actionId: 'local.storage-set', adapterId: 'local.storage-set/v1', actor: 'main', arguments: { modelName: 'synthetic-profile', record: { _v: 1, updatedAt: clockMs - 1000, data: { count: 42 } } }, bind: null },
      { instanceId: 'subscribe', actionId: 'local.subscribe', adapterId: 'local.subscribe/v1', actor: 'main', arguments: { modelBinding: 'model', callbackLogId: 'primary', callbackFixture: CALLBACK_FIXTURE, captureMode: 'cached-history' }, bind: { name: 'unsubscribe', type: 'unsubscribe-handle' } },
      { instanceId: 'observe', actionId: 'local.get-cached-history', adapterId: 'local.get-cached-history/v1', actor: 'main', arguments: { modelBinding: 'model', callbackLogId: 'primary', ttlMs: 7000 }, bind: null },
    ], fixtureRegistrations: fixtures });
  }
  if (rowId === 'local-first-stale-flag-inverted') {
    fixtures.push(callbackFixture('primary'));
    return structuredClone({ rowId, clockMs, actions: [
      define,
      { instanceId: 'store', actionId: 'local.storage-set', adapterId: 'local.storage-set/v1', actor: 'main', arguments: { modelName, record: { _v: 1, updatedAt: clockMs - 8000, data: { count: 1 } } }, bind: null },
      { instanceId: 'subscribe', actionId: 'local.subscribe', adapterId: 'local.subscribe/v1', actor: 'main', arguments: { modelBinding: 'model', callbackLogId: 'primary', callbackFixture: CALLBACK_FIXTURE, captureMode: 'cached-history' }, bind: { name: 'unsubscribe', type: 'unsubscribe-handle' } },
      { instanceId: 'observe', actionId: 'local.get-cached-history', adapterId: 'local.get-cached-history/v1', actor: 'main', arguments: { modelBinding: 'model', callbackLogId: 'primary', ttlMs: 5000 }, bind: null },
    ], fixtureRegistrations: fixtures });
  }
  if (rowId === 'local-first-error-not-notified') {
    fixtures.push(callbackFixture('primary'));
    return structuredClone({ rowId, clockMs, actions: [
      define,
      { instanceId: 'store', actionId: 'local.storage-set', adapterId: 'local.storage-set/v1', actor: 'main', arguments: { modelName, record: { _v: 1, updatedAt: clockMs - 1, data: { count: 'invalid' } } }, bind: null },
      { instanceId: 'subscribe', actionId: 'local.subscribe', adapterId: 'local.subscribe/v1', actor: 'main', arguments: { modelBinding: 'model', callbackLogId: 'primary', callbackFixture: CALLBACK_FIXTURE, captureMode: 'count-only' }, bind: { name: 'unsubscribe', type: 'unsubscribe-handle' } },
      { instanceId: 'observe', actionId: 'local.get-cached-error', adapterId: 'local.get-cached-error/v1', actor: 'main', arguments: { modelBinding: 'model', callbackLogId: 'primary' }, bind: null },
    ], fixtureRegistrations: fixtures });
  }
  fixtures.push(callbackFixture('primary'));
  fixtures.push(createFixtureRegistration(
    { id: 'local.broadcast-peer/v1', kind: 'external-environment', materializerId: 'local.broadcast-peer/v1', consumerActionId: 'local.patch', payloadArgumentPointer: '/broadcastFixture', publicActionTrace: ['local.patch'] },
    BROADCAST_FIXTURE,
  ));
  return structuredClone({ rowId, clockMs, actions: [
    define,
    { instanceId: 'replace', actionId: 'local.replace', adapterId: 'local.replace/v1', actor: 'main', arguments: { modelBinding: 'model', data: { count: 5 } }, bind: null },
    { instanceId: 'subscribe', actionId: 'local.subscribe', adapterId: 'local.subscribe/v1', actor: 'main', arguments: { modelBinding: 'model', callbackLogId: 'primary', callbackFixture: CALLBACK_FIXTURE, captureMode: 'count-only' }, bind: { name: 'unsubscribe', type: 'unsubscribe-handle' } },
    { instanceId: 'observe', actionId: 'local.patch', adapterId: 'local.patch/v1', actor: 'main', arguments: { modelBinding: 'model', patchId: 'local.increment-count/v1', value: 1, callbackLogId: 'primary', broadcastFixture: BROADCAST_FIXTURE }, bind: null },
  ], fixtureRegistrations: fixtures });
}

export function createBroadcastPeerRelay(channelName = 'firsttx:models') {
  const channels = new Set();
  const transcript = [];
  function dispatch(sender, data) {
    const targets = [...channels].filter((target) => target !== sender && !target.closed);
    return Promise.all(targets.map((target) => new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          const returned = target.onmessage?.({ data: structuredClone(data) });
          Promise.resolve(returned).then(resolve, reject);
        } catch (error) { reject(error); }
      });
    })));
  }
  class RegisteredBroadcastChannel {
    constructor(name) {
      if (name !== channelName) fail(`Unregistered BroadcastChannel name: ${name}`);
      this.name = name;
      this.onmessage = null;
      this.closed = false;
      channels.add(this);
    }
    postMessage(data) {
      if (this.closed) fail('BroadcastChannel is closed');
      transcript.push({ operation: 'post', sender: this === peer ? 'peer' : 'product', data: structuredClone(data) });
      void dispatch(this, data);
    }
    close() { this.closed = true; channels.delete(this); }
    dispatchEvent() { fail('Direct event dispatch is not registered'); }
  }
  const inbox = [];
  const waiters = [];
  const peer = new RegisteredBroadcastChannel(channelName);
  peer.onmessage = (event) => {
    inbox.push(structuredClone(event.data));
    waiters.splice(0).forEach((resolve) => resolve());
  };
  let retransmissions = 0;
  async function retransmitOnce() {
    if (retransmissions !== 0) fail('Broadcast peer retransmission limit exceeded');
    if (inbox.length === 0) await new Promise((resolve) => waiters.push(resolve));
    const message = inbox.shift();
    retransmissions += 1;
    transcript.push({ operation: 'post', sender: 'peer', data: structuredClone(message) });
    const deliveries = await dispatch(peer, message);
    if (deliveries.length !== 1) fail('Broadcast peer must invoke exactly one product message handler');
  }
  return Object.freeze({
    BroadcastChannel: RegisteredBroadcastChannel,
    async beginObservationWindow() {
      await Promise.resolve();
      inbox.splice(0);
      transcript.splice(0);
      retransmissions = 0;
    },
    retransmitOnce,
    snapshot() { return { senderSelfDeliveries: 0, peerReceipts: transcript.filter((entry) => entry.sender === 'product').length, peerRetransmissions: retransmissions }; },
    close() { [...channels].forEach((channel) => channel.close()); },
  });
}

export async function settleRelayQuiescence(relay, activity) {
  if (relay === null || typeof relay?.retransmitOnce !== 'function' || typeof activity?.completeAndMark !== 'function') fail('Relay quiescence inputs are invalid');
  await relay.retransmitOnce();
  await new Promise((resolve) => setImmediate(resolve));
  return activity.completeAndMark();
}

function fixtureValues(fixtures) {
  if (Array.isArray(fixtures)) return fixtures;
  if (fixtures instanceof Map) return [...fixtures.values()];
  fail('Local-first fixtures must be an array or Map');
}

export function validateFixtureRecord(record) {
  exactKeys(record, ['registrationId', 'registrationDigest', 'kind', 'producerArtifact', 'publicActionTrace', 'canonicalWirePayload', 'materializerId', 'stateDigest', 'consumerActionInstanceId'], 'Fixture record');
  validateFixturePayload(record.registrationId, record.canonicalWirePayload);
  if (!SHA_PATTERN.test(record.registrationDigest) || record.stateDigest !== fixtureStateDigest(record.canonicalWirePayload)) fail('Fixture record state or provenance digest mismatch');
  return record;
}

export function resolveLocalFirstRuntime(runtime) {
  const resolved = runtime;
  if (!isPlainObject(resolved)) fail('Local-first evaluator runtime was not explicitly injected');
  if (typeof resolved.loadPublicModule !== 'function') fail('Local-first public module loader is invalid');
  if (!isPlainObject(resolved.fixtureTools)) fail('Local-first fixture tools were not injected');
  validateFakeIndexedDBNamespace(resolved.fixtureTools.fakeIndexedDB);
  if (!isPlainObject(resolved.clock) || !Number.isSafeInteger(resolved.clock.nowMs)) fail('Local-first registered clock is invalid');
  return resolved;
}

export function installLocalFirstEnvironment(fixtures, runtime) {
  const resolved = resolveLocalFirstRuntime(runtime);
  const records = fixtureValues(fixtures);
  records.forEach(validateFixtureRecord);
  if (!records.some((record) => record.registrationId === 'local.indexeddb/v1')) fail('Local-first IndexedDB fixture is missing');
  const fake = validateFakeIndexedDBNamespace(resolved.fixtureTools.fakeIndexedDB);
  const activity = createIndexedDBActivityTracker(fake.indexedDB);
  const relayRecord = records.find((record) => record.registrationId === 'local.broadcast-peer/v1');
  const relay = relayRecord === undefined ? null : createBroadcastPeerRelay(relayRecord.canonicalWirePayload.channel);
  const globalObject = resolved.globalObject ?? globalThis;
  const names = ['indexedDB', 'IDBKeyRange', 'BroadcastChannel'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalObject, name)]));
  Object.defineProperty(globalObject, 'indexedDB', { configurable: true, writable: true, value: activity.indexedDB });
  Object.defineProperty(globalObject, 'IDBKeyRange', { configurable: true, writable: true, value: fake.IDBKeyRange });
  if (relay !== null) Object.defineProperty(globalObject, 'BroadcastChannel', { configurable: true, writable: true, value: relay.BroadcastChannel });
  else delete globalObject.BroadcastChannel;
  const originalDateNow = Date.now;
  Date.now = () => resolved.clock.nowMs;
  const callbackPayloads = records.filter((record) => record.registrationId === 'local.callback-log/v1').map((record) => record.canonicalWirePayload);
  const callbackCounts = new Map(callbackPayloads.map((payload) => [payload.logId, 0]));
  const callbackValues = new Map();
  let observationMarker = activity.marker();
  return {
    callback(logId, observe = null) {
      if (!callbackCounts.has(logId)) fail(`Unregistered callback log: ${logId}`);
      if (observe !== null && typeof observe !== 'function') fail('Callback observer must be adapter-owned code');
      return () => {
        callbackCounts.set(logId, callbackCounts.get(logId) + 1);
        if (observe !== null) callbackValues.set(logId, structuredClone(observe()));
      };
    },
    callbackCount(logId) {
      if (!callbackCounts.has(logId)) fail(`Unregistered callback log: ${logId}`);
      return callbackCounts.get(logId);
    },
    callbackValue(logId) {
      if (!callbackCounts.has(logId)) fail(`Unregistered callback log: ${logId}`);
      return callbackValues.has(logId) ? structuredClone(callbackValues.get(logId)) : null;
    },
    relay,
    async completeAndMark() { observationMarker = await activity.completeAndMark(); },
    async settleObservedActivity() { observationMarker = await activity.settleAfter(observationMarker); },
    async settleRelayDelivery() { observationMarker = await settleRelayQuiescence(relay, activity); },
    activitySnapshot: () => activity.snapshot(),
    teardown() {
      Date.now = originalDateNow;
      relay?.close();
      for (const [name, descriptor] of previous) descriptor === undefined ? delete globalObject[name] : Object.defineProperty(globalObject, name, descriptor);
    },
  };
}
