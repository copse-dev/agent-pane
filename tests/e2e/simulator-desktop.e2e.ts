import { $, browser } from '@wdio/globals'
import { PNG } from 'pngjs'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const DEVICE_UDID = '11111111-2222-4333-8444-555555555555'

function simulatorFrame(): string {
  const png = new PNG({ width: 390, height: 844 })
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4
      const progress = (x / png.width + y / png.height) / 2
      png.data[offset] = Math.round(103 - progress * 77)
      png.data[offset + 1] = Math.round(203 - progress * 140)
      png.data[offset + 2] = Math.round(224 - progress * 89)
      png.data[offset + 3] = 255
    }
  }
  const fill = (
    left: number,
    top: number,
    width: number,
    height: number,
    color: number[],
  ): void => {
    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        const offset = (y * png.width + x) * 4
        png.data[offset] = color[0] ?? 0
        png.data[offset + 1] = color[1] ?? 0
        png.data[offset + 2] = color[2] ?? 0
        png.data[offset + 3] = color[3] ?? 255
      }
    }
  }
  fill(132, 16, 126, 38, [5, 5, 7, 255])
  fill(24, 104, 342, 116, [241, 248, 252, 255])
  for (const y of [244, 352]) {
    for (const x of [24, 122, 220]) fill(x, y, 74, 74, [238, 246, 251, 255])
  }
  fill(20, 744, 350, 78, [139, 186, 225, 255])
  fill(112, 824, 166, 5, [255, 255, 255, 255])
  return PNG.sync.write(png).toString('base64')
}

describe('Simulator desktop preview', function () {
  this.timeout(90_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    await browser.execute(
      async (workspaceRoot, frameBase64, udid) => {
        await window.api.settings.set('onboardingCompleted', true)
        await window.api.settings.set('vncEnabled', true)
        const e2e = (
          window as unknown as {
            __copseE2e?: {
              openWorkspace(root: string): Promise<string>
              setSimulatorDesktop(value: unknown): Promise<void>
              showSimulatorDesktop(udid: string): Promise<void>
            }
          }
        ).__copseE2e
        if (!e2e) throw new Error('__copseE2e unavailable')
        await e2e.setSimulatorDesktop({
          devices: [{ udid, name: 'iPhone 17 Pro', runtime: 'iOS 26.5' }],
          frame: {
            base64: frameBase64,
            mimeType: 'image/png',
            pixelWidth: 390,
            pixelHeight: 844,
          },
        })
        await e2e.openWorkspace(workspaceRoot)
        const button = document.querySelector<HTMLElement>('[data-panel-control="vnc"]')
        button?.removeAttribute('hidden')
        button?.removeAttribute('data-experimental-hidden')
      },
      process.cwd(),
      simulatorFrame(),
      DEVICE_UDID,
    )
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const onboardingClose = $('#onboarding-close')
    if (await onboardingClose.isDisplayed()) await onboardingClose.click()
  })

  it('shows and controls a booted Simulator in the Desktop pane', async () => {
    await browser.execute(async (udid) => {
      const e2e = (
        window as unknown as {
          __copseE2e?: { showSimulatorDesktop(udid: string): Promise<void> }
        }
      ).__copseE2e
      if (!e2e) throw new Error('__copseE2e unavailable')
      await e2e.showSimulatorDesktop(udid)
    }, DEVICE_UDID)
    const simulator = $(`.vnc-device-header[data-machine="simulator:${DEVICE_UDID}"]`)
    await simulator.waitForDisplayed({ timeout: 20_000 })

    const canvas = $('.simulator-desktop-canvas')
    await canvas.waitForDisplayed({ timeout: 20_000 })
    await browser.waitUntil(async () => Number(await canvas.getAttribute('width')) === 390, {
      timeout: 20_000,
      timeoutMsg: 'Simulator frame was not painted',
    })
    await expect($('.vnc-status-title')).toHaveText('Connected to iPhone 17 Pro')
    await expect($('.vnc-tab.is-active .vnc-tab-label')).toHaveText('iPhone 17 Pro')
    await expect($('.vnc-control-btn')).toHaveText('Control simulator')
    await expect($('.vnc-home-btn')).toBeDisplayed()

    await $('.vnc-control-btn').click()
    await expect($('.vnc-control-btn')).toHaveText('Stop controlling')
    await canvas.click()
    await saveAppScreenshot('simulator-desktop-live.png')
  })
})
