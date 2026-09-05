import {
  createFixtureRegistration,
  installLocalFirstEnvironment,
  validateFixtureRecord,
} from './local-first-environment.mjs';
import { evaluateLocalFirstObservation, localFirstDescriptor, normalizeReturnedValue } from './local-first-oracle.mjs';
import { validateActionArguments } from './local-first-schema.mjs';

export const descriptor = localFirstDescriptor;
export { validateActionArguments };

const contexts = new WeakMap();

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function fixtureValues(fixtures) {
  if (Array.isArray(fixtures)) return fixtures;
  if (fixtures instanceof Map) return [...fixtures.values()];
  fail('Local-first fixtures must be an array or Map');
}

function binding(bindings, name, expectedType) {
  const entry = bindings.get(name);
  if (!isPlainObject(entry) || entry.type !== expectedType || !Object.hasOwn(entry, 'value')) fail(`Binding ${name} is not a ${expectedType}`);
  return entry.value;
}

function setBinding(bindings, actionInstance, type, value) {
  if (!isPlainObject(actionInstance.bind) || actionInstance.bind.type !== type || typeof actionInstance.bind.name !== 'string') fail(`${actionInstance.actionId} binding is invalid`);
  bindings.set(actionInstance.bind.name, { type, value });
}

function adapterId(action) {
  return action.adapterId ?? descriptor.actions.find((registration) => registration.id === action.actionId)?.adapterId;
}

function registeredSchema(runtime, schemaId) {
  if (schemaId !== 'local.count-record/v1') fail(`Unregistered local-first schema: ${schemaId}`);
  const z = runtime.zod?.z ?? runtime.zod;
  if (z === null || typeof z !== 'object' || typeof z.object !== 'function' || typeof z.number !== 'function') fail('Registered Zod runtime is invalid');
  return z.object({ count: z.number() });
}

async function contextFor(fixtures, runtime) {
  if (!isPlainObject(runtime)) fail('Local-first evaluator runtime must be a plain object');
  const existing = contexts.get(runtime);
  if (existing !== undefined) return existing;
  const environment = installLocalFirstEnvironment(fixtureValues(fixtures), runtime);
  let publicModule;
  try {
    publicModule = await runtime.loadPublicModule(descriptor.importSpecifier);
  } catch (error) {
    environment.teardown();
    throw new Error(`Local-first public module is unavailable: ${error.message}`, { cause: error });
  }
  if (publicModule === null || typeof publicModule !== 'object' || typeof publicModule.defineModel !== 'function' || typeof publicModule.Storage?.getInstance !== 'function') {
    environment.teardown();
    fail('Local-first public module exports are invalid');
  }
  const context = { environment, publicModule };
  contexts.set(runtime, context);
  return context;
}

function finish(runtime, context) {
  contexts.delete(runtime);
  context.environment.teardown();
}

export async function materializeFixture({ fixtureRecord, actionInstance, artifact, policy }) {
  if (!isPlainObject(actionInstance) || typeof actionInstance.instanceId !== 'string') fail('Fixture action instance is invalid');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) fail('Fixture policy must be an object when supplied');
  const record = validateFixtureRecord(fixtureRecord);
  const registration = descriptor.fixtures.find((item) => item.id === record.registrationId);
  if (registration === undefined || registration.consumerActionId !== actionInstance.actionId || record.consumerActionInstanceId !== actionInstance.instanceId) fail('Fixture record consumer disagrees with the action instance');
  if (record.producerArtifact?.moduleRegistrationId !== descriptor.moduleId || record.producerArtifact.targetArtifactDigest !== artifact?.targetArtifactDigest) fail('Fixture record artifact identity changed');
  const expected = createFixtureRegistration(registration, record.canonicalWirePayload);
  if (record.registrationDigest !== expected.registrationDigest || JSON.stringify(record.publicActionTrace) !== JSON.stringify(registration.publicActionTrace)) fail('Fixture record registration provenance changed');
  return structuredClone(record);
}

