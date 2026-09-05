import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import canonicalize from 'canonicalize';
import { FIXED_HTML, PREPAINT_CLOCK_ORIGIN_MS, validateBrowserPayload, validateIndexedDbPayload } from './prepaint-schema.mjs';

export { FIXED_HTML, PREPAINT_CLOCK_ORIGIN_MS, validateBrowserPayload, validateIndexedDbPayload } from './prepaint-schema.mjs';

export const FIXTURE_TOOLS_PACKAGE_PATH = '/fixture-tools/package.json';
export const FIXTURE_REGISTRATION_DOMAIN = 'bug-dreamer/v03-benchmark-fixture-registration/v1';
export const FIXTURE_STATE_DOMAIN = 'bug-dreamer/v03-benchmark-fixture-state/v1';

const SHA_PATTERN = /^[0-9a-f]{64}$/u;
const ROW_IDS = Object.freeze([
  'prepaint-route-prefix-overcapture',
  'prepaint-expired-snapshot-kept',
  'prepaint-oversize-snapshot-kept',
  'prepaint-relative-route-accepted',
  'synthetic-prepaint-nominal',
]);

function fail(message) {
  throw new TypeError(message);
}

function canonicalJson(value) {
  const result = canonicalize(value);
  if (typeof result !== 'string') fail('Fixture data is not canonical JSON');
  return result;
}

