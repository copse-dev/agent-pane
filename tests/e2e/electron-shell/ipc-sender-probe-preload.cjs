'use strict'

// Deliberately available only through the test-shell session injection. Browser
// guests and diagram children do not have this IPC capability in production.
const { ipcRenderer } = require('electron')
ipcRenderer.on('sender-fixture:run', async (_event, label, roots) => {
  const results = {}
  for (const [channel, args] of [
    ['workspace:get', []],
    ['skills:set-roots', [roots]],
    ['lm-studio:models', []],
    ['usage:get-summary', []],
    ['gh:agent-pr-links', []],
  ]) {
    if (label === 'trusted-main' && channel === 'skills:set-roots') continue
    try {
      await ipcRenderer.invoke(channel, ...args)
      results[channel] = 'accepted'
    } catch (error) {
      results[channel] = String(error)
    }
  }
  ipcRenderer.send('perf:record', { t: 0, name: `sender-fixture:${label}`, kind: 'mark' })
  // A trusted frame can still send malformed or stale one-way IPC. None may
  // throw out of the main-process event listener and kill the app.
  if (label === 'trusted-main') {
    const missingId = '00000000-0000-4000-8000-000000000001'
    ipcRenderer.send('vnc:start', null)
    ipcRenderer.send('vnc:start', missingId)
    ipcRenderer.send('vnc:send', missingId, null)
    ipcRenderer.send('vnc:send', missingId, new Uint8Array([1]))
  }
  if (label !== 'trusted-main') {
    // Invalid payloads make a missed sender check fail before reaching VNC IO.
    ipcRenderer.send('vnc:start', null)
    ipcRenderer.send('vnc:send', null, null)
    ipcRenderer.send('plugins:browser-tab-ready', null)
    ipcRenderer.send('video-decoder:ready')
    ipcRenderer.send('video-decoder:result', null)
  }
  ipcRenderer.send('sender-fixture:result', { label, results })
})
ipcRenderer.send('sender-fixture:ready')
