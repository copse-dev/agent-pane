import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { E2E_SCREENSHOT_DIR } from '../e2e/helpers/screenshot.ts'

describe('shared desktop chat in the paired browser', () => {
  it('renders the shipped composer, edits a suggestion, and keeps its draft through reconnect', async () => {
    await browser.setWindowSize(390, 844)
    await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await browser.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    })
    await browser.url('/mobile/')
    await browser.execute(async () => {
      await fetch('/remote-fixture/reset')
      localStorage.setItem('copse-mobile-token', 'shared-chat-test-token')
    })
    await browser.url('/remote/?project=proj-1&thread=thread-1')
    await expect($('#connection')).toHaveText('Connected to your Mac')
    await expect($('#conversation')).toHaveText(expect.stringContaining('shared chat'))
    await expect($('#conversation strong')).toHaveText('shared chat')
    await expect($('.apple-development-error')).not.toExist()
    const editor = $('.prompt-input')
    await expect(editor).toHaveAttribute('contenteditable', 'plaintext-only')
    await expect($('.remote-next-step')).toBeDisplayed()
    await $('.remote-next-step').click()
    await expect(editor).toHaveText('Run the phone reconnect test.')
    await editor.setValue('Run the phone reconnect test, including my draft.')
    expect(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    const geometry = await browser.execute(() => {
      const editor = document.querySelector('.prompt-input')?.getBoundingClientRect()
      const send = document.querySelector('.submit-btn')?.getBoundingClientRect()
      const card = document.getElementById('input-bar')?.getBoundingClientRect()
      if (!editor || !send || !card) throw new Error('Composer is missing')
      return {
        editorWidth: editor.width,
        controlsBelowDraft: send.top >= editor.bottom,
        cardFits: card.left >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
      }
    })
    expect(geometry.editorWidth).toBeGreaterThan(280)
    expect(geometry.controlsBelowDraft).toBe(true)
    expect(geometry.cardFits).toBe(true)
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'shared-remote-chat-phone-light.png'))
    await browser.execute(async () => {
      await fetch('/remote-fixture/offline')
    })
    await expect($('#connection')).toHaveAttribute('data-connected', 'false')
    await expect($('.submit-btn')).toBeDisabled()
    await expect(editor).toHaveText('Run the phone reconnect test, including my draft.')
    await browser.execute(async () => {
      await fetch('/remote-fixture/online')
    })
    await expect($('#connection')).toHaveText('Connected to your Mac')
    await expect($('.submit-btn')).toBeEnabled()
    await expect(editor).toHaveText('Run the phone reconnect test, including my draft.')
    await browser.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    await expect($('html')).toHaveAttribute('data-theme', 'dark')
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'shared-remote-chat-phone-dark.png'))
    await $('.submit-btn').click()
    await expect(editor).toHaveText('')
    const submissions = await browser.execute(async () => {
      const response = await fetch('/remote-fixture/status')
      return response.text()
    })
    expect(submissions).toBe('{"submissions":1}')
  })
})
