# Beyond the side highlight

A design prototype for replacing Copse's accent rail — the slim bar on one inline edge of a block,
drawn either as `border-left` or as an inset shadow with a horizontal offset.

Open `index.html` through Copse's Browser pane preview (it needs to be served over HTTP; the fonts
are loaded from `../../assets/fonts`). Switch treatments with the top-bar buttons, or link straight
to one:

| URL | View |
| --- | --- |
| `#current` | today's rails |
| **`#m`** | **the mix — the proposed direction** |
| `#mix` | today + B + H + M, side by side |
| `#a` `#b` `#c` | line — label line, quiet plate, gutter |
| `#split` | today + A/B/C, side by side |
| `#d` `#e` `#j` | depth — lifted, well, soft |
| `#material` | today + D/E/J, side by side |
| `#g` `#h` `#i` | low ink — ring, hatch, margin |
| `#quiet` | today + G/H/I, side by side |

`?at=<n>` scrolls to the nth specimen, so any part of any treatment is one URL.

**F — "Lit"** was cut. It tinted the chat pane's radial falloff with the severity hue; at block
scale the coloured gradient read as a smudge rather than a light. J is the same technique done
neutrally, which is what survived.

## What the rail is actually doing

Ten rails across six stylesheets, serving three unrelated jobs. That is why one visual device feels
repetitive: the transcript uses it for *containment* while the sidebar uses it for *selection*.

**Containment / subordination** — "this block is a different kind of content"

| Where | Source |
| --- | --- |
| Blockquotes, GitHub alerts (Note/Tip/Important/Warning/Caution) | `@copse/streaming-markdown` → `styles/default.css` |
| `.message-reasoning` | `conversation.css:200` |
| `.review-panel`, `.review-panel-error` | `todo.css:135`, `:150` |
| `.comparison-panel`, `.comparison-panel-error` | `todo.css:246`, `:261` |
| `.vnc-auth-panel` | `vnc.css:365` |

**Selection / state on a list row** — "this one is current"

| Where | Source |
| --- | --- |
| `.chat-row.selected` (trailing edge) | `layout.css:458` |
| `.settings-nav-btn.active` (leading edge) | `settings.css:120` |
| `.vnc-tab.is-active` | `vnc.css:60` |
| `.vnc-status[data-kind=…]` — the rail hue *is* the status | `vnc.css:499`–`515` |

**Structural nesting** — "these rows are children of that one"

| Where | Source |
| --- | --- |
| `.tool-rollup-body` | `tool-cards.css:161` |
| `.tool-card-subagent .subagent-timeline` | `tool-cards.css:319` |

Not rails, despite matching the grep: `.message-reasoning-icon::before` and the `perf-autopilot.ts`
markers are CSS triangles, and `.vnc-discovered-port.selected` already uses an even ring
(`inset 0 0 0 1px`). `todo.css` holds the review/comparison panels despite its name — the plan/todo
rows themselves have no rail.

## M — the mix (proposed)

Not a fourth idea but a composition, split by **what each block is** rather than by what it looks
like. That split is the point: it gives the two plate styles a meaning they have to earn, instead
of being two arbitrary looks.

| Block | Treatment | Why |
| --- | --- | --- |
| GitHub alerts, blockquotes | **B — flat plate** | Prose the agent wrote. It is part of the answer, so it gets a plain surface. |
| Thinking, review, comparison | **H — hatched plate** | Not part of the answer: Copse annotating its own turn. Same box, different material. |
| VNC pane | **C — gutter** | A separate pane with its own chrome, and its status hue has to survive on a single line where a plate would just box three of them. |
| Tool rollup, subagent timeline | **unchanged** | That bar is structure — "these rows are children" — not decoration, and the rollup rework already in flight supersedes anything done here. |
| Thread rows, settings nav, VNC tabs | **fill alone** | The full-bleed `--bg-selected` wash already says "selected"; the rail was always redundant with it. |

