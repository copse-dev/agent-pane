'use strict'
// The container worker offers no PTY terminal; anything that reaches for one
// gets a clear error instead of a missing native module at load time.
function unavailable() {
  throw new Error('node-pty is not available inside the Copse container worker')
}
module.exports = { spawn: unavailable }
