'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Written by `wdio.eval.conf.ts` so Electron gets eval env before `app-init` runs. */
const evalEnvFile = path.join(__dirname, '.eval-env.json')
if (fs.existsSync(evalEnvFile)) {
  try {
    const overrides = JSON.parse(fs.readFileSync(evalEnvFile, 'utf8'))
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined && value !== null) {
        process.env[key] = String(value)
      }
    }
  } catch (err) {
    console.error('[electron-shell] Failed to apply .eval-env.json:', err)
  }
}

require('../../../dist/main/index.js')
