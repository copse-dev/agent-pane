'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { ipcMain } = require('electron')

// Delay the real read-only response at the IPC boundary; product APIs stay unchanged.
exports.install = function install(directory) {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    if (channel !== 'plugins:list') return handle(channel, listener)
    return handle(channel, async (...args) => {
      const result = await listener(...args)
      if (!fs.existsSync(path.join(directory, 'hold'))) return result
      fs.writeFileSync(path.join(directory, 'started'), '')
      const deadline = Date.now() + 60_000
      while (!fs.existsSync(path.join(directory, 'release'))) {
        if (!fs.existsSync(directory)) throw new Error('Project-menu test barrier removed')
        if (Date.now() >= deadline) throw new Error('Project-menu test barrier timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return result
    })
  }
}
