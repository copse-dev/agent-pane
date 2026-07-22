# UI kit (renderer primitives)

Status: **Active** — first slice on branch `jkt/auto/ui-kit-web-components-*`.

## Question

Is there value in extracting common UI structure into reusable primitives — including web
components — to start a real UI kit?

## Verdict

**Yes for a UI kit. Not yet for Shadow DOM custom elements.**

Copse already has a nascent kit surface (`ui-icon`, `ui-inline-status`) built as **factory
functions + global CSS classes** on a vanilla TypeScript DOM renderer. The highest-value next
step is to grow that family — not to introduce Lit/Shadow DOM.

| Approach                                   | Fit for Copse                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Factory helpers + `.ui-*` CSS              | **Primary.** Matches `el()`, global tokens, happy-dom tests, form/`<dialog>` semantics.                                                 |
| Light-DOM custom elements (`<copse-ui-*>`) | **Useful for structural hosts** (field, actions) that enforce tag + class without fighting the cascade.                                 |
| Shadow DOM / Lit                           | **Defer.** Breaks global token/cascade CSS, complicates form association and `<dialog>`, and makes class-based tests/selectors awkward. |

## Why a kit is worth it

These patterns are copy-pasted with screen-local class names and near-identical tokens:

- Dialog / prompt buttons (`confirm-dialog-*`, `update-prompt-*`, `ssh-prompt-*`, `ask-user-*`)
- Action rows (end-aligned button clusters)
- Labeled fields with hints (`setup-field`, provider field groups, settings fieldsets)
- Badges/chips (roadmap, packs, PR, attachments) — later slice

Without a kit, every new dialog re-invents primary/secondary/danger padding and accent usage,
which fights [`docs/ui-taste.md`](../ui-taste.md).

## First slice (this plan)

Under `src/renderer/ui/`:

1. **`uiButton`** — native `<button class="ui-btn ui-btn-{variant}">` factory (not a custom
   element; keeps submit/focus/form behaviour honest).
2. **`<copse-ui-actions>` + `uiActions`** — light-DOM action row host.
3. **`<copse-ui-field>` + `uiField`** — light-DOM labelled field + optional hint.

CSS lives in [`src/renderer/styles/global/ui.css`](../../src/renderer/styles/global/ui.css) and is
imported from `global.css`. Elements register via `registerUiKit()` (idempotent; also runs on
module import).

### Initial call sites

- `confirm-dialog.ts` — buttons + actions
- `update-prompt-dialog.ts` — buttons + actions
- `setup/model-routing-section.ts` — fields

Legacy screen classes (e.g. `.confirm-dialog-confirm`) stay as **additional** selectors so existing
tests keep working while styles consolidate onto `.ui-btn*`.

## Explicit non-goals (for now)

- No Shadow DOM, no Lit, no design-system package split.
- No form-associated custom elements.
- No wholesale rewrite of settings/onboarding markup.
- No badge/chip/tab kit until buttons/fields earn their keep in a few more call sites.

## How to extend

1. Prefer a factory that returns a native element (`HTMLButtonElement`, etc.) when the browser
   already has the right primitive.
2. Use a light-DOM custom element only when a **tag name** helps enforce structure or shared
   behaviour across call sites.
3. Style with `.ui-*` classes and design tokens — never hardcode spacing/colour.
4. Migrate one call site family at a time; keep legacy classes until selectors/tests move.
5. Visual changes need a focused e2e screenshot (see AGENTS.md).

## Decisions log

1. **Kit yes, Shadow DOM no (2026-07-22).** Start with factories + light-DOM hosts under
   `src/renderer/ui/`, extending the existing `ui-*` naming.
2. **Buttons stay native.** `uiButton` returns `<button>`, never a custom element wrapper, so form
   submit and focus behaviour stay standard.
3. **Structural hosts may be custom elements.** `<copse-ui-actions>` and `<copse-ui-field>` are
   light-DOM only; they add kit classes and (for fields) assemble label/control/hint.
