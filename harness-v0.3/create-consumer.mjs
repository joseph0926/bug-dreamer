import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const registration = JSON.parse(await readFile('/registration/packages.json', 'utf8'));
const consumerRoot = process.argv[2] ?? '/consumer';
const dependencies = { ...registration.consumerDependencies };
for (const packageRegistration of registration.packages) {
  dependencies[packageRegistration.packageName] = `file:/artifacts/${packageRegistration.id}.tgz`;
}

await mkdir(consumerRoot, { recursive: true });
await writeFile(path.join(consumerRoot, 'package.json'), `${JSON.stringify({
  name: 'bug-dreamer-v03-clean-consumer',
  private: true,
  type: 'module',
  packageManager: registration.packageManager,
  engines: { node: registration.nodeVersion },
  dependencies,
}, null, 2)}\n`);

const allowBuilds = registration.consumerBuildPolicy.allowBuilds;
const overrides = registration.packages.map((packageRegistration) => `  '${packageRegistration.packageName}': file:/artifacts/${packageRegistration.id}.tgz`);
await writeFile(path.join(consumerRoot, 'pnpm-workspace.yaml'), `allowBuilds:\n${allowBuilds.map((name) => `  ${name}: true`).join('\n')}\noverrides:\n${overrides.join('\n')}\n`);
