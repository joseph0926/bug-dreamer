import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  V03SpecError,
  buildExecutionPlan,
  buildNightmareSpec,
  loadPhase2Catalog,
  parseNightmareSeed,
  planDigest,
  specDigest,
} from './v03-spec.mjs';
import { V03WireError, canonicalJson, domainDigest, parseJsonBytes } from './v03-wire.mjs';

const CASES_PATH = 'contracts/v0.3/spec-cases.json';
const EVIDENCE_PATH = 'evidence/v0.3/phase2-spec.json';

export class SpecValidationError extends Error {}

function fail(message) {
  throw new SpecValidationError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readBytes(repositoryRoot, relativePath) {
  return readFile(path.join(repositoryRoot, relativePath));
}

function rejection(error) {
  if (error instanceof V03SpecError) return { kind: error.kind, message: error.message };
  if (error instanceof V03WireError) return { kind: 'rejected-schema', message: error.message };
  throw error;
}

export async function buildSpecEvidence(repositoryRoot) {
  const [{ catalog, catalogBytes }, casesBytes] = await Promise.all([
    loadPhase2Catalog(repositoryRoot),
    readBytes(repositoryRoot, CASES_PATH),
  ]);
  const cases = parseJsonBytes(casesBytes);
  assert(cases.schemaVersion === 'bug-dreamer/spec-cases/v1', 'Unexpected spec case schemaVersion');
  assert(Array.isArray(cases.positive) && cases.positive.length > 0, 'Positive spec cases missing');
  assert(Array.isArray(cases.negative) && cases.negative.length > 0, 'Negative spec cases missing');

  const positive = [];
  for (const relativePath of cases.positive) {
    const seedBytes = await readBytes(repositoryRoot, relativePath);
    const seed = parseNightmareSeed(seedBytes, catalog);
    const spec = buildNightmareSpec(seed, catalog);
    const plan = buildExecutionPlan(spec, catalog);
    positive.push({
      path: relativePath,
      sourceSha256: sha256(seedBytes),
      seedDigest: domainDigest('bug-dreamer/nightmare-seed/v1', seed),
      specDigest: specDigest(spec, catalog),
      planDigest: planDigest(plan, spec, catalog),
      actionCount: plan.actions.length,
      fixtureCount: plan.fixtureSetup.length,
    });
  }

  const negative = [];
  for (const fixture of cases.negative) {
    const seedBytes = await readBytes(repositoryRoot, fixture.path);
    let observed;
    try {
      parseNightmareSeed(seedBytes, catalog);
      fail(`Negative spec case was accepted: ${fixture.path}`);
    } catch (error) {
      observed = rejection(error);
    }
    assert(observed.kind === fixture.expectedKind, `Negative spec kind mismatch: ${fixture.path}`);
    assert(observed.message.includes(fixture.expectedMessage), `Negative spec message mismatch: ${fixture.path}`);
    negative.push({
      path: fixture.path,
      sourceSha256: sha256(seedBytes),
      expectedKind: fixture.expectedKind,
      observedKind: observed.kind,
      expectedMessage: fixture.expectedMessage,
    });
  }

  return {
    schemaVersion: 'bug-dreamer/phase2-spec-evidence/v1',
    catalog: {
      path: 'registrations/v0.3/phase2-catalog.json',
      sha256: sha256(catalogBytes),
      catalogVersion: catalog.catalogVersion,
    },
    cases: {
      path: CASES_PATH,
      sha256: sha256(casesBytes),
    },
    canonicalizer: {
      standard: 'RFC 8785 JCS',
      package: 'canonicalize',
      version: '4.0.0',
    },
    positive,
    negative,
  };
}

export async function validateSpecContracts(repositoryRoot) {
  const [evidenceBytes, expected] = await Promise.all([
    readBytes(repositoryRoot, EVIDENCE_PATH),
    buildSpecEvidence(repositoryRoot),
  ]);
  const evidence = parseJsonBytes(evidenceBytes);
  assert(canonicalJson(evidence) === canonicalJson(expected), 'Recorded Phase 2 spec evidence differs from validation');
  return {
    catalogVersion: expected.catalog.catalogVersion,
    positiveCaseCount: expected.positive.length,
    negativeCaseCount: expected.negative.length,
  };
}
