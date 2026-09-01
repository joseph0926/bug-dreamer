import { lstat } from 'node:fs/promises';
import path from 'node:path';

export class PathContainmentError extends Error {}

function fail(message) {
  throw new PathContainmentError(message);
}

export function resolveContainedPath(root, relativePath) {
  if (typeof root !== 'string' || root.length === 0) fail('Containment root must be a non-empty string');
  if (typeof relativePath !== 'string') fail('Relative path must be a string');
  if (relativePath.length === 0) fail('Relative path must not be empty');
  if (relativePath.includes('\0')) fail('Relative path must not contain NUL');
  if (relativePath.includes('\\')) fail(`Relative path must not contain a backslash: ${relativePath}`);
  if (path.isAbsolute(relativePath)) fail(`Relative path must not be absolute: ${relativePath}`);
  const normalized = path.normalize(relativePath);
  if (normalized.split(path.sep).includes('..')) fail(`Relative path must not escape the root: ${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved === resolvedRoot) fail('Relative path must not resolve to the root itself');
  if (!resolved.startsWith(resolvedRoot + path.sep)) fail(`Relative path must not escape the root: ${relativePath}`);
  return resolved;
}

export async function assertNoSymlinkAncestors(root, absolutePath) {
  if (typeof root !== 'string' || root.length === 0) fail('Containment root must be a non-empty string');
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) fail('Symlink check requires an absolute path');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absolutePath);
  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) fail(`Path is outside the containment root: ${absolutePath}`);
  const segments = resolved.slice(resolvedRoot.length + 1).split(path.sep);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) fail(`Path traverses a symbolic link: ${current}`);
  }
  return resolved;
}
