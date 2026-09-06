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
- **oxfmt** (`npm run format:check`).

Run `npm run check` before every commit — never hand-format or eyeball types in place of it. For a
fast inner loop on a few files, `npx tsc --noEmit -p tsconfig.web.json`, `npx eslint <files>`, and
`npx oxfmt --write <files>` are the same tools `check` invokes.

## Write code the linter never has to flag

### Minimise `as` casts

A cast asserts a type the compiler can't verify, so each one is a place a refactor can silently go
wrong. Prefer the typed alternative:

- a narrowing **type guard** (`if (typeof x === 'string')`, `instanceof`, a custom `x is T`);
- a **discriminated union** instead of casting between shapes;
- a **zod-validated boundary** — use `defineTool()` so tool args are inferred from the schema, not
  cast;
- **`satisfies T`** to check a value against a type without widening it;
- the **`at()` helper** in `packages/std/src/array-utils.ts` (`@copse/std`, re-exported as `@shared/array-utils.ts`) for safe indexed access;
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

### Prefer a predicate the compiler checks

A type predicate is the one assertion TypeScript never checks. Nothing verifies that `x is T` follows
from the body, so this compiles and every caller is silently lied to:

```ts
function isUser(x: unknown): x is User {
  return true // no error
}
```

`no-unsafe-type-assertion` does **not** flag predicates, so with the baseline empty they are the
widest unverified claims left in the codebase (#1330). Reach for one of the three forms below before
writing one by hand — none of them costs a lint exemption, and none of them appears in the
[inventory](#the-hand-written-predicate-inventory-is-shrink-only).

**Membership — `memberOf(TUPLE)`.** `.includes()`, `.some()` and `.has()` do not narrow, so a
membership predicate can never be checked or inferred; the annotation and the list are free to drift
apart. `memberOf` in `packages/std/src/member-of.ts` (`@copse/std`, re-exported as
`@shared/member-of.ts`) makes the tuple the single source of truth, and holds the codebase's one
membership assertion, property-tested against `Array.prototype.includes`:

```ts
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export const isThemePreference = memberOf(THEME_PREFERENCES)
```

**Narrowing — annotate the binding, not the return.** Moving the annotation left turns the assertion
into a claim the compiler verifies against the arrow's own inferred predicate:

```ts
// asserted — nothing checks the body
function isCommandTimeout(e: unknown): e is CommandTimeoutError {
  return e instanceof CommandTimeoutError
}

// checked — a body that stops proving this is TS2677
const isCommandTimeout: (e: unknown) => e is CommandTimeoutError = (e) =>
  e instanceof CommandTimeoutError
```

`explicit-function-return-type` is fine with this: `allowTypedFunctionExpressions` (on by default)
covers a function expression whose binding is annotated, so the signature stays written down and no
rule has to be relaxed. Deleting the annotation from a `function` declaration to obtain inference
does violate the rule — that is the route not to take.

**Inline — write no annotation at all.** Inside `.filter()` / `.find()` / `.every()` the compiler
infers the predicate, and the same lint option means an unannotated arrow in argument position is
already legal:

```ts
const paths = entries.filter((entry) => typeof entry === 'string') // string[]
```

Two things to know before converting one:

- Inference is **silent when it fails**. A body it cannot derive a predicate from yields plain
  `boolean`, and the call site quietly gets a wider type instead of an error — so check the resulting
  type, don't assume. `Boolean(x)` narrows nothing at all; `x !== undefined` does.
- The annotation is **load-bearing over `any`**. Where the input array is `any[]` (a `storageGet`
  read, say), the annotation is the only thing pinning the element type, and removing it trips the
  `no-unsafe-*` rules. That site wants a decoder, not a predicate.

#### What TypeScript can actually infer from

Measured across every predicate in this repo, not guessed. Inference needs a **single** return of an
expression that narrows the parameter — a preceding `const` is fine, an early `return false` is not:

| Body                                                            | Inferred?                                          |
| --------------------------------------------------------------- | -------------------------------------------------- |
| `typeof v === 'string'`, `v instanceof Err`, `Array.isArray(v)` | yes                                                |
| `v === 'a' \|\| v === 'b'`, `v.kind === 'ssh'`                  | yes                                                |
| `'heading' in entry`, where `entry` is already an object union  | yes                                                |
| `Array.isArray(v) && v.every((e) => typeof e === 'string')`     | yes                                                |
| `v !== null && v !== undefined` (including generic `T \| null`) | yes                                                |
| `LIST.includes(v)`, `SET.has(v)`, `LIST.some((e) => e === v)`   | **no** — use `memberOf`                            |
| `isRecord(v) && typeof v['x'] === 'string'`                     | **no** — indexed access does not narrow the object |
| `typeof v === 'object' && v !== null && 'x' in v`               | **no** — proves the key exists, not its type       |
| `typeof v === 'object' && v !== null && !Array.isArray(v)`      | **no** — twice over, see below                     |
| `Boolean(v)`, `cond ? true : false`, an early `return false`    | **no**                                             |

`isRecord` is the instructive one: the negated `Array.isArray` stops inference producing a predicate
at all, and even without it the most the compiler will conclude is `v is object`, which has no index
signature and so is not `Record<string, unknown>`. There is no way to write it that the compiler
checks.

Those structural rows are why the inventory is still long: most predicates here are boundary parsers
over `unknown`, and no annotation gymnastics will make them checkable. The honest fix for those is a
schema at the boundary (see [Boundary parsing](#boundary-parsing-decoders-not-type-arguments)); until
then they need a test.

### An asserted predicate needs a test

**An exported predicate without a test is an unaudited `as`.** Add one in the same PR.

Two acceptable shapes — pick by whether the domain is finite:

**Exhaustive**, when the predicate is backed by a `const` tuple. Derive the cases _from the tuple_
rather than listing them, so adding a member extends the test automatically and a predicate that
stops agreeing with its own source list fails:

```ts
for (const member of THEME_PREFERENCES) {
  assert.equal(isThemePreference(member), true)
}
```

That drift — the tuple and the predicate disagreeing — is the failure that actually happens, and
exhaustive coverage of a small finite domain is strictly stronger than sampling it. No
property-testing dependency needed.

**Property / fuzz**, when the domain is open (structural predicates like `isRecord`): assert over a
generated corpus rather than a handful of literals. Reach for `fast-check` only here — for a tuple
of three strings it buys nothing exhaustive coverage doesn't already give.

Either way the **rejection** corpus is where the bugs hide. Include:

- prototype keys — `__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty` (a predicate
  backed by an object lookup rather than a list wrongly accepts these)
- wrong types — `null`, `undefined`, `NaN`, `[]`, functions, and an object with a matching
  `toString`
- near-misses derived from each member — case, leading/trailing whitespace, truncation, trailing
  newline

Worked examples: `src/shared/type-predicates.test.ts` and `packages/std/src/member-of.test.ts`.

Finally, **check the test can fail**. Mutate the predicate body to `return true` and confirm the
suite goes red before you trust it — a predicate test that passes against a broken predicate is
worse than none, because it reads like coverage.

### The hand-written predicate inventory is shrink-only

`scripts/type-predicate-inventory.test.ts` lists every asserted predicate in the tracked source and
fails in both directions: a predicate that is not on the list fails, and a list entry whose predicate
is gone fails. So adding one is a visible, deliberate line in the diff, and converting one forces its
entry out in the same change. It exists because counting by hand did not hold — #1330 measured 161,
then 212 four months later.

Only the asserted form is counted. The three checked forms above are absent from it by construction,
which is the point: the cheapest predicate to add is also the honest one.

If a change legitimately needs a new asserted predicate — a structural boundary parser usually does —
add its line and its contract test together.

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
`packages/std/src/safe-json.ts` (`@copse/std`, re-exported as `@shared/safe-json.ts`):

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
