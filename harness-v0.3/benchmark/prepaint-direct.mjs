import descriptorJson from '../../registrations/v0.3/benchmark/prepaint.json' with { type: 'json' };

import {
  installPrepaintEnvironment,
  materializeFixtureRecord,
  registeredPrepaintScenario,
  validatePrepaintArtifact,
  validatePrepaintRuntime,
} from './prepaint-environment.mjs';
import { classifyPrepaintError, normalizeReturnedValue } from './prepaint-oracle.mjs';

export const descriptor = Object.freeze(descriptorJson);

function fail(message) {
  throw new TypeError(message);
}

function artifactFixtureRecords(scenario, artifact, instanceId) {
  return scenario.fixtureRegistrations.map((fixtureRegistration) => materializeFixtureRecord({
    fixtureRegistration,
    artifact,
    moduleRegistrationId: descriptor.moduleId,
    consumerActionInstanceId: instanceId,
  }));
}

async function compareBoot(scenario, artifact, runtime) {
  const resolvedRuntime = validatePrepaintRuntime(runtime);
  const environment = await installPrepaintEnvironment(artifactFixtureRecords(scenario, artifact, `direct-${scenario.rowId}`), resolvedRuntime);
  try {
    const { boot } = await resolvedRuntime.loadPublicModule('@firsttx/prepaint');
    if (typeof boot !== 'function') fail('Prepaint public boot export is invalid');
    await boot(scenario.arguments.policy);
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

async function compareViteCreate(scenario, runtime) {
  try {
    const resolvedRuntime = validatePrepaintRuntime(runtime);
    const { firstTx } = await resolvedRuntime.loadPublicModule('@firsttx/prepaint/plugin/vite');
    if (typeof firstTx !== 'function') fail('Prepaint public firstTx export is invalid');
    const plugin = firstTx({ policy: scenario.arguments.policy, inline: false, minify: false });
    return normalizeReturnedValue({ kind: 'returned', name: typeof plugin?.name === 'string' ? plugin.name : null, messageClass: null });
  } catch (error) {
    return normalizeReturnedValue(classifyPrepaintError(error));
  }
}

export async function materializeComparison({ comparisonRegistration, row, artifact, policy, runtime }) {
  if (policy !== undefined && policy !== null && (typeof policy !== 'object' || Array.isArray(policy))) fail('Comparison policy must be an object when supplied');
  const rowId = row?.id ?? row?.inputId;
  if (typeof rowId !== 'string') fail('Comparison row ID is missing');
  if (comparisonRegistration?.id !== rowId) fail('Comparison registration and row disagree');
  validatePrepaintArtifact(artifact);
  const registered = descriptor.comparisons.find((item) => item.id === rowId);
  if (registered === undefined || JSON.stringify(registered) !== JSON.stringify(comparisonRegistration)) fail('Comparison registration is not the trusted descriptor entry');
  const scenario = registeredPrepaintScenario(rowId);
  if (rowId === 'synthetic-prepaint-nominal') {
    if (JSON.stringify(row.comparisonInput) !== JSON.stringify(scenario.arguments)) fail('Synthetic prepaint comparison input changed');
    scenario.arguments = structuredClone(row.comparisonInput);
  }
  return scenario.adapterId === 'prepaint.boot/v1' ? compareBoot(scenario, artifact, runtime) : compareViteCreate(scenario, runtime);
}
