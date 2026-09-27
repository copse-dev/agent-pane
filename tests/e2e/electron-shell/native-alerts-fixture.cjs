'use strict'

/**
 * Observe and drive the app's native alert boundary for an e2e spec.
 *
 * System notifications, the Dock/taskbar badge and hiding the window are OS
 * chrome that WebDriver cannot see or reach. Rather than adding a test-only
 * product API, this fixture sits at Electron's own boundary, beside the
 * secret-storage injection in bootstrap.cjs:
 *
 * - `Notification.isSupported` reports true and `Notification#show` records the
 *   product's own notification object instead of handing it to the OS (Linux
 *   runners have no notification daemon). A later "click" request emits `click`
 *   on that object, so the listener the product registered is what runs.
 * - `app.setBadgeCount` is wrapped, not replaced: the real call still happens
 *   and each call is recorded with what `app.getBadgeCount()` reports after it.
 * - A "hide" request hides the app window, as a user switching away would.
 *
 * The spec talks to it through files in `dir`: it writes `request.json`
 * (`{ id, action }`) and reads `events.jsonl`.
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Notification } = require('electron')

function install(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const eventsPath = path.join(dir, 'events.jsonl')
  const requestPath = path.join(dir, 'request.json')
  const record = (event) => {
    fs.appendFileSync(eventsPath, `${JSON.stringify({ ...event, at: Date.now() })}\n`)
  }
  const force = (target, name, value) => {
    Object.defineProperty(target, name, { value, writable: true, configurable: true })
  }

  const shown = []
  force(Notification, 'isSupported', () => true)
  force(Notification.prototype, 'show', function show() {
    shown.push(this)
    record({ type: 'notification', title: this.title, body: this.body })
  })

  const setBadgeCount = app.setBadgeCount.bind(app)
  force(app, 'setBadgeCount', (count) => {
    const accepted = setBadgeCount(count)
    record({ type: 'badge', requested: count, accepted, reported: app.getBadgeCount() })
    return accepted
  })

  const actions = {
    hide: () => {
      const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
      if (windows.length === 0) throw new Error('no window to hide')
      for (const win of windows) win.hide()
      return { visible: windows.map((win) => win.isVisible()) }
    },
    'click-notification': () => {
      const notification = shown.at(-1)
      if (!notification) throw new Error('no notification has been shown')
      notification.emit('click')
      return { title: notification.title }
    },
    'window-state': () => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      if (!win) throw new Error('no window')
      return { visible: win.isVisible(), focused: win.isFocused() }
    },
  }

  const poll = setInterval(() => {
    if (!fs.existsSync(requestPath)) return
    let request
    try {
      request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
      fs.rmSync(requestPath, { force: true })
    } catch {
      return // partially written; the next tick reads it whole
    }
    const action = actions[request.action]
    try {
      if (!action) throw new Error(`unknown action ${String(request.action)}`)
      record({ type: 'request', id: request.id, action: request.action, ok: true, ...action() })
    } catch (error) {
      record({
        type: 'request',
        id: request.id,
        action: request.action,
        ok: false,
        error: String(error),
      })
    }
  }, 50)
  poll.unref()
}

module.exports = { install }