The content/commentary distinction is the part worth defending in review. Everything else in the
transcript is the agent's output; thinking, review and comparison are the app talking about that
output, and today nothing in the visual language says so — they just get a differently-coloured bar
like everything else. A texture rather than another hue is what marks them without spending a
fourth colour or a fourth shape.

Open questions before this ships:

- **Moiré.** The hatch is a 1px line on an 8px pitch. That is exactly the pattern that aliases at
  fractional device pixel ratios, and Copse ships on mixed-DPI Windows. Test at 1.25×/1.5× before
  committing to the pitch; a coarser pitch or a `device-pixel-ratio` media query may be needed.
- **Accent load.** `.message-reasoning` and `.comparison-panel` both key off `--accent`, so a turn
  with thinking *and* a comparison shows two pink hatches. Not a regression — both already use the
  accent today — but the texture makes the hue more present than a 2px bar did.
- **Reduced transparency / high contrast.** A decorative texture needs a degradation path; the
  hatch should fall back to B's flat plate rather than disappearing into the page.
- **Where the work actually is.** Alerts and blockquotes are styled by `@copse/streaming-markdown`,
  not this repo, so B's plate for those is an upstream change or an override of its default
  stylesheet — the largest single chunk, and the one with a dependency outside our control.

## Callout icons

Once the rail goes, the icon is doing work it was never asked to do before — the bar used to carry
the severity hue across the whole height of the block, and now a 15px glyph carries all of it. At
1.4 the outline strokes read hollow next to a 600-weight title, so the title ends up carrying the
block alone. The workshop (second specimen) compares four fixes across all four severities.

Findings, in order of how much they buy:

1. **Solid beats heavier outline — chosen.** Going 1.4 → 1.9 helps but the glyph is still a wire
   drawing; a filled glyph is what actually balances the bold title. Thin strokes also lose
   disproportionately on a dark surface, where they get eaten by the surrounding value rather than
   standing out from it. Solid is applied to every transcript specimen; the workshop's first column
   keeps the old outline for comparison.
2. **Silhouette matters more than the glyph inside it.** Note and Caution are both circles today,
   so at small size they differ only by the mark within — and, for anyone who cannot separate the
   red from the blue, only by the mark within. Caution takes an octagon in the solid columns: the
   stop-sign outline reads before the glyph does and before the colour does. Honest caveat: at
   16px an octagon is only *somewhat* distinct from a circle. The gain is real but modest, and it
   would be larger at 18px.
3. **The disc is optional.** A tinted disc behind the glyph adds a footprint without asking the
   glyph to get heavier. It reads slightly more badge-like, and the lightbulb sits awkwardly in a
   circle. Worth having if solid alone still feels light in the real app; not needed otherwise.

### The rest of the icon set

The third specimen renders all 28 icons from `src/renderer/dom/icons.ts` — extracted from the real
registry by parsing the `outlineIcon('name', [paths], …)` calls, not hand-copied — so the callout
glyphs can be judged next to what they will actually sit beside. Two things it makes obvious:

- **The set is entirely outline, at stroke 2** (`.ui-icon` in `styles/global/icons.css`; the
  presentation-attribute fallback in `outline-icon.ts` is 1.75). Going solid for callouts makes the
  five alert marks the only filled shapes in the whole app. That is defensible — filled-vs-outline
  becomes meaningful, status marks are filled and chrome is outline — but it is a house rule being
  invented, and `docs/ui-taste.md` should say so rather than leaving it implicit. The two toggles
  under the gallery show the set at the callout weight and size so the comparison is visual rather
  than argued.
- **`triangle-alert` already exists** (`icons.ts:150`), as an outline. A solid `Warning` triangle
  would put two warning triangles in the app in two different styles. Either the callout reuses the
  existing outline glyph, or `triangle-alert` is retired in favour of the solid one, or the two are
  explicitly scoped (chrome vs transcript). Doing nothing leaves a visible inconsistency. The same
  question applies more weakly to `circle`, `dot` and `check`, which the Review annotation borrows.

