import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('OpenAI cloud agent prototype picker', () => {
  it('shows API billing and retention before selecting the hosted agent', async () => {
    await browser.url('/?scenario=concise-thread-full')
    const picker = await $('.footer-model-host .model-picker')
    await picker.waitForExist()
    await picker.$('.model-picker-trigger').click()
    await picker.$('.model-picker-browse').click()
    await picker.$('.model-picker-filter').setValue('OpenAI Cloud Agent')
    const option = picker.$('.model-picker-option[data-value="remote-agent:openai#gpt-6.1-sol"]')
    await expect(option).toBeDisplayed()
    await expect(picker.$('.model-picker-menu')).not.toHaveText(/API billed|no ZDR/i)
    await expect(option.$('.model-picker-retention')).toHaveAttribute('aria-label', 'No ZDR')
    await expect(option.$('.model-picker-retention')).toHaveAttribute(
      'title',
      /not eligible for zero data retention/,
    )
    await expect(option.$('.model-picker-retention svg')).toExist()
    await expect(
      $$('.model-picker-option[data-value^="remote-agent:openai#"]'),
    ).toBeElementsArrayOfSize(11)
    await expect(
      picker.$('.model-picker-option[data-value="remote-agent:openai#gpt-6-astra"]'),
    ).toExist()
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'openai-cloud-agent-picker.png',
    )
    await option.click()
    await expect(picker.$('.model-picker-trigger')).toHaveText(/GPT-6.1 Sol/)
    await browser.execute(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 32
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      context.fillStyle = '#ec4899'
      context.fillRect(0, 0, 64, 32)
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1] ?? ''), (c) =>
        c.charCodeAt(0),
      )
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
      document.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }),
      )
    })
    await expect($('.attachment-chips .image-chip')).toBeDisplayed()
    await expect($('.composer-image-warning')).not.toBeDisplayed()
    await saveElementScreenshot('#input-bar', 'openai-cloud-agent-image-input.png')
  })
})
