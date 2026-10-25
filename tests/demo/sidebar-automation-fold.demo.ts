import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// One schedule with waiting, working, failed and finished runs: collapsed, the
// Automations section keeps the live and failed ones in view and folds the finished
// runs into the schedule heading's count.

async function rows(): Promise<string[]> {
  const items = await $$('.automation-schedule-runs > *').getElements()
  return items.map((item) => item.getText())
}

describe('sidebar automation fold', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-automation-fold')
    await $('.automation-schedule-toggle').waitForExist({ timeout: 30_000 })
  })

  it('collapses waiting runs, keeps the working run, and collates the failures', async () => {
    await browser.waitUntil(async () => (await rows()).some((row) => row.includes('need you')), {
      timeout: 10_000,
      timeoutMsg: 'the waiting runs must collapse into one row',
    })
    const shown = await rows()
    expect(shown.some((row) => row.startsWith('4 need you'))).toBe(true)
    expect(shown.some((row) => row.startsWith('2 failed'))).toBe(true)
    expect(shown).toHaveLength(3)
    await expect($('.automation-schedule-count')).toHaveText('10 runs')
    await saveAppScreenshot('sidebar-automation-fold.png')
  })

  it('opens the collated failures into their own rows', async () => {
    await $('.automation-fold-row.is-failed').click()
    await browser.waitUntil(async () => (await rows()).length === 5)
  })
})
