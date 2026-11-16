import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.audit/**',
      'coverage/**',
      'src-tauri/**',
      'public/**',
      '_backup/**',
      'tests/perf/.runs/**',
      'tests/perf/.rollback/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-constant-binary-expression': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    // Native IPC fixtures deliberately inject malformed data across the typed boundary.
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
