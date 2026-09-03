# oxfmt formatter trial

**Status:** adopted. oxfmt is the formatter and the `format:check` gate; Prettier has been
removed. This document is kept as the record of what the trial measured.

[oxfmt](https://oxc.rs/docs/guide/usage/formatter) is VoidZero's Rust formatter, built to be a
drop-in Prettier replacement. It was first added alongside Prettier — a pinned dev dependency, a
config, and two `format:oxfmt*` scripts — so the two could be run against the same tree and the
difference measured rather than argued about. Those scripts are gone now: `format` and
`format:check` run oxfmt directly.

The motivating number is CI: `npm run format:check` costs 34-39s of the `precheck` job across the
three most recent green `main` runs, and the `autoformat` job that pairs with it OOM-kills on the
6 GB check fleet often enough to have earned a retry loop.

## What the trial proves

- oxfmt formats **2587 files** here — byte-for-byte the same set Prettier processes (verified: both
  tools report 2587), spanning `.ts` / `.mts` / `.js` / `.json` / `.md` / `.yml` / `.css`. There is
  no file type we would have to keep Prettier around for.
- On this repository it is **~9x faster in wall clock and ~2.6x cheaper in CPU** than the pinned
  Prettier 3.9.6.
- Its output is **not byte-identical to Prettier's**: 35 of 2587 files differ.
- All 35 differ for **exactly one reason**, and it is a known upstream bug rather than a design
  choice — see [Where they disagree](#where-they-disagree).
- `oxfmt --migrate=prettier` read `prettier.config.mjs` and `.prettierignore` unaided, and oxfmt
  honours `.prettierignore` and `.gitignore` natively at runtime. Every byte-exact exclusion
  (vendored upstream schemas, hook payload snapshots, the generated headless contract, the recorded
  demo sites) is respected without restating it, which is why `.oxfmtrc.json` carries no
  `ignorePatterns` block.

## Local results

Measured on 2026-08-31 against base `b7aa94f24`: Apple M1 Max, 10 cores, macOS 26.6.1, Node 22.22.2,
oxfmt 0.65.0 against the repository's pinned Prettier 3.9.6. Whole repository, warm filesystem
cache.

| Command              | Wall   | CPU time | Files scanned |
| -------------------- | ------ | -------- | ------------- |
| `prettier --check .` | 20.74s | 37.43s   | 2587          |
| `oxfmt --check .`    | 2.37s  | 14.40s   | 2587          |

For reference, the same check costs **34-39s** in the `precheck` job on the check fleet
([ci.yml](../../.github/workflows/ci.yml)), where the box is slower and busier than this laptop.

## Where they disagree

35 files, 152 added lines and 39 removed. Every one of the 152 is the same construct: a union type
that does not fit on its declaration line but does fit on a single indented continuation line.
Prettier hugs it onto that one line; oxfmt always explodes it to one member per line with a leading
pipe.

<!-- prettier-ignore -->
```ts
// Prettier 3.9.6 — the current committed form
export type StreamCutReason =
  'reasoning_runaway_cap' | 'reasoning_circle_detected' | 'trailing_reasoning_cap'

// oxfmt 0.65.0
export type StreamCutReason =
  | 'reasoning_runaway_cap'
  | 'reasoning_circle_detected'
  | 'trailing_reasoning_cap'
```

Both tools agree when the union fits on the declaration line, and both agree when it is too long
for one continuation line. Only the middle case diverges, which is why the blast radius is 35 files
and not thousands.

Both formatters are individually idempotent, and the two fixed points are mutually incompatible:
Prettier rejects oxfmt's output and oxfmt rejects Prettier's. **There is no configuration that makes
them agree, and no way to run both.** Adoption is a switch, not an addition.

This is tracked upstream and treated as a bug, not a deliberate difference —
[oxc#25437](https://github.com/oxc-project/oxc/issues/25437) describes exactly this case (closed as
a duplicate, still reproducible in 0.65.0), [oxc#25841](https://github.com/oxc-project/oxc/issues/25841)
covers the mirror-image case, and [oxc#18717](https://github.com/oxc-project/oxc/issues/18717) is
the umbrella tracker for remaining Prettier conformance gaps. oxfmt's own docs state that a
difference from current Prettier is a bug, so the expected resolution is upstream convergence
rather than a config knob on our side.

## Traps found while setting this up

The oxfmt ones are handled in `.oxfmtrc.json`; recording them because none is obvious and all are
silent.

- **`--write` is the default mode.** `oxfmt .` rewrites the tree; `--check` is the opt-in. Prettier
  is the other way round. Every script added here is explicit about which mode it wants.
- **Prettier formats code inside markdown fences**, so the example above needs a
  `<!-- prettier-ignore -->` to survive `pnpm run format`. Not an oxfmt trap, but it is the reason
  this file has one.
- **`sortPackageJson` defaults to on**, and it is not a Prettier setting. Left at its default it
  also re-sorts the keys of `package.json`, `packages/extract-zip/package.json`, and
  `benchmarks/steer/fixtures/injection-project/package.json` — the last of which is corpus bytes for
  the steer eval, not project source. Pinned off.

`--write`-by-default composes with one further behaviour into the trap worth naming: a bare
`oxfmt` in a directory where no config is discovered prints `No config found, using defaults` to
stdout and then reformats everything it can reach with semicolons and double quotes. That is the
whole reason the config here is `.oxfmtrc.json` rather than an `oxfmt.config.mjs` — only the
`.oxfmtrc.*` names are auto-discovered, so the settings apply even when nobody passes `-c`.

## Trying it

```bash
pnpm run format:oxfmt:check
```

To see the 35-file diff, run `pnpm run format:oxfmt` on a clean tree, inspect, then
`git checkout -- .`. Do not commit it: `pnpm run format:check` is still the gate and Prettier will
reject oxfmt's output.

## What would have to be true to adopt

1. **Upstream closes the union-layout gap.** Then the switch is byte-neutral and the whole trial
   reduces to swapping two scripts. This is the cheap path and it costs nothing to wait for.
2. **Or we accept a 35-file reformat commit** and switch `format` / `format:check` / the
   `autoformat` job to oxfmt in the same commit. Mechanical, but it touches the type declarations of
   35 files and needs `pnpm run check` green behind it.

Not attempted here, and the reason this stays a trial: nothing about the ~35s `format:check` step is
urgent enough to spend a reformat commit on, whereas the 104-120s `lint` step next to it is the
actual cost centre. If oxfmt earns its place, it will most likely be as the formatter half of a wider move
to the oxc toolchain — and the linter half of that needs TypeScript 7, which we are not on.

## Not evaluated

- Behaviour on Linux and Windows CI runners. Every number above is one macOS laptop.
- `sortImports` and the Tailwind class sorting oxfmt offers, both off. They are capabilities
  Prettier does not have, so enabling either makes the comparison something other than a formatter
  swap.
- Editor integration. oxfmt ships an LSP server (`oxfmt --lsp`); nobody has pointed an editor at it.
