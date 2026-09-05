import descriptorJson from '../../registrations/v0.3/benchmark/prepaint.json' with { type: 'json' };

import {
  installPrepaintEnvironment,
  validatePrepaintFixtureRecord,
  validatePrepaintRuntime,
} from './prepaint-environment.mjs';
import {
  classifyPrepaintError,
  evaluateRegisteredPrepaintInvariant,
  normalizeReturnedValue,
} from './prepaint-oracle.mjs';
import { validateActionArguments } from './prepaint-schema.mjs';

export { validateActionArguments };

export const descriptor = Object.freeze(descriptorJson);

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) fail(`${label} is invalid`);
}

export async function materializeFixture({ fixtureRecord, actionInstance, artifact, policy }) {
  if (!isPlainObject(actionInstance)) fail('Fixture action instance must be an object');
  if (policy !== undefined && policy !== null && !isPlainObject(policy)) fail('Fixture policy must be an object when supplied');
  const consumerActionInstanceId = actionInstance.instanceId;
  boundedString(consumerActionInstanceId, 'Fixture action instance ID', 256);
  validatePrepaintFixtureRecord(fixtureRecord, { artifact, actionInstance });
  return structuredClone(fixtureRecord);
}

function fixtureValues(fixtures) {
  if (Array.isArray(fixtures)) return fixtures;
  if (fixtures instanceof Map) return [...fixtures.values()];
  fail('Prepaint fixtures must be an array or Map');
}

async function executeBoot(actionInstance, fixtures, runtime) {
  const actionFixtures = fixtureValues(fixtures).filter((fixture) => fixture.consumerActionInstanceId === actionInstance.instanceId);
  const resolvedRuntime = validatePrepaintRuntime(runtime);
  const environment = await installPrepaintEnvironment(actionFixtures, resolvedRuntime);
  try {
    const { boot } = await resolvedRuntime.loadPublicModule('@firsttx/prepaint');
    if (typeof boot !== 'function') fail('Prepaint public boot export is invalid');
    await boot(actionInstance.arguments.policy);
    return normalizeReturnedValue({
      overlayMounted: document.getElementById('__firsttx_prepaint__') !== null,
      dataPrepaint: document.documentElement.hasAttribute('data-prepaint'),
      present: await environment.snapshotPresent(environment.pathname),
      payloadDigest: environment.payloadDigest,
    });
  } finally {
    environment.teardown();
  }
}

async function executeViteCreate(actionInstance, runtime) {
  try {
    const resolvedRuntime = validatePrepaintRuntime(runtime);
    const { firstTx } = await resolvedRuntime.loadPublicModule('@firsttx/prepaint/plugin/vite');
    if (typeof firstTx !== 'function') fail('Prepaint public firstTx export is invalid');
    const plugin = firstTx({
      policy: actionInstance.arguments.policy,
      inline: actionInstance.arguments.inline,
      minify: actionInstance.arguments.minify,
    });
    return normalizeReturnedValue({ kind: 'returned', name: typeof plugin?.name === 'string' ? plugin.name : null, messageClass: null });
  } catch (error) {
    return normalizeReturnedValue(classifyPrepaintError(error));
  }
}

export async function executeAction({ actionInstance, bindings, fixtures, scheduleControls, runtime }) {
  validateActionArguments({ action: actionInstance, bindings, policy: runtime?.policy });
  if (!Array.isArray(scheduleControls) || scheduleControls.length !== 0) fail('Prepaint actions do not accept schedule controls');
  const adapterId = actionInstance.adapterId ?? actionInstance.actionId;
  if (adapterId === 'prepaint.boot/v1' || actionInstance.actionId === 'prepaint.boot') return executeBoot(actionInstance, fixtures, runtime);
  if (fixtureValues(fixtures).length !== 0) fail('prepaint.vite-create does not accept fixtures');
  return executeViteCreate(actionInstance, runtime);
}

export function evaluateInvariant({ invariantRegistration, observation, plan }) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) fail('Prepaint invariant plan is missing');
  return evaluateRegisteredPrepaintInvariant(invariantRegistration, observation, plan);
}
