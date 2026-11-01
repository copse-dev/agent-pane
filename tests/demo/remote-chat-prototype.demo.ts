import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

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
    await saveElementScreenshot('#stage', 'remote-chat-prototype-desktop.png')
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
    const overflow = await browser.execute(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    expect(overflow).toBe(false)
    await expect($('#send')).toBeDisplayed()
    await saveElementScreenshot('#stage', 'remote-chat-prototype-phone-light.png')
    await $('#theme').click()
    await expect($('html')).toHaveAttribute('data-theme', 'dark')
    await saveElementScreenshot('#stage', 'remote-chat-prototype-phone-dark.png')
    await $('#nav-changes').click()
    await expect($('#panel-content')).toHaveText(expect.stringContaining('Working changes'))
    await saveElementScreenshot('#app', 'remote-chat-prototype-phone-changes.png')
  })
})
