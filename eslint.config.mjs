import js from '@eslint/js'
import ts from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default ts.config(
  {
    ignores: [
      'dist/',
      'dist-test/',
      'dist-types/',
      'node_modules/',
      '.tmp/',
      '.claude/**',
      'eslint.config.mjs',
      'prettier.config.mjs',
      'wdio.conf.ts',
      'wdio.ci.conf.ts',
      'wdio.eval.conf.ts',
      'tests/e2e/**',
      'tests/fixtures/git-changes-repo/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.node.json', './tsconfig.web.json'] },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      // require-await intentionally left off: de-asyncing functions changes
      // return types and sync-vs-rejected throw timing (a behavior-change
      // hazard), so it is deferred to a separate stage.
      '@typescript-eslint/require-await': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain CommonJS scripts aren't part of the typed tsconfig projects, so
    // disable type-aware linting and provide Node CJS globals for them.
    files: ['**/*.cjs'],
    extends: [ts.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // Static ESM worker host copied to dist; not part of the TS project graph.
    files: ['src/renderer/monaco/esm-worker-host.js'],
    extends: [ts.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'module',
      globals: {
        URL: 'readonly',
        globalThis: 'readonly',
        importScripts: 'readonly',
      },
    },
  },
)
