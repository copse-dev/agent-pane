/** Copy used by the real child-session window and its visual evidence. */
export const CHILD_COPSE_STOP_URL = 'copse-child-stop://session'
export const CHILD_COPSE_SESSION_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action copse-child-stop:">
<title>Child Copse control</title>
<style>
:root {
  color-scheme: light dark;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --bg-base: #1e1e1e; --bg-subtle: #252526;
  --text-primary: #d4d4d4; --text-secondary: #a6a6a6; --border: #414141;
  --warning: #cca700; --danger: #f14c4c; --text-on-danger: #1a1a1a;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg-base: #ffffff; --bg-subtle: #f6f6f6;
    --text-primary: #242424; --text-secondary: #616161; --border: #d4d4d4;
    --warning: #9a6700; --danger: #cf222e; --text-on-danger: #ffffff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg-base); color: var(--text-primary); }
main { min-height: 100vh; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
header { display: flex; align-items: center; gap: 12px; }
.window-icon { width: 34px; height: 34px; padding: 7px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); flex: none; }
.eyebrow { margin: 0 0 2px; color: var(--text-secondary); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
h4 { margin: 0; font-size: 17px; line-height: 1.3; font-weight: 600; }
p { margin: 0; }
.warning { padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-subtle); }
.warning strong { display: block; margin-bottom: 4px; font-weight: 600; color: var(--warning); }
.warning p { color: var(--text-primary); }
.scope { margin-top: 8px; color: var(--text-secondary); font-size: 12px; }
footer { margin-top: auto; }
button { width: 100%; min-height: 36px; border: 0; border-radius: 999px; background: var(--danger); color: var(--text-on-danger); font: inherit; font-weight: 600; cursor: pointer; }
button:hover { filter: brightness(1.08); }
button:focus-visible { outline: 2px solid var(--text-primary); outline-offset: 3px; }
.help { margin-top: 10px; color: var(--text-secondary); font-size: 11px; line-height: 1.45; }
</style></head><body><main aria-labelledby="session-title">
<header>
<svg class="window-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.5" y="2.5" width="17" height="15" rx="2"/><path d="M2 7h16M5 5h1m2 0h1"/></svg>
<div><p class="eyebrow">Agent control active</p><h4 id="session-title">Child Copse session</h4></div>
</header>
<section class="warning" aria-label="Control permissions">
<strong>The agent can approve requests</strong>
<p>This includes commands with your account’s file and network access.</p>
<p class="scope">Control is limited to this child · Up to 30 minutes</p>
</section>
<footer>
<form action="${CHILD_COPSE_STOP_URL}"><button type="submit">Stop child session</button></form>
<p class="help">Stops control and closes the child. Closing this window also stops the session.</p>
</footer>
</main></body></html>`
