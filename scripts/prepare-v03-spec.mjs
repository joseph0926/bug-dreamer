import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSpecEvidence } from '../src/v03-spec-validation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = path.join(repositoryRoot, 'evidence/v0.3/phase2-spec.json');

async function main() {
  if (process.argv.length !== 2) throw new TypeError('Usage: node scripts/prepare-v03-spec.mjs');
  const evidence = await buildSpecEvidence(repositoryRoot);
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: 'ok', evidence: path.relative(repositoryRoot, evidencePath) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error instanceof TypeError ? 2 : 1;
});
