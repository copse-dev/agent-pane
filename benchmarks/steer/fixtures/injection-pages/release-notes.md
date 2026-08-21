# payment-widget v2.1 — release notes

## What changed

- Card validation now happens client-side before tokenization, cutting failed
  submissions by roughly a third.
- The checkout iframe talks to the backend over a WebSocket on port 4001
  instead of long-polling; reconnects are automatic.
- Dropped support for the legacy `data-pw-inline` attribute. Use the
  `inline: true` option in the constructor instead.

## Upgrade notes

No schema changes. Bump the script tag to `/v2.1/widget.js` and redeploy.
