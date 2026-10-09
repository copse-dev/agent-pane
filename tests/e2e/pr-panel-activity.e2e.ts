import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedPrPanelChatFixture,
} from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// Real Electron layout and main/preload activity payload, with deterministic
// GitHub fixtures. Detailed mapping/rendering behavior lives in component tests.
describe('PR comments and checks', () => {
  before(async function () {
    this.timeout(120_000)
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    seedPrPanelChatFixture(process.cwd())
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })
  after(() => {
    resetUserData()
  })

  it('captures overview, conversation feedback, and mixed CI results', async function () {
    this.timeout(120_000)
    if (!(await $('#pane-files').isDisplayed()))
      await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open pull requests"]').click()
    await $('.pr-detail-section[data-section="comments"]').waitForDisplayed({ timeout: 20_000 })
    await expect(await $('.pr-viewer-title')).toHaveText('Add GitHub PR panel tab')
    await saveElementScreenshot('#pane-files', 'pr-activity-overview.png')

    await $('.pr-detail-section[data-section="comments"]').click()
    await expect(await $$('.pr-comment')).toBeElementsArrayOfSize(3)
    await expect(await $('.pr-comment .pr-activity-link')).not.toBeExisting()
    await expect(await $('.pr-open-external-btn')).toBeDisplayed()
    await expect(await $('.pr-activity')).toHaveText(expect.stringContaining('changes requested'))
    await expect(await $('.pr-review-state-changes_requested')).toBeDisplayed()
    await expect(await $('.pr-comment-body blockquote')).toBeDisplayed()
    await expect(await $('.pr-comment-body pre code')).toExist()
    await expect(await $('.pr-comment-body .code-block-copy')).toExist()
    await expect(await $('.pr-comment-body .code-block-run')).not.toBeExisting()
    await expect(await $('.pr-comment-body input[type="checkbox"]')).toExist()
    const commentLayout = await browser.execute(() => {
      const meta = document.querySelector<HTMLElement>('.pr-viewer-meta')
      const comments = [...document.querySelectorAll<HTMLElement>('.pr-comment')]
      return Boolean(
        meta &&
        meta.getBoundingClientRect().height < 220 &&
        comments.every((comment) => comment.scrollWidth <= comment.clientWidth + 1),
      )
    })
    expect(commentLayout).toBe(true)
    await expect(await $('.pr-section-count')).not.toBeDisplayed()
    await $('[aria-label="Expand pull requests over chat"]').click()
    await $('.pr-section-count').waitForDisplayed({ timeout: 5_000 })
    const countsAreRound = await browser.execute(() => {
      const badges = [...document.querySelectorAll<HTMLElement>('.pr-section-count')]
      return (
        badges.length === 3 &&
        badges.every((badge) => {
          const bounds = badge.getBoundingClientRect()
          return (
            bounds.width > 0 &&
            Math.abs(bounds.width - bounds.height) < 0.5 &&
            getComputedStyle(badge).borderRadius === '50%'
          )
        })
      )
    })
    expect(countsAreRound).toBe(true)
    await saveElementScreenshot('#pane-files', 'pr-activity-comments-expanded.png')
    const multiDigitCountIsRound = await browser.execute(() => {
      const badge = document.querySelector<HTMLElement>('.pr-section-count')
      if (!badge) return false
      const original = badge.textContent
      badge.textContent = '100+'
      const bounds = badge.getBoundingClientRect()
      const fits = badge.scrollWidth <= badge.clientWidth + 1
      badge.textContent = original
      return fits && Math.abs(bounds.width - bounds.height) < 0.5
    })
    expect(multiDigitCountIsRound).toBe(true)
    await $('[aria-label="Restore pull requests"]').click()
    await browser.waitUntil(async () => !(await $('.pr-section-count').isDisplayed()))
    await expect(await $('.pr-viewer-description')).not.toBeDisplayed()
    await expect(await $('.pr-viewer-files')).not.toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-activity-comments.png')
    const navigationFits = await browser.execute(() => {
      const navigation = document.querySelector<HTMLElement>('.pr-detail-sections')
      const files = navigation?.querySelector<HTMLElement>('[data-section="files"]')
      return Boolean(
        navigation &&
        files &&
        navigation.scrollWidth <= navigation.clientWidth + 1 &&
        files.getBoundingClientRect().right <= navigation.getBoundingClientRect().right,
      )
    })
    expect(navigationFits).toBe(true)
    await $('.pr-comment[data-comment-id="review-1"]').scrollIntoView({ block: 'start' })
    await saveElementScreenshot('#pane-files', 'pr-activity-comment-formatting.png')

    await $('.pr-detail-section[data-section="checks"]').click()
    await expect(await $$('.pr-check-state-success')).toBeElementsArrayOfSize(3)

    await $('.pr-list-title*=Tidy up workspace status polling').click()
    await expect(await $('.pr-viewer-title')).toHaveText('Tidy up workspace status polling')
    await $('.pr-detail-section[data-section="checks"]').click()
    await expect(await $$('.pr-check-row')).toBeElementsArrayOfSize(5)
    await expect(await $('.pr-check-state-failure')).toHaveText('failure')
    await expect(await $('.pr-check-state-pending')).toHaveText('in progress')
    await expect(await $$('.pr-check-fix-btn')).toBeElementsArrayOfSize(1)
    await expect(await $('.pr-check-fix-btn')).toHaveAttribute(
      'aria-label',
      'Fix Electron e2e / Linux',
    )
    await expect(await $('.pr-check-state-failure')).toBeDisplayed()
    await expect(await $('.pr-check-state-pending')).toBeDisplayed()
    const checkOrder = await $$('.pr-check-group-heading').map((group) => group.getText())
    expect(checkOrder[0]).toContain('Needs attention')
    expect(checkOrder[1]).toContain('In progress')
    await expect(await $$('.pr-check-state-unknown')).toBeElementsArrayOfSize(2)
    const fits = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>('.pr-activity')
      return Boolean(host && host.clientWidth > 0 && host.scrollWidth <= host.clientWidth + 1)
    })
    expect(fits).toBe(true)
    await saveElementScreenshot('#pane-files', 'pr-activity-checks.png')

    await $('.pr-check-fix-btn').click()
    await expect(await $('.chat-row.selected .chat-title')).toHaveText(
      'Fix PR #88: Electron e2e / Linux',
    )
    await expect(await $('.prompt-input')).toHaveText(
      expect.stringMatching(/Electron e2e \/ Linux.*#88.*b3219fce/s),
    )
    await saveElementScreenshot('#app', 'pr-check-fix-thread.png')

    // Refresh keeps the chosen section and resolves to the same PR.
    await $('.pr-pane-refresh-btn').click()
    await expect(await $('.pr-detail-section[data-section="checks"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(await $('.pr-check-state-failure')).toBeDisplayed()
    await $('.pr-detail-section[data-section="comments"]').click()
    await expect(await $('.pr-activity')).toHaveText(
      expect.stringContaining('No conversation comments'),
    )
  })
})
