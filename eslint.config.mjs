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
  ...ts.configs.strictTypeChecked,
  prettier,
  {
    // A stale `// eslint-disable` is as misleading as a missing one: it implies a
    // rule fires here when it no longer does. Fail the build on unused directives
    // so the inline-suppression inventory stays honest as the code changes.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
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
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // Ban `{ ... } as T` object-literal casts: they silently bypass excess-property
      // checks, so a typo'd or stale field type-checks clean. Annotate the binding
      // (`const x: T = { ... }`) or use `satisfies T` instead. Other `as` casts stay
      // allowed for now — narrowing those further is tracked separately.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  {
    // Package-boundary guard (#601): the @copse/streaming-markdown core must
    // stay app-independent so it can version and ship on its own. Ban imports of
    // app modules (path aliases) and any relative import that climbs out of the
    // package. Host-specific behaviour is injected (e.g. a LinkDecorator), not
    // imported. Tests are exempt (they may reach into ../tests helpers).
    files: ['packages/streaming-markdown/src/**/*.ts'],
    ignores: ['packages/streaming-markdown/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@shared', '@shared/*', '@main', '@main/*', '@renderer', '@renderer/*'],
              message:
                'The markdown package core must stay app-independent (#601): inject host behaviour (e.g. a LinkDecorator) instead of importing app modules.',
            },
            {
              group: ['../../*', '../../**'],
              message: 'Do not import from outside the @copse/streaming-markdown package (#601).',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/**/*.test.ts',
      'tests/**/*.ts',
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      // Test doubles must stay `async` to match the real async interfaces they
      // stand in for (provider `stream`, tool `executeTool`, etc.) even with no
      // internal await; de-asyncing would break their type contract.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests build partial doubles as object literals cast to the real type
      // (a fake `Response`, a stub `HTMLElement`). That's the deliberate test
      // pattern, so the object-literal-cast ban only applies to production code.
      '@typescript-eslint/consistent-type-assertions': 'off',
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
    rules: {
      // .cjs files are executed directly by node and can't carry TypeScript
      // return-type annotations, so this rule can't be satisfied here.
      '@typescript-eslint/explicit-function-return-type': 'off',
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
