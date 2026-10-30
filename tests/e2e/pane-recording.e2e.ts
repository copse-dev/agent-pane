import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { $, browser } from '@wdio/globals'
import { navigateActiveBrowserTab } from './helpers/browser-address.ts'
import { listenOnFixturePort } from './helpers/fixture-server.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

/**
 * Recording a pane surface into the chat. The Browser pane records its tab
 * (screencast → canvas → WebM) and the Desktop pane records its framebuffer
 * canvas. Both must show a live pill, a red frame, and a composer chip while
 * recording, then land as an ordinary video chip whose file actually decodes —
 * which is what `video_frames` will open.
 */

const PROJECT_ID = 'e2e-pane-recording'
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
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(WIDTH, 8)
  header.writeUInt16BE(HEIGHT, 10)
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4
      const left = x < WIDTH / 2
      pixels[offset] = left ? 255 : 0
      pixels[offset + 1] = left ? 90 : 74
      pixels[offset + 2] = left ? 165 : 70
    }
  }
  return Buffer.concat([header, pixels])
}

/** RFB 3.8, security None, one full-frame paint on the first update request. */
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
      else if (messageType === 4) length = 8
      else if (messageType === 5) length = 6
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

async function listenOnVncPort(server: Server): Promise<number> {
  for (let port = 5999; port >= 5900; port--) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      return port
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error
      }
    }
  }
  throw new Error('No conventional VNC port was available for the fake server')
}

async function closeServer(server: Server | HttpServer | null): Promise<void> {
  if (!server?.listening) return
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
}

/** Play the attached recording in the chip's preview and report what Chromium decoded. */
async function decodedPreviewSize(chipLabel: string): Promise<{ width: number; height: number }> {
  const opened = await browser.execute((name) => {
    const label = [
      ...document.querySelectorAll<HTMLElement>(
        '.attachment-chips .video-chip .attachment-chip-label',
      ),
    ].find((candidate) => candidate.textContent === name)
    label?.click()
    return label !== undefined
  }, chipLabel)
  assert.ok(opened, `expected a video chip named ${chipLabel}`)
  const dialog = $('.attachment-preview-dialog[data-preview-kind="video"]')
  try {
    await dialog.waitForExist({ timeout: 15_000 })
    const decoded = await browser
      .waitUntil(
        async () =>
          browser.execute(
            () =>
              (document.querySelector<HTMLVideoElement>('.video-expand-video')?.videoWidth ?? 0) >
              0,
          ),
        { timeout: 15_000 },
      )
      .then(
        () => true,
        () => false,
      )
    const state = await browser.execute(() => {
      const element = document.querySelector<HTMLVideoElement>('.video-expand-video')
      return {
        width: element?.videoWidth ?? 0,
        height: element?.videoHeight ?? 0,
        readyState: element?.readyState ?? -1,
        networkState: element?.networkState ?? -1,
        error: element?.error ? `${String(element.error.code)} ${element.error.message}` : null,
        hasSource: Boolean(element?.currentSrc),
        status:
          document.querySelector('.attachment-preview-dialog .attachment-preview-status')
            ?.textContent ?? null,
      }
    })
    assert.ok(
      decoded,
      `expected the recorded WebM to decode in the preview: ${JSON.stringify(state)}`,
    )
    return { width: state.width, height: state.height }
  } finally {
    // Never leave the modal over the next step, whatever happened above.
    await browser.execute(() => {
      document.querySelector<HTMLDialogElement>('.attachment-preview-dialog[open]')?.close()
    })
  }
}

async function waitForRecordingChip(): Promise<void> {
  await $('.recording-chips .recording-chip').waitForDisplayed({ timeout: 10_000 })
  // Let the clock tick past zero so the screenshot shows a running recording.
  await browser.waitUntil(async () => (await $('.recording-chip-clock').getText()) !== '0:00', {
    timeout: 5_000,
    timeoutMsg: 'expected the composer recording clock to advance',
  })
}

