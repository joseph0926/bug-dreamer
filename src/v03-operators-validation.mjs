import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildTransformedSpec, loadPhase3Catalog, validateTransformationRequest } from './v03-operators.mjs';
import {
  V03SpecError,
  buildExecutionPlan,
  parseNightmareSeed,
  planDigest,
  specDigest,
  validateNightmareSpec,
} from './v03-spec.mjs';
import { V03WireError, canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

const CASES_PATH = 'contracts/v0.3/operator-cases.json';
const EVIDENCE_PATH = 'evidence/v0.3/phase3-operators.json';

export class OperatorValidationError extends Error {}

function fail(message) {
  throw new OperatorValidationError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rejection(error) {
  if (error instanceof V03SpecError) return { kind: error.kind, message: error.message };
  if (error instanceof V03WireError) return { kind: 'rejected-schema', message: error.message };
  throw error;
}

async function buildPositiveSpec(repositoryRoot, fixture, catalog, operatorCatalog) {
  const seedBytes = await readFile(path.join(repositoryRoot, fixture.seed));
  const requestBytes = await readFile(path.join(repositoryRoot, fixture.request));
  const seed = parseNightmareSeed(seedBytes, catalog);
  const request = parseJsonBytes(requestBytes);
  const spec = buildTransformedSpec(seed, request, catalog, operatorCatalog);
  return { seedBytes, requestBytes, seed, request, spec };
}

export async function buildOperatorEvidence(repositoryRoot) {
  const [{ catalog, catalogBytes, operatorCatalog, operatorBytes }, casesBytes] = await Promise.all([
    loadPhase3Catalog(repositoryRoot),
    readFile(path.join(repositoryRoot, CASES_PATH)),
  ]);
  const cases = parseJsonBytes(casesBytes);
  assert(cases.schemaVersion === 'bug-dreamer/operator-cases/v1', 'Unexpected operator case schemaVersion');
  assert(Array.isArray(cases.positive) && cases.positive.length > 0, 'Positive operator cases missing');
  assert(Array.isArray(cases.negative) && cases.negative.length > 0, 'Negative operator cases missing');

  const positive = [];
  for (const fixture of cases.positive) {
    const { seedBytes, requestBytes, seed, request, spec } = await buildPositiveSpec(repositoryRoot, fixture, catalog, operatorCatalog);
    validateTransformationRequest(request, operatorCatalog);
    const plan = buildExecutionPlan(spec, catalog);
    positive.push({
      seedPath: fixture.seed,
      seedSha256: sha256(seedBytes),
      requestPath: fixture.request,
      requestSha256: sha256(requestBytes),
      seedDigest: domainDigest('bug-dreamer/nightmare-seed/v1', seed),
      specDigest: specDigest(spec, catalog),
      planDigest: planDigest(plan, spec, catalog),
      operatorIds: spec.transformations.map((item) => item.operatorId),
      transformationCount: spec.transformations.length,
      scheduleControlCount: spec.scheduleControls.length,
      fixtureCount: spec.fixtures.length,
    });
  }

  const negative = [];
  for (const fixture of cases.negative) {
    let observed;
    if (fixture.type === 'request') {
      const seedBytes = await readFile(path.join(repositoryRoot, fixture.seed));
      const requestBytes = await readFile(path.join(repositoryRoot, fixture.request));
      try {
        const seed = parseNightmareSeed(seedBytes, catalog);
        buildTransformedSpec(seed, parseJsonBytes(requestBytes), catalog, operatorCatalog);
        fail(`Negative operator case was accepted: ${fixture.request}`);
      } catch (error) {
        observed = rejection(error);
      }
      negative.push({
        type: fixture.type,
        seedPath: fixture.seed,
        seedSha256: sha256(seedBytes),
        requestPath: fixture.request,
        requestSha256: sha256(requestBytes),
        expectedKind: fixture.expectedKind,
        observedKind: observed.kind,
        expectedMessage: fixture.expectedMessage,
      });
    } else if (fixture.type === 'chain-tamper') {
      const base = cases.positive[fixture.positiveIndex];
      assert(base !== undefined, `Chain-tamper case references a missing positive case: ${fixture.positiveIndex}`);
      const { spec } = await buildPositiveSpec(repositoryRoot, base, catalog, operatorCatalog);
      assert(spec.transformations.length >= 2, 'Chain-tamper case requires a multi-record transformation chain');
      const tampered = structuredClone(spec);
      tampered.transformations[0].afterDigest = '0'.repeat(64);
      try {
        validateNightmareSpec(tampered, catalog);
        fail('Chain-tamper case was accepted');
      } catch (error) {
        observed = rejection(error);
      }
      negative.push({
        type: fixture.type,
        positiveIndex: fixture.positiveIndex,
        expectedKind: fixture.expectedKind,
        observedKind: observed.kind,
        expectedMessage: fixture.expectedMessage,
      });
    } else {
      fail(`Unknown negative operator case type: ${fixture.type}`);
    }
    assert(observed.kind === fixture.expectedKind, `Negative operator kind mismatch: ${JSON.stringify(fixture)}`);
    assert(observed.message.includes(fixture.expectedMessage), `Negative operator message mismatch: ${JSON.stringify(fixture)}`);
  }

  return {
    schemaVersion: 'bug-dreamer/phase3-operator-evidence/v1',
    operatorCatalog: {
      path: 'registrations/v0.3/phase3-operators.json',
      sha256: sha256(operatorBytes),
      catalogVersion: operatorCatalog.catalogVersion,
    },
    baseCatalog: {
      path: 'registrations/v0.3/phase2-catalog.json',
      sha256: sha256(catalogBytes),
      catalogVersion: catalog.catalogVersion,
    },
    cases: {
      path: CASES_PATH,
      sha256: sha256(casesBytes),
    },
    positive,
    negative,
  };
}

export async function validateOperatorContracts(repositoryRoot) {
  const [evidenceBytes, expected] = await Promise.all([
    readFile(path.join(repositoryRoot, EVIDENCE_PATH)),
    buildOperatorEvidence(repositoryRoot),
  ]);
  const evidence = parseJsonBytes(evidenceBytes);
  assert(canonicalJson(evidence) === canonicalJson(expected), 'Recorded Phase 3 operator evidence differs from validation');
  return {
    catalogVersion: expected.operatorCatalog.catalogVersion,
    positiveCaseCount: expected.positive.length,
    negativeCaseCount: expected.negative.length,
  };
}
