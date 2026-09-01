import { readFile, rename, writeFile } from 'node:fs/promises';

import { startTransaction } from '@firsttx/tx';

import {
  planDigest,
  specDigest,
  validateExecutionPlan,
  validateNightmareSpec,
  validatePhase2Catalog,
} from '/consumer/evaluator/src/v03-spec.mjs';
import { RESULT_DIGEST_DOMAIN, RESULT_SCHEMA_VERSION } from '/consumer/evaluator/src/v03-trust.mjs';
import { canonicalJson, domainDigest, parseJsonBytes } from '/consumer/evaluator/src/v03-wire.mjs';
import { createVirtualClock } from '/consumer/evaluator/virtual-clock.mjs';

export const resultPath = '/result/result.json';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bindingName(value) {
  assert(value !== null && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.$binding === 'string', 'Invalid binding reference');
  return value.$binding;
}

function executeRun(action, tx, observations, gatePromise) {
  const step = async () => {
    if (gatePromise !== null) await gatePromise;
    if (action.arguments.log !== null) process.stdout.write(`${action.arguments.log}\n`);
    if (action.arguments.outcome === 'throw') {
      const ErrorClass = action.arguments.errorName === 'TypeError' ? TypeError : Error;
      throw new ErrorClass(action.arguments.errorMessage);
    }
    return action.arguments.value;
  };
  return (async () => {
    try {
      const options = action.arguments.retry === null ? undefined : { retry: action.arguments.retry };
      const value = options === undefined ? await tx.run(step) : await tx.run(step, options);
      observations.set(action.instanceId, { kind: 'returned-value', fields: { value } });
    } catch (error) {
      observations.set(action.instanceId, { kind: 'thrown-error', fields: { name: error.name, message: error.message } });
    }
  })();
}

async function interpret(plan, clock) {
  const bindings = new Map();
  const observations = new Map();
  const gatedIds = new Set(plan.scheduleControls
    .filter((control) => control.kind === 'completion-release-order')
    .flatMap((control) => control.instanceIds));
  const gates = new Map();
  const pendingRuns = new Map();
  const launched = new Set();
  const executedControls = new Set();

  const applyAdvances = async (instanceId) => {
    for (const [index, control] of plan.scheduleControls.entries()) {
      if (control.kind !== 'virtual-time-advance' || control.afterInstanceId !== instanceId || executedControls.has(index)) continue;
      executedControls.add(index);
      await clock.advance(control.advanceMs);
    }
  };

  const releaseReady = async () => {
    for (const [index, control] of plan.scheduleControls.entries()) {
      if (control.kind !== 'completion-release-order' || executedControls.has(index)) continue;
      if (!control.instanceIds.every((instanceId) => launched.has(instanceId))) continue;
      executedControls.add(index);
      for (const instanceId of control.instanceIds) {
        gates.get(instanceId).release();
        await pendingRuns.get(instanceId);
        await applyAdvances(instanceId);
      }
    }
  };

  for (const action of plan.actions) {
    if (action.adapterId === 'tx.start/v1') {
      const tx = startTransaction({
        id: action.arguments.transactionId,
        timeout: action.arguments.timeoutMs,
        transition: action.arguments.transition,
      });
      bindings.set(action.bind.name, tx);
      observations.set(action.instanceId, { kind: 'transaction-created', fields: { id: action.arguments.transactionId } });
      await applyAdvances(action.instanceId);
      continue;
    }
    if (action.adapterId === 'tx.run/v1') {
      const tx = bindings.get(bindingName(action.arguments.tx));
      assert(tx !== undefined, 'tx.run binding is unavailable');
      if (gatedIds.has(action.instanceId)) {
        let release;
        const gatePromise = new Promise((resolve) => {
          release = resolve;
        });
        gates.set(action.instanceId, { release });
        pendingRuns.set(action.instanceId, executeRun(action, tx, observations, gatePromise));
        launched.add(action.instanceId);
        await releaseReady();
      } else {
        await executeRun(action, tx, observations, null);
        await applyAdvances(action.instanceId);
      }
      continue;
    }
    if (action.adapterId === 'tx.commit/v1') {
      const tx = bindings.get(bindingName(action.arguments.tx));
      assert(tx !== undefined, 'tx.commit binding is unavailable');
      try {
        await tx.commit();
        observations.set(action.instanceId, { kind: 'commit-result', fields: { status: 'resolved' } });
      } catch (error) {
        observations.set(action.instanceId, { kind: 'commit-result', fields: { status: 'rejected', name: error.name } });
      }
      await applyAdvances(action.instanceId);
      continue;
    }
    throw new Error(`Unregistered adapter: ${action.adapterId}`);
  }
  for (const [index] of plan.scheduleControls.entries()) {
    assert(executedControls.has(index), `Schedule control was not executed: ${index}`);
  }
  return observations;
}

