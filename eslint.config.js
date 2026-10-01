// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// resources/*.mjs and *.cjs are standalone Node build/verify scripts, not part of
// the TS build. ESLint's `no-undef` has no idea `Buffer`/`process` exist, so declare
// the Node globals they actually use instead of disabling the rule.
const nodeGlobals = {
  Buffer: 'readonly',
  URL: 'readonly',
  __dirname: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
};

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**', '.codegraph/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    // Node ESM helper scripts.
    files: ['resources/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // These scripts are plain JS run directly by node, so `require()` is only
      // legal in the .cjs CommonJS variants — never in .mjs.
      '@typescript-eslint/no-require-imports': 'error',
    },
  },
  {
    // CommonJS Electron helper scripts (run via `electron resources/...`).
    files: ['resources/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, require: 'readonly', module: 'writable' },
    },
    rules: {
      // `require()` is the whole point of a .cjs file.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // ESLint parses package.json as an ES module, so statement-level rules
    // misfire on a JSON document. Only the DSH pinning rule below is meaningful.
    files: ['package.json'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-undef': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.value=/^@deepseek-ai\\/dsh-/][value.value=/^(\\*|latest)$/]",
          message: 'DSH packages must be pinned to a specific RC version, never `*` or `latest`. See openspec/changes/todo-list-desktop/specs/ai-assistant/spec.md.',
        },
      ],
    },
  },
);
