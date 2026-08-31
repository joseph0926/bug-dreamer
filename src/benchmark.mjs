import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGET_REVISION } from './constants.mjs';
import { resolveModule } from './modules.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(repositoryRoot, 'benchmark', 'manifest.json');

export async function loadManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (manifest.target_revision !== TARGET_REVISION) {
    throw new Error(
      `Benchmark manifest revision ${manifest.target_revision} does not match target ${TARGET_REVISION}`,
    );
  }
  return manifest;
}

export function resolveDefect(manifest, defectId) {
  const defect = manifest.defects.find((entry) => entry.id === defectId);
  if (defect === undefined) {
    throw new Error(
      `Defect ${defectId} is not in the benchmark manifest. Known defects: ${manifest.defects.map((entry) => entry.id).join(', ')}`,
    );
  }
  resolveModule(defect.module);
  return defect;
}

export function benchImageTagFor(defectId) {
  return `bug-dreamer/firsttx:bench-${TARGET_REVISION.slice(0, 12)}-${defectId}`;
}

export function applyEdit(source, edit) {
  const occurrences = source.split(edit.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Defect edit for ${edit.file} matched ${occurrences} times; exactly one match is required`,
    );
  }
  return source.replace(edit.find, edit.replace);
}
