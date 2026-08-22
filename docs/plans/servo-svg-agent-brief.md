# Brief: prototype native SVG layout in Servo

A task brief for a coding agent (or a new contributor) to build a working
prototype of the phases costed in [`servo-svg-layout.md`](./servo-svg-layout.md).
Read that document first; this one assumes its conclusions and does not repeat
the evidence.

## Status

All six phases are done, plus features the plan did not list that turned out to
matter more than parts of it that it did.

| Phase                  | State       | Patches            |
| ---------------------- | ----------- | ------------------ |
| 1 — viewport           | done        | 0009               |
| 2 — geometry traversal | done        | 0010, 0015, 0017   |
| 3 — painting           | done        | 0010, 0012, 0013   |
| 4 — animation          | done        | 0013               |
| 5 — hit testing        | done        | 0011 + stylo-0002  |
| 0 — DOM interfaces     | partial     | 0016               |

Shipped beyond the phase list, each because something real was broken by its
absence: `pathLength` (0015), `transform-origin` and a `viewBox` intrinsic-ratio
fix (0014), `getBBox`/`getTotalLength` (0016), gradients and `clip-path` (0017).
Three stylo patches ungate SVG properties that Servo could not otherwise see at
all: `pointer-events` keywords, `stop-color` and `stop-opacity`.

### Measured

All pref-off versus pref-on on the same build, since that isolates this work.

| What | Result |
| ---- | ------ |
| Shapes, groups, transforms, stylesheet fill | **0.024%** of pixels differ from the rasterization path |
| Gradients — 6 variants | **0.024%** |
| Clipping — 5 cases | **0.020%** |
| Animation: 4s spinner at +1.1s/+2.1s/+3.1s | pref off **0 and 0** px change; pref on **2016 and 2201** |
| `svg/` WPT | **+199 subtests, 0 regressions** over 1261 tests |
| Unit tests | 50, running in ~1s without a Servo build |

The pixel differences are entirely edge antialiasing, where vello and resvg
disagree. Two cases where the native path is now *more* correct than the
rasterization path: `transform-origin` (which the raster path drops, rendering
some pages blank) and fractional `viewBox` ratios.

### Still not done

- **SVG text.** The largest remaining piece, and the only thing blocking
  Mermaid — which needs `getComputedTextLength` and `getBBox` on `<text>`, both
  of which are text measurement. Phase 2b, estimated 2 000–3 500 LOC, and
  explicitly deferred by the plan. Note `getBBox` on a `<text>` now returns an
  empty rect rather than throwing, so Mermaid will lay out silently wrong
  instead of failing loudly.
- **`<use>`.** Servo's `SVGUseElement` is a bare DOM stub with no shadow
  instancing. Rendering it needs an id lookup, which `0017` now has half of —
  the paint-server scan is exactly the mechanism `<use>` would reuse.
- Patterns, masks, markers. Unused by this app.
- Nested `<svg>` viewports, treated as plain groups.
- `clip-rule` is gecko-gated in stylo, so clips always use the non-zero rule.
- `getBBox`'s options argument (stroke/markers/clipped) is parsed and ignored.
  With the pref off, only direct children of the `<svg>` resolve.
- The rest of Phase 0: `getCTM`, `getScreenCTM`, `getPointAtLength`,
  `isPointInFill`/`isPointInStroke`, `SVGLength`/`SVGRect`/`SVGPoint`/
  `SVGPathSegList`.

### Things the plan got wrong, found by building it

Beyond the six corrections below:

1. **`svg > * { display: none }` in `servo.css` prunes the style traversal**, so
   nothing below a *direct child* of the `<svg>` is ever styled. A `<g>`'s
   children simply did not exist. Now in its own stylesheet, applied only when
   the pref is off.
2. **Phase 4 was not "mostly deletions".** Damage propagation already worked;
   `Animations::do_post_reflow_update` cancels animations on any node that is
   not "being rendered", which a boxless node reports.
3. **Presentation attributes Servo does not map are a recurring trap.**
   `transform`, `clip-path` and `stop-color` each silently did nothing until
   mapped or parsed by hand. Whenever an SVG attribute appears not to work,
   check `SVGElement::synthesize_presentational_hints` before anything else.