### Optical centring is not box centring

The first version of the workshop drew a crosshair on the **box** centre, which measures the wrong
thing. What the eye reads is the ink's **weighted centre** — its centre of mass — and for these five
silhouettes those are nowhere near each other:

- A triangle carries two thirds of its area in its bottom half, so a box-centred `Warning` reads
  **low**.
- A lightbulb and a speech bubble carry theirs at the top — the bulb and the bubble are the mass,
  while the base bars and the tail are thin — so both read **high**.
- Only the circle and the octagon are symmetric enough for box centre and weighted centre to
  coincide.

`proto.js` measures this rather than eyeballing it: each glyph is rasterised to a 128×128 canvas and
the alpha-weighted centroid computed, then every icon is translated so that centroid lands on the
optical line. The align strip keeps showing the *uncorrected* glyph with its measured centroid
marked, so the problem stays visible next to the fix.

All four workshop columns are corrected, not just the solid pair. Leaving the outline columns raw
would have compared weight and centring at the same time, and made the table's rows go ragged
across it. Paint is read off the live element before rasterising, because `.ico-thin` and
`.ico-bold` share their path data and differ only in stroke width — measuring one as the other
would silently reuse the wrong centroid.

Measured, in viewBox units (negative = sits high):

| Kind | Centroid offset | Applied nudge |
| --- | --- | --- |
| Note | −0.02 | +0.01 |
| Tip | −1.46 | +0.78 |
| Important | −1.36 | +0.84 |
| Warning | +1.61 | −1.00 |
| Caution | −0.00 | +0.00 |

Three things stop this being a naive "move the centroid to the middle":

- **Vertical only.** Correcting horizontally too is actively wrong here. These icons sit in
  left-aligned icon+label rows where horizontal position comes from the fixed-width box that every
  row shares. Nudging by centroid moves only the glyphs whose ink is horizontally asymmetric —
  `Important` is the sole one, because its tail hangs left of centre — so that single glyph ends up
  sitting proud of the column the others line up in. It is visible as a wobble in the workshop
  table between Tip and Important. Horizontal alignment is the box's job.

- **Damping (0.62).** Correcting a triangle *fully* would drive its apex through the top of the box
  and leave a third of the box empty underneath — the glyph stops reading low and starts reading
  shoved. Icon families take out most of the error, not all of it.
- **An edge clamp.** Ink may not come within 0.35u of the box edge. This is what holds `Tip` back
  from its full damped nudge (0.90 → 0.78): the base bars would otherwise touch the bottom.

For the real implementation these should be **baked into the path data**, not applied at runtime —
the measurement pass exists to derive the numbers once, not to ship as behaviour.

### Horizontal raggedness was two separate faults

**The dominant one was a grid bug, not an icon problem.** Every `.icon-row` in the workshop was its
own independent grid, so nothing actually made the columns line up across rows — they were only
equal by coincidence of content. And `1fr` means `minmax(auto, 1fr)`, whose `auto` floor lets a wide
cell push its own column out. The long word "Important" did exactly that, so that row's icon *and*
label both sat left of every other row's, by around 8px.

The fix is one grid for the whole table: `minmax(0, 1fr)` to remove the floor, and
`display: contents` on the rows so every cell joins the same grid and the columns are genuinely
shared. Worth remembering the general shape of it — a row-per-grid table looks aligned right up
until one cell's content outgrows its share.

**The secondary one was real but smaller: uneven ink widths.** The glyphs were centred correctly,
but they did not fill a common live area, so left edges sat at different insets:

| Kind | ink w × h, before | after |
| --- | --- | --- |
| Note | 13.4 × 13.4 | 13.4 × 13.4 |
| Tip | **9.1** × 13.9 | **10.1** × 13.8 |
| Important | 13.4 × 12.1 | 13.4 × 12.1 |
| Warning | **14.6** × 12.5 | **13.4** × 12.4 |
| Caution | 13.4 × 13.4 | 13.4 × 13.4 |

