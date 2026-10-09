'use strict'
const { ipcMain } = require('electron')

// Inject a transient transport failure at the real IPC boundary, not in product code.
exports.install = function install() {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    if (channel !== 'settings:get-snapshot') return handle(channel, listener)
    let failed = false
    return handle(channel, (...args) => {
      if (!failed) {
        failed = true
        throw new Error('Temporary settings connection failure')
      }
      return listener(...args)
    })
  }
}
