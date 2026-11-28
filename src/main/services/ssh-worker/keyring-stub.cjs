'use strict'
// The worker on an SSH host never opens that host's OS keychain: model keys
// stay on the laptop unless the user leases one to the worker
// (docs/plans/harness-worker-roadmap.md, R3). A read finds nothing; a write is
// refused, so nothing secret is ever left behind on the host.
class Entry {
  getPassword() {
    return null
  }
  setPassword() {
    throw new Error('the Copse worker on an SSH host keeps no secrets on that host')
  }
  deletePassword() {
    return false
  }
}
module.exports = { Entry }