The triangle was 5.5u wider than the bulb, so at a 16px icon their left edges sat ~2.7px apart —
about a third of the grid bug above, which is why fixing only this did not make the table look
right. Narrowing the triangle's base brought four of the five to exactly 13.4, the live area the
circle and octagon already used.

**Tip cannot be fixed this way and should not be forced.** A lightbulb's widest point is the bulb,
and taking it to 13.4 needs a radius of ~6.7 — which, with the base beneath it, overflows the
16-unit box. It is now 10.1 and that is about the honest limit for the silhouette.

Two ways to close the residual, if 1.65px of inset on one glyph matters:

- **Put every glyph on a disc** (the fourth workshop column). The disc gives all five an identical
  circular footprint, so left edges and label gaps become exactly uniform regardless of the glyph
  inside. This is the only *structural* fix — everything else is per-glyph tuning.
- **Change the Tip glyph** to something with a wider natural footprint. A bulb is the conventional
  "tip" mark though, so this trades recognisability for alignment.

### The five silhouettes

All five GitHub alert kinds are now specimened, and each has a shape of its own rather than a
shared circle with a different mark inside:

| Kind | Silhouette | Hue |
| --- | --- | --- |
| Note | circle | `--info` |
| Tip | lightbulb | `--success` |
| Important | speech bubble | `--important` |
| Warning | triangle | `--warning` |
| Caution | octagon | `--danger` |

**Two of those hues do not exist in `tokens.css`.** `--info` (Note) and `--important` are invented
here, and adding them is a real decision rather than a detail:

- Copse's palette is deliberately small — `docs/ui-taste.md` reserves pink for interaction emphasis
  and gives error/warning/success/danger their own semantic tokens. A five-kind alert family needs
  five hues, which is two more than the palette currently has.
- `--important: #9d7cf4` is pushed **bluer than a true violet on purpose**. `--accent` is `#ff93d0`,
  and a magenta-leaning purple reads as "accent" at 16px — especially next to the pink Thinking and
  Comparison labels that sit in the same transcript. Verify this holds under a custom accent: a
  user who sets their accent to purple collapses the distinction entirely, which is an argument for
  deriving `--important` away from whatever `--accent` currently is.
- Both need light-theme values derived for contrast, per the existing rule that light-theme
  interaction colours are derived rather than reused.

If a sixth and seventh hue is too much, the fallback is to give Important the same `--info` blue and
let the speech-bubble silhouette carry the distinction alone — weaker, but it spends no new colour.

## The three treatments

**A — Label line.** The bar becomes a small-caps label sitting on a hairline rule that runs *with*
the text. Nothing is boxed, nothing is indented, and the severity hue is spent on the one word that
carries it. Stacked callouts read as sections of one document instead of three pasted-in cards, and
prose keeps its full measure. Weakest signal of the three: a single `Caution` in a long transcript
is quieter than it is today.

**B — Quiet plate.** A flat 9% wash of the severity hue, small radius, no border. A plate has no
leading edge, so nothing can bow around a corner and the `accent-rails` rule becomes moot. But it
adds a visible block to a dense transcript, and it is what `docs/ui-taste.md` currently tells you to
avoid ("avoid … a solid tinted block around these secondary results"). The stacked VNC status lines
show the cost most clearly.

**C — Gutter.** The marker moves off the edge into a fixed 24px icon column, so every block kind
starts its text at the same inset and stacked callouts align. The sidebar reuses the 28px status
gutter `.chat-row` already reserves: a selected row gets an accent pip rather than an edge rail.

All three replace list selection with the fill alone plus a weight change — the full-bleed
`--bg-selected` wash already says "selected", and the rail is redundant with it.

## Depth (D, E, J)

A, B and C all replace one drawn line with another drawn thing. These three instead borrow the
technique the chat pane already uses on itself (`layout.css:676`): a light source above and a long
falloff, with no hard edge anywhere. Severity lives in the icon and title in all three, so none of
them tints a whole block flat the way B does.

