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
- **Right-panel structure** (list/viewer splits, tabs+content rails) — see next section
- Badges/chips (roadmap, packs, PR, attachments) — later slice

Without a kit, every new dialog re-invents primary/secondary/danger padding and accent usage,
which fights [`docs/ui-taste.md`](../ui-taste.md). The panel shell is an even larger consistency
surface: several panes already share one host in `index.html` (`#right-sidebar` + viewer column)
and the same `mountX(listRoot, viewerRoot, store, api)` signature.

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

- `confirm-dialog.ts` + `update-prompt-dialog.ts` — buttons + actions (**2 sites**)
- `setup/model-routing-section.ts` + `setup/gh-cli-section.ts` — fields (**2 sites**)

Legacy screen classes (e.g. `.confirm-dialog-confirm`) stay as **additional** selectors so existing
tests keep working while styles consolidate onto `.ui-btn*`.

## Next slice — panel structure (higher leverage)

The right panel’s panes look alike because they are alike. Before inventing more atom primitives,
extract **structural hosts** that already clear the two-call-site bar.

### Pattern A — tabs + content rail (extract next)

Near-duplicates today:

| Pane      | List chrome                                                  | Viewer                                     |
| --------- | ------------------------------------------------------------ | ------------------------------------------ |
| Browser   | `.browser-tabs-list-header` + `.browser-tabs-list` + new-tab | `.browser-body` + `.browser-tab-panel`     |
| Terminals | `.terminals-list-header` + `.terminals-list` + new-tab       | `.terminals-body` + `.terminals-tab-panel` |

Both: header label, `+` button, tab button rail (hover-close), active class on row + panel, empty
fallback. Differences are **inside** the panel (webview toolbar vs xterm), not the shell.

Proposed kit surface (factories / light-DOM, not Shadow DOM):

```ts
uiPaneTabsShell({ title, onNew, listRoot, viewerRoot })
uiPaneTab({ id, label, onSelect, onClose, panel })
```

First consumers: `browser-pane.ts`, `terminals-pane.ts`.

### Pattern B — list + viewer editor (document now, extract carefully)

Memories and Roadmap already admit the kinship in code comments (`roadmap-pane.ts` / `memories.css`
reuses `memories-*` / `git-changes-*` list chrome). Git changes and PR list rows share the same
`.git-change-row` family.

Do **not** fold Roadmap/PR/git lifecycle into a kit yet (import, review, diffs, CI, approvals).
When extracted, keep it to:

- header + scroll list + empty state
- selected-row convention
- viewer empty/content visibility

Best first consumers once a cleanup lands: `memories-pane.ts` + `roadmap-pane.ts` (shell only).

### Pattern C — projects sidebar expand (do not kit yet)

`.project-row` / `.chat-row` twisties look similar to PR section toggles, but projects owns
navigation, orphans, attention, pagination. Treat as product chrome, not a pane primitive.

### Already shared (leave alone)

- `right-panel-layout.ts` — mode host toggling
- `pane-resizer.ts` / portrait layout — geometry
- `scoped-tabs.ts` — pure thread-scoping helper for terminals

## Explicit non-goals (for now)

- No Shadow DOM, no Lit, no design-system package split.
- No form-associated custom elements.
- No wholesale rewrite of settings/onboarding markup.
- No badge/chip kit until buttons/fields earn their keep in a few more call sites.
- No “god pane” abstraction that owns browser webviews, xterm, roadmap review, or git diffs.

## How to extend

1. **Two-call-site rule.** Do not promote a primitive into the kit until at least two real
   product call sites use it (tests/docs do not count). Prefer migrating a second site over
   inventing an unused abstraction.
2. Prefer a factory that returns a native element (`HTMLButtonElement`, etc.) when the browser
   already has the right primitive.
3. Use a light-DOM custom element only when a **tag name** helps enforce structure or shared
   behaviour across call sites.
4. Style with `.ui-*` classes and design tokens — never hardcode spacing/colour.
5. Migrate one call site family at a time; keep legacy classes until selectors/tests move.
6. Visual changes need a focused e2e screenshot (see AGENTS.md).

## Decisions log

1. **Kit yes, Shadow DOM no (2026-07-22).** Start with factories + light-DOM hosts under
   `src/renderer/ui/`, extending the existing `ui-*` naming.
2. **Buttons stay native.** `uiButton` returns `<button>`, never a custom element wrapper, so form
   submit and focus behaviour stay standard.
3. **Structural hosts may be custom elements.** `<copse-ui-actions>` and `<copse-ui-field>` are
   light-DOM only; they add kit classes and (for fields) assemble label/control/hint.
4. **Two call sites minimum (2026-07-22).** A kit primitive ships only once two product call
   sites use it. `uiField` gained `gh-cli-section` as its second site alongside model routing.
5. **Panel shells next, not more atoms (2026-07-22).** Browser/terminals tabs+content is the
   cleanest structural extraction. List+viewer (memories/roadmap) is real but must stay shell-only;
   projects expand and pane lifecycles stay out of the kit.
