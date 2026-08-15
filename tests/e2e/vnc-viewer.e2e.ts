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

function attachRfb38AuthenticationFailure(socket: Socket): void {
  let state: 'version' | 'security' | 'response' | 'done' = 'version'
  let buffered = Buffer.alloc(0)
  socket.write('RFB 003.008\n')
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (state === 'version') {
        if (buffered.length < 12) return
        buffered = buffered.subarray(12)
        socket.write(Buffer.from([1, 2]))
        state = 'security'
        continue
      }
      if (state === 'security') {
        if (buffered.length < 1) return
        assert.equal(buffered[0], 2)
        buffered = buffered.subarray(1)
        socket.write(Buffer.alloc(16, 7))
        state = 'response'
        continue
      }
      if (state === 'response') {
        if (buffered.length < 16) return
        buffered = buffered.subarray(16)
        const reason = Buffer.from('The VNC password was rejected', 'utf8')
        const failure = Buffer.alloc(8)
        failure.writeUInt32BE(1, 0)
        failure.writeUInt32BE(reason.length, 4)
        socket.write(Buffer.concat([failure, reason]))
        state = 'done'
      }
      return
    }
  })
}

async function listenOn(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function listenOnVncPort(server: Server): Promise<number> {
  for (let port = 5999; port >= 5900; port--) {
    try {
      await listenOn(server, port)
      return port
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error
      }
    }
  }
  throw new Error('No conventional VNC port was available for the fake server')
}

