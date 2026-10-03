import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// A schedule's settled runs fold into one row per outcome in Recently finished, so a
// schedule that runs every hour cannot fill the Activity list. The fold opens out
// into its runs; each run is still an ordinary row.

async function folds(): Promise<string[]> {
  const rows = await $$('#activity-home .activity-fold')
  return rows.map((row) => row.getText())
}

describe('Activity home automation fold', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home-automation-fold')
    await $('#activity-home .activity-fold').waitForExist({ timeout: 30_000 })
  })

  it('folds each schedule into one row, failures first', async () => {
    const shown = await folds()
    expect(shown).toHaveLength(2)
    expect(shown[0]).toContain('Nightly dependency check')
    expect(shown[0]).toContain('3 runs')
    expect(shown[1]).toContain('Docs freshness')
    expect(shown[1]).toContain('5 runs')
    await saveAppScreenshot('activity-automation-fold.png')
  })

  it('opens a fold out into its runs and closes it again', async () => {
    const before = (await $$('#activity-home .activity-row')).length
    await $$('#activity-home .activity-fold-toggle')[1]?.click()
    await browser.waitUntil(
      async () => (await $$('#activity-home .activity-row')).length === before + 5,
    )
    expect((await $$('#activity-home .activity-fold-run')).length).toBe(5)
    await saveAppScreenshot('activity-automation-fold-open.png')
    await $$('#activity-home .activity-fold-toggle')[1]?.click()
    await browser.waitUntil(
      async () => (await $$('#activity-home .activity-row')).length === before,
    )
  })
})
