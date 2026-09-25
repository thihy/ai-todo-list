import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// `externalizeDepsPlugin()` externalizes every package.json dependency —
// including the `@deepseek-ai/*` DSH tree (dsh-base pulls ~273 ESM packages).
// They are NOT bundled into the main output; the main process loads them at
// runtime via dynamic `import()` from node_modules. This keeps the 273-pkg
// agent/sandbox/editor/terminal stack out of the rollup graph entirely, which
// is the only sane way to build it (those packages are ESM RC code with deep
// import graphs that would explode the bundler).
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
    // refuses to load and leaves window.todoList undefined. Force CJS + .cjs so
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
    server: {
      port: 8001,
      strictPort: true,
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          capture: resolve('src/renderer/capture.html'),
          pet: resolve('src/renderer/pet.html'),
        },
      },
    },
  },
});