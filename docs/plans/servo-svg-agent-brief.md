# Brief: prototype native SVG layout in Servo

A task brief for a coding agent (or a new contributor) to build a working
prototype of the phases costed in [`servo-svg-layout.md`](./servo-svg-layout.md).
Read that document first; this one assumes its conclusions and does not repeat
the evidence.

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

> **Seam budget: no more than ~50 changed lines total across all pre-existing
> files in `components/layout/` and `components/script/` (excluding
> `components/script/dom/svg/` and any new modules). Everything else goes in new
> files.**

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

Work against `main`, not a pinned rev — this is upstream-directed work.

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

### Phase 0 — DOM and geometry interfaces (~2 500–4 000 LOC + ~600 WebIDL)

Finish the SVG DOM: `SVGLength`, `SVGAnimatedLength`, `SVGRect`, `SVGPoint`,
`SVGPathSegList`, and the missing elements (`<text>`, `<tspan>`, `<marker>`,
`<clipPath>`, `<mask>`, `<pattern>`). Back `SVGMatrix`/`SVGTransform` with the
existing `DOMMatrix` — do not add a parallel matrix type.

_Exit:_ `./mach test-wpt tests/wpt/tests/svg/types/` improves; `getBBox()` and
`getCTM()` return real values. Report expectation files deleted.

### Phase 1 — SVG formatting context (~1 500–2 500 LOC, seam ≤ 20 lines)

New `components/layout/svg/`. Inline `<svg>` stops being
`ReplacedContentKind::SVGElement` and becomes a box establishing an SVG viewport
(`viewBox` transform, `preserveAspectRatio`). Outer sizing already works — reuse
`svg_kind_size`. **`<foreignObject>` is out of scope.**

Keep the old rasterization path alive behind a pref (`layout_svg_native_enabled`,
default off) so this is landable while incomplete. That pref is the single most
important design decision in the whole plan: it is what makes incremental landing
possible.

_Exit:_ with the pref on, a `<rect>` renders at the right position and size.

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

_Exit:_ `svg/painting/` WPT improves; strokes and dashes are visually correct.

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

1. **WPT is the only evidence of progress.** "It renders correctly on my test
   page" is not a result. Report expectation files deleted per phase.
2. **Respect the seam budget.** ≤ ~50 changed lines in pre-existing layout/script
   files across the whole project.
3. **One PR per phase**, behind `layout_svg_native_enabled` until Phase 4 lands.
4. **Never conclude a feature is missing without checking its pref.**
5. **Verify rendering by pixel diff, not by trace or by a single screenshot.**
6. **Stop and report** if: a phase needs more than its seam budget; upstream has
   landed overlapping work; a WPT count moves backwards; or the vello path cannot
   express something (that is an architectural finding, not a bug to route
   around).
7. **Do not report success without numbers.** Every phase report must contain
   before/after WPT expectation counts and, for Phase 4, a pixel-diff count.
