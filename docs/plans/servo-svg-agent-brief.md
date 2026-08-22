# Brief: prototype native SVG layout in Servo

A task brief for a coding agent (or a new contributor) to build a working
prototype of the phases costed in [`servo-svg-layout.md`](./servo-svg-layout.md).
Read that document first; this one assumes its conclusions and does not repeat
the evidence.

## Corrections after first contact (2026-08-22)

Phase 1 has been started and its first patch landed in the fork series as
`0009-layout-add-an-svg-viewport-behind-a-native-svg-pref.patch`. Building it
falsified six things this brief said. They are corrected in place below; this
section records what changed and why, so the reasoning is reviewable.

1. **Do Phase 1 before Phase 0.** This brief already said Phase 0 was the most
   likely to duplicate in-flight upstream work, then ordered it first anyway.
   Nothing in Phases 1–3 needs it: layout reads attributes and computed style,
   not `SVGLength` or `SVGPathSegList`. Phase 0 is volume that can be done by
   anyone, at any point, in parallel. Start where the architecture is.

2. **`<svg>` stays `ReplacedContentKind::SVGElement`.** Phase 1 said it "stops
   being" replaced content. That cannot be right and pref-gated at the same
   time — the old path has to stay intact — and `svg_kind_size`, which the same
   paragraph says to reuse, only runs for replaced content. SVG's own sizing
   spec treats `<svg>` as a replaced element, so this is not a shortcut: the
   dispatch stays one branch inside `svg_kind_size` and everything new lives in
   `components/layout/svg/`. This is also what keeps the seam small.

3. **Phase 1's exit criterion belonged to Phase 3.** "With the pref on, a
   `<rect>` renders at the right position and size" needs geometry traversal
   (Phase 2) and painting (Phase 3). Phase 1 cannot render anything. Its honest
   exit is the viewport transform being correct across the meet/slice ×
   alignment matrix, plus the pref selecting the code path.

4. **The seam budget counts *added* lines, and excludes two things.** Phase 4 is
   "mostly deletions" of the rasterization special case; charging those against
   a 50-line budget makes it unfinishable by construction. And the pref's own
   plumbing (`components/config/prefs.rs`, `ports/servoshell/prefs.rs`) is
   boilerplate every pref pays. Measured cost of Phase 1's first patch: **21
   added lines** across pre-existing files, of which 12 fall inside the budget's
   stated scope. That is a quarter of the budget for the smallest phase, so the
   budget is tight but real — which is the point of having one.

5. **WPT cannot be the per-commit oracle here, only the phase gate.** Rule 1
   said WPT is the only evidence of progress. It is the only evidence of
   *conformance*, and it stays the exit criterion — but it cannot be run in this
   stack. Servo is built as a path dependency of `tauri-shell`, so there is no
   `servo/target` and no `./mach` build; and servo's own workspace cannot be
   built here at all (it resolves a different `mozjs_sys` than the one
   `tauri-shell` has already compiled, and that build fails at linker
   detection). `cargo test -p servo-layout` fails for a third reason: from
   `tauri-shell/` it is a path dependency, not a workspace member, and cargo
   refuses to test those. See "The validation loop" below for what does work.

6. **Develop on the pinned rev; rebase onto `main` to submit.** This brief said
   to work against `main`. That throws away an 8-patch series and a warm 3.8 GB
   build tree for no benefit, since the deliverable is patch files that get
   rebased at submission time anyway. Checking `main` for collisions stays a
   precondition — it is just not the same thing as developing on it. Checked at
   `bd220a15`: no `components/layout/svg/` upstream, and the four commits
   touching `components/script/dom/svg/` since the pin are refactors, not
   geometry interfaces. Patch 0009 3-way-applies to `main` with one conflict, a
   one-line insertion into the sorted `EXPERIMENTAL_PREFS` list.

