import js from '@eslint/js'
import ts from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default ts.config(
  {
    ignores: [
      'dist/',
      'dist-test/',
      'dist-types/',
      'coverage/',
      'node_modules/',
      '.tmp/',
      '.claude/**',
      'eslint.config.mjs',
      'eslint.hook.config.mjs',
      'prettier.config.mjs',
      'wdio.conf.ts',
      'wdio.ci.conf.ts',
      'wdio.eval.conf.ts',
      'wdio.demo.conf.ts',
      'tests/e2e/**',
      'tests/demo/**',
      'tests/fixtures/git-changes-repo/**',
      // Bench-task fixture repos: code for the agent under eval to fix, not project code.
      'benchmarks/fixtures/**',
      'benchmarks/steer/fixtures/**',
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
      // Catch union members silently dropped by a `switch`. Switches that
      // intentionally lean on `default` to drop the rest (chunk/session-update
      // adapters, errno maps) stay valid via `considerDefaultExhaustiveForUnions`;
      // a switch with no `default` must still handle every member explicitly.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Ban `{ ... } as T` object-literal casts: they silently bypass excess-property
      // checks, so a typo'd or stale field type-checks clean. Annotate the binding
      // (`const x: T = { ... }`) or use `satisfies T` instead. Other `as` casts stay
      // allowed for now — narrowing those further is tracked separately.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      // #508 high-churn rules, enabled as errors but held to a shrink-only
      // baseline in `eslint-suppressions.json` (ESLint bulk suppressions). Today's
      // violations are recorded there and don't fail the build; any NEW violation
      // does. As sites are fixed, run `npm run lint:prune` to shrink the baseline —
      // it can only get smaller. See the "Type-safety & lint discipline" section
      // in AGENTS.md.
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  {
    files: [
      'src/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/**/*.ts',
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
    // Standalone test fixtures that are spawned as real child processes (see
    // tests/fixtures/mock-acp-agent.mjs). They run as plain ESM under `node`,
    // not through the test bundler, so they carry no TS annotations and are not
    // part of the TS project graph.
    files: ['tests/fixtures/*.mjs'],
    extends: [ts.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        ReadableStream: 'readonly',
      },
    },
    rules: {
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
  {
    // Marketing-site scripts: plain browser JS served as-is from `site/`, with
    // no build step and no TS project to type-check against.
    files: ['site/**/*.js'],
    extends: [ts.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    // Synchronous first-paint theme script copied to dist; not part of the TS project graph.
    files: ['src/renderer/theme-boot.js'],
    extends: [ts.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
)
