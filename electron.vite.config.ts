import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// `@deepseek-ai/*` and `cordis` are intentionally absent from node_modules —
// we ship a shim-only DSH because the upstream RC chain is broken. The dynamic
// imports in `src/main/dsh/container.ts` are catch-fallback paths; telling
// rollup they are external lets the bundler succeed without bringing the
// (non-existent) packages into the build.
const DSH_OPTIONAL = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-bash-env',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-permission',
  'cordis',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        external: DSH_OPTIONAL,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    // Electron 33's sandboxed preload must be CommonJS; with package.json
    // "type": "module", the default output is .mjs (ESM), which sandbox mode
    // refuses to load and leaves window.thihy undefined. Force CJS + .cjs so
    // the preload actually runs.
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          capture: resolve('src/renderer/capture.html'),
        },
      },
    },
  },
});