One thing found while doing it, worth a standalone upstream patch:
`SVGElementData::ratio_from_view_box` parses `viewBox` with `parse_integer` and
`parse_unsigned_integer`, so `viewBox="0 0 24.5 12.25"` yields **no intrinsic
aspect ratio at all** and the element sizes as if it had no `viewBox`. The
native path in 0009 parses SVG's `<number>` grammar instead; the rasterization
path is still wrong.

## The validation loop

Three tiers, fastest first. Use the cheap ones per commit; the expensive one is
a phase gate, not an inner loop.

```bash
# 1. Compile (~1 s warm). The only fast signal that the tree is consistent.
cd tauri-shell && cargo build --release -p servo-layout

# 2. Unit tests for the pure geometry (~1 s).
scripts/servo-svg-unit-tests.sh
```

`scripts/servo-svg-unit-tests.sh` copies `components/layout/svg/` verbatim into
a throwaway crate that depends only on `euclid`, stubs the one `pref!` lookup,
and runs `cargo test`. No source is duplicated — the files are re-copied every
run — so a test cannot drift from the code. This is only possible because the
SVG geometry is deliberately written as pure functions; keep it that way.

3. **WPT, per phase, elsewhere.** `./mach build --release && ./mach test-wpt
   tests/wpt/tests/svg/` on a standalone servo checkout. Report before/after
   expectation counts. Nothing in tiers 1–2 is evidence of conformance.

## Why this is a reasonable thing to hand to an agent

Three properties make it a better fit than most engine work:

1. **A machine-checkable oracle already exists.** `tests/wpt/tests/svg/` holds
   2 131 tests, 973 of which already carry Servo expectation files. Progress is
   "expectation files deleted", which is countable and not a matter of taste.
2. **The bulk is greenfield.** Phases 2 and 3 are new directories. New files do
   not conflict.
3. **The hard architectural decision is already made.** Servo paints paths with
   `vello`/`vello_cpu` and already depends on `kurbo`. There is no design space
   to get lost in — follow `components/canvas`.

And one property that makes it harder than it looks: **correct-looking SVG is
easy, spec-correct SVG is not.** The WPT suite is the only defence. An agent that
reports success without moving expectation counts has not done the work.

## Churn reality, and the seam budget

Measured over the last 12 months (4 977 commits in the repo):

| Path                                  | Commits | Verdict for this work                  |
| ------------------------------------- | ------: | -------------------------------------- |
| `components/layout/flow/inline/`      |     117 | **do not touch**                       |
| `components/layout/display_list/`     |     103 | touch only at a narrow seam            |
| `components/script/dom/svg/`          |      50 | upstream is _actively_ working here    |
| `components/canvas/`                  |      46 | read it, copy the pattern, do not edit |
| `components/layout/replaced.rs`       |      39 | seam only                              |
| `components/layout/dom.rs`            |      39 | seam only                              |
| `components/layout/flow/construct.rs` |      28 | seam only                              |
| `components/script/animations.rs`     |      11 | cold — safe to edit                    |

File-level churn overstates the risk. The actual SVG dispatch seam in
`replaced.rs` is a two-line `else if` arm that has been touched **7 times in its
entire history**. So:

> **Seam budget: no more than ~50 *added* lines total across all pre-existing
> files in `components/layout/` and `components/script/` (excluding
> `components/script/dom/svg/`, `components/config/prefs.rs`,
> `ports/servoshell/prefs.rs`, and any new modules). Everything else goes in new
> files. Deletions of the rasterization path in Phase 4 do not count.**

Added, not changed, and with those exclusions — see correction 4. Deletions are
the point of Phase 4, and pref boilerplate is a fixed cost every pref pays;
charging either against the budget makes it unmeetable rather than tight.

Spent so far: **12 lines** (Phase 1, patch 0009 — 21 across all pre-existing
files including the pref plumbing). A quarter of the budget for the smallest
phase is a fair warning that the remaining phases have to be disciplined.

If a phase cannot be done inside that budget, stop and report why rather than
spreading edits.

