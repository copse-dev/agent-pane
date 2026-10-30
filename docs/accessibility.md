# Accessibility acceptance

Copse targets **WCAG 2.2 level AA** on the documented release platform (macOS 26+, see
[release checklist](release-checklist.md)). This page defines what that means for a release: which
parts are checked automatically, which need a person with assistive technology, how failures are
triaged and who can waive them. Umbrella tracker:
[#1369](https://github.com/copse-dev/agent-pane/issues/1369).

## Supported matrix

| Dimension               | How it is verified                                                                                                                                                          | Status                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Roles and names         | axe-core WCAG A/AA rules in the [lane](#the-automated-lane); computed accessible names asserted for the Settings dialog and tool-card disclosure                            | Automated                                 |
| Keyboard operation      | Lane journeys: Settings reached by Tab and opened with Enter; tool card toggled with Enter and Space. Focused specs: OpenRouter picker, ask_user dialog keyboard submission | Automated (representative)                |
| Focus behaviour         | Lane journeys: Settings and ask_user take focus on open and contain Tab/Shift+Tab; Escape closes Settings and returns focus to its trigger                                  | Automated (representative)                |
| Contrast                | axe `color-contrast` on the transcript in dark and light themes, and on the main window and Settings in dark. Focused specs: light contrast controls, syntax contrast       | Automated; light Settings not yet scanned |
| Reduced motion          | Focused spec: agent avatars under emulated `prefers-reduced-motion`                                                                                                         | Focused only; no lane journey yet         |
| Zoom                    | Focused spec: UI scale (125%/135%) and its keyboard control                                                                                                                 | Focused only; 200% journeys not yet       |
| Screen reader           | [Manual VoiceOver journeys](#manual-assistive-technology-lane) on the release candidate                                                                                     | Manual; procedure defined, results due    |
| Complex native surfaces | Monaco editor, diff view and terminal are not yet scanned or driven by keyboard in the lane                                                                                 | Gap                                       |

"Automated" means the check runs in CI and fails the build; it does not mean the dimension is
fully proven. An automated DOM scan cannot show that a journey is usable, which is why the lane
also drives real keyboard input, and why the screen-reader row stays manual.

## The automated lane

[`tests/e2e/accessibility.e2e.ts`](../tests/e2e/accessibility.e2e.ts) runs in the real Electron
app through the ordinary WebdriverIO setup ([testing strategy](testing-strategy.md)):

- **Scans.** [`helpers/axe.ts`](../tests/e2e/helpers/axe.ts) injects axe-core into the renderer
  and runs the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` rules against a surface.
  A scan is repeated until two consecutive results agree, so a section that fills in late cannot
  make the result flap. Surfaces today: `main-dark` (empty thread), `settings-general`,
  `ask-user-dialog`, and `transcript-dark` / `transcript-light` (markdown heading, list, table,
  code block and an expanded tool card).
- **Journeys.** Keyboard-only checks for the behaviour a scan cannot see, listed in the matrix.

Because the spec lives in `tests/e2e/`, it belongs to the full e2e tier. That tier must pass
before a `main` → `release` promotion can merge, and it runs on the nightly schedule
([where each tier runs](testing-strategy.md#where-each-tier-runs-main-and-release)), so every
release candidate — weekly betas included — already carries a passing lane. Ordinary PRs run it
when the oracle selects it, or with the `ci-full` label.

Run it alone with `pnpm run build && pnpm run test:e2e:a11y`.

## The baseline only shrinks

[`tests/e2e/accessibility-baseline.json`](../tests/e2e/accessibility-baseline.json) records the
known violations: per surface, per axe rule, a node count and the issue that owns the fix.

- The lane requires the observed counts to **equal** the baseline. More nodes than recorded is a
  new violation and fails with the offending selectors. Fewer is also a failure: the fix must
  lower the count (or delete the entry) in the same PR, so the file never overstates the debt.
  Each run writes the observed counts to `e2e-failure-artifacts/accessibility-observed.json`.
- `pnpm run check:a11y-baseline` (part of `check:local`, and a step of CI's static gate against
  the PR or queue base) fails if any entry is new or any count grew. A new surface must therefore
  be clean when it is added, or have its violations fixed first.
- Counts are per rule, not per node: swapping one violation of a rule for another of the same rule
  keeps the count. The failure output lists selectors so a reviewer can tell.

## Failure triage

When the lane fails:

1. **New violation (`NEW`).** Fix it in the PR that introduced it; that is the default and the
   only path the baseline allows. If axe is wrong about a construct, prove it with the computed
   accessibility tree, file an issue, and narrow the scan with an `exclude` selector and a comment
   linking the issue — never by raising a count.
2. **Fixed violation (`FIXED`).** Lower the count in the baseline as the message says.
3. **Journey failure** (focus escaped, focus not returned, no accessible name). Treat as a product
   regression and fix it; journeys have no baseline.
4. **`never settled` or a timeout.** A harness or rendering-stability bug. Triage it like any other
   e2e flake ([host environment noise](host-environment-test-noise.md)); do not record it as a
   pass.

## Manual assistive-technology lane

Automation cannot claim screen-reader acceptance. For a stable release (and any beta cut by hand),
run these journeys with **VoiceOver on macOS** against the release candidate build:

1. Launch, move from the sidebar to the composer, and send a message.
2. Open Settings, change a setting, save, and confirm the dialog and its sections are announced
   with names.
3. Answer an ask_user question and an approval prompt.
4. Read an assistant reply containing a list, a table and a code block; expand a tool card.

Record in [product release evidence](product-release-evidence.md): candidate SHA, macOS and
VoiceOver versions, each journey's result, and any issue filed.

## Waivers and ownership

- **Baseline entries** are known debt with an owning issue, not waivers. Their owner is whoever
  is assigned the linked issue; unassigned entries are triaged by the release owner before a
  stable release.
- **Release waivers** — shipping with a failed manual journey or a gap in the matrix that the
  release changes — are decided by the **release owner**. Each one records owner, scope,
  rationale, tracking issue and an expiry release in
  [product release evidence](product-release-evidence.md). An expired waiver blocks the next
  stable release until it is renewed or resolved.
- The automated lane is never waived for a release: a red lane means the promotion did not pass
  `CI Passed`.
