# Type-safety & lint discipline

The hard-won conventions for keeping the codebase type-honest. AGENTS.md links here rather than
inlining all of it; this is the full reference.

## The three gates

The checks that keep the codebase honest run together under **`npm run check`** (and again in CI's
`precheck` job):

- **`tsc`** (`npm run typecheck`) — both tsconfig projects (`tsconfig.node.json`,
  `tsconfig.web.json`), on `strict` plus the extra flags (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, …).
- **ESLint** (`npm run lint`) — flat config in `eslint.config.mjs`, on `typescript-eslint`'s
  `strictTypeChecked`. Two high-churn rules run against a shrink-only baseline
  (`eslint-suppressions.json`); see [Baselined rules](#baselined-rules-shrink-only).
- **Prettier** (`npm run format:check`).

Run `npm run check` before every commit — never hand-format or eyeball types in place of it. For a
fast inner loop on a few files, `npx tsc --noEmit -p tsconfig.web.json`, `npx eslint <files>`, and
`npx prettier --write <files>` are the same tools `check` invokes.

## Write code the linter never has to flag

### Minimise `as` casts

A cast asserts a type the compiler can't verify, so each one is a place a refactor can silently go
wrong. Prefer the typed alternative:

- a narrowing **type guard** (`if (typeof x === 'string')`, `instanceof`, a custom `x is T`);
- a **discriminated union** instead of casting between shapes;
- a **zod-validated boundary** — use `defineTool()` so tool args are inferred from the schema, not
  cast;
- **`satisfies T`** to check a value against a type without widening it;
- the **`at()` helper** in `src/shared/array-utils.ts` for safe indexed access;
- the typed **`qs<E>()` / `qsRequired<E>()`** helpers in `src/renderer/dom/helpers.ts` instead of
  `root.querySelector(sel) as E` — they type the result via the DOM lib's own `querySelector<E>`
  signature, and `qsRequired` throws a clear error on a miss rather than returning a silent
  non-null lie.

`as const` is fine. `as unknown as T` double-casts are a code smell — reach for a real type first.

> `@typescript-eslint/no-unsafe-type-assertion` is **on**, but its existing violations are held to a
> shrink-only baseline (see [Baselined rules](#baselined-rules-shrink-only)). You never need to add a
> new one — clear a whole category (DOM casts, JSON-parse casts, `(err as Error)` …) at a time and
> prune the baseline as you go.

### Never cast object literals

`{ ... } as T` is banned in production code (`@typescript-eslint/consistent-type-assertions` with
`objectLiteralTypeAssertions: 'never'`) because it skips excess-property checking, so a typo'd or
stale field passes silently. Annotate the binding instead — `const x: T = { ... }` — or use
`{ ... } satisfies T`. (Tests may cast partial mocks to a real type; that override is intentional.)

### Don't reach for an escape hatch to silence a real error

`eslint-disable` and `@ts-expect-error` / `@ts-ignore` hide a finding rather than fix it. Fix the
underlying type or logic first. If a suppression is genuinely unavoidable (e.g. a defensive
`no-unnecessary-condition` guard against legacy persisted data, or a query helper's single-use type
parameter), it **must** carry a trailing `-- reason`:

- `ban-ts-comment` requires a description on every `@ts-expect-error`.
- `reportUnusedDisableDirectives` is set to `error`, so a suppression that no longer suppresses
  anything fails the build.

Keep the inventory small and justified.

### No `any`, no unsafe flow

`no-explicit-any` and the `no-unsafe-*` family are on. Type values at the boundary where they enter
the code (parse/validate untyped input — storage reads, `JSON.parse`, network responses) rather than
letting `any` propagate inward.

## Baselined rules (shrink-only)

Two high-churn rules from the #508 backlog are enabled as **errors** but carry too many existing
violations to fix in one pass:

- `@typescript-eslint/no-unsafe-type-assertion`
- `@typescript-eslint/prefer-nullish-coalescing`

Rather than leave them off (which lets new violations pile up unchecked), today's violations are
recorded in **`eslint-suppressions.json`** using ESLint's bulk-suppressions feature. The effect is an
allowlist that lets the backlog be paid down gradually while blocking regressions:

- **Existing** violations in the baseline don't fail `npm run lint`.
- **New** violations — anywhere, including a new file — fail immediately. This is the regression gate.
- The baseline only ever **shrinks**: when you fix a site, run **`npm run lint:prune`** and commit the
  updated `eslint-suppressions.json` in the same change.

`npm run lint` passes `--pass-on-unpruned-suppressions` so that fixing a site without pruning doesn't
red-wire the build (the CI `autoformat` job auto-applies `eslint --fix` on changed files, and a
full-tree prune can't safely run there). That tolerance is only for _stale_ entries — a genuinely new
violation still fails. Prune periodically, and always when a PR clears a batch, so the baseline stays
an honest floor.

Do **not** regenerate the whole file to “fix” a red build, and don't add new entries by hand. The
only sanctioned writes are `--prune-suppressions` (shrink) and a deliberate, reviewed re-baseline if
a rule's options change. The count-based baseline is per-file-per-rule, so it catches net new
violations, not a fix-and-reintroduce within the same file's existing budget — keep pruning to keep
that budget tight.
