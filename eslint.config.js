import tseslint from 'typescript-eslint';

const noDefaultExport = {
  selector: 'ExportDefaultDeclaration',
  message: 'Named exports only (see CLAUDE.md).',
};

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results'] },
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error', noDefaultExport],
    },
  },
  {
    // Pure code: no React or DOM-library imports (see CLAUDE.md).
    files: ['src/{model,geometry,toolpath,drivers,import,nesting}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['react', 'react-dom', 'zustand'],
          patterns: [{ group: ['react-dom/*', '**/ui/*'], message: 'Keep this code free of UI imports.' }],
        },
      ],
    },
  },
  {
    // Tool config files have to use a default export.
    files: ['*.config.{ts,js}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
