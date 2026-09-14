// Run with Electron, not plain Node: native modules and app.asar resolution
// must use the same runtime as the installed app.
// pnpm exec electron resources/check-packaged-dsh.cjs dist/win-unpacked/resources
const { app } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const resources = resolve(process.argv[2] || 'dist/win-unpacked/resources');
const appRoot = join(resources, 'app.asar');
const scratch = mkdtempSync(join(tmpdir(), 'todo-list-dsh-smoke-'));
process.env.DSH_SESSIONS_ROOT = join(scratch, 'sessions');
app.setPath('userData', scratch);

const timeout = setTimeout(() => {
  console.error('Packaged DSH boot timed out after 60 seconds');
  app.exit(1);
}, 60_000);

app.whenReady().then(async () => {
  let ctx;
  try {
    const { boot } = await import(pathToFileURL(join(
      appRoot, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    )).href);
    ctx = await boot('packaged-dsh-check', join(resources, 'dsh/cordis.yml'),
      undefined, undefined, new URL('.', pathToFileURL(appRoot).href).href);
    for (const service of ['llm', 'tools', 'agents', 'sessionPersistence']) {
      if (!ctx.get(service)) throw new Error(`Missing DSH service: ${service}`);
    }
    console.log('Packaged DSH boot passed: all configured plugins activated');
  } finally {
    await ctx?.fiber.dispose();
  }
}).then(() => finish(0), (error) => {
  console.error(error);
  finish(1);
});

function finish(code) {
  clearTimeout(timeout);
  rmSync(scratch, { recursive: true, force: true });
  app.exit(code);
}
