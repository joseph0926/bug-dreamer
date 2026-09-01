import { readFile, writeFile } from 'node:fs/promises';

const registration = JSON.parse(await readFile('/registration/packages.json', 'utf8'));
const dependencies = { ...registration.consumerDependencies };
for (const packageRegistration of registration.packages) {
  dependencies[packageRegistration.packageName] = `file:/artifacts/${packageRegistration.id}.tgz`;
}

await writeFile('/consumer/package.json', `${JSON.stringify({
  name: 'bug-dreamer-v03-clean-consumer',
  private: true,
  type: 'module',
  packageManager: registration.packageManager,
  engines: { node: registration.nodeVersion },
  dependencies,
}, null, 2)}\n`);

const allowBuilds = registration.consumerBuildPolicy.allowBuilds;
await writeFile('/consumer/pnpm-workspace.yaml', `allowBuilds:\n${allowBuilds.map((name) => `  ${name}: true`).join('\n')}\n`);
