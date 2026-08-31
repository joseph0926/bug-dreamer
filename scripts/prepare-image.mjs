import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEdit, benchImageTagFor, loadManifest, resolveDefect } from '../src/benchmark.mjs';
import { TARGET_REVISION } from '../src/constants.mjs';
import { DEFAULT_MODULE, imageTagFor, resolveModule } from '../src/modules.mjs';
import { runCommand } from '../src/process.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args) {
  let target;
  let moduleName;
  let defectId;

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}`);
    if (name === '--target') target = value;
    else if (name === '--module') moduleName = value;
    else if (name === '--defect') defectId = value;
    else throw new Error(`Unknown option: ${name}`);
  }

  if (target === undefined || target.length === 0) {
    throw new Error(
      'Usage: node scripts/prepare-image.mjs --target <firsttx-path> [--module <module> | --defect <defect-id>]',
    );
  }
  if (moduleName !== undefined && defectId !== undefined) {
    throw new Error('Use either --module or --defect, not both; a defect fixes its module');
  }

  return { target, moduleName: moduleName ?? DEFAULT_MODULE, defectId };
}

async function plantDefect(targetDestination, defect) {
  for (const edit of defect.edits) {
    const filePath = path.join(targetDestination, edit.file);
    const source = await readFile(filePath, 'utf8');
    await writeFile(filePath, applyEdit(source, edit));
  }
}

async function archiveTarget(targetPath, destination, archivePaths) {
  await new Promise((resolve, reject) => {
    const archive = spawn(
      'git',
      ['-C', targetPath, 'archive', '--format=tar', TARGET_REVISION, ...archivePaths],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const extract = spawn('tar', ['-x', '-C', destination], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let archiveError = '';
    let extractError = '';
    let archiveExit;
    let extractExit;

    archive.stdout.pipe(extract.stdin);
    archive.stderr.on('data', (chunk) => {
      archiveError += chunk.toString();
    });
    extract.stderr.on('data', (chunk) => {
      extractError += chunk.toString();
    });
    archive.once('error', reject);
    extract.once('error', reject);

    const finish = () => {
      if (archiveExit === undefined || extractExit === undefined) return;
      if (archiveExit !== 0 || extractExit !== 0) {
        reject(new Error(`Target archive failed: ${archiveError}${extractError}`));
        return;
      }
      resolve();
    };

    archive.once('close', (code) => {
      archiveExit = code;
      finish();
    });
    extract.once('close', (code) => {
      extractExit = code;
      finish();
    });
  });
}

async function main() {
  const { target: targetInput, moduleName, defectId } = parseArgs(process.argv.slice(2));
  const defect = defectId === undefined ? undefined : resolveDefect(await loadManifest(), defectId);
  const module = resolveModule(defect?.module ?? moduleName);
  const imageTag = defect === undefined ? imageTagFor(module.module) : benchImageTagFor(defect.id);
  const targetPath = await realpath(path.resolve(targetInput));
  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) throw new Error('Target path must be a directory');

  const revision = await runCommand('git', ['-C', targetPath, 'rev-parse', 'HEAD']);
  if (revision.exitCode !== 0) throw new Error(revision.stderr.trim());
  if (revision.stdout.trim() !== TARGET_REVISION) {
    throw new Error(`Target HEAD must be ${TARGET_REVISION}`);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bug-dreamer-build-'));
  const targetDestination = path.join(temporaryRoot, 'target');

  try {
    await mkdir(targetDestination, { recursive: true });
    await archiveTarget(targetPath, targetDestination, module.archivePaths);
    if (defect !== undefined) await plantDefect(targetDestination, defect);
    await cp(path.join(repositoryRoot, 'docker'), path.join(temporaryRoot, 'docker'), {
      recursive: true,
    });
    await cp(path.join(repositoryRoot, 'harness'), path.join(temporaryRoot, 'harness'), {
      recursive: true,
    });

    const lockfile = await readFile(path.join(targetDestination, 'pnpm-lock.yaml'));
    const dependenciesRef = `sha256:${createHash('sha256').update(lockfile).digest('hex')}`;
    const build = await runCommand('docker', [
      'build',
      '--load',
      '--pull',
      '--progress',
      'plain',
      '--tag',
      imageTag,
      '--build-arg',
      `TARGET_REVISION=${TARGET_REVISION}`,
      '--build-arg',
      `DEPENDENCIES_REF=${dependenciesRef}`,
      '--build-arg',
      `MODULE_DIR=${module.module}`,
      '--build-arg',
      `MODULE_FILTER=${module.filter}`,
      '--build-arg',
      `BUILD_FILTERS=${module.buildFilters.join(' ')}`,
      '--file',
      path.join(temporaryRoot, 'docker', 'Dockerfile'),
      temporaryRoot,
    ]);

    process.stdout.write(build.stdout);
    process.stderr.write(build.stderr);
    if (build.exitCode !== 0) process.exitCode = 1;
    else
      process.stdout.write(
        `${JSON.stringify({ image: imageTag, module: module.module, defect: defect?.id, dependencies_ref: dependenciesRef })}\n`,
      );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
