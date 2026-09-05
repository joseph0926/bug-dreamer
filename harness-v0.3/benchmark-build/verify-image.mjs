import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function treeEntries(root, prefix = '') {
  const entries = [];
  async function visit(relativeDirectory) {
    for (const entry of (await readdir(path.join(root, relativeDirectory), { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const relative = path.join(relativeDirectory, entry.name).split(path.sep).join('/');
      const absolute = path.join(root, relative);
      const info = await lstat(absolute);
      if (info.isDirectory()) await visit(relative);
      else if (info.isFile()) entries.push({ path: relative, kind: 'file', sha256: sha256(await readFile(absolute)) });
      else if (info.isSymbolicLink()) entries.push({ path: relative, kind: 'symlink', sha256: sha256(Buffer.from(await readlink(absolute))) });
      else throw new Error(`Image closure contains unsupported entry: ${absolute}`);
    }
  }
  await visit(prefix);
  return entries;
}

async function verifyRoot(root) {
  const actual = await treeEntries(root.path);
  if (JSON.stringify(actual) !== JSON.stringify(root.files)) throw new Error(`Image closure differs from its manifest: ${root.path}`);
}

const manifest = JSON.parse(await readFile('/registration/image-manifest.json', 'utf8'));
if (manifest.schemaVersion !== 'bug-dreamer/v03-benchmark-image-manifest/v1') throw new Error('Unexpected benchmark image manifest');
for (const root of manifest.roots) await verifyRoot(root);
for (const file of manifest.files) {
  if (sha256(await readFile(file.path)) !== file.sha256) throw new Error(`Image file differs from its manifest: ${file.path}`);
}
if (process.argv[2] === '--json') {
  process.stdout.write(`${JSON.stringify({ artifactSetId: manifest.artifactSetId, benchmarkImageContractKey: manifest.benchmarkImageContractKey })}\n`);
}
