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
  `strictTypeChecked`.
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

> The wider `as`-reduction effort (the `no-unsafe-type-assertion` backlog) is tracked as a staged
> cleanup; clear a whole category (DOM casts, JSON-parse casts, `(err as Error)` …) at a time.

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
