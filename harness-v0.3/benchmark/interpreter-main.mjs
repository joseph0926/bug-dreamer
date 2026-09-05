import {
  benchmarkPlanDigest,
  benchmarkSpecDigest,
  validateBenchmarkPlan,
  validateBenchmarkSpec,
} from '../../src/v03-benchmark-spec.mjs';
import { createBenchmarkTrustedResult } from '../../src/v03-benchmark-result.mjs';
import { validateBenchmarkTrustedResult } from '../../src/v03-benchmark-trust.mjs';
import * as localFirst from './local-first.mjs';
import {
  applyMainScheduleControls,
  createEvaluatorRuntime,
  readMainInput,
  releaseCompletionGroup,
  writeTrustedResult,
} from './main-common.mjs';
import * as prepaint from './prepaint.mjs';
import * as tx from './tx.mjs';

export const INTERPRETER_INPUT_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-interpreter-input/v1';

const MODULES = Object.freeze({ tx, 'local-first': localFirst, prepaint });

function fail(message) { throw new TypeError(message); }

function completionControlFor(action, controls) {
  return controls.find((control) => control.kind === 'completion-release-order' && control.instanceIds.includes(action.instanceId));
}

async function executePlan(module, plan, fixtures, runtime) {
  const bindings = new Map();
  const pending = new Map();
  let observation = null;
  for (const actionInstance of plan.actions) {
    const control = completionControlFor(actionInstance, plan.scheduleControls);
    if (control === undefined) {
      observation = await module.executeAction({ actionInstance, bindings, fixtures, scheduleControls: plan.scheduleControls, runtime });
      await applyMainScheduleControls(plan.scheduleControls, actionInstance.instanceId, runtime);
      continue;
    }
    pending.set(actionInstance.instanceId, module.executeAction({ actionInstance, bindings, fixtures, scheduleControls: plan.scheduleControls, runtime }));
    if (!control.instanceIds.every((instanceId) => pending.has(instanceId))) continue;
    releaseCompletionGroup(control, plan.actions, runtime);
    for (const instanceId of control.instanceIds) {
      observation = await pending.get(instanceId);
      pending.delete(instanceId);
      await applyMainScheduleControls(plan.scheduleControls, instanceId, runtime);
    }
  }
  if (pending.size !== 0) fail('Completion-release group did not become runnable');
  if (observation === null) fail('Interpreter produced no observation');
  return observation;
}

export async function runInterpreterMain(inputPath, outputPath) {
  const input = await readMainInput(inputPath, INTERPRETER_INPUT_SCHEMA_VERSION, [
    'moduleId', 'descriptorId', 'artifact', 'spec', 'plan', 'policy',
  ]);
  const module = MODULES[input.moduleId];
  if (module === undefined || module.descriptor.id !== input.descriptorId) fail('Interpreter module descriptor binding is invalid');
  validateBenchmarkSpec(input.spec, module.descriptor, input.artifact);
  validateBenchmarkPlan(input.plan, input.spec, module.descriptor, input.artifact);
  const { runtime, teardown } = createEvaluatorRuntime(input.moduleId, input.artifact, input.plan.virtualTime);
  try {
    const fixtures = [];
    for (const fixtureRecord of input.plan.fixtureSetup) {
      const actionInstance = input.plan.actions.find((item) => item.instanceId === fixtureRecord.consumerActionInstanceId);
      if (actionInstance === undefined) fail(`Fixture consumer is missing: ${fixtureRecord.consumerActionInstanceId}`);
      fixtures.push(await module.materializeFixture({ fixtureRecord, actionInstance, artifact: input.artifact, policy: input.policy }));
    }
    const observation = await executePlan(module, input.plan, fixtures, runtime);
    const invariant = module.descriptor.invariants.find((item) => item.id === input.plan.invariantRegistrationId);
    if (invariant === undefined) fail('Interpreter invariant is not registered');
    const evaluation = module.evaluateInvariant({ invariantRegistration: invariant, observation, plan: input.plan });
    const result = createBenchmarkTrustedResult({
      specDigest: benchmarkSpecDigest(input.spec, module.descriptor, input.artifact),
      planDigest: benchmarkPlanDigest(input.plan, input.spec, module.descriptor, input.artifact),
      targetArtifactDigest: input.artifact.targetArtifactDigest,
      invariantRegistrationId: invariant.id,
    }, evaluation);
    validateBenchmarkTrustedResult(result, input.plan, input.spec, module.descriptor);
    await writeTrustedResult(outputPath, result);
    return result;
  } finally {
    teardown();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runInterpreterMain(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
