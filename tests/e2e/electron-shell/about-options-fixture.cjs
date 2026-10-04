'use strict'

const fs = require('node:fs')
const { app } = require('electron')

/** Observe the real OS About-options call without replacing its behavior. */
exports.install = function (recordPath) {
  const original = app.setAboutPanelOptions.bind(app)
  app.setAboutPanelOptions = function (options) {
    original(options)
    fs.writeFileSync(recordPath, JSON.stringify(options), 'utf8')
  }
}
