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

const mode = process.env.BUG_DREAMER_TRUST_MODE ?? 'valid';
const resultPath = '/result/result.json';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bindingName(value) {
  assert(value !== null && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.$binding === 'string', 'Invalid binding reference');
  return value.$binding;
}

async function interpret(plan) {
  const bindings = new Map();
  const observations = new Map();
  for (const action of plan.actions) {
    if (action.adapterId === 'tx.start/v1') {
      const tx = startTransaction({
        id: action.arguments.transactionId,
        timeout: action.arguments.timeoutMs,
        transition: action.arguments.transition,
      });
      bindings.set(action.bind.name, tx);
      observations.set(action.instanceId, { kind: 'transaction-created', fields: { id: action.arguments.transactionId } });
      continue;
    }
    if (action.adapterId === 'tx.run/v1') {
      const tx = bindings.get(bindingName(action.arguments.tx));
      assert(tx !== undefined, 'tx.run binding is unavailable');
      const step = async () => {
        if (action.arguments.log !== null) process.stdout.write(`${action.arguments.log}\n`);
        if (action.arguments.outcome === 'throw') {
          const ErrorClass = action.arguments.errorName === 'TypeError' ? TypeError : Error;
          throw new ErrorClass(action.arguments.errorMessage);
        }
        return action.arguments.value;
      };
      try {
        const options = action.arguments.retry === null ? undefined : { retry: action.arguments.retry };
        const value = options === undefined ? await tx.run(step) : await tx.run(step, options);
        observations.set(action.instanceId, { kind: 'returned-value', fields: { value } });
      } catch (error) {
        observations.set(action.instanceId, { kind: 'thrown-error', fields: { name: error.name, message: error.message } });
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
      continue;
    }
    throw new Error(`Unregistered adapter: ${action.adapterId}`);
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

async function writeResult(result) {
  const temporaryPath = `${resultPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryPath, resultPath);
}

async function main() {
  const [catalogBytes, specBytes, planBytes] = await Promise.all([
    readFile('/registration/phase2-catalog.json'),
    readFile('/input/spec.json'),
    readFile('/input/plan.json'),
  ]);
  const catalog = validatePhase2Catalog(parseJsonBytes(catalogBytes));
  const spec = validateNightmareSpec(parseJsonBytes(specBytes), catalog);
  const plan = validateExecutionPlan(parseJsonBytes(planBytes), spec, catalog);
  const observations = await interpret(plan);
  const evaluation = evaluate(plan, observations);
  const result = createResult(plan, spec, catalog, evaluation);

  if (mode === 'missing') {
    process.stdout.write('BUG_DREAMER_RESULT {"execution":"candidate-failure"}\n');
    return;
  }
  if (mode === 'malformed') {
    process.stderr.write('BUG_DREAMER_RESULT {"execution":"candidate-failure"}\n');
    await writeFile(resultPath, '{"schemaVersion":');
    return;
  }
  if (mode === 'wrong-digest') {
    result.payloadDigest = '0'.repeat(64);
    await writeResult(result);
    return;
  }
  if (mode === 'early-exit') {
    process.stderr.write('BUG_DREAMER_RESULT {"execution":"candidate-failure"}\n');
    process.exitCode = 17;
    return;
  }
  assert(mode === 'valid', `Unknown trust mode: ${mode}`);
  await writeResult(result);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