function domainDigest(domain, value) {
  return createHash('sha256').update(`${domain}\0`, 'utf8').update(canonicalJson(value), 'utf8').digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function loadPrepaintFixtureTools() {
  const fixtureRequire = createRequire(FIXTURE_TOOLS_PACKAGE_PATH);
  try {
    return Object.freeze({
      jsdom: fixtureRequire('jsdom'),
      fakeIndexedDB: fixtureRequire('fake-indexeddb'),
    });
  } catch (error) {
    throw new Error(`Benchmark fixture tools are unavailable: ${error.message}`, { cause: error });
  }
}

export function validatePrepaintRuntime(runtime) {
  if (!isPlainObject(runtime) || typeof runtime.loadPublicModule !== 'function' || !isPlainObject(runtime.fixtureTools)) fail('Prepaint evaluator runtime is invalid');
  const jsdom = runtime.fixtureTools.jsdom;
  const fakeIndexedDB = runtime.fixtureTools.fakeIndexedDB;
  if (jsdom === null || typeof jsdom !== 'object' || typeof jsdom.JSDOM !== 'function') fail('jsdom fixture namespace is invalid');
  if (fakeIndexedDB === null || typeof fakeIndexedDB !== 'object' || typeof fakeIndexedDB.IDBFactory !== 'function' || typeof fakeIndexedDB.IDBKeyRange !== 'function') fail('fake-indexeddb fixture namespace is invalid');
  return runtime;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} fields changed`);
}

function boundedString(value, label, maximum = 8192) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) fail(`${label} is invalid`);
}

function validateRoute(route, label) {
  boundedString(route, label, 512);
  if (!route.startsWith('/') || route.includes('?') || route.includes('#')) fail(`${label} must be an absolute pathname`);
}

export function fixtureRegistrationDigest(fixtureRegistration) {
  const { registrationDigest, ...payload } = fixtureRegistration;
  return domainDigest(FIXTURE_REGISTRATION_DOMAIN, payload);
}

export function fixtureStateDigest(payload) {
  return domainDigest(FIXTURE_STATE_DOMAIN, payload);
}

export function prepaintPayloadDigest(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function createFixtureRegistration(staticRegistration, canonicalWirePayload) {
  exactKeys(staticRegistration, ['id', 'kind', 'materializerId', 'consumerActionId', 'payloadArgumentPointer', 'publicActionTrace'], 'Static fixture registration');
  const registration = { ...staticRegistration, canonicalWirePayload };
  return { ...registration, registrationDigest: domainDigest(FIXTURE_REGISTRATION_DOMAIN, registration) };
}

export function materializeFixtureRecord({ fixtureRegistration, artifact, moduleRegistrationId, consumerActionInstanceId }) {
  exactKeys(fixtureRegistration, ['id', 'kind', 'materializerId', 'consumerActionId', 'payloadArgumentPointer', 'publicActionTrace', 'canonicalWirePayload', 'registrationDigest'], 'Fixture registration');
  exactKeys(artifact, ['role', 'targetArtifactDigest', 'evaluationContractKey'], 'Artifact');
  if (!['clean', 'single-patch-defect'].includes(artifact.role) || !SHA_PATTERN.test(artifact.targetArtifactDigest) || !SHA_PATTERN.test(artifact.evaluationContractKey)) fail('Artifact identity is invalid');
  if (fixtureRegistration.registrationDigest !== fixtureRegistrationDigest(fixtureRegistration)) fail('Fixture registration digest mismatch');
  if (fixtureRegistration.id === 'prepaint.browser/v1') validateBrowserPayload(fixtureRegistration.canonicalWirePayload);
  else if (fixtureRegistration.id === 'prepaint.indexeddb/v1') validateIndexedDbPayload(fixtureRegistration.canonicalWirePayload);
  else fail(`Unregistered prepaint fixture: ${fixtureRegistration.id}`);
  boundedString(consumerActionInstanceId, 'Fixture consumer action instance ID', 256);
  return {
    registrationId: fixtureRegistration.id,
    registrationDigest: fixtureRegistration.registrationDigest,
    kind: fixtureRegistration.kind,
    producerArtifact: { moduleRegistrationId, targetArtifactDigest: artifact.targetArtifactDigest },
    publicActionTrace: structuredClone(fixtureRegistration.publicActionTrace),
    canonicalWirePayload: structuredClone(fixtureRegistration.canonicalWirePayload),
    materializerId: fixtureRegistration.materializerId,
    stateDigest: fixtureStateDigest(fixtureRegistration.canonicalWirePayload),
    consumerActionInstanceId,
  };
}

export function validatePrepaintArtifact(artifact) {
  exactKeys(artifact, ['role', 'targetArtifactDigest', 'evaluationContractKey'], 'Artifact');
  if (!['clean', 'single-patch-defect'].includes(artifact.role) || !SHA_PATTERN.test(artifact.targetArtifactDigest) || !SHA_PATTERN.test(artifact.evaluationContractKey)) fail('Artifact identity is invalid');
  return artifact;
}

function scenarioFixtureRegistrations(browser, indexeddb) {
  return [
    createFixtureRegistration({ id: 'prepaint.browser/v1', kind: 'external-environment', materializerId: 'prepaint.browser/v1', consumerActionId: 'prepaint.boot', payloadArgumentPointer: '/browser', publicActionTrace: ['prepaint.boot'] }, browser),
    createFixtureRegistration({ id: 'prepaint.indexeddb/v1', kind: 'documented-wire-state', materializerId: 'prepaint.indexeddb/v1', consumerActionId: 'prepaint.boot', payloadArgumentPointer: '/indexeddb', publicActionTrace: ['prepaint.boot'] }, indexeddb),
  ];
}

export function registeredPrepaintScenario(rowId) {
  if (!ROW_IDS.includes(rowId)) fail(`Unregistered prepaint benchmark row: ${rowId}`);
  if (rowId === 'prepaint-relative-route-accepted') return structuredClone({
    rowId,
    adapterId: 'prepaint.vite-create/v1',
    arguments: { policy: { routes: ['dashboard'] }, inline: false, minify: false },
    fixtureRegistrations: [],
  });
  const clockMs = PREPAINT_CLOCK_ORIGIN_MS;
  let pathname = '/checkout-admin';
  let policy = { routes: ['/checkout'], ttlMs: 10_000, maxSnapshotBytes: 1024, includeStyles: true };
  let snapshot = { route: pathname, body: '<div>Admin</div>', timestamp: clockMs - 1, styles: [] };
  if (rowId === 'synthetic-prepaint-nominal') {
    pathname = '/smoke-dashboard';
    policy = { routes: [pathname], ttlMs: 10_000, maxSnapshotBytes: 1024, includeStyles: true };
    snapshot = { route: pathname, body: '<main id="smoke">Ready</main>', timestamp: clockMs - 1, styles: [] };
  } else if (rowId === 'prepaint-expired-snapshot-kept') {
    pathname = '/account';
    policy = { routes: [pathname], ttlMs: 1000, maxSnapshotBytes: 1024, includeStyles: true };
    snapshot = { route: pathname, body: '<div>Expired</div>', timestamp: clockMs - 1001, styles: [] };
  } else if (rowId === 'prepaint-oversize-snapshot-kept') {
    pathname = '/catalog';
    policy = { routes: [pathname], ttlMs: 10_000, maxSnapshotBytes: 24, includeStyles: true };
    snapshot = { route: pathname, body: '<div>한글</div>', timestamp: clockMs - 1, styles: [] };
  }
  const browser = { schemaVersion: 'bug-dreamer/prepaint-browser-fixture/v1', url: `https://benchmark.invalid${pathname}`, html: FIXED_HTML, clockMs };
  const indexeddb = { schemaVersion: 'bug-dreamer/prepaint-indexeddb-fixture/v1', database: 'firsttx-prepaint', version: 2, store: 'snapshots', records: [snapshot] };
  return structuredClone({ rowId, adapterId: 'prepaint.boot/v1', arguments: { policy, browser, indexeddb }, fixtureRegistrations: scenarioFixtureRegistrations(browser, indexeddb) });
}

