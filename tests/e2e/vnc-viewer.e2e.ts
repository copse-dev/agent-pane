import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { $, browser } from '@wdio/globals'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const WIDTH = 320
const HEIGHT = 180

function serverInit(): Buffer {
  const name = Buffer.from('Copse fake desktop', 'utf8')
  const message = Buffer.alloc(24 + name.length)
  message.writeUInt16BE(WIDTH, 0)
  message.writeUInt16BE(HEIGHT, 2)
  message[4] = 32
  message[5] = 24
  message[6] = 0
  message[7] = 1
  message.writeUInt16BE(255, 8)
  message.writeUInt16BE(255, 10)
  message.writeUInt16BE(255, 12)
  message[14] = 0
  message[15] = 8
  message[16] = 16
  message.writeUInt32BE(name.length, 20)
  name.copy(message, 24)
  return message
}

function framebufferUpdate(): Buffer {
  const header = Buffer.alloc(16)
  header[0] = 0
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(0, 4)
  header.writeUInt16BE(0, 6)
  header.writeUInt16BE(WIDTH, 8)
  header.writeUInt16BE(HEIGHT, 10)
  header.writeInt32BE(0, 12)
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4
      const left = x < WIDTH / 2
      pixels[offset] = left ? 255 : 0
      pixels[offset + 1] = left ? 90 : 74
      pixels[offset + 2] = left ? 165 : 70
      pixels[offset + 3] = 0
    }
  }
  return Buffer.concat([header, pixels])
}

function attachRfb38(socket: Socket): void {
  let state: 'version' | 'security' | 'client-init' | 'messages' = 'version'
  let buffered = Buffer.alloc(0)
  let painted = false
  socket.write('RFB 003.008\n')
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (state === 'version') {
        if (buffered.length < 12) return
        buffered = buffered.subarray(12)
        socket.write(Buffer.from([1, 1]))
        state = 'security'
        continue
      }
      if (state === 'security') {
        if (buffered.length < 1) return
        buffered = buffered.subarray(1)
        socket.write(Buffer.alloc(4))
        state = 'client-init'
        continue
      }
      if (state === 'client-init') {
        if (buffered.length < 1) return
        buffered = buffered.subarray(1)
        socket.write(serverInit())
        state = 'messages'
        continue
      }
      if (buffered.length < 1) return
      const messageType = buffered[0]
      let length: number
      if (messageType === 0) length = 20
      else if (messageType === 2) {
        if (buffered.length < 4) return
        length = 4 + buffered.readUInt16BE(2) * 4
      } else if (messageType === 3) length = 10
      else if (messageType === 150) length = 10
      else return
      if (buffered.length < length) return
      buffered = buffered.subarray(length)
      if (messageType === 3 && !painted) {
        painted = true
        socket.write(framebufferUpdate())
      }
    }
  })
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected fake VNC TCP address')
  return address.port
}

describe('read-only VNC viewer', function () {
  this.timeout(120_000)
  const sockets = new Set<Socket>()
  let server: Server
  let port = 0

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      attachRfb38(socket)
    })
    port = await listen(server)
    await browser.execute(async (workspaceRoot) => {
      await window.api.settings.set('onboardingCompleted', true)
      await window.api.settings.set('vncEnabled', true)
      const e2e = (
        window as unknown as {
          __copseE2e?: { openWorkspace: (root: string) => Promise<string> }
        }
      ).__copseE2e
      if (!e2e) throw new Error('__copseE2e unavailable')
      await e2e.openWorkspace(workspaceRoot)
    }, process.cwd())
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const onboardingClose = $('#onboarding-close')
    if (await onboardingClose.isDisplayed()) await onboardingClose.click()
    // The titlebar mounted before the live fixture enabled this experimental
    // setting. Mirror its normal settings_changed reconciliation without a
    // second Electron session, which is unreliable on local macOS WebDriver.
    await browser.execute(() => {
      const button = document.querySelector<HTMLElement>('[data-panel-control="vnc"]')
      button?.removeAttribute('hidden')
      button?.removeAttribute('data-experimental-hidden')
    })
  })

  after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('paints a fake RFB framebuffer without exposing input controls', async () => {
    const desktopButton = $('.titlebar-btn[aria-label="Open remote desktop"]')
    await desktopButton.waitForDisplayed({ timeout: 20_000 })
    await desktopButton.click()
    const portInput = $('.vnc-port-input')
    await portInput.waitForExist({ timeout: 20_000 })
    await portInput.setValue(String(port))
    await $('.vnc-connect-btn').click()

    await browser.waitUntil(async () => (await $('.vnc-status').getText()).includes('Connected'), {
      timeout: 20_000,
      timeoutMsg: 'expected the fake VNC server to finish the RFB handshake',
    })
    const canvas = $('.vnc-screen canvas')
    await canvas.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await canvas.getAttribute('width'), String(WIDTH))
    assert.equal(await canvas.getAttribute('height'), String(HEIGHT))
    assert.match(await $('.vnc-view-only-note').getText(), /Keyboard, pointer, and clipboard input/)

    const sampled = await browser.execute(() => {
      const painted = document.querySelector<HTMLCanvasElement>('.vnc-screen canvas')
      if (!painted) return null
      const context = painted.getContext('2d')
      if (!context) return null
      return {
        left: [...context.getImageData(40, 90, 1, 1).data],
        right: [...context.getImageData(280, 90, 1, 1).data],
      }
    })
    assert.deepEqual(sampled?.left, [255, 90, 165, 255])
    assert.deepEqual(sampled?.right, [0, 74, 70, 255])

    // The fake server listens on an ephemeral port. Normalize the disabled
    // field before capture so the reference PNG is stable across runs.
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('.vnc-port-input')
      if (input) input.value = '5901'
    })
    await saveElementScreenshot('#pane-files', 'vnc-viewer-read-only.png')
    await assertNoErrorToasts('read-only VNC viewer')
  })
})
