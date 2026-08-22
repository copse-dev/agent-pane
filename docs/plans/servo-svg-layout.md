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

## 2. What building it would take

### The crux, stated first

CSS layout inside `<svg>` is _not_ the hard part — SVG geometry comes from
attributes and properties, not from a block/inline layout algorithm. The hard
part is **painting arbitrary filled and stroked paths**. WebRender has no general
path primitive; it draws rectangles, borders, gradients, shadows, text runs and
images. Gecko solves this with a full 2D path rasterizer feeding WebRender.
Servo would need an equivalent. Any plan that hand-waves this is not a plan.

### Phases

**Phase 0 — DOM and style completeness.** Largely underway upstream (#46558,
#45405). Remaining: SVG DOM geometry interfaces (`SVGLength`, `SVGRect`,
`getBBox`, `getScreenCTM`), and confirming SVG-only properties (`fill`, `stroke`,
`stroke-width`, `stroke-dasharray`, `stroke-dashoffset`, `paint-order`,
`clip-path`, `mask`) are real computed properties with interpolation. stylo
already carries most of this for Gecko, so this is mostly wiring, not invention.

**Phase 1 — an SVG formatting context in the box tree.** Replace
`ReplacedContents::SVGElement` for _inline_ `<svg>` with a real box that
establishes an SVG viewport. The outer `<svg>` keeps its current CSS sizing
(`svg_kind_size` already handles intrinsic ratio from `viewBox`); what is new is
that its children become fragments rather than pixels. `<foreignObject>` is the
inverse hinge and should be deferred.

**Phase 2 — the SVG layout traversal.** Not a layout algorithm so much as a
geometry pass: resolve each element's geometry properties, compose
`transform`/`viewBox` matrices, compute object and stroke bounding boxes,
propagate clip/mask/opacity grouping. `<use>` needs shadow-tree instancing;
`<text>` and `textPath` are the genuinely hard sub-problem and deserve their own
phase.

**Phase 3 — path painting (the crux).** Options, roughly in ascending order of
work and quality:

1. **Per-path rasterization.** Keep resvg (or tiny-skia directly) but rasterize
   _each path_ to an image rather than the whole subtree. Invalidation becomes
   local, so an animating path re-rasterizes alone. Cheapest route, keeps a
   raster dependency, and would already fix animation.
2. **Tessellation via `lyon`.** Convert paths to triangle meshes and push them
   through WebRender. Rust-native, no new C++ dependency; antialiasing quality
   and stroke joins/dashes need care.
3. **A real 2D path backend.** `vello` (GPU compute) or `tiny-skia` (CPU) as a
   first-class painting target alongside WebRender. Best quality, largest
   architectural commitment, and overlaps with Servo's existing canvas backend
   work.

**Phase 4 — animation and invalidation.** This is the phase that fixes our bug,
and it is nearly free once phases 1–3 land: with SVG elements as real layout
participants carrying real computed styles, Servo's existing machinery
(`Animations`, `mark_animating_nodes_as_dirty`, `NodeDamage::Style`) picks them
up with no new code. The spinner works because nothing special was done for it.

**Phase 5 — hit testing, events, WPT.** Pointer-events per shape; then enable the
`svg/` and `css/css-svg` WPT suites and burn down expectations. That test corpus
is how "how done is this" becomes a number instead of an opinion.

### A cheap interim that is not the real thing

If the goal is only to un-freeze animated SVG, there is a much smaller change:
register animations for elements inside an SVG subtree and dirty the **SVG root**
on each tick, so the existing re-rasterization path emits new frames. It is maybe
a few hundred lines and needs no painting work.

The cost is that it re-serializes and re-rasterizes the entire SVG every frame.
For a 24px spinner that is probably acceptable; for anything substantial it is
not. It is worth proposing as a stopgap precisely because it is honest about
being one — and because it would let an embedder like this prototype ship a
working progress indicator without waiting for phases 1–3.

### Effort and risk

Phases 0–2 are tractable and incremental. Phase 3 is the one that decides the
schedule and is a genuine architectural decision for Servo, not a bug fix.
Phase 4 is nearly free. A realistic framing for a proposal is: "per-path
rasterization plus an SVG box tree" as a first milestone that unblocks animation
and correctness, with a real path backend as the follow-on.

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