4. **Gecko-gated properties are the other recurring trap.** `pointer-events`
   keywords, `stop-color`, `stop-opacity` and `clip-rule` all exist in stylo and
   are all invisible to Servo. Grep for `engine = "gecko"` in
   `longhands.toml` before concluding a property is unimplemented.
5. **An unresolvable `clip-path` reference means *ignore the property*, not
   *hide the element*.** SVG 1.1 said the opposite. Getting it backwards
   silently hides content.
6. **Headless tests are not sufficient.** `transform-origin` was broken while
   every headless test passed, because none rotated about a non-zero origin.
   One headed run found it in a frame. Run headed at least once per phase.

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

5. **WPT is the phase gate, not the per-commit oracle.** Rule 1 said WPT is
   the only evidence of progress; it is the only evidence of *conformance*.
   ~~It cannot be run in this stack.~~ **It can** — that first conclusion was
   wrong, and cost a phase's worth of confidence. `./mach build` fails only for
   two removable reasons (a pinned `mozjs_sys` that fails linker detection on
   this SDK, and a GStreamer dependency servoshell does not need); both are one
   flag or one `cargo update` away, and the suite then runs in 4.5 minutes. The
   loop below now has four tiers, not three. `cargo test -p servo-layout` still
   does not work — from `tauri-shell/` servo-layout is a path dependency, not a
   workspace member — which is why the unit-test harness exists.

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

Four tiers, fastest first.

```bash
# 1. Compile (~1 s warm), from tauri-shell/.
cargo build --release -p servo-layout

# 2. Unit tests for the pure geometry (~1 s).
scripts/servo-svg-unit-tests.sh
```

`scripts/servo-svg-unit-tests.sh` copies the pure SVG modules verbatim into a
throwaway crate depending only on `euclid`, `kurbo` and `vello_cpu`, stubs the
one `pref!` lookup, and runs `cargo test`. No source is duplicated — files are
re-copied every run — so a test cannot drift from the code. It deliberately
*cannot* compile `image.rs`, `integration.rs`, `resolve.rs` or `tree.rs`, the
four modules that touch stylo, the DOM and the fragment tree. That is the
constraint the module is organised around: if that exclusion list has to grow,
logic has leaked into the bridge.

**3. A real browser (~2 min rebuild, seconds to run).** This stack *can* build
servoshell standalone, which the first pass wrongly concluded it could not.
Three things were in the way:

```bash
cargo update -p mozjs           # 0.21.0 -> 0.21.6; the pinned mozjs_sys
                                # 140.13 fails linker detection on this SDK,
                                # 140.14 (what tauri-shell already builds) does not
./mach build --release --media-stack dummy   # avoids a GStreamer dependency
                                             # servoshell does not need here
```

plus a `[patch."https://github.com/servo/stylo"]` block in servo's own
`Cargo.toml` redirecting all eleven stylo crates at `../stylo`, mirroring what
`tauri-shell/Cargo.toml` does, so the build picks up stylo-0001 and stylo-0002.
**All three are local-only and must not be committed to the patch series.**

```bash
./target/release/servoshell -z -x -o out.png --pref layout_svg_native_enabled URL
./target/release/servoshell --pref layout_svg_native_enabled URL      # headed
COPSE_SERVO_ANIM_DEBUG=1 ./target/release/servoshell -z URL           # animation tracing
```

Screenshot with the pref off and on and diff the PNGs; that is how the
rendering numbers above were produced. For animation, delay the `load` event
with a busy-wait so the screenshot lands at a chosen wall-clock time, and
sample the same page at several offsets — a single screenshot cannot tell a
stopped animation from a still frame, and two runs of a *stopped* animation can
differ by chance, so use three points and require change at each.

**And run it headed at least once per phase.** The `transform-origin` bug
survived every headless test and was obvious in one frame of a real window.

**4. WPT, per phase (~4.5 min).**

```bash
./mach test-wpt --release --headless --processes 6 \
  --pref layout_svg_native_enabled --log-raw out.jsonl tests/wpt/tests/svg/
```

Compare pref-off against pref-on **on the same build**, not against the
checked-in expectations: the fork's patches 0003/0005/0006 already diverge from
those, so 47 results are "unexpected" before this work starts. The suite's
reftests are also not stable run to run, so treat a single test flipping as
noise and the net plus the regression count as the signal.