describe('read-only VNC viewer', function () {
  this.timeout(120_000)
  const sockets = new Set<Socket>()
  let server: Server
  let authenticationServer: Server
  let port = 0
  let authenticationPort = 0

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
    port = await listenOnVncPort(server)
    authenticationServer = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      attachRfb38AuthenticationFailure(socket)
    })
    await browser.execute(async (workspaceRoot) => {
      await window.api.settings.set('onboardingCompleted', true)
      await window.api.settings.set('vncEnabled', true)
      // Saved SSH machines are reusable VNC targets even when remote-workspace
      // execution is disabled independently.
      await window.api.settings.set('sshWorkspaceEnabled', false)
      await window.api.settings.set('sshWorkspaceHosts', [
        {
          id: 'build-box',
          label: 'Build box',
          host: 'build.example',
          user: 'ubuntu',
        },
      ])
      const e2e = (
        window as unknown as {
          __copseE2e?: {
            openWorkspace: (root: string) => Promise<string>
            setVncNearbyServers: (servers: unknown) => Promise<void>
          }
        }
      ).__copseE2e
      if (!e2e) throw new Error('__copseE2e unavailable')
      await e2e.setVncNearbyServers([
        {
          name: 'Studio Mac',
          host: 'studio.local',
          port: 5900,
          addresses: ['192.168.1.20'],
        },
        {
          name: 'Build box',
          host: 'build.example',
          port: 5900,
          addresses: ['192.168.1.40'],
        },
      ])
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
    await Promise.all(
      [server, authenticationServer].map(
        (runningServer) =>
          new Promise<void>((resolve) => {
            if (!runningServer.listening) {
              resolve()
              return
            }
            runningServer.close(() => resolve())
          }),
      ),
    )
  })

  it('paints a fake RFB framebuffer without exposing input controls', async () => {
    const desktopButton = $('.titlebar-btn[aria-label="Open remote desktop"]')
    await desktopButton.waitForDisplayed({ timeout: 20_000 })
    await desktopButton.click()
    const portInput = $('.vnc-port-input')
    await portInput.waitForExist({ timeout: 20_000 })
    const advanced = $('.vnc-advanced')
    const advancedSummary = $('.vnc-advanced summary')
    assert.equal(await advanced.getAttribute('open'), null)
    assert.equal(await portInput.isDisplayed(), false)
    await $('.vnc-machine-select option[value="network:nearby:0"]').waitForExist({
      timeout: 20_000,
    })
    const machineOptions = await browser.execute(() =>
      [...document.querySelectorAll<HTMLOptionElement>('.vnc-machine-select option')].map(
        (option) => option.textContent,
      ),
    )
    assert.deepEqual(machineOptions, [
      'This machine',
      'Studio Mac · studio.local:5900',
      'Other address…',
      'Build box · ubuntu@build.example',
    ])
    assert.match(await $('.vnc-nearby-status').getText(), /1 matched to saved SSH/i)

    const machineSelect = $('.vnc-machine-select')
    await machineSelect.selectByAttribute('value', 'network:manual')
    const addressInput = $('.vnc-address-input')
    await addressInput.waitForDisplayed()
    assert.equal(await portInput.getValue(), '5900')
    await addressInput.setValue('192.168.1.20:5901')
    assert.match(await $('.vnc-network-warning').getText(), /unencrypted/i)
    await $('.vnc-connect-btn').click()
    const confirmDialog = $('#confirm-dialog')
    await confirmDialog.waitForDisplayed()
    assert.match(await $('.confirm-dialog-message').getText(), /192\.168\.1\.20:5901/)
    assert.match(await $('.confirm-dialog-detail').getText(), /does not encrypt/i)
    await $('.confirm-dialog-cancel').click()
    await machineSelect.selectByAttribute('value', 'local')

    const discoveredServer = $(`.vnc-discovered-port[data-port="${String(port)}"]`)
    await discoveredServer.waitForExist({ timeout: 20_000 })
    authenticationPort = await listenOnVncPort(authenticationServer)
    await advancedSummary.click()
    await portInput.waitForDisplayed()
    await portInput.setValue(String(authenticationPort))
    await advancedSummary.click()
    await browser.waitUntil(async () => !(await portInput.isDisplayed()))
    await $('.vnc-connect-btn').click()
    const authPanel = $('.vnc-auth-panel')
    await authPanel.waitForDisplayed({ timeout: 20_000 })
    assert.equal(await $('.vnc-auth-title').getText(), 'Authentication required')
    assert.match(await $('.vnc-auth-description').getText(), /VNC password/i)
    assert.equal(await $('.vnc-status').isDisplayed(), false)
    assert.equal(await $('.vnc-username-field').isDisplayed(), false)
    assert.equal(await $('.vnc-password-field').isDisplayed(), true)
    assert.equal(await $('.vnc-disconnect-btn').getText(), 'Cancel')
    await saveElementScreenshot('#pane-files', 'vnc-viewer-auth-required.png')

    await $('.vnc-password-input').setValue('incorrect-password')
    await $('.vnc-authenticate-btn').click()
    assert.equal(await $('.vnc-password-input').getValue(), '')
    await browser.waitUntil(
      async () => (await $('.vnc-status-title').getText()) === 'Authentication failed',
      {
        timeout: 20_000,
        timeoutMsg: 'expected the rejected VNC password to remain visible after disconnect',
      },
    )
    assert.equal(await authPanel.isDisplayed(), false)
    assert.match(await $('.vnc-status-detail').getText(), /check the VNC password/i)
    assert.match(await $('.vnc-status-detail').getText(), /password was rejected/i)
    await saveElementScreenshot('#pane-files', 'vnc-viewer-auth-failed.png')

    await advancedSummary.click()
    await portInput.waitForDisplayed()
    await portInput.setValue(String(port))
    assert.equal(await portInput.getValue(), String(port))
    await advancedSummary.click()
    await browser.waitUntil(async () => !(await portInput.isDisplayed()))
    assert.equal(
      await discoveredServer.getAttribute('aria-label'),
      `Display :${String(port - 5900)}, port ${String(port)}`,
    )
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

    // Show the nearby-device state in the visual reference. The connection was
    // made locally above so the fake server still validates the real RFB path.
    await browser.execute(() => {
      const machine = document.querySelector<HTMLSelectElement>('.vnc-machine-select')
      if (machine) {
        machine.value = 'network:nearby:0'
        machine.dispatchEvent(new Event('change'))
      }
    })
    await saveElementScreenshot('#pane-files', 'vnc-viewer-read-only.png')
    await assertNoErrorToasts('read-only VNC viewer')
  })
})
