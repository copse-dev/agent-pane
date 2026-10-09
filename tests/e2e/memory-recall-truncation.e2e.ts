import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedMemoryRecallTruncationFixture,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const CLIPPED =
  '(Memory truncated at 20,000 characters; call recall with a query naming it to read it in full.)'
const NEXT_PAGE = 'More memories available. Next cursor: m:1'

describe('memory recall size cap', () => {
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

  it('shows a clipped memory and where the next page resumes in an unfiltered recall', async () => {
    const card = await $('.tool-card[data-tool-id="memory-recall-truncated"]')
    await card.waitForExist({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect(card.$('.tool-name')).toHaveText('Recall')
    await expect(card).not.toHaveAttribute('open')

    await card.$('summary.tool-card-header').click()
    await expect(card).toHaveAttribute('open')
    const resultScrollport = await card.$('.tool-result')
    const result = await resultScrollport.$('pre')
    await expect(result).toHaveText('Found 3 memories (showing 1–1):', { containing: true })
    await expect(result).toHaveText(CLIPPED, { containing: true })

    const copy = await result.getText()
    expect(copy.match(/^## /gm)).toHaveLength(1)
    expect(copy.endsWith(NEXT_PAGE)).toBe(true)

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
