'use strict'

const fs = require('node:fs')
const path = require('node:path')
const electron = require('electron')
const moduleLoader = require('node:module')
const { app, ipcMain, session } = electron

exports.install = function install(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const record = (value) =>
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(value)}\n`)
  const frames = new Map()
  const anonymous = []
  const OriginalWindow = electron.BrowserWindow
  // Deliberate test-only exposure: run the session preload in app subframes as
  // well. Production leaves nodeIntegrationInSubFrames disabled. Do not treat
  // this injected bridge as evidence of a production guest capability.
  const injectedElectron = {
    ...electron,
    BrowserWindow: class extends OriginalWindow {
      constructor(options) {
        const isApp = options?.webPreferences?.preload?.endsWith('/preload/index.js')
        super(
          isApp
            ? {
                ...options,
                webPreferences: { ...options.webPreferences, nodeIntegrationInSubFrames: true },
              }
            : options,
        )
      }
    },
  }
  // Electron's constructor export is non-configurable. Substitute the module
  // at the launcher's dependency boundary, without modifying the native export.
  const load = moduleLoader._load
  moduleLoader._load = function (request, ...args) {
    return request === 'electron' ? injectedElectron : load.call(this, request, ...args)
  }
  const injected = new WeakSet()
  const inject = (ses) => {
    if (injected.has(ses)) return
    injected.add(ses)
    ses.registerPreloadScript({
      type: 'frame',
      filePath: path.join(__dirname, 'ipc-sender-probe-preload.cjs'),
    })
  }
  app.on('session-created', inject)
  void app.whenReady().then(() => inject(session.defaultSession))
  const identity = (event) => ({
    contentsId: event.sender.id,
    contentsType: event.sender.getType(),
    isMainFrame: event.senderFrame === event.sender.mainFrame,
    frameUrl: event.senderFrame?.url ?? null,
  })
  ipcMain.on('sender-fixture:ready', (event) => {
    if (!event.senderFrame) return
    const info = identity(event)
    frames.set(`${event.senderFrame.processId}:${event.senderFrame.routingId}`, {
      frame: event.senderFrame,
      info,
    })
    record({ type: 'ready', ...info })
  })
  ipcMain.on('sender-fixture:result', (event, result) => {
    record({ type: 'result', ...identity(event), ...result })
  })
  const timer = setInterval(() => {
    const command = path.join(dir, 'run.json')
    if (!fs.existsSync(command)) return
    const input = JSON.parse(fs.readFileSync(command, 'utf8'))
    fs.unlinkSync(command)
    if (input.createUnregistered) {
      const win = new OriginalWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true },
      })
      anonymous.push(win)
      void win.loadURL('about:blank')
      return
    }
    for (const { frame, info } of frames.values()) {
      if (frame.detached) continue
      let label
      if (info.contentsType === 'webview') label = 'guest'
      else if (!info.isMainFrame) label = 'child'
      else if (info.frameUrl === 'about:blank') label = 'unregistered'
      else if (info.frameUrl.includes('/index.html')) label = 'trusted-main'
      if (label) frame.send('sender-fixture:run', label, input.roots)
    }
  }, 50)
  timer.unref()
  app.on('before-quit', () => {
    for (const win of anonymous) if (!win.isDestroyed()) win.destroy()
  })
}
