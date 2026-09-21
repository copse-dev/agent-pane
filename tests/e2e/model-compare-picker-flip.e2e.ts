import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'

const FIXTURE_MODEL_COUNT = 18

/**
 * A tiny stand-in LM Studio server so Reviewer B's picker has enough real,
 * chat-capable options to fill its menu close to its own `max-height` cap —
 * the shape a real user with several providers configured would see, unlike
 * the near-empty list an unconfigured e2e project offers. Only the
 * OpenAI-compatible `/v1/models` route matters: `fetchLmStudioModels` also
 * probes a native LM Studio endpoint, and a 404 there is a normal "not that
 * kind of server" answer it already falls back from.
 */
function startFixtureModelServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: Array.from({ length: FIXTURE_MODEL_COUNT }, (_, i) => ({
              id: `fixture-chat-model-${String(i + 1).padStart(2, '0')}`,
            })),
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a bound TCP address for the fixture model server'))
        return
      }
      resolve({ server, url: `http://127.0.0.1:${String(address.port)}/v1` })
    })
  })
}

/**
 * Issue #2487: Reviewer B's picker opens downward from a trigger low in the
 * "Compare models on this diff?" dialog. When the dialog itself is short (a
 * small window, or a tall interface scale, or simply a long model catalog),
 * the menu's preferred position overflows the dialog's own bottom edge and
 * gets clipped by `.pane-chat` behind it — the surface Chromium's
 * `position-try-fallbacks` cannot see, per the comment in model-picker.css.
 * This pins the JS fallback (`placeFieldMenuInsideSurface` in
 * model-picker.ts) that flips or contains the menu against the dialog
 * instead.
 */
describe('model comparison picker does not clip in a short dialog', function () {
  this.timeout(60_000)

  let fixtureServer: Server
  let fixtureUrl: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    ;({ server: fixtureServer, url: fixtureUrl } = await startFixtureModelServer())
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-model-compare-picker-flip-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
      modelComparisonEnabled: true,
      localServerUrl: fixtureUrl,
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    fixtureServer.close()
  })

  /**
   * Shrink `#app` in place (same technique as `prepareE2eScreenshot`) so the
   * dialog's percentage-based `max-height` is squeezed below what Reviewer
   * B's menu needs to open downward. This reaches the same state a real
   * short window would without depending on the main window's 600px
   * `minHeight`, which a real `window.resizeTo` cannot get under.
   */
  async function shrinkAppHeight(height: number): Promise<void> {
    await browser.execute((h) => {
      const app = document.getElementById('app')
      if (!app) return
      app.style.height = `${String(h)}px`
      app.style.overflow = 'hidden'
      window.dispatchEvent(new Event('resize'))
    }, height)
    await browser.pause(100)
  }

  it('flips or contains Reviewer B so the whole menu stays inside the dialog', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await setComposerValue('[[mcp:compare_models {}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    // Short enough to force the flip, but tall enough that the dialog's own
    // rows (Reviewer A/B, Judge, the remember checkbox, Approve/Reject) are
    // not themselves squeezed past their box — this isolates the picker's
    // own clipping from a short-dialog content overflow, which is a
    // different, pre-existing limitation outside this issue's scope.
    await shrinkAppHeight(520)

    const pickers = await dialog.$$('.approval-model-picker')
    expect(pickers.length).toBe(3)
    const reviewerB = pickers[1]
    if (!reviewerB) throw new Error('expected a Reviewer B picker')

    await reviewerB.$('.model-picker-trigger').click()
    const menu = reviewerB.$('.model-picker-menu')
    await menu.waitForDisplayed({ timeout: 10_000 })
    await reviewerB.$('.model-picker-option').waitForExist({ timeout: 10_000 })
    // The fixture's models load asynchronously; wait for a healthy chunk of
    // them so the menu has actually grown toward its max-height before the
    // geometry below is measured.
    await browser.waitUntil(
      async () => (await reviewerB.$$('.model-picker-option')).length >= FIXTURE_MODEL_COUNT,
      {
        timeout: 10_000,
        timeoutMsg: 'expected the fixture chat models to populate Reviewer B',
      },
    )

    // Screenshot at the *shrunk* size directly: the shared `saveElementScreenshot`
    // helper re-pins `#app` to the fixed 1280x800 e2e viewport first, which would
    // undo the squeeze this spec depends on.
    await browser.pause(100)
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'model-compare-reviewer-b-flip.png'))

    const geometry = await browser.execute(() => {
      const dialogEl = document.getElementById('approval-dialog')
      const pickerEls = document.querySelectorAll('.approval-model-picker')
      const reviewerBEl = pickerEls[1]
      const menuEl = reviewerBEl?.querySelector('.model-picker-menu')
      if (!dialogEl || !menuEl) return null
      const dialogRect = dialogEl.getBoundingClientRect()
      const menuRect = menuEl.getBoundingClientRect()
      return {
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        menuTop: menuRect.top,
        menuBottom: menuRect.bottom,
        flipped: menuEl.classList.contains('is-surface-flipped'),
        contained: menuEl.classList.contains('is-surface-contained'),
      }
    })

    expect(geometry).not.toBeNull()
    // The whole menu must land inside the dialog's own box: no part hangs past
    // its bottom edge for `.pane-chat`'s overflow to clip.
    expect(geometry!.menuBottom).toBeLessThanOrEqual(geometry!.dialogBottom + 1)
    expect(geometry!.menuTop).toBeGreaterThanOrEqual(geometry!.dialogTop - 1)
    // It only stays inside because the JS fallback recognised the dialog as a
    // smaller surface than the viewport and flipped or contained it.
    expect(geometry!.flipped || geometry!.contained).toBe(true)

    // More than the single clipped sliver the report described should be
    // visible and reachable.
    const optionCount = (await reviewerB.$$('.model-picker-option')).length
    expect(optionCount).toBeGreaterThan(1)

    // Close the still-open menu before tearing down: it overlaps the dialog's
    // own buttons by design (it is anchored on top of the dialog content), so
    // Reject underneath it is not clickable until it closes.
    await browser.keys('Escape')
    await menu.waitForDisplayed({ reverse: true, timeout: 5_000 })
    await dialog.$('.approval-reject').click()
  })
})
