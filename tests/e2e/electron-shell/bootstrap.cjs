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

require('../../../dist/main/index.js')
