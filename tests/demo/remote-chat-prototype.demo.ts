import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'
import { expectCaptureFitsWidth } from './helpers/capture-fit.ts'

describe('remote chat interaction prototype', () => {
  beforeEach(async () => {
    await browser.setWindowSize(1280, 900)
    await browser.url('/prototypes/remote-chat.html')
    await $('#thread-title').waitForDisplayed()
    await browser.execute(() => {
      document.documentElement.dataset['theme'] = 'light'
    })
  })

  it('renders the desktop workspace and keeps suggestions editable', async () => {
    await expect($('.sidebar')).toBeDisplayed()
    await expect($('.right')).toBeDisplayed()
    await $('#suggestions button').click()
    await expect($('#prompt')).toHaveValue('Run the focused tests')
    await expect($$('.message.user')).toBeElementsArrayOfSize(1)
    // A document page: the default frame pins Copse's #app shell, which this page lacks.
    await saveElementScreenshot('#stage', 'remote-chat-prototype-desktop.png', {
      frame: 'document',
      beforeCapture: () => expectCaptureFitsWidth('#stage'),
    })
  })

  it('recovers a completed host response once after disconnect without losing a draft', async () => {
    await $('#phone').click()
    await $('#suggestions button').click()
    await $('#send').click()
    await expect($('#stop')).toBeDisplayed()
    await $('#network').click()
    await expect($('#send')).toBeDisabled()
    await $('#prompt').setValue('My next question')
    await $('#nav-activity').click()
    await expect($('#panel-content')).toHaveText(expect.stringContaining('Mac activity'))
    await browser.waitUntil(
      async () => (await $('#panel-content').getText()).includes('Agent is idle'),
      { timeout: 15000, timeoutMsg: 'simulated host should finish while client is disconnected' },
    )
    await $('#close-panel').click()
    await $('#network').click()
    await expect($('#prompt')).toHaveValue('My next question')
    await expect($$('.message.user')).toBeElementsArrayOfSize(2)
    await expect($$('.message.assistant')).toBeElementsArrayOfSize(2)
    await expect($('#transcript')).toHaveText(expect.stringContaining('12 tests'))
    await expect($('#stop')).not.toBeDisplayed()
    await $('#protocol').$('summary').click()
    await expect($('#events')).toHaveText(expect.stringContaining('no resend'))
  })

  it('fits touch controls at phone width, retains per-thread drafts, and supports dark mode', async () => {
    await browser.setWindowSize(390, 900)
    await $('#phone').click()
    await $('#prompt').setValue('Keep this local draft')
    await $('#menu').click()
    await $('[data-thread="keyboard"]').click()
    await expect($('#prompt')).toHaveValue('')
    await $('#menu').click()
    await $('[data-thread="remote"]').click()
    await expect($('#prompt')).toHaveValue('Keep this local draft')
    // Nothing may run off a phone from a small Android (350) to a large iPhone (390).
    for (const width of [350, 375, 390]) {
      await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      })
      await expectCaptureFitsWidth('#stage')
    }
    await browser.sendCommand('Emulation.clearDeviceMetricsOverride', {})
    await expect($('#send')).toBeDisplayed()
    await saveElementScreenshot('#stage', 'remote-chat-prototype-phone-light.png', {
      frame: 'document',
      beforeCapture: () => expectCaptureFitsWidth('#stage'),
    })
    await $('#theme').click()
    await expect($('html')).toHaveAttribute('data-theme', 'dark')
    await saveElementScreenshot('#stage', 'remote-chat-prototype-phone-dark.png', {
      frame: 'document',
      beforeCapture: () => expectCaptureFitsWidth('#stage'),
    })
    await $('#nav-changes').click()
    await expect($('#panel-content')).toHaveText(expect.stringContaining('Working changes'))
    await saveElementScreenshot('#workspace', 'remote-chat-prototype-phone-changes.png', {
      frame: 'document',
      beforeCapture: () => expectCaptureFitsWidth('#workspace'),
    })
  })
})
