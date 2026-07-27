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
  `strictTypeChecked`, with no suppression baseline — see
  [The suppression baseline is empty](#the-suppression-baseline-is-empty--keep-it-that-way).
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

> `@typescript-eslint/no-unsafe-type-assertion` is **on and fully enforced** — the categories that
> used to fill its baseline (DOM casts, JSON-parse casts, `(err as Error)` …) are all cleared, so
> there is nothing to absorb a new one. If you find yourself needing one, the fix is a type guard, a
> `satisfies`, or a schema at the boundary — see
> [Boundary parsing](#boundary-parsing-decoders-not-type-arguments).

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

## The suppression baseline is empty — keep it that way

`eslint-suppressions.json` is `{}`. It used to hold a shrink-only baseline for
`no-unsafe-type-assertion` and `prefer-nullish-coalescing` while their backlog was paid down; #1307
cleared the last of it. Both rules are now **enforced outright, with nothing absorbing a new
violation**.

Practically:

- A new unsafe assertion fails `npm run lint` immediately. There is no budget to spend.
- **Do not** add entries by hand, and do not re-baseline to get a red build green. Fix the site.
- `npm run lint:prune` and the `--pass-on-unpruned-suppressions` flag are vestigial while the file is
  empty; they only matter if a future rule is introduced the same way.

If a rule ever does need re-baselining, that's a deliberate, reviewed decision — not a way around a
failing check.

## Boundary parsing: decoders, not type arguments

`JSON.parse` returns `any`, so every parse is a trust boundary. The contract in
`src/shared/safe-json.ts`:

```ts
safeJsonParse(text) // → unknown. You must narrow it.
safeJsonParse(text, decodeWithSchema(mySchema)) // → T | null. Checked, not asserted.
```

A **type argument is not a check**. `parse<User>(text)` names a shape that nothing verifies — the
caller asserts, the compiler believes it, and the lie propagates inward exactly like `any`. That is
why `safeJsonParse` has no `<T>` overload without a decoder, and why `parseGhJson` requires a schema.

`decodeWithSchema` accepts anything with a `safeParse` method, so a zod schema works as-is.

### Where schemas live

One definition per payload shape. Schemas with **more than one consumer** belong in a shared module
(`src/main/services/github/gh-json-schemas.ts` is the worked example); schemas with a **single**
consumer stay next to their call site.

Derive the TypeScript type from the schema with `z.infer` rather than hand-writing an interface
beside it — a hand-written type and the schema that validates the same payload will drift, and
nothing catches it when they do.

Boundary schemas should be **tolerant**: make fields optional and `.catch()`-guarded so one drifted
field degrades to `undefined` instead of discarding an entire payload. Validate the shape; let the
call site decide what to do about missing values.
