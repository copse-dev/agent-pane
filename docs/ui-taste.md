# UI taste & appearance notes

Hard-won appearance/layout conventions for the Copse renderer (`src/renderer`). This is a living
"taste" file: when a UI tweak teaches us something worth remembering, add it here so the next agent
doesn't relearn it. It complements — not replaces — the visual-eval rules in
[`AGENTS.md`](../AGENTS.md) and the markdown invariants in
[`src/renderer/markdown/README.md`](../src/renderer/markdown/README.md).

## Design tokens, not magic numbers

All spacing, radii, colors, and fonts come from CSS custom properties in
[`src/renderer/styles/tokens.css`](../src/renderer/styles/tokens.css). Reach for a token before
typing a raw pixel value; if you find yourself writing `padding: 8px 20px`, that's a smell.

| Token          | Value | Token              | Value |
| -------------- | ----- | ------------------ | ----- |
| `--spacing-xs` | 4px   | `--radius`         | 4px   |
| `--spacing-sm` | 8px   | `--radius-lg`      | 8px   |
| `--spacing-md` | 12px  | `--font-size-sm`   | 12px  |
| `--spacing-lg` | 16px  | `--font-size-base` | 14px  |
| `--spacing-xl` | 24px  | `--font-size-lg`   | 16px  |

- There is no spacing token larger than `--spacing-xl` (24px). When you genuinely need more, compose
  with `calc()` from existing tokens (e.g. `calc(var(--spacing-xl) + var(--spacing-lg))`) rather than
  introducing a new magic number. This mirrors what `onboarding.css` already does.
- Colors: `--bg-base` / `--bg-elevated` / `--bg-hover`, `--text-primary` / `--text-secondary` /
  `--text-muted`, `--border`, `--accent`, and the `--error` / `--success` / `--warning` status hues.
- Per user preference: before adding any constant, check whether one already exists to import/use.

## Comfortable action bars

For primary/secondary action buttons (Save / Cancel style):

- Give buttons a roomy hit area — `padding: var(--spacing-md) var(--spacing-xl)` reads better than a
  cramped `8px 20px`.
- Separate buttons with `gap: var(--spacing-md)`, not a tight `--spacing-sm`.
- Keep an action bar clear of the window's bottom edge. Don't let buttons sit flush against the
  bottom; add generous bottom spacing (e.g. `calc(var(--spacing-xl) + var(--spacing-lg))`).

## Sticky footers inside scroll containers (gotcha)

A `position: sticky; bottom: 0` element **cannot extend past its containing block's content box**.
So if the scroll container has bottom padding, the sticky footer stops short by exactly that padding,
leaving a gap underneath where scrolled content shows _through / past_ the footer.

Rules of thumb:

- Put the scroll container's bottom breathing room **inside the sticky footer** (as the footer's own
  `padding-bottom`), not as `padding-bottom` on the scroll container.
- The sticky footer needs an opaque `background` (`var(--bg-base)`) so content scrolling beneath it is
  actually covered.
- Alternatively, mirror the onboarding pattern: make the footer a non-scrolling flex sibling
  (`flex-shrink: 0`) _outside_ the scroll region (see `onboarding.css` / `onboarding-dialog.ts`).
  Prefer this when the footer doesn't need to live inside a `<form>` for submit semantics.

### Worked example — Settings Save/Cancel bar

Symptom: while scrolling Settings, fieldset content was visible _past_ (below) the Save/Cancel bar.

Root cause: `.settings-buttons` is `position: sticky; bottom: 0` inside the scrollable
`form.settings-content`, which had `padding: var(--spacing-xl)` on all four sides. The 24px bottom
padding left a 24px gap below the sticky bar.

Fix (in [`src/renderer/styles/global/settings.css`](../src/renderer/styles/global/settings.css)):

- Drop the scroll container's bottom padding: `padding: var(--spacing-xl) var(--spacing-xl) 0`.
- Move that breathing room into the footer and lift it off the window edge:
  `padding-bottom: calc(var(--spacing-xl) + var(--spacing-lg))`.
- Roomier buttons: `padding: var(--spacing-md) var(--spacing-xl)`, `gap: var(--spacing-md)`.

## Prove visual changes with a focused e2e eval

Per `AGENTS.md`, any user-visible change needs a focused WebdriverIO Electron spec that seeds the
target state, asserts the DOM/layout behavior, and saves a screenshot — not just `npm run check` or a
manual VNC glance.

- For the footer fix, [`tests/e2e/settings-footer.e2e.ts`](../tests/e2e/settings-footer.e2e.ts)
  scrolls content beneath the bar and asserts (a) the footer's bottom is flush with the scrollport
  bottom (gap ≤ 1px) and (b) `elementFromPoint` at the bottom edge resolves to the footer, not
  scrolled-through content.
- Validate a layout-invariant test by confirming it **fails** on the pre-fix CSS, then **passes**
  with the fix. The footer spec failed with `gap=24px` before the fix.
- Run with the mock LLM and no keys: `COPSE_PANEL_MOCK_LLM=1 ANTHROPIC_API_KEY= OPENAI_API_KEY= npm run test:e2e -- --spec <spec>`.
- Reference screenshots that include a surface you changed (e.g. the settings footer appears in
  `settings-model-routing` shots) should be regenerated so they stay accurate.
