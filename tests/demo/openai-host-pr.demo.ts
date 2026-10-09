import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

describe('OpenAI host PR result', () => {
  it('shows the local PR tool result after hosted changes are imported', async () => {
    await browser.url('/?scenario=openai-host-pr')
    await $('.tool-card-rollup > summary').click()
    const card = $('[data-tool-id="openai-publish-turn-call"]')
    await card.waitForDisplayed()
    await expect($('.msg-assistant')).toHaveText(/Changes imported/)
    await card.$('summary').click()
    await card.$('.tool-args > summary').click()
    await expect(card).toHaveText(/docs: MCP Apps support plan/)
    await expect(card).toHaveText(/Created draft PR/)
    const push = $('[data-tool-id="openai-publish-turn-push"]')
    await push.$('summary').click()
    await expect(push).toHaveText(/Pushed feature\/mcp-apps to origin/)
    await expect(push).toHaveText(/Existing PR updated/)
    await saveAppScreenshot('openai-host-pr.png')
  })
})