export async function executeAction({ actionInstance, bindings, fixtures, scheduleControls, runtime }) {
  validateActionArguments({ action: actionInstance, bindings, policy: runtime?.policy });
  if (!Array.isArray(scheduleControls) || scheduleControls.length !== 0) fail('Local-first actions do not accept schedule controls');
  const context = await contextFor(fixtures, runtime);
  const { environment, publicModule } = context;
  const args = actionInstance.arguments;
  const id = adapterId(actionInstance);
  if (id === 'local.define-model/v1') {
    const options = { schema: registeredSchema(runtime, args.schemaId), version: args.version, ttl: args.ttlMs };
    if (args.hasInitialData) options.initialData = structuredClone(args.initialData);
    const model = publicModule.defineModel(args.name, options);
    setBinding(bindings, actionInstance, 'model-handle', model);
    return normalizeReturnedValue({ modelName: model.name, ttlMs: model.ttl });
  }
  if (id === 'local.storage-set/v1') {
    await publicModule.Storage.getInstance().set(args.modelName, structuredClone(args.record));
    await environment.completeAndMark();
    return normalizeReturnedValue({ stored: true });
  }
  if (id === 'local.subscribe/v1') {
    const model = binding(bindings, args.modelBinding, 'model-handle');
    const observe = args.captureMode === 'cached-history' ? () => model.getCachedHistory() : null;
    const unsubscribe = model.subscribe(environment.callback(args.callbackLogId, observe));
    setBinding(bindings, actionInstance, 'unsubscribe-handle', unsubscribe);
    return normalizeReturnedValue({ subscribed: true });
  }
  if (id === 'local.replace/v1') {
    const model = binding(bindings, args.modelBinding, 'model-handle');
    await model.replace(structuredClone(args.data));
    await environment.completeAndMark();
    await environment.relay?.beginObservationWindow();
    return normalizeReturnedValue({ replaced: true });
  }
  if (id === 'local.patch/v1') {
    const model = binding(bindings, args.modelBinding, 'model-handle');
    const before = environment.callbackCount(args.callbackLogId);
    await model.patch((draft) => { draft.count += args.value; });
    const afterLocalMutation = environment.callbackCount(args.callbackLogId);
    await environment.completeAndMark();
    if (environment.relay === null) fail('Registered broadcast peer fixture is missing');
    await environment.settleRelayDelivery();
    const afterPeerRelay = environment.callbackCount(args.callbackLogId);
    const relay = environment.relay.snapshot();
    const observation = normalizeReturnedValue({
      localMutationCallbacks: afterLocalMutation - before,
      callbackCountAfterPeerRelay: afterPeerRelay - afterLocalMutation,
      ...relay,
    });
    finish(runtime, context);
    return observation;
  }
  if (id === 'local.get-history/v1') {
    const model = binding(bindings, args.modelBinding, 'model-handle');
    const history = await model.getHistory();
    await environment.completeAndMark();
    const observation = normalizeReturnedValue({
      updatedAt: history.updatedAt,
      age: history.age,
      isStale: history.isStale,
      isConflicted: history.isConflicted,
      ttlMs: args.ttlMs,
    });
    finish(runtime, context);
    return observation;
  }
  if (id === 'local.get-cached-history/v1') {
    binding(bindings, args.modelBinding, 'model-handle');
    await environment.settleObservedActivity();
    const history = environment.callbackValue(args.callbackLogId);
    if (!isPlainObject(history)) fail('Subscriber did not capture public cached history');
    const observation = normalizeReturnedValue({ updatedAt: history.updatedAt, age: history.age, isStale: history.isStale, isConflicted: history.isConflicted, ttlMs: args.ttlMs });
    finish(runtime, context);
    return observation;
  }
  if (id === 'local.get-cached-error/v1') {
    if (process.env.NODE_ENV === 'production') fail('Error-transition oracle requires the pinned non-production public behavior');
    const model = binding(bindings, args.modelBinding, 'model-handle');
    await environment.settleObservedActivity();
    const error = model.getCachedError();
    const observation = normalizeReturnedValue({ notified: environment.callbackCount(args.callbackLogId) >= 1, errorName: error?.name ?? null });
    finish(runtime, context);
    return observation;
  }
  fail(`Unregistered local-first action: ${id}`);
}

export function evaluateInvariant({ invariantRegistration, observation, plan }) {
  if (!isPlainObject(plan)) fail('Local-first invariant plan must be a plain object');
  return evaluateLocalFirstObservation(invariantRegistration.id, observation);
}
