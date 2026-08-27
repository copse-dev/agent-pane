'use strict'

const fs = require('node:fs')
const path = require('node:path')

function applyEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  try {
    const overrides = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined && value !== null) {
        process.env[key] = String(value)
      }
    }
  } catch (err) {
    console.error(`[electron-shell] Failed to apply ${path.basename(filePath)}:`, err)
  }
}

/** Env overrides must land before `app-init` runs (see wdio.conf.ts / wdio.eval.conf.ts). */
applyEnvFile(path.join(__dirname, '.eval-env.json'))
applyEnvFile(path.join(__dirname, '.e2e-env.json'))

/**
 * Inject unavailable storage at the two external cipher boundaries. Linux's
 * native keyring falls back from Secret Service to kernel keyutils, so host
 * environment alone cannot reliably reach this supported product state. The
 * fixture stays in the e2e shell rather than adding a test-only product API.
 */
if (process.env.COPSE_E2E_SECRET_STORAGE === 'unavailable') {
  const { Entry } = require('@napi-rs/keyring')
  const { safeStorage } = require('electron')
  const unavailable = () => {
    throw new Error('e2e fixture: OS keyring unavailable')
  }

  Entry.prototype.getPassword = unavailable
  Entry.prototype.setPassword = unavailable
  safeStorage.isEncryptionAvailable = () => false
}

require('../../../dist/main/index.js')