**And know how much of the suite can see this work at all — it is less than the
plan assumed.** Native SVG only handles *inline* `<svg>` inside HTML, and
**519 of the 1 261 executed tests (41%) are standalone `.svg` documents**, which
take a completely different path. Measured, not inferred: a `pservers` gradient
test renders **identically** with the pref on and off as a standalone document
(0 pixels differ), and differs by **80 000 pixels** when the same markup is
inlined into HTML. Nearly all the gradient tests are in the blind 41%.

Two consequences worth carrying:

- **A small WPT delta is not evidence of a small change.** Gradients and
  `clip-path` moved the count by almost nothing while fixing a visible
  regression across 39 and 19 of the app's own files. The pixel diff against the
  rasterization path is the honest oracle for painting; WPT is the oracle for
  conformance detail and for catching regressions.
- **Some reftests pass vacuously.** Four of the 17 passing `pservers` tests
  passed because the *reference* also used `fill:url(#…)`, so "both render
  nothing" scored as a match. Implementing the feature can therefore turn a
  vacuous pass into a real failure, which looks like a regression and is
  progress. Two tests did exactly that here, and fixing them properly is what
  produced gradient `href` inheritance and percent-decoded fragments.

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

**The budget was exceeded, and the estimate was the thing that was wrong.**

Final spend across everything: see the table below, against roughly 3 900 lines
of new code under `components/layout/svg/`.

**243 added lines** across pre-existing files, of which **83** fall inside the
budget's stated scope (it excludes `components/script/dom/svg/`, the two prefs
files and new modules).

| Where                       | Added | Why                                                       |
| --------------------------- | ----: | --------------------------------------------------------- |
| `layout/layout_impl.rs`     |    48 | UA-stylesheet gating, the registry, the upload drain, two queries |
| `shared/layout/lib.rs`      |    42 | the `viewBox` ratio fix, `preserveAspectRatio`, one query   |
| `script/dom/svg/*`          |    93 | presentation attributes, `getBBox`, `getTotalLength` — outside the budget's scope |
| `layout/replaced.rs`        |    21 | the sizing seam and the native dispatch                     |
| `layout/context.rs`         |     9 | two `ImageResolver` fields                                  |
| `script_bindings/*`         |    13 | two WebIDL declarations and a codegen entry                 |
| everything else             |    17 | pref plumbing, module decls, one dependency                 |

Rule 6 says report an overrun rather than absorb it, so: it is over, and by
enough that the ~50 figure should be treated as retired rather than missed. It
was set before anyone had built the thing, and most of the spend went on two
discoveries the plan did not contain — gating the `svg > *` UA rule, and
teaching `node_rendering_type` about boxless SVG descendants.

What the budget *did* achieve is visible in the ratio: ~3 900 lines of new code
behind a seam measured in tens. Three times during the work the seam drifted and
the fix was the same each time — move the logic, and the comment explaining it,
into `svg/` rather than trim the comment. Keep doing that.

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

### Phase 1 — SVG formatting context (~1 500–2 500 LOC, seam ≤ 20 lines) — **done**

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

_Status: **done**._ Patch 0009. `viewBox`/`preserveAspectRatio` parsing and
the viewport transform, 15 unit tests, 21 seam lines. The transform is applied
at paint time rather than baked into the tree, because it depends on the used
content-box size — which also means a resize repaints without rebuilding.

### Phase 2 — geometry traversal (~2 500–4 000 LOC, all new files) — **done**

Per-element geometry from properties/attributes; transform composition; object
and stroke bounding boxes; `<use>` shadow instancing; group opacity/clip/mask;
gradient paint servers (reuse `display_list/gradient.rs`).

_Exit:_ shapes, groups, transforms and gradients render correctly; `svg/shapes/`
and `svg/coordinate-systems/` WPT improve.

_Status: **done except `<use>` and paint servers**._ Patch 0010. Shapes,
groups, transforms, opacity and visibility, 22 unit tests. Most geometry came
free: Servo already maps the SVG geometry attributes onto CSS longhands, so
this reads computed style rather than attributes, and inheritance and
selector-driven styling work with nothing SVG-specific. `<use>` is skipped
because Servo's `SVGUseElement` is a bare DOM stub with no shadow instancing —
rendering it needs an id lookup layout does not have. Gradients are skipped
because an unresolved paint server resolving to black would look deliberate.

