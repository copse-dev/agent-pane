import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedAcpUsageUpdateFixture } from './helpers/seed-config.ts'
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
    seedAcpUsageUpdateFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows the skipped semantic-index chip with scale-guard reason', async () => {
    await $('.input-footer').waitForExist({ timeout: 30_000 })
    const chip = await $('.footer-indexing')
    await expect(chip).not.toBeDisplayed()

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

    await expect(chip).toBeDisplayed({ wait: 5_000 })
    await expect(chip).toHaveText('Semantic index skipped')
    await expect(chip).toHaveAttribute('data-state', 'skipped')
    expect(await chip.getAttribute('title')).toMatch(/120,000 indexed paths/)

    const divider = await chip.getCSSProperty('border-right-width')
    const inset = await chip.getCSSProperty('padding-right')
    expect(divider.value).toBe('1px')
    expect(Number.parseFloat(inset.value)).toBeGreaterThan(0)

    const wheel = await $('.context-wheel')
    await expect(wheel).toBeDisplayed()
    await expect(wheel.$('.context-wheel-label')).toHaveText('40%')
    const geometry = await browser.execute(() => {
      const chipElement = document.querySelector<HTMLElement>('.footer-indexing')
      const wheelElement = document.querySelector<HTMLElement>('.context-wheel')
      if (!chipElement || !wheelElement) throw new Error('Footer usage controls not mounted')
      const chipRect = chipElement.getBoundingClientRect()
      const wheelRect = wheelElement.getBoundingClientRect()
      return { chipRight: chipRect.right, wheelLeft: wheelRect.left }
    })
    expect(geometry.wheelLeft).toBeGreaterThanOrEqual(geometry.chipRight)

    await saveElementScreenshot('#input-bar', 'footer-index-scale-guard-skipped.png')
  })
})