describe('Recording a pane into the chat', function () {
  this.timeout(120_000)
  let pageServer: HttpServer | null = null
  let vncServer: Server | null = null
  const sockets = new Set<Socket>()
  let vncPort = 0

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID)

    pageServer = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <html>
          <head>
            <title>Checkout</title>
            <style>
              body { font: 16px system-ui; margin: 40px; color: #1d1d1f; background: #f3f5ef; }
              main { max-width: 480px; padding: 24px; background: white; border-radius: 10px; }
              #status { margin-top: 12px; color: #9b1c1c; }
            </style>
          </head>
          <body>
            <main>
              <h1>Checkout</h1>
              <p>Order #4821 · total £123.50</p>
              <div id="status">Processing…</div>
            </main>
            <script>
              let n = 0
              setInterval(() => {
                document.getElementById('status').textContent = 'Retry ' + (++n)
              }, 250)
            </script>
          </body>
        </html>`)
    })
    const origin = await listenOnFixturePort(pageServer, 43119)

    vncServer = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      attachRfb38(socket)
    })
    vncPort = await listenOnVncPort(vncServer)

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(async () => {
      await window.api.settings.set('vncEnabled', true)
    })
    const onboardingClose = $('#onboarding-close')
    if (await onboardingClose.isDisplayed()) await onboardingClose.click()
    // The titlebar mounted before the setting changed; mirror its normal
    // settings_changed reconciliation, as vnc-viewer.e2e.ts does.
    await browser.execute(() => {
      const button = document.querySelector<HTMLElement>('[data-panel-control="vnc"]')
      button?.removeAttribute('hidden')
      button?.removeAttribute('data-experimental-hidden')
    })

    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await $('.browser-url-input').waitForDisplayed({ timeout: 10_000 })
    await navigateActiveBrowserTab(`${origin}/checkout`)
    await browser.waitUntil(
      async () =>
        (await $('.browser-tabs-tab.is-active .browser-tabs-tab-label').getText()) === 'Checkout',
      { timeout: 15_000, timeoutMsg: 'expected the checkout fixture to load' },
    )
  })

  after(async () => {
    for (const socket of sockets) socket.destroy()
    await closeServer(vncServer)
    await closeServer(pageServer)
    resetUserData()
  })

  it('records a Browser-pane tab and attaches a playable video', async () => {
    const recordButton = $('.browser-tab-panel:not([hidden]) .browser-record-btn')
    assert.equal(await recordButton.getAttribute('aria-label'), 'Record this tab')
    await recordButton.click()

    const pill = $('.browser-tab-panel:not([hidden]) .recording-indicator')
    await pill.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await recordButton.getAttribute('aria-pressed'), 'true')
    assert.match(await pill.getText(), /Recording\s+0:0\d \/ 5:00\s+Stop/)
    // In a narrow pane the pill floats over the page; Stop must stay inside the
    // pane and be the element a click on it would reach.
    const stopPlacement = await browser.execute(() => {
      const panel = document.querySelector('.browser-tab-panel:not([hidden])')
      const stop = panel?.querySelector('.recording-indicator-stop')
      if (!panel || !stop) return null
      const box = stop.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return {
        overflow: box.right - panel.getBoundingClientRect().right,
        reachable: hit !== null && stop.contains(hit),
      }
    })
    assert.ok(
      stopPlacement !== null && stopPlacement.overflow <= 0.5 && stopPlacement.reachable,
      `Stop is not inside the pane and clickable: ${JSON.stringify(stopPlacement)}`,
    )
    assert.equal(
      await $('.browser-tab-panel:not([hidden]) .browser-webview-host').getAttribute('class'),
      'browser-webview-host is-recording',
    )
    await waitForRecordingChip()
    assert.match(
      await $('.recording-chip .attachment-chip-label').getText(),
      /^Recording Tab — 127\.0\.0\.1:43119$/,
    )
    await saveAppScreenshot('pane-recording-browser-live.png')

    await browser.pause(1_500)
    await pill.$('.recording-indicator-stop').click()

    const chip = $('.attachment-chips .video-chip')
    await chip.waitForDisplayed({ timeout: 15_000 })
    const name = await chip.$('.attachment-chip-label').getText()
    assert.match(name, /^Recording — Tab — 127\.0\.0\.1:43119 — \d\d-\d\d-\d\d\.webm$/)
    assert.equal(await $('.recording-chips .recording-chip').isExisting(), false)
    assert.equal(await pill.isDisplayed(), false)
    assert.equal(await recordButton.getAttribute('aria-pressed'), 'false')
    await saveElementScreenshot('#input-bar', 'pane-recording-browser-attached.png')

    const size = await decodedPreviewSize(name)
    assert.ok(size.width > 0 && size.height > 0, 'the tab recording must decode with real frames')
  })

  it('records the Desktop pane framebuffer and attaches a playable video', async () => {
    await $('.titlebar-btn[aria-label="Open remote desktop"]').click()
    // The address form opens from the device list's "Add device" entry.
    const addDevice = $('.vnc-device-header[data-machine="network:manual"]')
    await addDevice.waitForDisplayed({ timeout: 20_000 })
    await addDevice.click()
    const addressInput = $('.vnc-address-input')
    await addressInput.waitForDisplayed()
    await addressInput.setValue('localhost')
    const advancedSummary = $('.vnc-advanced summary')
    await advancedSummary.click()
    const portInput = $('.vnc-port-input')
    await portInput.waitForDisplayed()
    await portInput.setValue(String(vncPort))
    await advancedSummary.click()
    await $('.vnc-connect-btn').click()
    await $('.vnc-screen canvas').waitForDisplayed({ timeout: 20_000 })

    const recordButton = $('.vnc-controls-panel:not([hidden]) .vnc-record-btn')
    await recordButton.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await recordButton.getText(), 'Record screen')
    await recordButton.click()

    const pill = $('.vnc-controls-panel:not([hidden]) .recording-indicator')
    await pill.waitForDisplayed({ timeout: 10_000 })
    // The pill shares the narrow controls column; its Stop must stay inside it.
    const overflow = await browser.execute(() => {
      const indicator = document.querySelector(
        '.vnc-controls-panel:not([hidden]) .recording-indicator',
      )
      const stop = indicator?.querySelector('.recording-indicator-stop')
      const column = indicator?.parentElement
      if (!stop || !column) return null
      return stop.getBoundingClientRect().right - column.getBoundingClientRect().right
    })
    assert.ok(
      overflow !== null && overflow <= 0.5,
      `Stop overflows the column by ${String(overflow)}px`,
    )
    assert.equal(await recordButton.isDisplayed(), false)
    assert.equal(
      await $('.vnc-viewer-panel:not([hidden]) .vnc-screen').getAttribute('class'),
      'vnc-screen is-recording',
    )
    await waitForRecordingChip()
    assert.match(
      await $('.recording-chip .attachment-chip-label').getText(),
      /^Recording Desktop — /,
    )
    await saveAppScreenshot('pane-recording-desktop-live.png')

    await browser.pause(1_500)
    await pill.$('.recording-indicator-stop').click()

    // Query fresh on every poll: the tab recording's chip is already in the
    // row, and a resolved element would keep pointing at it.
    const desktopChipName = (): Promise<string | null> =>
      browser.execute(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '.attachment-chips .video-chip .attachment-chip-label',
            ),
          ]
            .map((label) => label.textContent)
            .find((text) => text.startsWith('Recording — Desktop — ')) ?? null,
      )
    const attached = await browser
      .waitUntil(async () => (await desktopChipName()) !== null, { timeout: 15_000 })
      .then(
        () => true,
        () => false,
      )
    if (!attached) {
      const toasts = await browser.execute(() =>
        [...document.querySelectorAll('#toast-host > *')].map((toast) => toast.textContent),
      )
      assert.fail(
        `expected the desktop recording to become a video chip; toasts: ${JSON.stringify(toasts)}`,
      )
    }
    const name = (await desktopChipName()) ?? ''
    assert.match(name, /^Recording — Desktop — localhost — \d\d-\d\d-\d\d\.webm$/)
    assert.equal(await recordButton.isDisplayed(), true)
    await saveElementScreenshot('#input-bar', 'pane-recording-desktop-attached.png')

    const size = await decodedPreviewSize(name)
    assert.deepEqual(size, { width: WIDTH, height: HEIGHT })
  })
})
