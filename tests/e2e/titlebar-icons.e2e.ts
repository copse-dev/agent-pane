import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { createFixtureDirectory } from './helpers/fixture-directory.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('titlebar panel icons', () => {
  let workspaceRoot: string
  let cleanupWorkspace = () => {}

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const fixture = createFixtureDirectory('copse-panel-titlebar-icons')
    workspaceRoot = fixture.root
    cleanupWorkspace = fixture.cleanup
    seedEmptyProject(workspaceRoot, 'e2e-titlebar-icons-project')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    cleanupWorkspace()
  })

  it('shows consistent outline icons on the panel controls', async () => {
    const titlebar = await $('#titlebar')
    await titlebar.waitForDisplayed({ timeout: 30_000 })

    const buttons = [
      { label: 'Toggle right panel', icon: 'panel', text: 'Panel' },
      { label: 'Open thread context', icon: 'context', text: 'Context' },
      { label: 'Open terminal', icon: 'terminal', text: 'Terminal' },
      { label: 'Open changes', icon: 'changes', text: 'Changes' },
      { label: 'Open pull requests', icon: 'prs', text: 'PRs' },
      { label: 'Open browser', icon: 'browser', text: 'Browser' },
    ]

    for (const button of buttons) {
      // Scope to #titlebar — portrait chrome mounts a second labeled cluster
      // under the composer with the same aria-labels / titlebar-text-btn classes.
      const btn = await $(`#titlebar .titlebar-text-btn[aria-label="${button.label}"]`)
      await expect(btn).toHaveText(button.text)
      const icon = await btn.$(`svg.titlebar-btn-icon[data-icon="${button.icon}"]`)
      await expect(icon).toExist()
      await expect(icon).toHaveAttribute('aria-hidden', 'true')
    }

    const iconStyles = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<SVGSVGElement>(
          '#titlebar .titlebar-text-btn svg.titlebar-btn-icon',
        ),
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
    // Eleven outline-icon buttons: the six checked above, Side chat (hidden until
    // the open thread has a side chat), the experimental
    // Memories and Roadmap buttons (rendered up front but hidden until their
    // flags are on), Desktop (hidden until vncEnabled), and the "Open in
    // editor" primary button (hidden until an editor is detected). All are
    // still in the DOM here, so their SVGs count. The Open-in-editor caret
    // uses a ui-icon chevron, not titlebar-btn-icon, so it is excluded from
    // this set. Portrait-bar duplicates are excluded by the #titlebar scope.
    await expect(
      await $$('#titlebar .titlebar-text-btn svg.titlebar-btn-icon'),
    ).toBeElementsArrayOfSize(11)
    await browser.execute(() => {
      const dragRegion = document.querySelector<HTMLElement>('.titlebar-drag')
      if (!dragRegion) throw new Error('Missing titlebar drag region')
      dragRegion.style.flex = '0 0 16px'
    })
    // Observe readiness after framing: resizing can trigger the titlebar ResizeObserver.
    // The controls' outer box is fixed, so checking that box alone misses late
    // font metrics and individual label/icon movement inside it.
    await saveElementScreenshot(
      '#titlebar .titlebar-panel-controls',
      'titlebar-outline-icons.png',
      {
        beforeCapture: async () => {
          await browser.execute(async () => {
            const host = document.querySelector('#titlebar .titlebar-panel-controls')
            if (!host) throw new Error('Missing titlebar panel controls')
            host.getBoundingClientRect()
            await document.fonts.ready
            await new Promise<void>((resolve, reject) => {
              let previous = ''
              let stableFrames = 0
              const deadline = performance.now() + 5_000
              const sample = (): void => {
                if (performance.now() > deadline) {
                  reject(new Error('Titlebar labels and icons did not settle before capture'))
                  return
                }
                const nodes = [host, ...host.querySelectorAll('button, span, svg')]
                const geometry = nodes
                  .map((node) => {
                    const rect = node.getBoundingClientRect()
                    return [rect.x, rect.y, rect.width, rect.height].join(',')
                  })
                  .join(';')
                if (document.fonts.status === 'loaded' && geometry === previous) {
                  stableFrames += 1
                } else {
                  stableFrames = 0
                }
                previous = geometry
                if (stableFrames >= 3) resolve()
                else requestAnimationFrame(sample)
              }
              requestAnimationFrame(sample)
            })
          })
        },
      },
    )
  })
})