function evaluate(plan, observations) {
  const runAction = [...plan.actions].reverse().find((action) => action.actionId === 'tx.run');
  assert(runAction !== undefined, 'Invariant requires a tx.run action');
  const observed = observations.get(runAction.instanceId);
  assert(observed !== undefined, 'Invariant observation is missing');
  let passed;
  if (plan.evaluatorId === 'tx.original-error-propagation/v1') {
    passed = observed.kind === 'thrown-error'
      && observed.fields.name === runAction.arguments.errorName
      && observed.fields.message === runAction.arguments.errorMessage;
  } else if (plan.evaluatorId === 'tx.successful-step-return/v1') {
    passed = observed.kind === 'returned-value'
      && canonicalJson(observed.fields.value) === canonicalJson(runAction.arguments.value);
  } else if (plan.evaluatorId === 'tx.total-timeout/v1') {
    passed = observed.kind === 'thrown-error' && observed.fields.name === 'TransactionTimeoutError';
  } else {
    throw new Error(`Unregistered evaluator: ${plan.evaluatorId}`);
  }
  return {
    execution: passed ? 'pass' : 'candidate-failure',
    observedKind: observed.kind,
    observedFields: observed.fields,
  };
}

function createResult(plan, spec, catalog, evaluation) {
  const violationIdentity = evaluation.execution === 'candidate-failure' ? {
    invariantRegistrationId: plan.invariantRegistrationId,
    normalizedObservedKind: evaluation.observedKind,
    normalizedObservedFields: evaluation.observedFields,
    targetArtifactDigest: plan.targetArtifactDigest,
  } : null;
  const payload = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    specDigest: specDigest(spec, catalog),
    planDigest: planDigest(plan, spec, catalog),
    targetArtifactDigest: plan.targetArtifactDigest,
    invariantRegistrationId: plan.invariantRegistrationId,
    evaluatorStatus: 'evaluated',
    execution: evaluation.execution,
    observedKind: evaluation.observedKind,
    observedFields: evaluation.observedFields,
    violationIdentity,
  };
  return { ...payload, payloadDigest: domainDigest(RESULT_DIGEST_DOMAIN, payload) };
}

async function extendCatalog(catalog) {
  let extensionBytes;
  try {
    extensionBytes = await readFile('/registration/phase3-operators.json');
  } catch {
    return catalog;
  }
  const { validatePhase3OperatorCatalog } = await import('/consumer/evaluator/src/v03-operators.mjs');
  const extension = validatePhase3OperatorCatalog(parseJsonBytes(extensionBytes));
  return { ...catalog, invariants: [...catalog.invariants, ...extension.invariants] };
}

export async function evaluateTrustedResult() {
  const [catalogBytes, specBytes, planBytes] = await Promise.all([
    readFile('/registration/phase2-catalog.json'),
    readFile('/input/spec.json'),
    readFile('/input/plan.json'),
  ]);
  const catalog = await extendCatalog(validatePhase2Catalog(parseJsonBytes(catalogBytes)));
  const spec = validateNightmareSpec(parseJsonBytes(specBytes), catalog);
  const plan = validateExecutionPlan(parseJsonBytes(planBytes), spec, catalog);
  const clock = createVirtualClock(plan.virtualTime.originMs);
  clock.install();
  let observations;
  try {
    observations = await interpret(plan, clock);
  } finally {
    clock.uninstall();
  }
  const evaluation = evaluate(plan, observations);
  return createResult(plan, spec, catalog, evaluation);
}

export async function writeTrustedResult(result) {
  const temporaryPath = `${resultPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryPath, resultPath);
}
