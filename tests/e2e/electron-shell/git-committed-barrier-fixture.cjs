'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { ipcMain } = require('electron')

/** Keep candidate code untouched: hold the real IPC handler at registration. */
exports.install = function install(directory) {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    if (channel !== 'git:committed-changes') return handle(channel, listener)
    return handle(channel, async (...args) => {
      fs.writeFileSync(path.join(directory, 'started'), '')
      const deadline = Date.now() + 60_000
      while (!fs.existsSync(path.join(directory, 'release'))) {
        if (!fs.existsSync(directory)) throw new Error('e2e committed lookup barrier removed')
        if (Date.now() >= deadline) throw new Error('e2e committed lookup barrier timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return listener(...args)
    })
  }
}
