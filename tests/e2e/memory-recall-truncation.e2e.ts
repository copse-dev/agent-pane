import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedMemoryRecallTruncationFixture,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const GUIDANCE =
  'Output truncated: showing 50 of 55 memories; 5 not shown. Call recall with a query to find a specific memory.'

describe('memory recall truncation guidance', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedMemoryRecallTruncationFixture(seedStableWorkspace())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows how to query for memories omitted from an unfiltered recall', async () => {
    const card = await $('.tool-card[data-tool-id="memory-recall-truncated"]')
    await card.waitForExist({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect(card.$('.tool-name')).toHaveText('Recall')
    await expect(card).not.toHaveAttribute('open')

    await card.$('summary.tool-card-header').click()
    await expect(card).toHaveAttribute('open')
    const resultScrollport = await card.$('.tool-result')
    const result = await resultScrollport.$('pre')
    await expect(result).toHaveText('Found 55 memories:', { containing: true })
    await expect(result).toHaveText(GUIDANCE, { containing: true })

    const copy = await result.getText()
    expect(copy.match(/^## /gm)).toHaveLength(2)
    expect(copy.endsWith(`(${GUIDANCE})`)).toBe(true)

    const scroll = await browser.execute((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('tool result not found')
      element.scrollTop = element.scrollHeight
      return {
        scrollable: element.scrollHeight > element.clientHeight,
        distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      }
    }, resultScrollport)
    expect(scroll.scrollable).toBe(true)
    expect(scroll.distanceFromBottom).toBeLessThanOrEqual(1)

    await saveElementScreenshot(
      '.tool-card[data-tool-id="memory-recall-truncated"][open]',
      'memory-recall-truncation-guidance.png',
    )
  })
})
