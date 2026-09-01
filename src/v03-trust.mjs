import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { WIRE_LIMITS, canonicalJson, domainDigest, parseJsonBytes, validateJsonValueLimits } from './v03-wire.mjs';
import { planDigest, specDigest, validateExecutionPlan, validateNightmareSpec } from './v03-spec.mjs';

export const RESULT_SCHEMA_VERSION = 'bug-dreamer/trusted-result/v1';
export const RESULT_DIGEST_DOMAIN = 'bug-dreamer/trusted-result/v1';

export class V03TrustError extends Error {}

function fail(message) {
  throw new V03TrustError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictKeys(value, keys, label) {
  assert(isPlainObject(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} fields changed`);
}

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function fileType(metadata) {
  if (metadata.isFile()) return 'regular';
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isSymbolicLink()) return 'symbolic-link';
  if (metadata.isFIFO()) return 'fifo';
  if (metadata.isSocket()) return 'socket';
  if (metadata.isBlockDevice()) return 'block-device';
  if (metadata.isCharacterDevice()) return 'character-device';
  return 'unknown';
}

export async function readTrustedResultChannel(resultDirectory) {
  const names = (await readdir(resultDirectory)).sort();
  const entries = await Promise.all(names.map(async (name) => {
    const metadata = await lstat(path.join(resultDirectory, name));
    return { name, type: fileType(metadata), size: metadata.size };
  }));
  const accepted = entries.length === 1
    && entries[0].name === 'result.json'
    && entries[0].type === 'regular'
    && entries[0].size <= WIRE_LIMITS.inputBytes;
  return {
    entries,
    resultBytes: accepted ? await readFile(path.join(resultDirectory, 'result.json')) : null,
  };
}

function validateObservedFields(value, registrations) {
  assert(isPlainObject(value), 'Trusted result observedFields must be an object');
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(registrations.map((item) => item.name).sort()), 'Trusted result observedFields differ from the invariant allow-list');
  for (const registration of registrations) {
    const observed = value[registration.name];
    if (registration.type === 'string') assert(typeof observed === 'string', `Observed field type mismatch: ${registration.name}`);
    else if (registration.type === 'json') validateJsonValueLimits(observed);
    else fail(`Unknown observed field type: ${registration.type}`);
  }
}

function resultPayload(result) {
  const { payloadDigest, ...payload } = result;
  return payload;
}

export function validateTrustedResult(result, plan, spec, catalog) {
  validateNightmareSpec(spec, catalog);
  validateExecutionPlan(plan, spec, catalog);
  strictKeys(result, ['schemaVersion', 'specDigest', 'planDigest', 'targetArtifactDigest', 'invariantRegistrationId', 'evaluatorStatus', 'execution', 'observedKind', 'observedFields', 'violationIdentity', 'payloadDigest'], 'Trusted result');
  assert(result.schemaVersion === RESULT_SCHEMA_VERSION, 'Unexpected trusted result schemaVersion');
  assert(result.specDigest === specDigest(spec, catalog), 'Trusted result specDigest mismatch');
  assert(result.planDigest === planDigest(plan, spec, catalog), 'Trusted result planDigest mismatch');
  assert(result.targetArtifactDigest === plan.targetArtifactDigest, 'Trusted result target artifact mismatch');
  assert(result.invariantRegistrationId === plan.invariantRegistrationId, 'Trusted result invariant mismatch');
  assert(result.evaluatorStatus === 'evaluated', 'Trusted result evaluator status is invalid');
  assert(['pass', 'candidate-failure'].includes(result.execution), 'Trusted result execution is invalid');
  assert(result.observedKind === plan.normalizedObservedKind, 'Trusted result observed kind mismatch');
  validateObservedFields(result.observedFields, plan.observedFields);
  assert(validSha(result.payloadDigest), 'Trusted result payload digest is invalid');
  assert(result.payloadDigest === domainDigest(RESULT_DIGEST_DOMAIN, resultPayload(result)), 'Trusted result payload digest mismatch');
  if (result.execution === 'pass') {
    assert(result.violationIdentity === null, 'Passing trusted result cannot contain a violation identity');
  } else {
    strictKeys(result.violationIdentity, ['invariantRegistrationId', 'normalizedObservedKind', 'normalizedObservedFields', 'targetArtifactDigest'], 'Violation identity');
    assert(result.violationIdentity.invariantRegistrationId === plan.invariantRegistrationId, 'Violation identity invariant mismatch');
    assert(result.violationIdentity.normalizedObservedKind === result.observedKind, 'Violation identity observed kind mismatch');
    assert(canonicalJson(result.violationIdentity.normalizedObservedFields) === canonicalJson(result.observedFields), 'Violation identity observed fields mismatch');
    assert(result.violationIdentity.targetArtifactDigest === plan.targetArtifactDigest, 'Violation identity target artifact mismatch');
  }
  return result;
}

function evaluatorError(reason) {
  return {
    evaluator: 'evaluator-error',
    execution: {
      status: 'unrunnable',
      kind: 'infrastructure',
      reason,
    },
    trustedResultDigest: null,
    violationIdentity: null,
  };
}

export function classifyTrustedResult({ resultBytes, exitCode, plan, spec, catalog }) {
  if (exitCode !== 0) return evaluatorError('evaluator-early-exit');
  if (resultBytes === null || resultBytes === undefined) return evaluatorError('missing-trusted-result');
  let result;
  try {
    result = validateTrustedResult(parseJsonBytes(resultBytes), plan, spec, catalog);
  } catch (error) {
    return evaluatorError(`malformed-trusted-result:${error.message}`);
  }
  return {
    evaluator: 'evaluated',
    execution: { status: result.execution },
    trustedResultDigest: result.payloadDigest,
    violationIdentity: result.violationIdentity,
  };
}