export function validatePrepaintFixtureRecord(record, { artifact, actionInstance } = {}) {
  exactKeys(record, ['registrationId', 'registrationDigest', 'kind', 'producerArtifact', 'publicActionTrace', 'canonicalWirePayload', 'materializerId', 'stateDigest', 'consumerActionInstanceId'], 'Fixture record');
  exactKeys(record.producerArtifact, ['moduleRegistrationId', 'targetArtifactDigest'], 'Fixture producer artifact');
  if (record.producerArtifact.moduleRegistrationId !== 'prepaint' || !SHA_PATTERN.test(record.producerArtifact.targetArtifactDigest)) fail('Fixture producer artifact is invalid');
  if (!SHA_PATTERN.test(record.registrationDigest) || record.stateDigest !== fixtureStateDigest(record.canonicalWirePayload)) fail('Fixture record state or provenance digest mismatch');
  const staticRegistration = record.registrationId === 'prepaint.browser/v1'
    ? { id: 'prepaint.browser/v1', kind: 'external-environment', materializerId: 'prepaint.browser/v1', consumerActionId: 'prepaint.boot', payloadArgumentPointer: '/browser', publicActionTrace: ['prepaint.boot'] }
    : record.registrationId === 'prepaint.indexeddb/v1'
      ? { id: 'prepaint.indexeddb/v1', kind: 'documented-wire-state', materializerId: 'prepaint.indexeddb/v1', consumerActionId: 'prepaint.boot', payloadArgumentPointer: '/indexeddb', publicActionTrace: ['prepaint.boot'] }
      : null;
  if (staticRegistration === null) fail(`Unregistered fixture record: ${record.registrationId}`);
  if (record.registrationDigest !== fixtureRegistrationDigest(createFixtureRegistration(staticRegistration, record.canonicalWirePayload))) fail('Fixture record registration digest mismatch');
  if (record.kind !== staticRegistration.kind || record.materializerId !== staticRegistration.materializerId || canonicalJson(record.publicActionTrace) !== canonicalJson(staticRegistration.publicActionTrace)) fail('Fixture record registration fields changed');
  if (record.registrationId === 'prepaint.browser/v1') validateBrowserPayload(record.canonicalWirePayload);
  else if (record.registrationId === 'prepaint.indexeddb/v1') validateIndexedDbPayload(record.canonicalWirePayload);
  else fail(`Unregistered fixture record: ${record.registrationId}`);
  if (artifact !== undefined && record.producerArtifact.targetArtifactDigest !== validatePrepaintArtifact(artifact).targetArtifactDigest) fail('Fixture record artifact mismatch');
  if (actionInstance !== undefined && record.consumerActionInstanceId !== actionInstance.instanceId) fail('Fixture record consumer mismatch');
  return record;
}

