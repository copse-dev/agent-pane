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
 *
 * Both boundaries are replaced with `defineProperty` rather than `=`. A
 * non-writable descriptor turns assignment into a silent no-op outside strict
 * mode, and the app would then keep its real cipher while the fixture believed
 * it had removed one.
 */
if (process.env.COPSE_E2E_SECRET_STORAGE === 'unavailable') {
  const { Entry } = require('@napi-rs/keyring')
  const { safeStorage } = require('electron')
  const unavailable = () => {
    throw new Error('e2e fixture: OS keyring unavailable')
  }
  const encryptionUnavailable = () => false
  // Swallow a refused redefinition so the check below reports which boundary
  // resisted, rather than dying here with a bare "Cannot redefine property".
  const force = (target, name, value) => {
    try {
      Object.defineProperty(target, name, { value, writable: true, configurable: true })
    } catch {
      /* reported by the verification below */
    }
  }

  force(Entry.prototype, 'getPassword', unavailable)
  force(Entry.prototype, 'setPassword', unavailable)
  force(safeStorage, 'isEncryptionAvailable', encryptionUnavailable)

  // Prove the injection took, here, where the cause is still legible.
  //
  // Everything downstream of a patch that fails to land reports something
  // else: the cipher stays available, `setApiKey` succeeds, and the spec ends
  // up timing out on a UI string ("plaintext-disabled guidance never
  // appeared") that names neither boundary and looks like a renderer bug. The
  // keyring probe is behavioural — `new Entry()` does no I/O, and a fresh
  // instance is what the product builds — while safeStorage is only compared
  // by identity, because calling it before `app` is ready throws.
  const keyringPatched = (() => {
    try {
      new Entry('copse-e2e-probe', 'probe').getPassword()
      return false
    } catch {
      return true
    }
  })()
  const safeStoragePatched = safeStorage.isEncryptionAvailable === encryptionUnavailable
  if (!keyringPatched || !safeStoragePatched) {
    throw new Error(
      '[electron-shell] COPSE_E2E_SECRET_STORAGE=unavailable did not take: ' +
        `keyring=${keyringPatched ? 'patched' : 'STILL AVAILABLE'}, ` +
        `safeStorage=${safeStoragePatched ? 'patched' : 'STILL AVAILABLE'}`,
    )
  }
}

require('../../../dist/main/index.js')
