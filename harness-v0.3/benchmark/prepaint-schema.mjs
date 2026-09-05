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

function boundedString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) fail(`${label} is invalid`);
}

export const FIXED_HTML = '<!doctype html><html><head></head><body><div id="root"></div></body></html>';
export const PREPAINT_CLOCK_ORIGIN_MS = 1_000_000_000_000;

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is outside its registered bounds`);
}

function validatePathname(route, label) {
  boundedString(route, label);
  if (!route.startsWith('/') || route.includes('?') || route.includes('#')) fail(`${label} must be an absolute pathname`);
}

export function validateBrowserPayload(payload) {
  exactKeys(payload, ['schemaVersion', 'url', 'html', 'clockMs'], 'Prepaint browser fixture');
  if (payload.schemaVersion !== 'bug-dreamer/prepaint-browser-fixture/v1') fail('Unexpected prepaint browser fixture schemaVersion');
  boundedString(payload.url, 'Prepaint browser URL', 1024);
  let parsed;
  try { parsed = new URL(payload.url); } catch { fail('Prepaint browser URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail('Prepaint browser URL must be a credential-free HTTPS pathname');
  if (payload.html !== FIXED_HTML) fail('Prepaint browser HTML is not the registered fixed document');
  safeInteger(payload.clockMs, 'Prepaint browser clock');
  if (payload.clockMs !== PREPAINT_CLOCK_ORIGIN_MS) fail('Prepaint browser clock differs from the registered virtual-time origin');
  return payload;
}

function validateStyle(style, label) {
  exactKeys(style, ['type', 'content'], label);
  if (style.type !== 'inline') fail(`${label} may not load an external resource`);
  if (typeof style.content !== 'string' || Buffer.byteLength(style.content, 'utf8') > 8192) fail(`${label}.content is invalid`);
}

function validateSnapshot(snapshot, label) {
  exactKeys(snapshot, ['route', 'body', 'timestamp', 'styles'], label);
  validatePathname(snapshot.route, `${label}.route`);
  if (typeof snapshot.body !== 'string' || Buffer.byteLength(snapshot.body, 'utf8') > 8192) fail(`${label}.body is invalid`);
  safeInteger(snapshot.timestamp, `${label}.timestamp`);
  if (!Array.isArray(snapshot.styles) || snapshot.styles.length > 8) fail(`${label}.styles is invalid`);
  snapshot.styles.forEach((style, index) => validateStyle(style, `${label}.styles[${index}]`));
}

export function validateIndexedDbPayload(payload) {
  exactKeys(payload, ['schemaVersion', 'database', 'version', 'store', 'records'], 'Prepaint IndexedDB fixture');
  if (payload.schemaVersion !== 'bug-dreamer/prepaint-indexeddb-fixture/v1' || payload.database !== 'firsttx-prepaint' || payload.version !== 2 || payload.store !== 'snapshots') fail('Prepaint IndexedDB identity changed');
  if (!Array.isArray(payload.records) || payload.records.length > 8) fail('Prepaint IndexedDB records are invalid');
  payload.records.forEach((record, index) => validateSnapshot(record, `Prepaint snapshot[${index}]`));
  if (new Set(payload.records.map((record) => record.route)).size !== payload.records.length) fail('Prepaint snapshot routes are duplicated');
  return payload;
}

function validatePolicy(policy, { relativeRoutesAllowed }) {
  if (!isPlainObject(policy)) fail('Prepaint policy must be a plain object');
  const keys = Object.keys(policy);
  if (!keys.includes('routes') || keys.some((key) => !['routes', 'ttlMs', 'maxSnapshotBytes', 'includeStyles'].includes(key))) fail('Prepaint policy fields changed');
  if (!Array.isArray(policy.routes) || policy.routes.length === 0 || policy.routes.length > 8) fail('Prepaint policy routes are invalid');
  const routes = new Set();
  for (const route of policy.routes) {
    boundedString(route, 'Prepaint policy route');
    if (!relativeRoutesAllowed && !route.startsWith('/')) fail('Prepaint policy route must be an absolute pathname');
    if (route.includes('?') || route.includes('#')) fail('Prepaint policy route must be a pathname');
    if (routes.has(route)) fail('Prepaint policy routes are duplicated');
    routes.add(route);
  }
  if (policy.ttlMs !== undefined && (!Number.isSafeInteger(policy.ttlMs) || policy.ttlMs < 1 || policy.ttlMs > 604_800_000)) fail('Prepaint ttlMs is outside its registered bounds');
  if (policy.maxSnapshotBytes !== undefined && (!Number.isSafeInteger(policy.maxSnapshotBytes) || policy.maxSnapshotBytes < 1 || policy.maxSnapshotBytes > 1_048_576)) fail('Prepaint maxSnapshotBytes is outside its registered bounds');
  if (policy.includeStyles !== undefined && typeof policy.includeStyles !== 'boolean') fail('Prepaint includeStyles must be boolean');
}

export function validateActionArguments({ action, bindings, policy }) {
  if (!(bindings instanceof Map)) fail('Prepaint bindings must be a Map');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) fail('Prepaint action policy must be an object when supplied');
  if (!isPlainObject(action)) fail('Prepaint action must be a plain object');
  const adapterId = action.adapterId ?? action.actionId;
  if (adapterId === 'prepaint.boot/v1' || action.actionId === 'prepaint.boot') {
    exactKeys(action.arguments, ['policy', 'browser', 'indexeddb'], 'prepaint.boot arguments');
    validatePolicy(action.arguments.policy, { relativeRoutesAllowed: false });
    validateBrowserPayload(action.arguments.browser);
    validateIndexedDbPayload(action.arguments.indexeddb);
  } else if (adapterId === 'prepaint.vite-create/v1' || action.actionId === 'prepaint.vite-create') {
    exactKeys(action.arguments, ['policy', 'inline', 'minify'], 'prepaint.vite-create arguments');
    validatePolicy(action.arguments.policy, { relativeRoutesAllowed: true });
    if (action.arguments.inline !== false || action.arguments.minify !== false) fail('prepaint.vite-create benchmark options must remain false');
  } else fail(`Unregistered prepaint action: ${adapterId}`);
  if (action.bind !== null) fail('Prepaint actions may not declare bindings');
}
