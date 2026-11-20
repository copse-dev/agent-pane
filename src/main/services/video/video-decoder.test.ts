import { after, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Module, { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'
import {
  VIDEO_DECODE_READY_CHANNEL,
  type DecodeFramesRequest,
} from '@shared/video/decode-contract.ts'
import { closeVideoDecoder, decodeVideoFrames, setVideoDecoderPlatform } from './video-decoder.ts'

// Stand the sidecar's Electron shim in for the `electron` module, as
// thread-passive-reads.test.ts does: its windows are plain event emitters, so a
// renderer crash and a window close can be raised by hand.
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
const originalElectron = require.cache[electronPath]
const electron = import('../../../sidecar/electron-shim/index.ts').then((shim) => {
  const module = new Module(electronPath)
  module.exports = shim
  require.cache[electronPath] = module
  return import('electron')
})

after(() => {
  if (originalElectron) require.cache[electronPath] = originalElectron
  else Reflect.deleteProperty(require.cache, electronPath)
})

async function installPlatform(): Promise<{
  windows: BrowserWindow[]
  reportReady: (window: BrowserWindow) => void
}> {
  const { BrowserWindow: ShimWindow, ipcMain } = await electron
  const windows: BrowserWindow[] = []
  setVideoDecoderPlatform({
    createWindow: (options) => {
      const window = new ShimWindow(options)
      // The page never loads here; whether it reports ready is up to the test.
      window.loadFile = (): Promise<void> => Promise.resolve()
      windows.push(window)
      return window
    },
    ipcMain,
    attachWebContentsLockdown: (): void => {},
  })
  return {
    windows,
    reportReady: (window): void => {
      ipcMain.emit(VIDEO_DECODE_READY_CHANNEL, { sender: window.webContents })
    },
  }
}

const INPUT: Omit<DecodeFramesRequest, 'requestId'> = {
  video: new Uint8Array(new ArrayBuffer(1)),
  mimeType: 'video/mp4',
  startSeconds: 0,
  endSeconds: null,
  sampleIntervalSeconds: null,
  maxSamples: 1,
  maxWidth: 320,
  quality: 0.8,
}

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

describe('video decoder window', () => {
  afterEach(() => {
    closeVideoDecoder()
    setVideoDecoderPlatform(null)
  })

  it('fails the decode when the window dies before it reports ready', async () => {
    const { windows } = await installPlatform()
    const decode = decodeVideoFrames(INPUT)
    await nextTurn()
    const first = windows[0]
    assert.ok(first, 'the decoder window was created')

    // The renderer crashes while the decoder page is still starting up.
    first.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await assert.rejects(decode, /closed before it was ready/)

    // The queue is not left waiting on the dead window: the next decode opens
    // a fresh one.
    const retry = decodeVideoFrames(INPUT)
    await nextTurn()
    assert.equal(windows.length, 2)
    windows[1]?.destroy()
    await assert.rejects(retry, /closed before it was ready/)
  })

  it('still reports a window that closes mid-decode as such', async () => {
    const { windows, reportReady } = await installPlatform()
    const decode = decodeVideoFrames(INPUT)
    await nextTurn()
    const window = windows[0]
    assert.ok(window)
    reportReady(window)
    await nextTurn()
    window.destroy()
    await assert.rejects(decode, /closed before the decode finished/)
  })
})