**The real collision risk is not rebase churn — it is upstream.** `script/dom/svg/`
saw 50 commits in 12 months because Servo contributors are building the SVG DOM
right now (#46558, #45405, #45979). Before writing any Phase 0 code, check what
has landed since the pinned rev and what is open. Duplicating in-flight upstream
work is the most likely way to waste this effort.

## Setup

```bash
git clone https://github.com/servo/servo && cd servo
./mach bootstrap
./mach build --release          # first build is long
./mach run --release -- --enable-experimental-web-platform-features <url>
./mach test-wpt tests/wpt/tests/svg/      # the oracle
```

**Corrected (see correction 6):** develop against the pinned rev with the fork's
existing patch series applied, and rebase onto `main` when submitting. The
deliverable is patch files, so the rebase is deferred at no cost, and this stack
has a warm build tree that a `main` checkout would not. Checking `main` for
collisions before each phase remains a precondition — that is a different
activity from developing on it.

In this repo the stack is already checked out and wired up: servo at
`.claude/worktrees/servo` (a symlink to `servo-stack/servo`) on branch
`tauri-runtime-patches`, consumed by `tauri-shell/` through the `[patch]`
sections in its `Cargo.toml`. The patch series lives in
`.claude/worktrees/tauri/tauri-runtime-servo/servo-patches/`.

## Facts already established — do not re-derive

- SVG today: `SVGSVGElement` serializes its subtree to a `data:` URL,
  `components/net/image_cache.rs` rasterizes it with **resvg**, and
  `components/layout/replaced.rs` treats the result as a replaced element.
- Nothing inside an `<svg>` is a layout participant, which is why CSS animations
  on SVG never run: computed `animation-name` is correct, but
  `Animations::mark_animating_nodes_as_dirty` has nothing registered to dirty.
- `layout_grid_enabled` and 20 other prefs are off by default; `EXPERIMENTAL_PREFS`
  in `ports/servoshell/prefs.rs` is the canonical list. **A pref-gated feature is
  indistinguishable from an unimplemented one from inside the page** — check the
  pref before concluding anything is missing.
- `getComputedStyle(el, '::before')` returns _computed_, not _used_, values.
  Do not use it to reason about layout.

## Phases

Each phase is a separate PR. Do not start the next until the previous one's exit
criterion is met.

**Numbered as in `servo-svg-layout.md`, but do them 1 → 2 → 3 → 4 → 5 → 0.**
Phase 0 is the highest-collision, lowest-architectural-risk work and no other
phase depends on it (see correction 1). It is also the most parallelisable, so
it is the right thing to hand to a second contributor rather than to block on.

### Phase 1 — SVG formatting context (~1 500–2 500 LOC, seam ≤ 20 lines) — **started**

New `components/layout/svg/`. An inline `<svg>` gains a real SVG viewport
(`viewBox` transform, `preserveAspectRatio`) whose subtree keeps its computed
styles instead of being serialized away.

It **stays** `ReplacedContentKind::SVGElement` (correction 2): SVG's sizing spec
treats `<svg>` as a replaced element, `svg_kind_size` already does the outer
sizing correctly, and keeping the dispatch to one branch inside it is what keeps
the seam under budget and the pref meaningful. **`<foreignObject>` is out of
scope.**

Keep the old rasterization path alive behind `layout_svg_native_enabled`
(default off) so this is landable while incomplete. That pref is the single most
important design decision in the whole plan: it is what makes incremental
landing possible.

_Exit (corrected — see correction 3):_ the viewport transform is correct across
the meet/slice × alignment matrix under `scripts/servo-svg-unit-tests.sh`, and
the pref selects the code path. Rendering a `<rect>` is Phase 3's exit, not
this one's.

_Status:_ patch `0009-layout-add-an-svg-viewport-behind-a-native-svg-pref.patch`
in the fork series. Viewport parsing and transform done, 9 unit tests passing,
21 seam lines spent. Still to do in this phase: hand the viewport to box-tree
construction so Phase 2 has something to traverse into.

### Phase 2 — geometry traversal (~2 500–4 000 LOC, all new files)

Per-element geometry from properties/attributes; transform composition; object
and stroke bounding boxes; `<use>` shadow instancing; group opacity/clip/mask;
gradient paint servers (reuse `display_list/gradient.rs`).

_Exit:_ shapes, groups, transforms and gradients render correctly; `svg/shapes/`
and `svg/coordinate-systems/` WPT improve.

### Phase 3 — painting via vello (~1 500–3 000 LOC)

**Follow `components/canvas` exactly.** Build `kurbo` paths, paint with
`vello_cpu`, deliver a snapshot behind a WebRender `ImageKey`. Map paint servers
to vello brushes; implement stroke width/dash/join/cap; apply clip and mask;
handle group isolation and opacity.

**Do not** write a rasterizer. **Do not** add `lyon`. **Do not** attempt
WebRender path primitives — they do not exist.

_Exit:_ with the pref on, a `<rect>` renders at the right position and size
(inherited from Phase 1, see correction 3); `svg/painting/` WPT improves;
strokes and dashes are visually correct.

### Phase 4 — animation (~150–400 LOC, mostly deletions)

Remove the serialize-and-rasterize special case for the native path and confirm
`NodeDamage::Style` propagates from an SVG descendant to its viewport box. The
existing `Animations` machinery should then work unchanged.

_Exit — this is the end-to-end proof:_ a page with
`<path style="animation: spin 1s linear infinite">` must produce **changing
pixels across consecutive frames**. Verify by screenshotting twice ~500 ms apart
and diffing; a static screenshot cannot distinguish a stopped animation from a
still frame. Report the pixel-difference count.

### Phase 5 — hit testing (~300–600 LOC)

Per-shape `pointer-events`, `fill` vs `stroke` regions. `display_list/hit_test.rs`
already imports `kurbo::Shape`.

### Phase 0 — DOM and geometry interfaces (~2 500–4 000 LOC + ~600 WebIDL) — *do last, or in parallel*

Finish the SVG DOM: `SVGLength`, `SVGAnimatedLength`, `SVGRect`, `SVGPoint`,
`SVGPathSegList`, and the missing elements (`<text>`, `<tspan>`, `<marker>`,
`<clipPath>`, `<mask>`, `<pattern>`). Back `SVGMatrix`/`SVGTransform` with the
existing `DOMMatrix` — do not add a parallel matrix type.

_Exit:_ `./mach test-wpt tests/wpt/tests/svg/types/` improves; `getBBox()` and
`getCTM()` return real values. Report expectation files deleted.

### Explicitly out of scope

SVG text (`<text>`, `textPath`), filters, `<foreignObject>`, SMIL. Each is a
separate project. Do not start them.

## The interim, if the full plan is not attempted

A much smaller change that only un-freezes animated SVG: register animations for
elements inside an SVG subtree and dirty the **SVG root** each tick, so the
existing rasterization path re-emits frames. ~150–400 LOC in
`components/script/animations.rs` (cold file) and
`components/script/dom/svg/svgsvgelement.rs`. Costs a full re-serialize and
re-rasterize per frame. Propose it as a stopgap, labelled as one.

## Rules

1. **WPT is the only evidence of *conformance*, and it is a phase gate, not an
   inner loop.** "It renders correctly on my test page" is not a result. Report
   expectation files deleted per phase. Per commit, use the two cheap tiers in
   "The validation loop" — and never report those as conformance (correction 5).
2. **Respect the seam budget.** ≤ ~50 *added* lines in pre-existing
   layout/script files across the whole project, with the exclusions above.
   Report the count in every phase report.
3. **One PR per phase**, behind `layout_svg_native_enabled` until Phase 4 lands.
4. **Never conclude a feature is missing without checking its pref.**
5. **Verify rendering by pixel diff, not by trace or by a single screenshot.**
6. **Stop and report** if: a phase needs more than its seam budget; upstream has
   landed overlapping work; a WPT count moves backwards; or the vello path cannot
   express something (that is an architectural finding, not a bug to route
   around).
7. **Do not report success without numbers.** Every phase report must contain
   before/after WPT expectation counts and, for Phase 4, a pixel-diff count.
