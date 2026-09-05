import {
  installLocalFirstEnvironment,
  materializeFixtureRecord,
  registeredLocalFirstScenario,
  resolveLocalFirstRuntime,
} from './local-first-environment.mjs';
import { localFirstDescriptor, normalizeReturnedValue } from './local-first-oracle.mjs';

export const descriptor = localFirstDescriptor;

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function countSchema(runtime) {
  const z = runtime.zod?.z ?? runtime.zod;
  if (z === null || typeof z !== 'object' || typeof z.object !== 'function' || typeof z.number !== 'function') fail('Registered Zod runtime is invalid');
  return z.object({ count: z.number() });
}

function fixtureRecords(scenario, artifact) {
  return scenario.fixtureRegistrations.map((registration) => {
    const action = scenario.actions.find((candidate) => candidate.actionId === registration.consumerActionId);
    if (action === undefined) fail(`Fixture consumer action is missing: ${registration.consumerActionId}`);
    return materializeFixtureRecord({
      fixtureRegistration: registration,
      artifact,
      moduleRegistrationId: descriptor.moduleId,
      consumerActionInstanceId: action.instanceId,
    });
  });
}

async function publicModule(runtime) {
  const namespace = await runtime.loadPublicModule(descriptor.importSpecifier);
  if (namespace === null || typeof namespace !== 'object' || typeof namespace.defineModel !== 'function' || typeof namespace.Storage?.getInstance !== 'function') fail('Local-first public module exports are invalid');
  return namespace;
}

function define(namespace, runtime, action) {
  return namespace.defineModel(action.arguments.name, {
    schema: countSchema(runtime),
    version: action.arguments.version,
    ttl: action.arguments.ttlMs,
  });
}

async function compareStaleness(namespace, runtime, environment, scenario) {
  const [defineAction, storeAction, subscribeAction, observeAction] = scenario.actions;
  const model = define(namespace, runtime, defineAction);
  await namespace.Storage.getInstance().set(storeAction.arguments.modelName, structuredClone(storeAction.arguments.record));
  await environment.completeAndMark();
  const unsubscribe = model.subscribe(environment.callback(subscribeAction.arguments.callbackLogId, () => model.getCachedHistory()));
  try {
    await environment.settleObservedActivity();
    const history = environment.callbackValue(subscribeAction.arguments.callbackLogId);
    if (!isPlainObject(history)) fail('Subscriber did not capture public cached history');
    return normalizeReturnedValue({ updatedAt: history.updatedAt, age: history.age, isStale: history.isStale, isConflicted: history.isConflicted, ttlMs: observeAction.arguments.ttlMs });
  } finally { unsubscribe(); }
}

async function compareError(namespace, runtime, environment, scenario) {
  if (process.env.NODE_ENV === 'production') fail('Error-transition oracle requires the pinned non-production public behavior');
  const [defineAction, storeAction, subscribeAction] = scenario.actions;
  const model = define(namespace, runtime, defineAction);
  await namespace.Storage.getInstance().set(storeAction.arguments.modelName, structuredClone(storeAction.arguments.record));
  await environment.completeAndMark();
  const unsubscribe = model.subscribe(environment.callback(subscribeAction.arguments.callbackLogId));
  try {
    await environment.settleObservedActivity();
    return normalizeReturnedValue({ notified: environment.callbackCount(subscribeAction.arguments.callbackLogId) >= 1, errorName: model.getCachedError()?.name ?? null });
  } finally { unsubscribe(); }
}

async function compareSelfBroadcast(namespace, runtime, environment, scenario) {
  const [defineAction, replaceAction, subscribeAction, patchAction] = scenario.actions;
  const model = define(namespace, runtime, defineAction);
  await model.replace(structuredClone(replaceAction.arguments.data));
  await environment.completeAndMark();
  await environment.relay?.beginObservationWindow();
  const unsubscribe = model.subscribe(environment.callback(subscribeAction.arguments.callbackLogId));
  try {
    const before = environment.callbackCount(patchAction.arguments.callbackLogId);
    await model.patch((draft) => { draft.count += patchAction.arguments.value; });
    const afterLocalMutation = environment.callbackCount(patchAction.arguments.callbackLogId);
    await environment.completeAndMark();
    if (environment.relay === null) fail('Registered broadcast peer fixture is missing');
    await environment.settleRelayDelivery();
    const afterPeerRelay = environment.callbackCount(patchAction.arguments.callbackLogId);
    return normalizeReturnedValue({
      localMutationCallbacks: afterLocalMutation - before,
      callbackCountAfterPeerRelay: afterPeerRelay - afterLocalMutation,
      ...environment.relay.snapshot(),
    });
  } finally { unsubscribe(); }
}

export async function materializeComparison({ comparisonRegistration, row, artifact, policy, runtime: injectedRuntime }) {
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) fail('Comparison policy must be an object when supplied');
  const rowId = row?.id ?? row?.inputId;
  if (typeof rowId !== 'string' || comparisonRegistration?.id !== rowId) fail('Comparison registration and row disagree');
  const registered = descriptor.comparisons.find((item) => item.id === rowId);
  if (registered === undefined || JSON.stringify(registered) !== JSON.stringify(comparisonRegistration)) fail('Comparison registration is not the trusted descriptor entry');
  const scenario = registeredLocalFirstScenario(rowId);
  const runtime = resolveLocalFirstRuntime(injectedRuntime);
  if (runtime.clock.nowMs !== scenario.clockMs) fail('Comparison runtime clock differs from the registered scenario');
  const environment = installLocalFirstEnvironment(fixtureRecords(scenario, artifact), runtime);
  try {
    const namespace = await publicModule(runtime);
    if (rowId === 'local-first-stale-flag-inverted') return await compareStaleness(namespace, runtime, environment, scenario);
    if (rowId === 'local-first-error-not-notified') return await compareError(namespace, runtime, environment, scenario);
    return await compareSelfBroadcast(namespace, runtime, environment, scenario);
  } finally { environment.teardown(); }
}
