import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The API/host regression exercises Stop and failed HTTP recovery. This browser
// boundary fixture checks the resulting notice in the real conversation renderer.
describe('OpenAI cancellation recovery notice', () => {
  it('shows confirmed cancellation and the recovery action in the transcript', async () => {
    await browser.url('/?scenario=openai-cancellation-recovery')
    const notice = $('.msg-assistant blockquote')
    await notice.waitForDisplayed()
    await expect(notice).toHaveText(/cancellation was confirmed.*could not be recovered/)
    await expect(notice).toHaveText(/resend the previous message.*before starting another task/)
    const bounds = await notice.getSize()
    expect(bounds.height).toBeGreaterThan(30)
    await saveAppScreenshot('openai-cancellation-recovery.png')
  })
})
