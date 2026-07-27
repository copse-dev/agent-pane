// ESLint config for the post-edit hook (`scripts/hook-file-check.mts`) — the
// project config with every type-aware rule switched off.
//
// The repo lints with `strictTypeChecked` and `parserOptions.project`, so
// linting a single file still builds the whole TypeScript program: ~10s per
// file. At that cost an agent routes around the hook, and a hook that gets
// disabled catches nothing. `disableTypeChecked` clears `parserOptions.project`
// along with the typed rules, which brings a one-file lint down to ~2s and
// keeps the high-frequency findings (unused vars, undefined references, missing
// return types).
//
// What this config CANNOT see — the type-aware rules, including the two held to
// the `eslint-suppressions.json` baseline (`no-unsafe-type-assertion`,
// `prefer-nullish-coalescing`) — is exactly why the hook's report says it is a
// subset and points at `npm run check`. This config is never the gate; CI and
// `npm run lint` always use `eslint.config.mjs`.
import ts from 'typescript-eslint'
import base from './eslint.config.mjs'

export default [
  ...base,
  {
    files: ['**/*.{ts,mts,cts,tsx,js,mjs,cjs}'],
    ...ts.configs.disableTypeChecked,
    // With the typed rules off, every `// eslint-disable` covering one of them
    // looks unused. Those directives are load-bearing under the real lint, so
    // reporting them here would be pure noise.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
]
