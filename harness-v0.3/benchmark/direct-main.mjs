import { createBenchmarkTrustedResult } from '../../src/v03-benchmark-result.mjs';
import * as localFirstDirect from './local-first-direct.mjs';
import { evaluateLocalFirstObservation } from './local-first-oracle.mjs';
import { createEvaluatorRuntime, readMainInput, strictObject, writeTrustedResult } from './main-common.mjs';
import * as prepaintDirect from './prepaint-direct.mjs';
import { evaluatePrepaintObservation } from './prepaint-oracle.mjs';
import * as txDirect from './tx-direct.mjs';
import { evaluateTxResult } from './tx-oracle.mjs';

export const DIRECT_INPUT_SCHEMA_VERSION = 'bug-dreamer/v03-benchmark-direct-input/v1';

const MODULES = Object.freeze({ tx: txDirect, 'local-first': localFirstDirect, prepaint: prepaintDirect });

function fail(message) { throw new TypeError(message); }

function oracleEvaluation(moduleId, descriptor, comparison, observation, row) {
  const invariant = descriptor.invariants.find((item) => item.id === comparison.invariantId);
  if (invariant === undefined) fail('Direct comparison invariant is not registered');
  if (moduleId === 'tx') {
    const comparisonInput = row.comparisonInput;
    const plan = {
      ...comparisonInput,
      invariantRegistrationId: invariant.id,
      evaluatorId: invariant.evaluatorId,
      normalizedObservedKind: invariant.normalizedObservedKind,
      observedFields: invariant.observedFields,
    };
    return evaluateTxResult(invariant, observation, plan);
  }
  if (moduleId === 'local-first') return evaluateLocalFirstObservation(invariant.id, observation);
  const actionId = invariant.id === 'prepaint.absolute-routes/v1' ? 'prepaint.vite-create' : 'prepaint.boot';
  return evaluatePrepaintObservation(invariant.id, observation, { actions: [{ actionId, arguments: row.comparisonInput }] });
}

export async function runDirectMain(inputPath, outputPath) {
  const input = await readMainInput(inputPath, DIRECT_INPUT_SCHEMA_VERSION, [
    'moduleId', 'descriptorId', 'comparisonRegistration', 'row', 'artifact', 'runtimePolicy', 'policy', 'metadata',
  ]);
  const module = MODULES[input.moduleId];
  if (module === undefined || module.descriptor.id !== input.descriptorId) fail('Direct module descriptor binding is invalid');
  if (input.metadata.invariantRegistrationId !== input.comparisonRegistration.invariantId) fail('Direct result invariant metadata is not bound to the comparison');
  if (input.metadata.targetArtifactDigest !== input.artifact.targetArtifactDigest) fail('Direct result artifact metadata is not bound to the target artifact');
  strictObject(input.runtimePolicy, ['virtualTime'], 'Direct runtime policy');
  const { runtime, teardown } = createEvaluatorRuntime(input.moduleId, input.artifact, input.runtimePolicy.virtualTime);
  try {
    const observation = await module.materializeComparison({
      comparisonRegistration: input.comparisonRegistration,
      row: input.row,
      artifact: input.artifact,
      policy: input.policy,
      runtime,
    });
    const evaluation = oracleEvaluation(input.moduleId, module.descriptor, input.comparisonRegistration, observation, input.row);
    const result = createBenchmarkTrustedResult(input.metadata, evaluation);
    await writeTrustedResult(outputPath, result);
    return result;
  } finally {
    teardown();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runDirectMain(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
