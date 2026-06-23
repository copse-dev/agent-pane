import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { $, $$, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('titlebar panel icons', () => {
  let workspaceRoot: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-panel-titlebar-icons-'))
    seedEmptyProject(workspaceRoot, 'e2e-titlebar-icons-project')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('shows consistent outline icons on the panel controls', async () => {
    const titlebar = await $('#titlebar')
    await titlebar.waitForDisplayed({ timeout: 15_000 })

    const buttons = [
      { label: 'Toggle right panel', icon: 'panel', text: 'Panel' },
      { label: 'Open terminal', icon: 'terminal', text: 'Terminal' },
      { label: 'Open changes', icon: 'changes', text: 'Changes' },
    ]

    for (const button of buttons) {
      const btn = await $(`.titlebar-text-btn[aria-label="${button.label}"]`)
      await expect(btn).toHaveText(button.text)
      const icon = await btn.$(`svg.titlebar-btn-icon[data-icon="${button.icon}"]`)
      await expect(icon).toExist()
      await expect(icon).toHaveAttribute('aria-hidden', 'true')
    }

    const iconStyles = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<SVGSVGElement>('.titlebar-text-btn svg.titlebar-btn-icon'),
      ).map((icon) => {
        const styles = getComputedStyle(icon)
        const buttonStyles = getComputedStyle(icon.closest('button')!)
        return {
          fill: styles.fill,
          stroke: styles.stroke,
          strokeLinecap: styles.strokeLinecap,
          strokeLinejoin: styles.strokeLinejoin,
          buttonColor: buttonStyles.color,
        }
      }),
    )
    for (const styles of iconStyles) {
      await expect(styles.fill).toBe('none')
      await expect(styles.stroke).toBe(styles.buttonColor)
      await expect(styles.strokeLinecap).toBe('round')
      await expect(styles.strokeLinejoin).toBe('round')
    }
    await expect(await $$('.titlebar-text-btn svg.titlebar-btn-icon')).toBeElementsArrayOfSize(3)
    await browser.execute(() => {
      const dragRegion = document.querySelector<HTMLElement>('.titlebar-drag')
      if (!dragRegion) throw new Error('Missing titlebar drag region')
      dragRegion.style.flex = '0 0 16px'
    })
    await saveElementScreenshot('.titlebar-panel-controls', 'titlebar-outline-icons.png')
  })
})
