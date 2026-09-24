# drauu (vendored)

Vendored from [antfu/drauu](https://github.com/antfu/drauu) `packages/core`
at v1.0.0 (commit of 2026-01-13), MIT licence, copyright Anthony Fu. The
original licence text is in `LICENSE`.

Why a copy rather than a dependency: the library is ~1,300 lines, its last
release is a year old, and the annotation layer needs to reshape it (tool set,
eraser behaviour, export) rather than configure it. The ink itself is
`perfect-freehand`, which stays a real dependency.

Changes from upstream:

- `nanoevents` replaced by `emitter.ts` (twenty lines, same `on`/`emit` shape).
- Typed for `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
  no non-null assertions.
- `mount` takes elements, not selector strings.
- When the SVG element lacks `createSVGPoint` (jsdom), coordinates fall back to
  `getBoundingClientRect` instead of throwing, so the models are unit-testable.
- `getTotalLength` is guarded where jsdom lacks it.
- Dropped the `cssZoom`, `coordinateScale` and `offset` options; the layer
  always sizes its SVG to the host in CSS pixels.
