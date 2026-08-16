import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { $, browser } from '@wdio/globals'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const WIDTH = 320
const HEIGHT = 180

type RfbInputEvent =
  | { kind: 'key'; down: boolean; keysym: number }
  | { kind: 'pointer'; buttons: number; x: number; y: number }

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

function attachRfb38(socket: Socket, onInput: (event: RfbInputEvent) => void): void {
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
      else if (messageType === 4) length = 8
      else if (messageType === 5) length = 6
      else if (messageType === 150) length = 10
      else return
      if (buffered.length < length) return
      const message = buffered.subarray(0, length)
      buffered = buffered.subarray(length)
      if (messageType === 3 && !painted) {
        painted = true
        socket.write(framebufferUpdate())
      } else if (messageType === 4) {
        onInput({ kind: 'key', down: message[1] !== 0, keysym: message.readUInt32BE(4) })
      } else if (messageType === 5) {
        onInput({
          kind: 'pointer',
          buttons: message[1] ?? 0,
          x: message.readUInt16BE(2),
          y: message.readUInt16BE(4),
        })
      }
    }
  })
}

function attachRfb38AuthenticationFailure(
  socket: Socket,
  onUsername: (username: string) => void,
): void {
  let state:
    'version' | 'security' | 'vencrypt-version' | 'vencrypt-subtype' | 'credentials' | 'done' =
    'version'
  let buffered = Buffer.alloc(0)
  socket.write('RFB 003.008\n')
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    for (;;) {
      if (state === 'version') {
        if (buffered.length < 12) return
        buffered = buffered.subarray(12)
        socket.write(Buffer.from([1, 19]))
        state = 'security'
        continue
      }
      if (state === 'security') {
        if (buffered.length < 1) return
        assert.equal(buffered[0], 19)
        buffered = buffered.subarray(1)
        socket.write(Buffer.from([0, 2]))
        state = 'vencrypt-version'
        continue
      }
      if (state === 'vencrypt-version') {
        if (buffered.length < 2) return
        assert.deepEqual([...buffered.subarray(0, 2)], [0, 2])
        buffered = buffered.subarray(2)
        const subtype = Buffer.alloc(6)
        subtype[0] = 0
        subtype[1] = 1
        subtype.writeUInt32BE(256, 2)
        socket.write(subtype)
        state = 'vencrypt-subtype'
        continue
      }
      if (state === 'vencrypt-subtype') {
        if (buffered.length < 4) return
        assert.equal(buffered.readUInt32BE(0), 256)
        buffered = buffered.subarray(4)
        state = 'credentials'
        continue
      }
      if (state === 'credentials') {
        if (buffered.length < 8) return
        const usernameLength = buffered.readUInt32BE(0)
        const passwordLength = buffered.readUInt32BE(4)
        const messageLength = 8 + usernameLength + passwordLength
        if (buffered.length < messageLength) return
        onUsername(buffered.subarray(8, 8 + usernameLength).toString('utf8'))
        buffered = buffered.subarray(messageLength)
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

describe('VNC viewer', function () {
  this.timeout(120_000)
  const sockets = new Set<Socket>()
  const inputEvents: RfbInputEvent[] = []
  let server: Server
  let authenticationServer: Server
  let port = 0
  let authenticationPort = 0
  let authenticationUsername = ''

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      attachRfb38(socket, (event) => {
        inputEvents.push(event)
      })
    })
    port = await listenOnVncPort(server)
    authenticationServer = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      attachRfb38AuthenticationFailure(socket, (username) => {
        authenticationUsername = username
      })
    })
    await browser.execute(async (workspaceRoot) => {
      await window.api.settings.set('onboardingCompleted', true)
      await window.api.settings.set('vncEnabled', true)
      // Saved SSH machines are reusable VNC targets even when remote-workspace
      // execution is disabled independently.
      await window.api.settings.set('sshWorkspaceEnabled', false)
      await window.api.settings.set('sshWorkspaceHosts', [
        {
          id: 'kingston-mac-mini',
          label: 'kingston-mac-mini',
          host: 'localhost',
          user: 'jonathankingston',
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
          name: 'Jonathan’s Mac mini',
          host: 'test-mac-box.local',
          port: 5900,
          addresses: ['127.0.0.1'],
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

  it('paints, controls, shares, and tabs fake RFB desktops', async () => {
    const desktopButton = $('.titlebar-btn[aria-label="Open remote desktop"]')
    await desktopButton.waitForDisplayed({ timeout: 20_000 })
    await desktopButton.click()
    const portInput = $('.vnc-port-input')
    await portInput.waitForExist({ timeout: 20_000 })
    assert.equal(await $$('.vnc-tab').length, 1)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'Desktop 1')
    assert.equal(await $('.vnc-tabs-new-btn').getAttribute('aria-label'), 'New desktop tab')
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
      'kingston-mac-mini · jonathankingston@localhost',
    ])
    assert.doesNotMatch(machineOptions.join('\n'), /test-mac-box/)
    assert.match(await $('.vnc-nearby-status').getText(), /1 matched to saved SSH/i)

    const machineSelect = $('.vnc-machine-select')
    const previousFilesWidth = await browser.execute(() => {
      const body = document.getElementById('body')
      const previous = body?.style.getPropertyValue('--files-width') ?? ''
      body?.style.setProperty('--files-width', '700px')
      document.querySelector<HTMLSelectElement>('.vnc-machine-select')?.setAttribute('size', '6')
      window.dispatchEvent(new Event('resize'))
      return previous
    })
    await saveAppScreenshot('vnc-viewer-deduped-machines.png')
    await browser.execute((filesWidth) => {
      const body = document.getElementById('body')
      if (filesWidth) body?.style.setProperty('--files-width', filesWidth)
      else body?.style.removeProperty('--files-width')
      document.querySelector<HTMLSelectElement>('.vnc-machine-select')?.removeAttribute('size')
      window.dispatchEvent(new Event('resize'))
    }, previousFilesWidth)
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

    await browser.waitUntil(
      async () => (await $('.vnc-discovery-status').getText()) === 'Screen sharing is available.',
      {
        timeout: 20_000,
        timeoutMsg: 'expected local screen sharing discovery to complete',
      },
    )
    assert.equal(await $('.vnc-discovered-ports').isDisplayed(), false)
    assert.equal(await $$('.vnc-discovered-port').length, 0)
    authenticationPort = await listenOnVncPort(authenticationServer)
    assert.equal(
      await browser.execute(
        (targetPort) =>
          window.api.vnc.rememberUsername(
            { kind: 'loopback', port: targetPort },
            'remembered-user',
          ),
        authenticationPort,
      ),
      true,
    )
    await advancedSummary.click()
    await portInput.waitForDisplayed()
    assert.equal(await portInput.getValue(), String(port))
    await portInput.setValue(String(authenticationPort))
    await advancedSummary.click()
    await browser.waitUntil(async () => !(await portInput.isDisplayed()))
    await $('.vnc-connect-btn').click()
    const authPanel = $('.vnc-auth-panel')
    await authPanel.waitForDisplayed({ timeout: 20_000 })
    assert.equal(await $('.vnc-auth-title').getText(), 'Authentication required')
    assert.match(await $('.vnc-auth-description').getText(), /allowed account/i)
    assert.equal(await $('.vnc-setup-fields').isDisplayed(), false)
    assert.equal(await $('.vnc-status').isDisplayed(), false)
    assert.equal(await $('.vnc-username-field').isDisplayed(), true)
    assert.equal(await $('.vnc-username-input').getValue(), 'remembered-user')
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
    assert.equal(authenticationUsername, 'remembered-user')
    assert.match(await $('.vnc-status-detail').getText(), /check the Screen Sharing password/i)
    assert.match(await $('.vnc-status-detail').getText(), /password was rejected/i)
    await saveElementScreenshot('#pane-files', 'vnc-viewer-auth-failed.png')

    await advancedSummary.click()
    await portInput.waitForDisplayed()
    await portInput.setValue(String(port))
    assert.equal(await portInput.getValue(), String(port))
    await advancedSummary.click()
    await browser.waitUntil(async () => !(await portInput.isDisplayed()))
    await $('.vnc-connect-btn').click()

    await browser.waitUntil(async () => (await $('.vnc-status').getText()).includes('Connected'), {
      timeout: 20_000,
      timeoutMsg: 'expected the fake VNC server to finish the RFB handshake',
    })
    const canvas = $('.vnc-screen canvas')
    await canvas.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await canvas.getAttribute('width'), String(WIDTH))
    assert.equal(await canvas.getAttribute('height'), String(HEIGHT))
    assert.equal(await $('.vnc-status-title').getText(), 'Connected to this machine')
    assert.match(
      await $('.vnc-status-detail').getText(),
      /View only.*keyboard and mouse control are off/i,
    )
    assert.equal(await $('.vnc-setup-fields').isDisplayed(), false)
    assert.equal(await $('.vnc-connect-btn').isDisplayed(), false)
    assert.equal(await $('.vnc-view-only-note').isDisplayed(), false)
    assert.equal(await $('.vnc-disconnect-btn').getText(), 'Disconnect')
    const controlButton = $('.vnc-control-btn')
    assert.equal(await controlButton.isDisplayed(), true)
    assert.equal(await controlButton.getText(), 'Control desktop')
    assert.equal(await controlButton.getAttribute('aria-pressed'), 'false')
    assert.equal(await $('.vnc-controls-host .git-changes-title').isDisplayed(), true)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'This machine')

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
    await browser.execute(() => window.scrollTo(0, 0))
    await saveElementScreenshot('#pane-files', 'vnc-viewer-read-only.png')

    await controlButton.click()
    assert.equal(await controlButton.getText(), 'Stop controlling')
    assert.equal(await controlButton.getAttribute('aria-pressed'), 'true')
    assert.match(await $('.vnc-status-detail').getText(), /mouse and keyboard control are on/i)
    assert.equal(
      await $('.vnc-tab.is-active').getAttribute('aria-label'),
      'This machine, mouse and keyboard control on',
    )
    assert.equal(await $('.vnc-screen').getAttribute('class'), 'vnc-screen is-controlling')
    await canvas.click()
    await browser.keys('a')
    await browser.waitUntil(
      () =>
        inputEvents.some((event) => event.kind === 'pointer' && event.buttons === 1) &&
        inputEvents.some((event) => event.kind === 'pointer' && event.buttons === 0) &&
        inputEvents.some((event) => event.kind === 'key' && event.down && event.keysym === 97) &&
        inputEvents.some((event) => event.kind === 'key' && !event.down && event.keysym === 97),
      {
        timeout: 5_000,
        timeoutMsg: 'expected noVNC to forward pointer and keyboard input while control is on',
      },
    )
    await canvas.click({ button: 'right' })
    await browser.waitUntil(
      () => inputEvents.some((event) => event.kind === 'pointer' && event.buttons === 4),
      {
        timeout: 5_000,
        timeoutMsg: 'expected right-click to reach the remote desktop while control is on',
      },
    )
    assert.equal(await $('.context-menu').isExisting(), false)
    await browser.execute(() => window.scrollTo(0, 0))
    await saveElementScreenshot('#pane-files', 'vnc-viewer-control-enabled.png')

    await controlButton.click()
    assert.equal(await controlButton.getText(), 'Control desktop')
    assert.equal(await controlButton.getAttribute('aria-pressed'), 'false')
    assert.match(await $('.vnc-status-detail').getText(), /view only/i)
    assert.equal(await $('.vnc-screen').getAttribute('class'), 'vnc-screen')

    await canvas.click({ button: 'right' })
    const shareMenu = $('.context-menu')
    await shareMenu.waitForDisplayed({ timeout: 5_000 })
    assert.equal(await $('.context-menu-item').getText(), 'Share screen with model')
    await saveElementScreenshot('.context-menu', 'vnc-viewer-share-screen-menu.png')
    await $('.context-menu-item').click()
    await expect(shareMenu).not.toBeExisting()
    const sharedScreen = $('.attachment-chips .image-chip img')
    await sharedScreen.waitForDisplayed({ timeout: 5_000 })
    assert.match(await sharedScreen.getAttribute('src'), /^data:image\/png;base64,/)
    assert.deepEqual(
      await browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>('.attachment-chips .image-chip img')
        return image ? { width: image.naturalWidth, height: image.naturalHeight } : null
      }),
      { width: WIDTH, height: HEIGHT },
    )
    await saveAppScreenshot('vnc-viewer-shared-screen.png')
    await $('.toast').waitForExist({ reverse: true, timeout: 5_000 })

    await $('.vnc-tabs-new-btn').click()
    assert.equal(await $$('.vnc-tab').length, 2)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'Desktop 2')
    assert.equal(await $$('.vnc-viewer-panel .vnc-screen canvas').length, 1)
    assert.equal(await $('.vnc-viewer-panel:not([hidden]) .vnc-screen canvas').isExisting(), false)

    const secondControls = '.vnc-controls-panel:not([hidden])'
    const secondPortInput = $(`${secondControls} .vnc-port-input`)
    const secondAdvancedSummary = $(`${secondControls} .vnc-advanced summary`)
    await secondPortInput.waitForExist({ timeout: 20_000 })
    await secondAdvancedSummary.click()
    await secondPortInput.waitForDisplayed()
    await secondPortInput.setValue(String(port))
    await secondAdvancedSummary.click()
    await $(`${secondControls} .vnc-connect-btn`).click()
    await browser.waitUntil(
      async () => (await $(`${secondControls} .vnc-status-title`).getText()).includes('Connected'),
      {
        timeout: 20_000,
        timeoutMsg: 'expected the second VNC tab to connect independently',
      },
    )

    assert.deepEqual(await $$('.vnc-tab-label').map((label) => label.getText()), [
      'This machine 1',
      'This machine 2',
    ])
    assert.equal(await $$('.vnc-viewer-panel .vnc-screen canvas').length, 2)
    assert.equal(await $('.vnc-viewer-panel:not([hidden]) .vnc-screen canvas').isDisplayed(), true)
    assert.equal(await $('.vnc-viewer-panel[hidden] .vnc-screen canvas').isDisplayed(), false)
    await browser.execute(() => window.scrollTo(0, 0))
    await saveElementScreenshot('#pane-files', 'vnc-viewer-tabs.png')

    await $$('.vnc-tab')[0].click()
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'This machine 1')
    assert.equal(
      await $('.vnc-controls-panel:not([hidden]) .vnc-status-title').getText(),
      'Connected to this machine',
    )
    await $$('.vnc-tab')[1].click()
    await $('.vnc-tab.is-active .vnc-tab-close').click()
    assert.equal(await $$('.vnc-tab').length, 1)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'This machine')
    assert.equal(await $$('.vnc-viewer-panel .vnc-screen canvas').length, 1)
    assert.equal(
      await $('.vnc-controls-panel:not([hidden]) .vnc-status-title').getText(),
      'Connected to this machine',
    )

    await assertNoErrorToasts('VNC viewer')
  })
})
