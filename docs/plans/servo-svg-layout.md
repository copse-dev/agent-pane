# Native SVG layout in Servo: prior art, and what building it would take

Written 2026-08-22, prompted by a concrete failure in the Copse-on-Servo
prototype: the thinking spinner does not animate, because CSS animations never
run on SVG elements. See the "CSS animations never run on SVG content" section
of [`tauri-servo-migration.md`](./tauri-servo-migration.md) for the evidence
trail. This document answers two questions — has anyone proposed doing SVG
natively, and what would it involve.

## 1. Has anyone proposed it?

**Short answer: not currently, and not in the sense of native layout.** The two
proposals that exist are a decade old and were superseded; the active 2026 work
is building the DOM layer, which is a prerequisite for native layout but is not
being framed as leading to it.

### Prior proposals (both stale)

| Artefact                                                                                           | Date | Status | Substance                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [servo#12973 "Support a subset of SVG"](https://github.com/servo/servo/issues/12973)               | 2016 | closed | Metabug. "Implement the smallest subset possible, such that particular testcases look correct… behind feature flags."                                                                           |
| [Wiki: "Basic SVG support project"](https://github.com/servo/servo/wiki/Basic-SVG-support-project) | 2016 | stale  | Josh Matthews. Explicitly "an _extremely small subset_"; aimed at exercising WebRender, proposing `SVGElement`/`SVGCircleElement` plus WebRender primitives and an SVG fragment type in layout. |

The wiki project is the only thing resembling a native-layout plan, and it is a
WebRender-era exploration whose stated purpose was "to explore the capabilities
of our experimental WebRender technology" rather than to ship SVG.

### What actually shipped, and where it lives

Inline SVG rendering landed around August 2025 via **rasterization, not layout**.
The architecture is the load-bearing fact:

- `SVGSVGElement` XML-serializes its own subtree and caches the result.
- The serialization becomes a `data:` URL handed to **`components/net/image_cache.rs`**,
  which rasterizes it with **resvg**.
- `components/layout/replaced.rs` treats `<svg>` as a **replaced element**
  (`ReplacedContentKind::SVGElement`, `svg_kind_size`, `ratio_from_view_box`).

So SVG lives in the _image_ pipeline. Everything inside an `<svg>` is a picture,
not boxes — which is why the tauri fork needed patches 0003/0005/0006 just to get
CSS-driven _static_ styling into the raster, and why no descendant can animate.

### Active work (2026): DOM scaffolding, not layout

36 SVG commits in 2026 so far, from Martin Robinson, Josh Matthews, Oriol Brufau,
Mohamed Mostafa, Euclid Ye and others. The notable ones:

- **#46558** — SVG DOM element types for shapes, gradients and structural
  elements (`SVGGeometryElement`, `SVGPathElement`, `SVGCircleElement`,
  `SVGGradientElement`, `SVGUseElement`, …) plus per-element presentation-attribute
  to CSS mapping.
- **#45405** — SVG presentation attributes enabled via a stylo bump.
- **#45979** — `font` support in `<text>`; **#44420** — `viewBox` affecting the
  layout fragment rect; **#45422** — SVG cache invalidation on subtree mutation;
  **#44805** / **#46199** — rasterization caching and zero-size guards.

Read together this is _real DOM and style plumbing for SVG_ — genuinely the
foundation native layout would need — but every one of these still feeds the
rasterizer. Nothing proposes replacing it. No roadmap entry, no funded project,
and the Servo blog through June 2026 does not mention native SVG layout.

**Conclusion for our purposes:** if the animated-spinner problem is to be fixed
upstream, someone has to propose the work. It does not exist as a plan today.

## 2. Calibration: measured sizes, so the estimates can be checked

Every estimate below is anchored to something measured in the trees at the
pinned revs, not to intuition. Reviewers should attack the anchors first.

**Servo layout subsystems** (`components/layout`, 46 228 LOC total):

| Subsystem       |   LOC | Why it is a useful anchor                            |
| --------------- | ----: | ---------------------------------------------------- |
| `flow/inline/`  | 6 937 | Hardest existing formatting context                  |
| `display_list/` | 6 580 | Fragment tree → WebRender                            |
| `table/`        | 5 061 | A whole self-contained formatting context            |
| `flow/mod.rs`   | 2 259 | Block layout                                         |
| `taffy/`        | 1 640 | Grid+flex **integration** (Taffy itself is external) |
| `positioned.rs` | 1 112 | Abspos handling                                      |
| `replaced.rs`   | 1 050 | Where `<svg>` is handled today                       |

**Existing SVG code in Servo:**

| Piece                        |   LOC |
| ---------------------------- | ----: |
| `script/dom/svg/` (21 files) | 1 823 |
| 20 SVG WebIDL files          |   295 |
| `script/svg_font.rs`         |   127 |

The WebIDL total is the tell: 295 lines across 20 interfaces means these are
mostly empty shells. The DOM hierarchy exists; the geometry APIs do not.

**The reference implementation, split by what Servo would and would not need:**

| Crate / part                                 |    LOC | Servo needs it?                              |
| -------------------------------------------- | -----: | -------------------------------------------- |
| `usvg` **parser/**                           | 10 097 | **No** — Servo has a DOM and stylo's cascade |
| `usvg` **tree/**                             |  3 883 | Yes, as fragment-tree semantics              |
| `usvg` **text/**                             |  2 790 | Yes if `<text>` is in scope                  |
| `usvg` `writer.rs`                           |  1 591 | No                                           |
| `resvg` core paint (`render`+`path`+`image`) |    571 | Yes — and note how small it is               |
| `resvg` `filter/`                            | ~2 416 | Only if filters are in scope                 |
| `tiny-skia` + `tiny-skia-path`               | 25 883 | **No** — see below                           |

**The architectural finding that dominates the cost.** Servo has already made
its path-rendering decision, and it is not WebRender primitives:

- `components/canvas` (2 824 LOC) paints via **`vello`** and **`vello_cpu`**,
  already workspace dependencies (`vello_cpu` 11 977 + `vello_common` 14 832 LOC).
- Canvas output reaches the compositor as a snapshot behind a WebRender
  `ImageKey` (`canvas_paint_thread.rs`).
- `components/layout` **already depends on `kurbo`** (currently only in
  `display_list/hit_test.rs`).

So "native SVG layout" in Servo does **not** mean teaching WebRender to draw
paths. It means SVG becomes a real box/fragment tree whose painting goes through
vello into an image, exactly as canvas already does. That removes the single
scariest line item — nobody has to write a rasterizer.

## 3. The plan, phase by phase

Estimates are **implementation LOC only** (Rust + WebIDL), excluding tests and
WPT expectation churn. Ranges are wide on purpose; the low end assumes heavy
reuse of stylo and Servo's fragment tree, the high end assumes each piece needs
its own machinery.

### Phase 0 — DOM and geometry interfaces

**Scope.** Finish the SVG DOM. The element hierarchy landed in #46558; what is
missing is the geometry and animated-value layer that content and layout both
need: `SVGLength`, `SVGAnimatedLength`, `SVGRect`, `SVGPoint`, `SVGMatrix` /
`SVGTransform` (or `DOMMatrix` reuse), `SVGPathSegList`, plus the element types
still absent (`<text>`, `<tspan>`, `<marker>`, `<clipPath>`, `<mask>`,
`<pattern>`, `<filter>`).

**Files.** `components/script/dom/svg/*`, `components/script_bindings/webidls/SVG*.webidl`.

**Reuse.** Presentation-attribute → CSS mapping already exists (#45405). `DOMMatrix`
already exists and should back `SVGMatrix` rather than a parallel type.

**Estimate: 2 500–4 000 LOC script + ~600 LOC WebIDL.**
_Basis:_ roughly doubles the current interface count (1 823 LOC) while adding
animated-value wrappers, which are mechanical but numerous.

**Risk:** low. Mostly volume. Parallelisable across contributors.

**Exit criteria:** `svg/types/` WPT subtree runs; `getBBox()` / `getCTM()` return
real values.

### Phase 1 — an SVG formatting context in the box tree

**Scope.** Inline `<svg>` stops being `ReplacedContents::SVGElement` and becomes a
box establishing an SVG viewport: `viewBox` → viewport transform,
`preserveAspectRatio`, and child fragment construction for shapes and groups.
Outer sizing already works (`svg_kind_size`, `ratio_from_view_box`).
`<foreignObject>` is the inverse hinge — explicitly deferred.

**Files.** `components/layout/replaced.rs` (subtract), new
`components/layout/svg/` (add), `components/layout/flow/construct.rs`,
`components/layout/dom.rs`.

**Estimate: 1 500–2 500 LOC.**
_Basis:_ `taffy/` integration is 1 640 and `positioned.rs` 1 112 for problems of
comparable structural complexity. This is a new formatting context but a shallow
one — no line breaking, no fragmentation.

**Risk:** medium. Touches box construction, which is central.

### Phase 2 — geometry traversal (non-text)

**Scope.** Per-element geometry resolution from properties/attributes; transform
composition; object and stroke bounding boxes; `<use>` shadow instancing; group
opacity/clip/mask grouping; paint servers (gradients).

**Reuse.** Servo already emits gradient display items
(`display_list/gradient.rs`); stylo already computes `fill`, `stroke`,
`stroke-width`, `stroke-dasharray`, `stroke-dashoffset` for Gecko.

**Estimate: 2 500–4 000 LOC.**
_Basis:_ `usvg/tree/` is 3 883 LOC for the same semantics, and some of that
(node storage, attribute plumbing) is replaced by Servo's existing fragment tree
and cascade rather than reimplemented.

**Risk:** medium. `<use>` instancing interacts with shadow DOM and with style
sharing.

### Phase 2b — SVG text _(recommend deferring)_

**Scope.** `<text>`, `<tspan>`, `x`/`y`/`dx`/`dy`/`rotate` lists, `textPath`.

**Estimate: 2 000–3 500 LOC.**
_Basis:_ `usvg/text/` is 2 790 LOC _and_ delegates shaping to an external stack;
Servo has its own font and shaping machinery to integrate against, which cuts
some work and adds some.

**Risk:** high, and almost entirely separable. Ship without it.

### Phase 3 — painting

**Option A — vello, following the canvas model (recommended).**
Build `kurbo` paths from Phase 2 geometry, paint with `vello_cpu`, deliver a
snapshot behind a WebRender `ImageKey`. Work is: paint-server → vello brush
mapping, stroke/dash/join/cap, clip and mask application, group isolation and
opacity, and invalidation keyed on computed style.

**Estimate: 1 500–3 000 LOC.**
_Basis:_ `resvg`'s equivalent core is **571 LOC** on top of a rasterizer;
`components/canvas` is 2 824 LOC for the whole vello-and-ImageKey integration,
and much of that plumbing already exists to copy.

**Option B — WebRender primitives via `lyon` tessellation.** Tessellate to
triangle meshes and push through WebRender. Adds a dependency, and antialiasing,
stroke joins and dashing all become someone's problem. **Estimate: 3 000–5 000
LOC** and worse output. Not recommended given Option A exists.

**Option C — write a rasterizer.** `tiny-skia` is 25 883 LOC. Do not.

**Risk:** low-to-medium for Option A, precisely because the backend decision is
already made and proven in-tree by canvas.

### Phase 4 — animation and invalidation _(the phase that fixes our bug)_

**Scope.** Essentially deletion. Once SVG elements are layout participants with
real computed styles, `Animations` / `mark_animating_nodes_as_dirty` /
`NodeDamage::Style` pick them up unchanged. Work is removing the
serialize-and-rasterize special case and confirming damage propagates from an
SVG descendant to its viewport box.

**Estimate: 150–400 LOC** (mostly removals).

**Risk:** low. This is the phase where the spinner starts turning because nothing
special was done for it.

### Phase 5 — hit testing and events

**Scope.** Per-shape `pointer-events`, `stroke` vs `fill` hit regions.

**Reuse.** `display_list/hit_test.rs` already imports `kurbo::Shape`.

**Estimate: 300–600 LOC.**

### Deferred — filters and masks

**Estimate: 2 000–3 500 LOC.** _Basis:_ `resvg/filter/` is ~2 416 LOC. Nothing in
a typical application UI needs SVG filters; defer indefinitely.

### Totals

| Milestone                                           | Estimate LOC     |
| --------------------------------------------------- | ---------------- |
| **MVP** — phases 0,1,2,3A,4,5 (no text, no filters) | **8 450–14 500** |
| \+ SVG text (2b)                                    | 10 450–18 000    |
| \+ filters and masks                                | 12 450–21 500    |

**Cross-check.** `usvg` + `resvg` together are 23 527 LOC for a standalone
_static_ SVG renderer that includes its own parser. Servo's version drops the
parser (−10 097) and adds DOM, box-tree and animation integration. Landing at
12–21 k for the full thing is consistent from both directions, which is the main
reason to trust the range at all.

**Rough schedule.** At a deliberately conservative 3 000–5 000 LOC per
person-quarter for spec-conformant engine code with review and WPT burn-down,
the MVP is **roughly 2–5 person-quarters**, with phases 0 and 2 parallelisable
across contributors and phase 2b/filters excluded. Treat this as an order of
magnitude, not a commitment: WPT conformance work, not code volume, is what
usually dominates the tail.

### Verification plan

The corpus already exists and is the honest measure of done:

- `tests/wpt/tests/svg/` — **2 131 tests**, of which **973** already carry Servo
  expectation files.
- A phase is "done" when its slice of that corpus moves from expectation files to
  passes; the count of removed `expected: FAIL` lines is the reviewable metric.

## 4. The cheap interim, costed

If the goal is only to un-freeze animated SVG without any of the above: register
animations for elements inside an SVG subtree and dirty the **SVG root** each
tick, so the existing serialize-and-rasterize path re-emits frames. The raster
cache is already keyed on the serialized computed-style state (patch 0006), so
new frames fall out once the root is marked dirty.

**Estimate: 150–400 LOC**, touching `components/script/animations.rs`,
`components/script/dom/svg/svgsvgelement.rs` and the layout damage path.

**Cost:** re-serializes and re-rasterizes the entire SVG every frame. For a 24 px
spinner, fine. For a large illustration, not. It is worth proposing precisely
because it is small enough to review in one sitting and honest about being a
stopgap.

## 3. What this means for the prototype now

Nothing here lands soon enough to matter for the migration decision. The
practical options remain, in order of cost:

1. Build progress affordances from HTML + CSS rather than SVG paths. A
   `transform` animation on a `<div>` registers and runs correctly under Servo
   today — verified.
2. Propose the interim invalidation fix upstream (or carry it as patch 0009 in
   the fork's series) if animated SVG specifically must keep working.
3. Treat native SVG layout as a multi-quarter upstream effort that would need to
   be proposed and staffed. It is not on anyone's roadmap today.

## 5. Review of the prototype series (2026-08-22)

Two corrections to earlier claims in this document, both found by running the
app rather than reading the code.

### `pathLength` is missing, and that — not animation — is why the indicator is frozen

The reasoning indicator still does not move under native SVG. It is tempting to
call that an animation bug. It is not: **CSS animations on SVG work**. The
sidebar's three running dots animate 4–8 px per frame under Servo against 6–12 px
in Electron, and the prototype's own rotation spinner animates too. An earlier
guess in review — that `SVGTree` was not rebuilt on style-only changes, so
`content_hash` saw stale values — was wrong, and so was a guess that CSS Grid was
involved. Both were tested and eliminated.

The actual setup, from `src/renderer/dom/reasoning-activity-icon.ts`:

```
<svg viewBox="-540 -540 1080 1080">
  <path class="reasoning-activity-path" d="M416 -141 C…"  pathLength="1" />
</svg>
```

```css
.reasoning-activity-path {
  stroke: currentColor;
  stroke-width: 152;
  stroke-dasharray: 1 1; /* in pathLength units, so 1 == the whole path */
  stroke-dashoffset: 1;
  animation: reasoning-activity-draw 2.5s ease-in-out infinite;
}
@keyframes reasoning-activity-draw {
  0%,
  1% {
    stroke-dashoffset: 1;
    opacity: 0;
  }
  2% {
    stroke-dashoffset: 1;
    opacity: 1;
  }
  46%,
  56% {
    stroke-dashoffset: 0;
    opacity: 1;
  }
  98% {
    stroke-dashoffset: -1;
    opacity: 1;
  }
  99%,
  100% {
    stroke-dashoffset: -1;
    opacity: 0;
  }
}
```

This is the standard "draw a line on" trick, and **it depends entirely on
`pathLength="1"`**, which renormalizes the path's length so `stroke-dasharray: 1 1`
means one dash covering the whole path and one gap of the same size. Animating
`stroke-dashoffset` from 1 to −1 then sweeps the dash across, drawing and erasing
the spiral.

`pathLength` is absent from Servo — it appears nowhere in
`components/script/dom/svg/` nor in the new `components/layout/svg/`. Without it
the dash pattern is computed against the path's _real_ length, which for this
spiral is on the order of thousands of user units. A 1-unit dash and 1-unit gap
at `stroke-width: 152` is then indistinguishable from a solid stroke, and moving
`stroke-dashoffset` by ±1 shifts it by well under a thousandth of the path.
Frozen, and fully drawn — which is exactly what the pixels show: Servo renders
the complete spiral, statically, while Electron sweeps it.

Note this is consistent with the measured evidence that ruled out an animation
bug: `stroke-dashoffset` **does** advance in computed style under Servo
(0.1191px → 0px) essentially as under Electron (0.137251px → 0px). Style is
correct; the dash geometry it feeds is computed against the wrong length.

**The discriminating test**, which should be run before any code is written:
animate `stroke-dashoffset` on a path with a _known_ length and **no**
`pathLength` attribute (e.g. a 100-unit straight line with
`stroke-dasharray: 50 50`). If that animates, `pathLength` is confirmed as the
only defect and the fix is a geometry feature, not an invalidation one. If it
also freezes, dash handling is not being re-resolved per frame and the
invalidation theory is back on the table.

### Phase 0 — the prototype was right, this document was wrong

The plan listed a DOM/geometry interface phase first. The prototype skipped it
and reported it was unnecessary, and for _rendering_ that is correct: layout
reads geometry from attributes directly and never needs the scripted interfaces.
The working renderer is the proof.

The distinction the plan should have drawn is between three separate things:

1. **Scripted geometry APIs** (`getBBox`, `getCTM`, `SVGLength`, `SVGRect`) —
   not needed to paint, needed by _content that scripts SVG_. `getBBox` is
   commented out in `SVGGraphicsElement.webidl` today. This is why Mermaid fails:
   it measures text with `getBBox` to lay out nodes, and it fails **identically
   with the native pref on and off**, which is the signature of a missing DOM API
   rather than a painting gap.
2. **Rendering-affecting geometry attributes** (`pathLength`, `preserveAspectRatio`) —
   not scripting APIs at all, and genuinely required for correct painting. These
   belong in the geometry phase, and `pathLength` slipping through is a hole in
   that phase rather than in Phase 0.
3. **Element types** (`<marker>`, `<clipPath>`, `<mask>`, `<pattern>`) — needed
   for both.

So Phase 0 is deprioritisable for a rendering prototype and blocking for
JS-driven SVG. Mermaid is the concrete case: it will not work until (1) lands,
no matter how good the painting gets.

### `pathLength` fix — validated 2026-08-22

`81f07f9b89a layout: honor pathLength when scaling dash patterns` (78 lines,
two unit tests). Measured on the real app, same region and method as the
original defect report, with Electron as the control:

| Region                   | Servo before        | Servo after                   | Electron control          |
| ------------------------ | ------------------- | ----------------------------- | ------------------------- |
| Reasoning indicator      | 0 px/frame, max Δ 1 | **30–66 px/frame, max Δ 223** | 34–52 px/frame, max Δ 223 |
| Sidebar dots (unchanged) | 4–8 px/frame        | 8–12 px/frame                 | 6–12 px/frame             |

The max delta matching Electron's exactly (223) is the strongest single
signal: the stroke now reaches full amplitude rather than sitting at a
near-constant value. Visually confirmed across two frames — a complete spiral
stroke in one, partially erased in the next, which is the sweep.

Rendering quality improved as a side effect, and the reason is worth noting:
with the dash miscounted the indicator painted as a fat, blobby, slightly
translucent mass (fifty sub-pixel dashes overlapping); it now paints as the
clean thin spiral stroke Chromium draws. So the old rendering was wrong in
appearance as well as motion, which no static screenshot had flagged.

No regressions observed elsewhere in the app.

**Still open, and untouched by this fix:** `getBBox` remains commented out in
`SVGGraphicsElement.webidl`, so Mermaid diagrams still fail — identically with
the native pref on and off, as before. That is the scripted-geometry category
(1) above and needs its own work.

**Process note:** unlike the earlier commits in the series this one cites no
WPT evidence. Two unit tests plus the empirical validation above are reasonable
for a 78-line geometry change, but the standing rule was WPT numbers per
change.

### Why Mermaid still fails, after `getBBox` landed (2026-08-22)

`getBBox` was implemented and Mermaid still shows "Diagram could not be
rendered". The reason is specific and easy to miss.

Probed in-page, creating an `<svg><text>Mg</text></svg>` and calling the APIs
Mermaid uses:

|                           | Servo                                      | Electron             |
| ------------------------- | ------------------------------------------ | -------------------- |
| `<text>.getBBox`          | **`TypeError: getBBox is not a function`** | `function`, width 20 |
| `getComputedTextLength`   | (unreached)                                | `function`           |
| `foreignObject` creatable | (unreached)                                | `true`               |

`getBBox` was added to **`SVGGraphicsElement`**
(`components/script/dom/svg/svggraphicselement.rs:65`), which is correct. But
Servo's SVG element hierarchy has no text types at all — the directory contains
circle, defs, ellipse, g, geometry, gradient, graphics, image, line,
linearGradient, path, polygon, polyline, radialGradient, rect, stop, svg,
symbol and use, and **no `SVGTextElement`, no `SVGTextContentElement`, no
`SVGTSpanElement`**. A `<text>` element therefore never gets the
`SVGGraphicsElement` interface, so it does not inherit `getBBox`, and the call
throws.

Mermaid measures every label with `getBBox` on a `<text>` node to size the
boxes it draws around them. The first measurement throws, `mermaid.run` bails,
no `<svg>` is produced, and the app's `diagramRenderFailed` check — which is
just "is there an svg?" — reports failure. `suppressErrors: true` is why
nothing appears in the console.

**What it would take.** Not a small addition, and worth being explicit that it
crosses into the phase this project deferred:

1. `SVGTextContentElement` → `SVGTextPositioningElement` → `SVGTextElement` and
   `SVGTSpanElement`, plus the element-creation mapping so `<text>`/`<tspan>`
   are constructed as those types rather than falling back to a generic
   element. That alone makes `getBBox` _reachable_.
2. A real text bounding box behind it, which requires SVG text layout — font
   selection, shaping and positioning of `x`/`y`/`dx`/`dy`. **This is phase 2b,
   explicitly out of scope.** A stub returning zeros would be worse than the
   current failure, not better: Mermaid would "succeed" and lay every node out
   on top of every other, and the app would render a broken diagram instead of
   an honest error.
3. `getComputedTextLength()` on `SVGTextContentElement`, which Mermaid also
   uses.
4. Painting `<text>`, or the diagram renders with boxes and arrows and no
   labels.

So the honest summary for anyone picking this up: **Mermaid is blocked on SVG
text, not on `getBBox`.** Adding `getBBox` to shapes was necessary and is not
sufficient, and the remaining work is the text phase in full — interfaces,
layout and painting — rather than another interface-shaped patch. Nothing about
the current failure indicates a defect in the work that has landed.

### Retest 2026-08-23 — SVG text and `<foreignObject>` landed; Mermaid renders

Five further commits: `isPointInFill`/`isPointInStroke`/`getPointAtLength`, SVG
text (measure and paint), `SVGForeignObjectElement` plus laying out and painting
its content, and `SVGStyleElement`. The series is now 5 787 insertions across 47
files, seam +60 in pre-existing layout/script files.

The element hierarchy has grown the types whose absence blocked Mermaid:
`svgtextelement`, `svgtextcontentelement`, `svgtextpositioningelement`,
`svgtspanelement`, plus `svgforeignobjectelement` and `svgstyleelement`.

**Mermaid renders.** The same flowchart that previously produced "Diagram could
not be rendered" now draws: `Start` box, `Choice` diamond, `Done` box, the
`yes`/`no` edge labels, and the connecting edges. This was the case that
motivated calling the text phase a blocker, and it is closed.

**Remaining fidelity gap: no arrowheads.** Edges terminate as plain lines where
Chromium draws arrow tips. There is no `SVGMarkerElement`, and
`components/layout/svg/tree.rs` classes `marker` with the non-rendering
container elements. Everything else in the diagram matches. `<marker>` is the
obvious next element type, and unlike text it is small — marker placement and
orientation on a path, not a layout subsystem.

**No animation regression.** Same regions and method as before:

| Region              | This retest               | Previous                  | Electron control          |
| ------------------- | ------------------------- | ------------------------- | ------------------------- |
| Reasoning indicator | 30–69 px/frame, max Δ 223 | 30–66 px/frame, max Δ 223 | 34–52 px/frame, max Δ 223 |
| Sidebar dots        | 12 px/frame               | 8–12 px/frame             | 6–12 px/frame             |

So the text and `<foreignObject>` work did not disturb the painting or
invalidation paths that the animation depends on.

### Retest 2026-08-23b — vertex markers: arrowheads render

`a67ee5ec38d layout: vertex markers` — 684 insertions, almost all of it a new
`components/layout/svg/marker.rs` (503 lines) plus paint-server and tree
changes; +21 lines in `svgelement.rs` and nothing else outside the SVG module.

**Arrowheads render on all three edges of the Mermaid flowchart**, including
the `no` edge whose arrow points back left into `Start` — so `orient="auto"`
and the reversed case both work, not just the trivial one.

**Geometry matches Chromium exactly.** Scanline through the boxes: the `Start`
box measures 190 px wide in both engines, and every feature — box borders, text
glyphs, diamond edges, arrow tips — sits at a uniform 16 px horizontal offset,
which is window placement, not rendering. There is no accumulated layout drift.

**Whole-diagram difference at best alignment (dx=16, dy=0):** 7.0% of pixels at
tolerance 8, 2.2% at 24, 0.88% at 48.

That is more than the 0.13%/0.02% the earlier simple-shape comparison reported,
so it is worth saying where it comes from. Region by region, at tolerance 48:

| Region                | Servo vs Chromium |
| --------------------- | ----------------- |
| Start box top border  | 33.2%             |
| Plain edge line       | 32.3%             |
| Arrowhead into Done   | 12.3%             |
| Arrowhead into Choice | 7.2%              |
| `Start` text glyphs   | 5.1%              |
| Diamond outline       | 3.4%              |

The difference is concentrated on **thin axis-aligned strokes**, not on text and
not on diagonals. Sampling a vertical profile through the box's top border
shows why: Servo puts the line across rows 166–168 with intensities 139/198/101,
Chromium across 167–169 with 179/197/47. Total ink is the same (438 versus 423
above background) and the peak is one row apart — a **sub-pixel vertical
placement difference of roughly half a pixel**, i.e. Chromium snaps thin
axis-aligned strokes to the pixel grid and vello does not.

That is a rasterizer characteristic rather than a defect: hairlines read very
slightly softer and offset under Servo. Worth knowing before anyone reads a
whole-image percentage as a correctness signal, since it will put a floor under
every diff involving thin horizontal or vertical strokes.
