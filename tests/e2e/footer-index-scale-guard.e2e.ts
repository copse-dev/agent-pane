import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

type CopseE2e = {
  setSemanticIndexScaleGuard: (phase: 'limited' | 'skipped', reason: string) => Promise<void>
}

describe('footer index scale guard', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'proj-index-scale-guard')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the skipped semantic-index chip with scale-guard reason', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })

    await browser.execute(async () => {
      const e2e = (window as unknown as { __copseE2e?: CopseE2e }).__copseE2e
      if (!e2e?.setSemanticIndexScaleGuard) {
        throw new Error('__copseE2e.setSemanticIndexScaleGuard unavailable')
      }
      return e2e.setSemanticIndexScaleGuard(
        'skipped',
        'Workspace has 120,000 indexed paths (cap 100,000)',
      )
    })

    const chip = await $('.footer-indexing')
    await expect(chip).toBeDisplayed({ wait: 5_000 })
    await expect(chip).toHaveText('Semantic index skipped')
    await expect(chip).toHaveAttribute('data-state', 'skipped')
    expect(await chip.getAttribute('title')).toMatch(/120,000 indexed paths/)

    await saveElementScreenshot('#input-bar', 'footer-index-scale-guard-skipped.png')
  })
})
