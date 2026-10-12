import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'
import { setComposerValue, submitComposer } from '../e2e/helpers/composer.ts'
import { waitForAgentIdle } from '../e2e/helpers.ts'

describe('ACP bridge tool presentation', () => {
  it('shows patch file links and shell task output for wrapped names without an ACP kind', async () => {
    await browser.url('/?scenario=bridged-tools&autoplay=0')
    const card = $('.tool-card:not(.tool-card-rollup)')
    await card.waitForDisplayed()
    await card.$('summary').click()
    await expect(card.$('.tool-name')).toHaveText('Patched 2 files')
    await expect(card.$$('.tool-patch-file')).toBeElementsArrayOfSize(2)
    await expect(card.$('.tool-patch-file')).toHaveAttribute('data-edit-path', 'src/greeting.ts')
    await expect(card.$('.tool-patch-file')).toBeDisplayed()
    await saveAppScreenshot('bridged-tools-patch.png')

    await $('.titlebar-btn[aria-label="Open terminal"]').click()
    await setComposerValue('Run the greeting tests.')
    await submitComposer()
    const task = $('.agent-task-tab')
    await task.waitForDisplayed()
    await expect(task.$('.agent-task-label')).toHaveText('pnpm test greetings')
    await expect(task).toHaveAttribute('data-status', 'done')
    await task.click()
    const panel = $('.agent-task-output-panel:not([hidden])')
    await expect(panel).toHaveText(expect.stringContaining('2 greeting tests passed.'))
    await waitForAgentIdle()
    await saveAppScreenshot('bridged-tools-shell.png')
  })

  it('names the running wrapped command in concise activity', async () => {
    await browser.url('/?scenario=bridged-tools-concise')
    await expect($('.agent-activity-label')).toHaveText('Running pnpm test greetings…')
    await saveAppScreenshot('bridged-tools-concise.png')
  })
})
