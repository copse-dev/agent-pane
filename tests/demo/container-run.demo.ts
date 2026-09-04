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
    await expect(dialog.$('.container-run-prompt')).toBeDisplayed()
    await expect(dialog.$('.container-run-minutes')).toHaveValue('120')
    await expect(dialog.$('.container-run-tokens')).toHaveValue('2000000')
    const hint = await dialog.$('.container-run-model-hint').getText()
    expect(hint).toContain('Model: lmstudio:qwen/qwen3.6-35b-a3b')
    expect(hint).toContain("only the model's endpoint")
    await expect(dialog.$('.container-run-start')).toHaveText('Start unattended run')
    await saveElementScreenshot('#container-run-dialog', 'container-run-arm-form.png')
    await dialog.$('.container-run-cancel').click()
    await expect(dialog).not.toBeDisplayed()
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
})
