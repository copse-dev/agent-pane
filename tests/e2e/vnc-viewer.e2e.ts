import { at } from '@copse/std/array-utils.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { $, browser } from '@wdio/globals'
import { seedStableWorkspace } from './helpers/seed-config.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { assertCheckboxBesideLabel } from './helpers/checkbox-row.ts'
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
    | 'version'
    | 'security'
    | 'vencrypt-version'
    | 'vencrypt-subtype'
    | 'credentials'
    | 'done' = 'version'
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

/** The VNC severity recipe as rendered: gutter dot, title hue, and the tokens. */
async function readVncSeverity(
  containerSelector: string,
  titleSelector: string,
): Promise<{
  titleColor: string
  dotColor: string
  gutter: string
  columnGap: string
  icons: number
  tokens: { warning: string; error: string; accent: string }
} | null> {
  return browser.execute(
    (container, title) => {
      const host = document.querySelector<HTMLElement>(container)
      const heading = host?.querySelector<HTMLElement>(title)
      const dot = host?.querySelector<HTMLElement>(':scope > .vnc-status-dot')
      if (!host || !heading || !dot) return null
      const resolve = (token: string): string => {
        const probe = document.createElement('span')
        probe.style.color = `var(${token})`
        host.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }
      const style = getComputedStyle(host)
      return {
        titleColor: getComputedStyle(heading).color,
        dotColor: getComputedStyle(dot).backgroundColor,
        gutter: style.gridTemplateColumns.split(' ')[0] ?? '',
        columnGap: style.columnGap,
        icons: host.querySelectorAll(':scope > svg').length,
        tokens: {
          warning: resolve('--warning'),
          error: resolve('--error'),
          accent: resolve('--accent'),
        },
      }
    },
    containerSelector,
    titleSelector,
  )
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
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
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
          id: 'studio-mac-mini',
          label: 'studio-mac-mini',
          host: 'localhost',
          user: 'alexandra-morgan',
        },
      ])
      const e2e = window.__copseE2e
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
    }, seedStableWorkspace())
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
            runningServer.close(() => {
              resolve()
            })
          }),
      ),
    )
  })

  it('paints, controls, shares, and tabs fake RFB desktops', async () => {
    const desktopButton = $('.titlebar-btn[aria-label="Open remote desktop"]')
    await desktopButton.waitForDisplayed({ timeout: 20_000 })
    await desktopButton.click()
    const portInput = $('.vnc-port-input')
    assert.equal(await $$('.vnc-tab').length, 1)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'Desktop 1')
    assert.equal(await $('.vnc-tabs-new-btn').getAttribute('aria-label'), 'New desktop tab')
    assert.equal(await portInput.isExisting(), false)
    const advanced = $('.vnc-advanced')
    const advancedSummary = $('.vnc-advanced summary')
    await $('.vnc-machine-select option[value="network:nearby:0"]').waitForExist({
      timeout: 20_000,
    })
    const machineOptions = await browser.execute(() =>
      [...document.querySelectorAll<HTMLOptionElement>('.vnc-machine-select option')].map(
        (option) => option.textContent,
      ),
    )
    assert.deepEqual(machineOptions, [
      'Studio Mac · studio.local:5900',
      'Other address…',
      'studio-mac-mini · alexandra-morgan@localhost',
    ])
    assert.doesNotMatch(machineOptions.join('\n'), /test-mac-box/)
    assert.equal(await $('.vnc-nearby-status').isDisplayed(), false)
    assert.equal(await $('.vnc-nearby-btn').isDisplayed(), false)
    const deviceSummaries = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('.vnc-device')].map((item) => ({
        name: item.querySelector('.vnc-device-name')?.textContent ?? '',
        meta: item.querySelector('.vnc-device-meta')?.textContent ?? '',
      })),
    )
    assert.deepEqual(
      deviceSummaries.map(({ name }) => name),
      ['Studio Mac', 'Add device', 'studio-mac-mini'],
    )
    assert.equal(deviceSummaries.length, 3)
    assert.equal(await $$('.vnc-device.is-selected').length, 0)
    assert.equal(await $('.vnc-discovery-status').isDisplayed(), false)
    assert.match(deviceSummaries[0]?.meta ?? '', /Nearby.*studio\.local:5900/i)
    assert.match(deviceSummaries[2]?.meta ?? '', /Saved SSH.*alexandra-morgan@localhost/i)

    const previousFilesWidth = await browser.execute(() => {
      const body = document.getElementById('body')
      const previous = body?.style.getPropertyValue('--files-width') ?? ''
      body?.style.setProperty('--files-width', '520px')
      window.dispatchEvent(new Event('resize'))
      return previous
    })
    await saveAppScreenshot('vnc-viewer-deduped-machines.png')
    await browser.execute((filesWidth) => {
      const body = document.getElementById('body')
      if (filesWidth) body?.style.setProperty('--files-width', filesWidth)
      else body?.style.removeProperty('--files-width')
      window.dispatchEvent(new Event('resize'))
    }, previousFilesWidth)
    await $('.vnc-device-header[data-machine="network:manual"]').click()
    await portInput.waitForExist()
    assert.equal(await advanced.getAttribute('open'), null)
    assert.equal(await portInput.isDisplayed(), false)
    const addressInput = $('.vnc-address-input')
    await addressInput.waitForDisplayed()
    assert.equal(await $('.vnc-device.is-selected .vnc-device-name').getText(), 'Add device')
    assert.equal(
      await $('.vnc-device.is-selected .vnc-device-header').getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(await $('.vnc-network-warning').isDisplayed(), false)
    assert.equal(await $('.vnc-setup-username-field').isDisplayed(), true)
    assert.equal(await $('.vnc-setup-password-field').isDisplayed(), true)
    assert.equal(await $('.vnc-connect-btn').getText(), 'Sign in & connect')
    assert.equal(await portInput.getValue(), '5900')
    await saveElementScreenshot('#pane-files', 'vnc-viewer-add-device.png')
    await addressInput.setValue('192.168.1.20:5901')
    assert.match(await $('.vnc-network-warning').getText(), /unencrypted/i)
    await $('.vnc-connect-btn').click()
    const confirmDialog = $('#confirm-dialog')
    await confirmDialog.waitForDisplayed()
    assert.match(await $('.confirm-dialog-message').getText(), /192\.168\.1\.20:5901/)
    assert.match(await $('.confirm-dialog-detail').getText(), /does not encrypt/i)
    await $('.confirm-dialog-cancel').click()
    await addressInput.setValue('localhost')
    assert.equal(await $('.vnc-network-warning').isDisplayed(), false)
    assert.equal(await $('.vnc-discovery-status').isDisplayed(), false)
    authenticationPort = await listenOnVncPort(authenticationServer)
    const rememberedUsername = await browser.execute(
      (targetPort) =>
        window.api.vnc.rememberUsername({ kind: 'loopback', port: targetPort }, 'remembered-user'),
      authenticationPort,
    )
    await advancedSummary.click()
    await portInput.waitForDisplayed()
    assert.equal(await portInput.getValue(), '5900')
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
    const usernameInput = $('.vnc-username-input')
    assert.equal(await usernameInput.getValue(), rememberedUsername ? 'remembered-user' : '')
    // Linux CI has no OS-backed secret cipher, so refusing to persist is the
    // secure outcome. Enter the same username explicitly and keep exercising
    // the authentication handshake on either platform.
    if (!rememberedUsername) await usernameInput.setValue('remembered-user')
    assert.equal(await $('.vnc-password-field').isDisplayed(), true)
    const secureCredentialStorage = await browser.execute(() =>
      window.api.vnc.canStoreCredentials(),
    )
    assert.equal(await $('.vnc-remember-password').isDisplayed(), secureCredentialStorage)
    if (secureCredentialStorage) {
      assert.match(await $('.vnc-remember-password').getText(), /remember password securely/i)
      assert.equal(await $('.vnc-remember-password-input').isSelected(), true)
    }
    // "Remember password" is a checkbox line: the box sits beside its wording,
    // not stacked above it by forms.css's column `label`. Linux CI has no
    // secure store, so the product keeps the line hidden there; its layout is
    // still pure CSS on the real node, so show it for the measurement and
    // hand the panel back exactly as the product left it.
    if (!secureCredentialStorage) {
      await browser.execute(() => {
        const field = document.querySelector<HTMLElement>('.vnc-remember-password')
        if (field) field.hidden = false
      })
    }
    await assertCheckboxBesideLabel('.vnc-remember-password')
    await saveElementScreenshot('.vnc-auth-panel', 'vnc-viewer-remember-password-row.png')
    if (!secureCredentialStorage) {
      await browser.execute(() => {
        const field = document.querySelector<HTMLElement>('.vnc-remember-password')
        if (field) field.hidden = true
      })
    }
    assert.equal(await $('.vnc-disconnect-btn').getText(), 'Cancel')
    await saveElementScreenshot('#pane-files', 'vnc-viewer-auth-required.png')
    // One severity recipe (#3065): "Authentication required" is a blocking ask,
    // marked like every VNC status line — a 6px gutter dot with the title in
    // the same hue — and that hue is --warning, never the pink accent.
    const authMarker = await readVncSeverity(
      '.vnc-controls-panel:not([hidden]) .vnc-auth-panel',
      '.vnc-auth-title',
    )
    assert.ok(authMarker, 'the auth panel must render its severity dot and title')
    assert.equal(authMarker.icons, 0, 'the auth panel no longer carries a lock-icon gutter')
    assert.equal(authMarker.titleColor, authMarker.tokens.warning)
    assert.notEqual(authMarker.titleColor, authMarker.tokens.accent)
    assert.equal(authMarker.dotColor, authMarker.titleColor)
    assert.equal(authMarker.gutter, '6px')
    // Every auth field's text is in the interface font: no monospace username
    // beside a system-ui "Password". Only the password mask itself is drawn in
    // the system font, because Pliant's bullet reads as a row of periods.
    const fieldFonts = await browser.execute(() => {
      const family = (selector: string): string => {
        const element = document.querySelector(selector)
        return element ? getComputedStyle(element).fontFamily : ''
      }
      return {
        interface: getComputedStyle(document.documentElement)
          .getPropertyValue('--font-family')
          .trim(),
        username: family('.vnc-username-input'),
        usernameLabel: family('.vnc-username-field'),
        setupUsername: family('.vnc-setup-username-input'),
        passwordMask: family('.vnc-password-input'),
      }
    })
    const normalizeFamily = (value: string): string =>
      value
        .replace(/["']/g, '')
        .replace(/\s*,\s*/g, ',')
        .replace(/-apple-system,(?:BlinkMacSystemFont|system-ui)/g, '-apple-system,system-ui')
    assert.equal(normalizeFamily(fieldFonts.username), normalizeFamily(fieldFonts.interface))
    for (const text of [fieldFonts.usernameLabel, fieldFonts.setupUsername]) {
      assert.equal(normalizeFamily(text), normalizeFamily(fieldFonts.username))
    }
    // Chromium does not resolve `::placeholder` through getComputedStyle, so
    // the password placeholder's interface font is pinned in
    // dialog-tokens.test.ts and visible in vnc-viewer-auth-failed.png.
    assert.match(fieldFonts.passwordMask, /system-ui/)

    await $('.vnc-password-input').setValue('incorrect-password')
    await saveElementScreenshot('.vnc-auth-panel', 'vnc-viewer-auth-fields.png')
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
    const failedMarker = await readVncSeverity(
      '.vnc-controls-panel:not([hidden]) .vnc-status',
      '.vnc-status-title',
    )
    assert.ok(failedMarker, 'the failed status must render its severity dot and title')
    assert.equal(failedMarker.titleColor, failedMarker.tokens.error)
    assert.equal(failedMarker.dotColor, failedMarker.titleColor)
    // Same gutter as the auth panel it replaced.
    assert.equal(failedMarker.gutter, authMarker.gutter)
    assert.equal(failedMarker.columnGap, authMarker.columnGap)

    if (secureCredentialStorage) {
      const target = { kind: 'loopback', port: authenticationPort } as const
      assert.equal(
        await browser.execute(
          (savedTarget) => window.api.vnc.rememberPassword(savedTarget, 'rejected-saved-password'),
          target,
        ),
        true,
      )
      await $('.vnc-connect-btn').click()
      await browser.waitUntil(
        async () => (await $('.vnc-status-title').getText()) === 'Authentication failed',
        { timeout: 20_000, timeoutMsg: 'expected the rejected saved VNC password to be removed' },
      )
      assert.equal(await authPanel.isDisplayed(), false)
      assert.equal(
        await browser.execute((savedTarget) => window.api.vnc.hasPassword(savedTarget), target),
        false,
      )
    }

    await advancedSummary.click()
    await portInput.waitForDisplayed()
    await portInput.setValue(String(port))
    assert.equal(await portInput.getValue(), String(port))
    await advancedSummary.click()
    await browser.waitUntil(async () => !(await portInput.isDisplayed()))
    if (secureCredentialStorage) {
      const savedTarget = { kind: 'loopback', port } as const
      assert.equal(
        await browser.execute(
          (target) => window.api.vnc.rememberUsername(target, 'saved-user'),
          savedTarget,
        ),
        true,
      )
      assert.equal(
        await browser.execute(
          (target) => window.api.vnc.rememberPassword(target, 'saved-password'),
          savedTarget,
        ),
        true,
      )
      await browser.execute(() => {
        document
          .querySelector<HTMLInputElement>('.vnc-port-input')
          ?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await $('.vnc-saved-login').waitForDisplayed()
      assert.match(await $('.vnc-saved-login').getText(), /Signed in as saved-user/i)
      assert.equal(await $('.vnc-setup-credentials').isDisplayed(), false)
      assert.equal(await $('.vnc-connect-btn').getText(), 'Connect')
      await saveElementScreenshot('#pane-files', 'vnc-viewer-saved-device-details.png')
    }
    await $('.vnc-connect-btn').click()

    await browser.waitUntil(async () => (await $('.vnc-status').getText()).includes('Connected'), {
      timeout: 20_000,
      timeoutMsg: 'expected the fake VNC server to finish the RFB handshake',
    })
    const canvas = $('.vnc-screen canvas')
    await canvas.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await canvas.getAttribute('width'), String(WIDTH))
    assert.equal(await canvas.getAttribute('height'), String(HEIGHT))
    assert.equal(await $('.vnc-status-title').getText(), 'Connected to localhost')
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
    assert.equal(await $('.vnc-controls-host .pane-header-title').isDisplayed(), true)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'localhost')

    if (secureCredentialStorage) {
      const target = { kind: 'loopback', port } as const
      const forgetLogin = $('.vnc-forget-login')
      await forgetLogin.waitForDisplayed()
      await saveElementScreenshot('#pane-files', 'vnc-viewer-saved-login.png')
      await forgetLogin.click()
      assert.equal(
        await browser.execute((savedTarget) => window.api.vnc.hasPassword(savedTarget), target),
        false,
      )
      await $('.toast').waitForDisplayed()
      assert.match(await $('.toast').getText(), /forgot the saved desktop login/i)
      // Let it go before the shared-screen capture, which one of three CI runs
      // caught with this toast still stacked above its own.
      await $('.toast').waitForExist({ reverse: true, timeout: 10_000 })
    }

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
    assert.deepEqual(sampled.right, [0, 74, 70, 255])
    await browser.execute(() => {
      window.scrollTo(0, 0)
    })
    await saveElementScreenshot('#pane-files', 'vnc-viewer-read-only.png')

    await controlButton.click()
    assert.equal(await controlButton.getText(), 'Stop controlling')
    assert.equal(await controlButton.getAttribute('aria-pressed'), 'true')
    assert.match(await $('.vnc-status-detail').getText(), /mouse and keyboard control are on/i)
    assert.equal(
      await $('.vnc-tab.is-active').getAttribute('aria-label'),
      'localhost, mouse and keyboard control on',
    )
    assert.equal(await $('.vnc-screen').getAttribute('class'), 'vnc-screen is-controlling')
    assert.match(
      await browser.execute(() => {
        const painted = document.querySelector<HTMLCanvasElement>('.vnc-screen canvas')
        return painted?.style.cursor ?? ''
      }),
      /^url\(/,
      'expected noVNC to show its fallback cursor when the server sends no cursor image',
    )
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
    await browser.execute(() => {
      window.scrollTo(0, 0)
    })
    await saveElementScreenshot('#pane-files', 'vnc-viewer-control-enabled.png')

    await browser.execute(() => {
      const remoteScreen = document.querySelector<HTMLElement>('.vnc-screen')
      if (!remoteScreen) throw new Error('Remote screen container is missing')
      const bounds = remoteScreen.getBoundingClientRect()
      remoteScreen.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
          buttons: 2,
          clientX: bounds.left + 4,
          clientY: bounds.top + 4,
        }),
      )
    })
    const shareMenu = $('.context-menu')
    await shareMenu.waitForDisplayed({ timeout: 5_000 })
    assert.equal(await $('.context-menu-item').getText(), 'Share screen with model')
    await saveElementScreenshot('.context-menu', 'vnc-viewer-share-screen-menu.png')
    await $('.context-menu-item').click()
    await expect(shareMenu).not.toBeExisting()
    const sharedScreen = $('.attachment-chips .image-chip img')
    await sharedScreen.waitForDisplayed({ timeout: 5_000 })
    assert.match((await sharedScreen.getAttribute('src')) ?? '', /^data:image\/png;base64,/)
    assert.deepEqual(
      await browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>('.attachment-chips .image-chip img')
        return image ? { width: image.naturalWidth, height: image.naturalHeight } : null
      }),
      { width: WIDTH, height: HEIGHT },
    )
    await saveAppScreenshot('vnc-viewer-shared-screen.png')
    await $('.toast').waitForExist({ reverse: true, timeout: 5_000 })

    await controlButton.click()
    assert.equal(await controlButton.getText(), 'Control desktop')
    assert.equal(await controlButton.getAttribute('aria-pressed'), 'false')
    assert.match(await $('.vnc-status-detail').getText(), /view only/i)
    assert.equal(await $('.vnc-screen').getAttribute('class'), 'vnc-screen')
    await canvas.click({ button: 'right' })
    await shareMenu.waitForDisplayed({ timeout: 5_000 })
    assert.equal(await $('.context-menu-item').getText(), 'Share screen with model')
    await browser.keys('Escape')
    await expect(shareMenu).not.toBeExisting()

    await $('.vnc-tabs-new-btn').click()
    assert.equal(await $$('.vnc-tab').length, 2)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'Desktop 2')
    assert.equal(await $$('.vnc-viewer-panel .vnc-screen canvas').length, 1)
    assert.equal(await $('.vnc-viewer-panel:not([hidden]) .vnc-screen canvas').isExisting(), false)

    const secondControls = '.vnc-controls-panel:not([hidden])'
    await $(`${secondControls} .vnc-device-header[data-machine="network:manual"]`).click()
    const secondPortInput = $(`${secondControls} .vnc-port-input`)
    const secondAdvancedSummary = $(`${secondControls} .vnc-advanced summary`)
    await secondPortInput.waitForExist({ timeout: 20_000 })
    const secondAddressInput = $(`${secondControls} .vnc-address-input`)
    await secondAddressInput.waitForDisplayed()
    await secondAddressInput.setValue('localhost')
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
      'localhost 1',
      'localhost 2',
    ])
    assert.equal(await $$('.vnc-viewer-panel .vnc-screen canvas').length, 2)
    assert.equal(await $('.vnc-viewer-panel:not([hidden]) .vnc-screen canvas').isDisplayed(), true)
    assert.equal(await $('.vnc-viewer-panel[hidden] .vnc-screen canvas').isDisplayed(), false)
    await browser.execute(() => {
      window.scrollTo(0, 0)
    })
    await saveElementScreenshot('#pane-files', 'vnc-viewer-tabs.png')

    await at([...(await $$('.vnc-tab').getElements())], 0).click()
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'localhost 1')
    assert.equal(
      await $('.vnc-controls-panel:not([hidden]) .vnc-status-title').getText(),
      'Connected to localhost',
    )
    await at([...(await $$('.vnc-tab').getElements())], 1).click()
    await $('.vnc-tab.is-active .vnc-tab-close').click()
    assert.equal(await $$('.vnc-tab').length, 1)
    assert.equal(await $('.vnc-tab.is-active .vnc-tab-label').getText(), 'localhost')
    assert.equal(await $$('.vnc-viewer-panel .vnc-screen canvas').length, 1)
    assert.equal(
      await $('.vnc-controls-panel:not([hidden]) .vnc-status-title').getText(),
      'Connected to localhost',
    )

    await browser.execute(async () => {
      const bridge = window.__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.setVncNearbyServers([])
    })
    await $('.vnc-tabs-new-btn').click()
    const retryControls = '.vnc-controls-panel:not([hidden])'
    await browser.waitUntil(
      async () =>
        (await $(`${retryControls} .vnc-nearby-status`).getText()).includes(
          'No nearby desktops found',
        ),
      {
        timeout: 20_000,
        timeoutMsg: 'expected automatic nearby discovery to report an empty result',
      },
    )
    const nearbyRetry = $(`${retryControls} .vnc-nearby-btn`)
    assert.equal(await nearbyRetry.isDisplayed(), true)
    assert.equal(await nearbyRetry.getText(), 'Try again')
    assert.equal(await nearbyRetry.getAttribute('aria-label'), 'Look for nearby devices again')
    assert.equal(await $(`${retryControls} .vnc-discovery-status`).isDisplayed(), false)
    assert.equal(
      await $(`${retryControls} .vnc-device-header[data-machine="local"]`).isExisting(),
      false,
    )
    await saveElementScreenshot('#pane-files', 'vnc-viewer-discovery-retry.png')
    await nearbyRetry.click()
    await browser.waitUntil(
      async () =>
        (await nearbyRetry.isDisplayed()) &&
        (await $(`${retryControls} .vnc-nearby-status`).getText()).includes(
          'No nearby desktops found',
        ),
      {
        timeout: 20_000,
        timeoutMsg: 'expected the nearby discovery retry to finish with an empty result',
      },
    )

    await assertNoErrorToasts('VNC viewer')
  })
})