### Phase 3 — painting via vello (~1 500–3 000 LOC) — **done**

**Follow `components/canvas` exactly.** Build `kurbo` paths, paint with
`vello_cpu`, deliver a snapshot behind a WebRender `ImageKey`. Map paint servers
to vello brushes; implement stroke width/dash/join/cap; apply clip and mask;
handle group isolation and opacity.

**Do not** write a rasterizer. **Do not** add `lyon`. **Do not** attempt
WebRender path primitives — they do not exist.

_Status: **done**._ Patch 0010 paints with `vello_cpu` (9 pixel tests,
including that group opacity composites as a unit); 0012 is the `ImageKey`
registry; 0013 connects it. Delivery is split because `CrossProcessPaintApi`
is `!Sync` and `LayoutContext` must be `Sync`: keys come from
`ImageCache::get_image_key`, which is reachable from parallel layout, and the
upload is queued and drained on the layout thread before the display list is
sent — the same shape as `pending_rasterization_images`.

_Exit:_ with the pref on, a `<rect>` renders at the right position and size
(inherited from Phase 1, see correction 3); `svg/painting/` WPT improves;
strokes and dashes are visually correct.

### Phase 4 — animation (~150–400 LOC, *not* mostly deletions) — **done**

Remove the serialize-and-rasterize special case for the native path and confirm
`NodeDamage::Style` propagates from an SVG descendant to its viewport box. The
existing `Animations` machinery should then work unchanged.

_Status: **done**, and it was not deletions._ See "Things the plan got wrong"
above: `Animations::do_post_reflow_update` cancels animations on any node that
is not "being rendered", which a boxless SVG descendant reports. Fixed in
`node_rendering_type`, patch 0013.

_Exit — this is the end-to-end proof:_ a page with
`<path style="animation: spin 1s linear infinite">` must produce **changing
pixels across consecutive frames**. Verify by screenshotting twice ~500 ms apart
and diffing; a static screenshot cannot distinguish a stopped animation from a
still frame. Report the pixel-difference count.

### Phase 5 — hit testing (~300–600 LOC) — **done**

Per-shape `pointer-events`, `fill` vs `stroke` regions. `display_list/hit_test.rs`
already imports `kurbo::Shape`.

### Phase 0 — DOM and geometry interfaces (~2 500–4 000 LOC + ~600 WebIDL) — **partial**

Finish the SVG DOM: `SVGLength`, `SVGAnimatedLength`, `SVGRect`, `SVGPoint`,
`SVGPathSegList`, and the missing elements (`<text>`, `<tspan>`, `<marker>`,
`<clipPath>`, `<mask>`, `<pattern>`). Back `SVGMatrix`/`SVGTransform` with the
existing `DOMMatrix` — do not add a parallel matrix type.

_Exit:_ `./mach test-wpt tests/wpt/tests/svg/types/` improves; `getBBox()` and
`getCTM()` return real values. Report expectation files deleted.

_Status: **partial**._ `getBBox` and `getTotalLength` land in 0016 (+188
subtests on their own). They were cheap because layout already resolves SVG
geometry into `kurbo` paths — a bounding box and a perimeter are one call each.

The plan treated this phase as one thing; it is three, and they have different
urgencies:

1. **Scripted geometry APIs** — `getBBox`, `getCTM`, `SVGLength`, `SVGRect`.
   Not needed to paint. Needed by content that *scripts* SVG, which is why
   Mermaid fails identically with the pref on and off — the signature of a
   missing DOM API rather than a painting gap.
2. **Rendering-affecting attributes** — `pathLength`, `preserveAspectRatio`.
   Not scripting APIs at all, and required for correct painting. These belong
   in the geometry phase, and `pathLength` slipping through was a hole in that
   phase, not in this one. It cost a real bug: an indicator that looked fully
   drawn and frozen while its computed `stroke-dashoffset` advanced correctly.
3. **Element types** — `<marker>`, `<clipPath>`, `<mask>`, `<pattern>`. Needed
   by both. `<clipPath>` landed in 0017.

So this phase is deprioritisable for a rendering prototype and blocking for
JS-driven SVG.

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
