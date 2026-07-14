// Issue #41: apply the persisted theme before stylesheets load. Main passes the
// resolved theme as `?t=<light|dark>` on index.html; boot() later re-applies the
// same value once settings load (idempotent).
;(function applyBootThemeFromQuery() {
  var theme = new URLSearchParams(window.location.search).get('t')
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme
  }
})()
