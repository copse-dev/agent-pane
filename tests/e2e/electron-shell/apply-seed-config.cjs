'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Consume a fixture once, after the old Electron process has shut down. */
function applyPendingSeedConfig(profileRoot) {
  try {
    fs.renameSync(
      path.join(profileRoot, '.e2e-pending-config.json'),
      path.join(profileRoot, 'config.json'),
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

module.exports = { applyPendingSeedConfig }
