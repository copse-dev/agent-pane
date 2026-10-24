// Issue #41: apply the persisted theme before stylesheets load. Main passes the
// resolved theme as `?t=<light|dark>` on index.html; boot() later re-applies the
// same value once settings load (idempotent).
;(function applyBootThemeFromQuery() {
  var theme = new URLSearchParams(window.location.search).get('t')
  // Keep the document themed when index.html is loaded without the main-process
  // query (browser demo/tests or a malformed URL). The normal Electron path
  // always supplies the persisted, system-resolved value.
  document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'dark'
})()
