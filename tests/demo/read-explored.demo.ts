import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// #1433 Fix 0b: read_explored quotes lines an explore call already read. Its
// card reads as a file read, with the quoted lines in the result.
describe('browser-hosted read_explored card', () => {
  beforeEach(async () => {
    await browser.url('/?scenario=read-explored')
    await $('.tool-card').waitForExist()
  })

  it('labels the call as quoting explored lines and shows the quote', async () => {
    const card = await $('.tool-card').getElement()
    await expect(card.$('.tool-name')).toHaveText(expect.stringContaining('Quoted explored lines'))
    await card.$('summary.tool-card-header').click()
    await expect(card.$('pre code')).toHaveText(
      expect.stringContaining("if (event.key === 'Enter') {"),
    )
    await saveAppScreenshot('read-explored-expanded.png')
  })
})
