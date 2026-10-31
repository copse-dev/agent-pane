'use strict'

const { ipcMain } = require('electron')

// Replace discovery dependencies in the test launcher so first-run fallback
// acceptance does not depend on real model servers or agents on the host.
// Settings writes, key storage, the dialog, and completion IPC remain real.
exports.install = function install() {
  const handle = ipcMain.handle.bind(ipcMain)
  const responses = new Map([
    ['acp:detect-agents', () => []],
    ['lm-studio:test', () => ({ ok: false, models: [] })],
    [
      'lm-studio:detect',
      () => ({
        serverRunning: false,
        serverUrl: 'http://127.0.0.1:1/v1',
        installDetected: false,
        models: [],
        modelContexts: {},
        preferredPresent: [],
        preferredMissing: [],
      }),
    ],
  ])
  ipcMain.handle = (channel, listener) => handle(channel, responses.get(channel) ?? listener)
}
