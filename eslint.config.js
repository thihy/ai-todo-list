// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**', '.codegraph/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
    files: ['package.json'],
    rules: {
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