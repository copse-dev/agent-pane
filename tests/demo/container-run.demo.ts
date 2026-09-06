import { $, $$, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

/**
 * The unattended-container-run surface over the mocked backend: the footer
 * action, the arming form, the composer banner for a finished run, and the
 * status face of the dialog with the review record. No Docker anywhere — the
 * `container-run` scenario carries a finished run, and the plain
 * `footer-compact` scenario has none, so both faces render deterministically.
 */

async function openOverflowItem(label: string): Promise<void> {
  await $('.footer-overflow-trigger').click()
  await expect($('.footer-overflow-menu')).toBeDisplayed()
  const items = await $$('.footer-overflow-item')
  const item = await items.find(async (candidate) => (await candidate.getText()).includes(label))
  if (!item) throw new Error(`Footer overflow item "${label}" was not available`)
  await item.click()
}

describe('unattended container run (browser-hosted)', () => {
  it('offers the arming form from the footer when the thread has no run', async () => {
    await browser.url('/?scenario=footer-compact')
    await $('.input-footer').waitForExist()
    await expect($('.container-run-banner')).not.toBeDisplayed()

    await openOverflowItem('Run unattended in a container…')
    const dialog = await $('#container-run-dialog')
    await dialog.waitForDisplayed()
    await expect(dialog.$('.container-run-title')).toHaveText(
      'Run this thread unattended in a container',
    )
    // No draft in the composer, so the task is the one thing there is to fill
    // in — an editable field, and no run can start until it has something.
    const task = dialog.$('.container-run-prompt')
    await expect(task).toBeDisplayed()
    await expect(task).toHaveValue('')
    expect(await task.getAttribute('readonly')).toBe(null)
    await expect(dialog.$('.container-run-start')).toBeDisabled()
    await expect(dialog.$('.container-run-minutes')).toHaveValue('120')
    await expect(dialog.$('.container-run-tokens')).toHaveValue('2000000')
    // The model is the same searchable picker the composer and Settings use,
    // over a hidden native select that carries the value, defaulting to the
    // thread's model.
    await expect(dialog.$('.container-run-model')).toHaveValue('lmstudio:qwen/qwen3.6-35b-a3b')
    const trigger = dialog.$('.model-picker-trigger[aria-label="Model for the unattended run"]')
    await expect(trigger).toBeDisplayed()
    await trigger.click()
    // A filter box is the point of reusing it: the roster is searchable rather
    // than a flat native dropdown.
    await expect(dialog.$('.model-picker-filter')).toBeDisplayed()
    await browser.keys('Escape')
    const hint = await dialog.$('.container-run-model-hint').getText()
    expect(hint).toContain('endpoint')
    expect(hint).toContain('scoped to the run')
    await task.setValue('Fix the failing lint rule')
    await expect(dialog.$('.container-run-start')).toBeEnabled()
    await expect(dialog.$('.container-run-start')).toHaveText('Start unattended run')
    await saveElementScreenshot('#container-run-dialog', 'container-run-arm-form.png')
    await dialog.$('.container-run-cancel').click()
    await expect(dialog).not.toBeDisplayed()
  })

  it('quotes the composer draft as the task instead of asking for it again', async () => {
    await browser.url('/?scenario=footer-compact')
    await $('.input-footer').waitForExist()
    await $('.prompt-input').setValue('Tidy the backlog of lint suppressions')

    await openOverflowItem('Run unattended in a container…')
    const dialog = await $('#container-run-dialog')
    await dialog.waitForDisplayed()
    const task = dialog.$('.container-run-prompt')
    await expect(task).toHaveValue('Tidy the backlog of lint suppressions')
    // Shown, not asked for: the user typed it a moment ago in the composer.
    expect(await task.getAttribute('readonly')).not.toBe(null)
    await expect(dialog.$('.container-run-start')).toBeEnabled()
    await saveElementScreenshot('#container-run-dialog', 'container-run-arm-form-draft.png')
    await dialog.$('.container-run-cancel').click()
  })

  it('shows the finished run in the banner and the review record in the dialog', async () => {
    await browser.url('/?scenario=container-run')
    await $('.input-footer').waitForExist()

    const banner = await $('.container-run-banner')
    await banner.waitForDisplayed()
    await expect(banner).toHaveAttribute('data-phase', 'finished')
    const bannerText = await banner.getText()
    expect(bannerText).toContain('Container run: finished')
    expect(bannerText).toContain('3 commits back, 1 waiting for review')
    await saveElementScreenshot('#input-bar', 'container-run-banner-finished.png')

    await banner.$('.container-run-details').click()
    const dialog = await $('#container-run-dialog')
    await dialog.waitForDisplayed()
    const status = await dialog.$('.container-run-status')
    await expect(status).toHaveAttribute('data-phase', 'finished')
    const summary = await dialog.$('.container-run-summary').getText()
    expect(summary).toContain('Finished')
    expect(summary).toContain('api.anthropic.com:443')
    expect(summary).toContain('brokered egress')
    expect(summary).toContain('refs/copse/runs/run-demo-1')
    expect(summary).toContain('absent')
    // The checkout the run actually carried in — a thread worktree, not the
    // project checkout (PR review finding 1).
    expect(summary).toContain('thread worktree (demo/lint-backlog)')
    expect(summary).toMatch(/Prompts reached a handler\s*0/)
    // Section headings render uppercase through CSS; compare the source text.
    await expect(dialog.$('.container-run-deferrals h3')).toHaveText(
      'Waiting for your review (1)',
      {
        ignoreCase: true,
      },
    )
    expect(await dialog.$('.container-run-deferrals').getText()).toContain(
      'git push publishes commits to a remote',
    )
    await expect($$('.container-run-commits li')).toBeElementsArrayOfSize(3)
    expect(await dialog.$('.container-run-log').getText()).toContain('carry-out fetched')
    await expect(dialog.$('.container-run-again')).toBeDisplayed()
    await saveElementScreenshot('#container-run-dialog', 'container-run-result.png')

    // The menu label follows the run state: a finished run is not "live".
    await dialog.$('.container-run-close').click()
    await $('.footer-overflow-trigger').click()
    const labels = await (await $$('.footer-overflow-item')).map((item) => item.getText())
    expect(labels).toContain('Run unattended in a container…')
  })

  it('shows a failed run without claiming its unfetched commits are back', async () => {
    await browser.url('/?scenario=container-run')
    await $('.container-run-banner').waitForDisplayed()
    await $('.container-run-details').click()
    await $('.container-run-again').click()

    // Inject at the demo API boundary, not through a product-only test flag.
    // judgeRun unit tests prove these records become failed progress; this
    // geometry eval proves the same progress remains honest in the real view.
    await browser.execute(async () => {
      const run = await window.api.container.getRun('demo-container-thread')
      if (!run?.record) throw new Error('Expected the container demo record')
      const failed = {
        ...run,
        phase: 'failed' as const,
        error: "The guest's commits could not be fetched: missing carry-out bundle",
        record: {
          ...run.record,
          carryOut: { expected: true, ref: null, error: 'missing carry-out bundle' },
        },
      }
      window.api.container.runThread = () => Promise.resolve(failed)
    })
    await $('.container-run-start').click()
    await expect($('.container-run-banner')).toHaveAttribute('data-phase', 'failed')
    expect(await $('.container-run-banner').getText()).not.toContain('commits back')
    const dialog = await $('#container-run-dialog')
    await expect(dialog.$('.container-run-status')).toHaveAttribute('data-phase', 'failed')
    expect(await dialog.$('.container-run-summary').getText()).toContain('missing carry-out bundle')
    await expect(dialog.$('.container-run-commits h3')).toHaveText(
      'Commits the guest made (not fetched)',
      { ignoreCase: true },
    )
    await saveElementScreenshot('#container-run-dialog', 'container-run-failed-result.png')
  })
})
