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
    // Keep the agent path importable without Electron. `agent-path-electron-surface.test.ts`
    // already proves the product's agent construction runs under plain Node, but it does so
    // by walking the import graph from three named roots — so a file that is not yet
    // reachable can take a runtime Electron dependency freely, and only turns some later,
    // unrelated PR red once something imports it. This rule enforces the same boundary at
    // every file, and reports it where the mistake is made.
    //
    // Type-only imports stay allowed everywhere (`allowTypeImports`): TypeScript erases
    // them, so Node never resolves Electron, and several pure modules legitimately type
    // their injected handles as `BrowserWindow` / `IpcMain`.
    //
    // Only the bare `electron` module is restricted. `electron-updater` and
    // `electron-store` are separate packages and do not match a `paths` entry; bringing
    // them under the boundary is a follow-up, not a silent side effect of this rule.
    // `.mts` is listed alongside `.ts` because `src/shared` has two of them, and shared
    // code is exactly where an Electron import would do the most damage.
    files: ['src/**/*.ts', 'src/**/*.mts', 'packages/*/src/**/*.ts', 'packages/*/src/**/*.mts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              allowTypeImports: true,
              message:
                'Importing Electron here couples the agent path to the desktop runtime. Inject the ' +
                'capability from an Electron entry point instead (see the handler seams in ' +
                'approval.ts / ask-user.ts), or `import type` if you only need its types. If this ' +
                'file genuinely IS a desktop entry point, add it to the allow-list in ' +
                'eslint.config.mjs — deliberately, and visibly in review.',
            },
          ],
        },
      ],
    },
  },
  {
    // The Electron surface: every file that may hold a runtime `electron` import. Kept as an
    // explicit list rather than a glob over `src/main/**` because the point of the rule is
    // that `src/main` is NOT the boundary — 18 of its ~400 files need Electron, and the rest
    // are a portable agent runtime that merely lives beside them.
    //
    // `windows/` and `ipc/` are wholesale: both directories exist to own the desktop shell
    // and IPC surface. `preload/` bridges the renderer and cannot work without it. The
    // six services below are the leaky ones — each is a desktop capability behind a seam
    // (auto-update, dialogs, tray/menu prompts, the browser panel, SSH IPC), and each is a
    // candidate for the `*-electron.ts` suffix convention if that is ever adopted.
    //
    // The renderer is deliberately absent: it reaches Electron only through the preload
    // bridge, and today imports it nowhere.
    files: [
      'src/preload/**/*.ts',
      'src/main/index.ts',
      'src/main/app-init.ts',
      'src/main/app-icon.ts',
      'src/main/windows/**/*.ts',
      'src/main/ipc/**/*.ts',
      'src/main/services/auto-update.ts',
      'src/main/services/close-confirm.ts',
      'src/main/services/update-prompt.ts',
      'src/main/services/user-alerts-electron.ts',
      'src/main/services/packs/pack-browser-panel.ts',
      'src/main/services/ssh-workspace/ssh-workspace-ipc.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
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
    // Executable resources shipped inside built-in skills run directly under
    // Node and are copied as-is, so they are not part of a TypeScript project.
    files: ['assets/skills/**/*.mjs'],
    extends: [ts.configs.disableTypeChecked],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
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
    // Static-site scripts: plain browser JS served as-is, with no TS project to
    // type-check against. Demo sites are copied next to the browser build.
    files: ['site/**/*.js', 'src/shared/demo-sites/**/*.js'],
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
