# Product announcements

Task brief: reusable, once-per-profile announcements for shipped product changes,
covering new installs and upgrades, with optional navigation to a Settings section.
Base revision: 81215fcf7. No Compact graduation, default changes, remote content,
or updater changes are included. Profile history uses the existing validated
settings API. Native dialogs must wait for onboarding and other open modals.

Acceptance: each unseen ID appears in order; Got it, Escape, and a settings action
save acknowledgement; relaunch skips acknowledged IDs; a later new ID remains
eligible; failed saves leave a retryable message; pop-outs do not announce.
Validation: component tests for lifecycle, history, queueing and failures; schema
validation; real browser rendering/settings navigation/screenshots; full check
because this introduces persisted profile state.

## Announce a shipped change

Add a declarative entry to `PRODUCT_ANNOUNCEMENTS` in
`src/renderer/product-announcements.ts` in the same change that ships the feature:

```ts
{
  id: 'compact-view-released-v1',
  title: 'Compact is now the default',
  message: 'Compact view is available to everyone. Chats now have a more concise, focused layout.',
  detail: 'Change your view anytime in Settings → Appearance.',
  settingsAction: { label: 'Appearance settings', section: 'appearance' },
}
```

The shipped catalog is deliberately empty while Compact remains experimental.
The example above is not an active announcement and does not change a default.
Only include truthful copy for behavior that already ships. The optional settings
action uses an existing typed Settings section. Omit it for informational notices.
Copy is plain text; no HTML, URLs, scripts, or callbacks are read from release notes.

IDs are permanent identities, independent of build or version numbers. Copy edits
keep the same ID. A different change gets a new ID. Entries show in catalog order.
Remove retired entries to keep fresh installs relevant; keep retained history so
restoring an entry does not show it again. There is no version-comparison gate:
both development builds and packaged updates run the same primary-window boot path.

History lives in `acknowledgedProductAnnouncements` in the profile's validated
settings store. Dismissal is saved before advancing or opening Settings. Closing
the app without acknowledging leaves the notice eligible for the next launch.
Save failures keep the dialog open with an inline retry message. Opening Settings
acknowledges only the current entry; the next waits until Settings is closed.
History is re-read before each write to preserve intervening acknowledgements
from other windows; simultaneous main windows can each present an unacknowledged
notice until one acknowledges it. Pop-out windows do not mount the system.

Browser demo scenarios `product-announcements-fresh`, `product-announcements-update`,
and `product-announcements-seen` inject illustrative entries at the controller
boundary. Demo copy never activates the shipped catalog or changes any defaults.

## Completion evidence

Initial implementation based on `81215fcf7`; the PR branch is rebased onto `634b450ef`. No release is created.

- `pnpm test -- product-announcement`: 13 passed.
- `pnpm test -- product-announcement modern-css ui-font-scale session-start`: 43 passed after correcting the modal typography; includes the hook test that timed out in the broad run.
- `pnpm run test:demo --spec tests/demo/product-announcements.demo.ts`: 3 passed on Chrome 154/macOS, after the final typography change.
- Desktop and demo builds completed successfully.
- Dark, light and 358px-wide modal screenshots reviewed: readable wrapping, visible actions, no overflow. The settings action opens the real Appearance section; one Escape closes only one dialog.
- Full `pnpm run check`: first run completed 11,848 tests, with two new CSS contract failures (since corrected and rerun green) and one unrelated hook timeout (standalone rerun green). The final full-gate attempt passed all static gates, then was interrupted by a termination signal (exit 143) during the test suite. A clean final full-suite pass remains unverified.

Reference images: `tests/e2e/screenshots/product-announcement-{dark,light,narrow}.png`.
The demo injects sample announcements; the production catalog remains empty.
Simultaneous main-window acknowledgement writes are not an atomic cross-window
transaction; this implementation preserves intervening saves by re-reading history.

PR preparation on the rebased branch: `pnpm run typecheck` passed;
`pnpm test -- product-announcement modern-css ui-font-scale session-start`
passed all 43 tests; `pnpm run build:demo` passed; the two announcement browser
specs passed all 6 tests. The full-gate results above came from the original
checkout and are not a clean full-suite result for the rebased PR head.
