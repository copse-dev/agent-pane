# Default change announcement prototype

Interactive browser prototype for the future Compact graduation announcement.
Uses the app's local fonts, theme tokens, and button styles. The background chat
and settings destination are illustrative; no product defaults or saved settings change.

Acceptance: show the same clear announcement for fresh installs and updates;
Got it and Escape dismiss it; Appearance settings opens a preview destination;
keep the modal readable on narrow screens and in light/dark themes.
Base revision: 81215fcf7. Scope is static prototype and focused browser coverage.
No persisted data, update machinery, or runtime boundaries are changed.

Open `prototypes/default-announcement/index.html` in the browser preview.
Add `?context=fresh` for the fresh-install entry. After dismissing the modal,
the preview toolbar lets you replay either entry or switch themes.
The setting choices are illustrative names pending the final product implementation.

Validation: `pnpm run test:demo --spec tests/demo/default-announcement.demo.ts`.
The focused spec covers both entries, dismissal, settings navigation, keyboard
focus, light theme, narrow geometry, and screenshots.

Completion evidence: all 3 focused browser tests passed on Chrome 154 (macOS).
Reviewed dark, light, and 358px-wide modal captures: copy wraps cleanly, actions
remain visible, and no horizontal overflow occurs. Reference screenshots live
in `tests/e2e/screenshots/default-announcement-{dark,light,narrow}.png`.
This does not validate real startup/update triggering or production settings
navigation; those belong to the later rollout implementation. The full app
suite was not run for this standalone design prototype.