**D — Lifted.** The block is a leaf raised a hair off the transcript: no border and no rail, a soft
drop shadow plus a 1px inner top highlight catching the same light the pane is lit by. The fill is
barely above the page — the shadow, not the tint, is what contains the block. Selection lifts the
row toward you, full-bleed so the shadow spills above and below rather than drawing a pill.

**E — Well.** The inverse: the block is pressed *into* the surface, with an inset shadow under the
top lip and a highlight along the bottom one. Recessed reads as subordinate with no hue at all,
which is semantically right for a quote, a thinking block, or raw technical details. Selection
inverts to the same gesture as a held button.

**J — Soft.** The chat pane technique with the colour taken out: the surface gets lighter where the
title is, then dissolves into the page over a long falloff. No border, no shadow, no hue. Subtlest
of the three — the block has a top but no bottom, so it never reads as a card. Selection fades the
same way rather than sitting as a flat slab.

Trade-offs: D and E both give every block a visible edge, so a transcript with several callouts
gains several cards — less of a problem than B's saturated plates, more than A's rules. J is the
quietest but also the weakest at containment, and its nesting groups (`.tool-rollup-body`,
`.subagent-timeline`) read poorly: a faint top-lit panel says "these rows are grouped" far less
clearly than the guide line it replaces. Any of the three pairs sensibly with a retained hairline
guide for nesting, which is structure rather than decoration.

## Low ink (G, H, I)

**G — Ring.** A hairline all the way round in a low-alpha severity hue, nothing filled. A ring has
no leading edge, so it follows a radius evenly on all four corners and the "rails never curve"
problem stops existing outright — `.provider-chip.active` and `.vnc-discovered-port.selected`
already work this way, so it is the one option with precedent in the codebase. Cheapest containment
of the set, and the only one that survives a light theme unchanged.

**H — Hatch.** A texture rather than a tint: a 1px diagonal hatch at very low alpha, so the block
reads as a different material without becoming a solid coloured slab. Its one real advantage is
that density stays constant, so a tall callout weighs no more than a short one — which a flat wash
cannot claim. Against it: at 8px pitch it is the busiest thing on the page, it risks moiré at
fractional device pixel ratios, and it has no precedent anywhere in Copse.

**I — Margin.** No graphic at all. The kind of block is named in a fixed 78px left column,
right-aligned so every label ends where the body begins. Stacked callouts share one column and line
up, and severity is carried entirely by the label. Reads best at full transcript width; in a narrow
pane the column eats measure, and it is the only option that introduces a left-edge zigzag —
callout bodies sit at 94px while ordinary prose sits at 0.

## Known gaps

- Blockquotes and GitHub alerts are styled by `@copse/streaming-markdown`, not by this repo. Either
  the package changes upstream or Copse overrides its default stylesheet.
- `<details>` cannot take C's grid: Chromium wraps everything after the summary in a
  `::details-content` box, which auto-places into the gutter column and reflows the body one word
  per line. `.message-reasoning` and `.tool-card-rollup` need padding instead. D, E, G, H and J
  sidestep this by scoping their surface to `.reason[open]` rather than laying out the disclosure;
  I uses a negative-indent float for the same reason.
- D, E and J are tuned for the dark theme only. The shadow alphas in particular do not survive a
  light background unchanged: a `rgba(0,0,0,.26)` drop shadow that reads as a hair of lift on
  `#1e1e1e` reads as dirt on cream. Light theme needs its own pass before any of them ship. G and I
  are the two that port over unchanged.
- None of these has been checked against the strong-tint interface setting, which shifts
  `--bg-base` far enough that D's 72% `--bg-elevated` fill and J's falloff both need re-deriving.
- Adopting any of these means rewriting `src/renderer/styles/accent-rails.test.ts` (it pins the
  rail's *shape*, not its existence) and the "Accent rails never curve" / "Sidebar selections"
  sections of `docs/ui-taste.md`.
- Light theme is not covered here; the severity hues need re-deriving for contrast.
