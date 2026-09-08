// ESM resolve hook: stub the `electron` module so importing src/main/logger
// and src/main/dsh/dsh-runtime (which use electron's `app`) works outside the
// Electron runtime. getAppPath returns the real project root (two levels up from
// this loader) so resources/dsh/cordis.yml + node_modules resolve correctly; the
// test chdir's to a temp dir first so the cordis.yml session-persistence `root:`
// (process.cwd() + '/.thihy-todolist/dsh-sessions') does not pollute the repo.
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = pathResolve(here, '..', '..');

const electronSource = `
const ROOT = ${JSON.stringify(PROJECT_ROOT)};
export const app = {
  getAppPath: () => ROOT,
  getPath: (name) => ${JSON.stringify(join(tmpdir(), 'thihy-test'))} + '/' + name,
  getName: () => 'thihy-test',
  getVersion: () => '0.0.0-test',
  isReady: () => true,
  on: () => {},
  whenReady: () => Promise.resolve(),
};
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      url: 'data:text/javascript;base64,' + Buffer.from(electronSource).toString('base64'),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
