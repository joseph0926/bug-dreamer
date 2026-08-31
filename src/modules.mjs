import { TARGET_REVISION } from './constants.mjs';

const COMMON_ARCHIVE_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
];

export const MODULES = Object.freeze({
  'packages/tx': Object.freeze({
    filter: '@firsttx/tx',
    buildFilters: Object.freeze(['@firsttx/shared']),
    archivePaths: Object.freeze([...COMMON_ARCHIVE_PATHS, 'packages/shared', 'packages/tx']),
  }),
  'packages/local-first': Object.freeze({
    filter: '@firsttx/local-first',
    buildFilters: Object.freeze(['@firsttx/shared']),
    archivePaths: Object.freeze([
      ...COMMON_ARCHIVE_PATHS,
      'packages/shared',
      'packages/local-first',
    ]),
  }),
  'packages/prepaint': Object.freeze({
    filter: '@firsttx/prepaint',
    buildFilters: Object.freeze(['@firsttx/shared']),
    archivePaths: Object.freeze([...COMMON_ARCHIVE_PATHS, 'packages/shared', 'packages/prepaint']),
  }),
});

export const DEFAULT_MODULE = 'packages/tx';

export function resolveModule(name) {
  const definition = MODULES[name];
  if (definition === undefined) {
    throw new Error(
      `Module ${name} has no registered execution contract. Registered modules: ${Object.keys(MODULES).join(', ')}`,
    );
  }
  return { module: name, ...definition };
}

export function imageTagFor(name) {
  resolveModule(name);
  const base = `bug-dreamer/firsttx:v0.1-${TARGET_REVISION.slice(0, 12)}`;
  return name === DEFAULT_MODULE ? base : `${base}-${name.split('/')[1]}`;
}