function fixturesArray(fixtures) {
  if (Array.isArray(fixtures)) return fixtures;
  if (fixtures instanceof Map) return [...fixtures.values()];
  fail('Prepaint fixtures must be an array or Map');
}

function request(requestFactory) {
  return new Promise((resolve, reject) => {
    const value = requestFactory();
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed'));
  });
}

async function openFixtureDatabase(indexedDB, payload) {
  const database = await new Promise((resolve, reject) => {
    const opening = indexedDB.open(payload.database, payload.version);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(payload.store)) opening.result.createObjectStore(payload.store, { keyPath: 'route' });
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB open failed'));
  });
  if (payload.records.length > 0) {
    const transaction = database.transaction(payload.store, 'readwrite');
    const store = transaction.objectStore(payload.store);
    const completed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB fixture transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB fixture transaction aborted'));
    });
    for (const record of payload.records) await request(() => store.put(structuredClone(record)));
    await completed;
  }
  database.close();
}

export async function installPrepaintEnvironment(fixtures, runtime) {
  const records = fixturesArray(fixtures);
  records.forEach((record) => validatePrepaintFixtureRecord(record));
  const browser = records.find((record) => record.registrationId === 'prepaint.browser/v1')?.canonicalWirePayload;
  const storage = records.find((record) => record.registrationId === 'prepaint.indexeddb/v1')?.canonicalWirePayload;
  if (browser === undefined || storage === undefined || records.length !== 2) fail('Prepaint boot requires exactly the browser and IndexedDB fixtures');
  const artifactDigests = new Set(records.map((record) => record.producerArtifact.targetArtifactDigest));
  if (artifactDigests.size !== 1) fail('Prepaint fixture artifacts disagree');

  const resolvedRuntime = validatePrepaintRuntime(runtime);
  const { JSDOM } = resolvedRuntime.fixtureTools.jsdom;
  const fakeIndexedDb = resolvedRuntime.fixtureTools.fakeIndexedDB;
  const indexedDB = new fakeIndexedDb.IDBFactory();
  const { IDBKeyRange } = fakeIndexedDb;
  const dom = new JSDOM(browser.html, { url: browser.url });
  const globals = ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'DOMParser', 'Node', 'Element', 'DocumentFragment', 'ShadowRoot', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'indexedDB', 'IDBKeyRange'];
  const previous = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const windowNames = ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'DOMParser', 'Node', 'Element', 'DocumentFragment', 'ShadowRoot', 'getComputedStyle'];
  for (const name of windowNames) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? dom.window : dom.window[name] });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, writable: true, value: (callback) => setTimeout(() => callback(browser.clockMs), 0) });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, writable: true, value: clearTimeout });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: indexedDB });
  Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, writable: true, value: IDBKeyRange });
  const originalDateNow = Date.now;
  Date.now = () => browser.clockMs;
  try {
    await openFixtureDatabase(indexedDB, storage);
  } catch (error) {
    Date.now = originalDateNow;
    for (const [name, descriptor] of previous) descriptor === undefined ? delete globalThis[name] : Object.defineProperty(globalThis, name, descriptor);
    dom.window.close();
    throw new Error(`Benchmark fixture setup failed: ${error.message}`, { cause: error });
  }

  return {
    async snapshotPresent(route) {
      validateRoute(route, 'Snapshot lookup route');
      const database = await request(() => indexedDB.open(storage.database, storage.version));
      try {
        const value = await request(() => database.transaction(storage.store, 'readonly').objectStore(storage.store).get(route));
        return value !== undefined;
      } finally { database.close(); }
    },
    payloadDigest: prepaintPayloadDigest(storage),
    pathname: new URL(browser.url).pathname,
    teardown() {
      Date.now = originalDateNow;
      for (const [name, descriptor] of previous) descriptor === undefined ? delete globalThis[name] : Object.defineProperty(globalThis, name, descriptor);
      dom.window.close();
    },
  };
}
