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
    await expect(await $('.pr-viewer-description')).not.toBeDisplayed()
    await expect(await $('.pr-viewer-files')).not.toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-activity-comments.png')

    await $('.pr-detail-section[data-section="checks"]').click()
    await expect(await $$('.pr-check-state-success')).toBeElementsArrayOfSize(3)

    await $('.pr-list-title*=Tidy up workspace status polling').click()
    await expect(await $('.pr-viewer-title')).toHaveText('Tidy up workspace status polling')
    await $('.pr-detail-section[data-section="checks"]').click()
    await expect(await $$('.pr-check-row')).toBeElementsArrayOfSize(5)
    await expect(await $('.pr-check-state-failure')).toHaveText('failure')
    await expect(await $('.pr-check-state-pending')).toHaveText('in progress')
    await expect(await $$('.pr-check-state-unknown')).toBeElementsArrayOfSize(2)
    const fits = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>('.pr-activity')
      return Boolean(host && host.clientWidth > 0 && host.scrollWidth <= host.clientWidth + 1)
    })
    expect(fits).toBe(true)
    await saveElementScreenshot('#pane-files', 'pr-activity-checks.png')

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
