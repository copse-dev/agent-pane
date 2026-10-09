import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

describe('URL approval explanations', () => {
  for (const fixture of [
    {
      id: 'approval-web-url',
      url: 'https://example.com/docs?topic=approvals',
      effect: 'site can see the request',
      grant: 'future requests to this origin',
      action: 'Allow request',
    },
    {
      id: 'approval-browser-url',
      url: 'https://example.com/docs?topic=approvals',
      effect: 'site can see the request',
      grant: 'chat’s browser session',
      action: 'Allow navigation',
    },
    {
      id: 'approval-provider-url',
      url: 'https://api.example.com/v1',
      effect: 'API key and prompts',
      grant: 'always allows this provider host',
      action: 'Always allow host',
    },
  ]) {
    it(`isolates the URL and explains the effect and grant for ${fixture.id}`, async () => {
      await browser.url(`/?scenario=${fixture.id}`)
      const dialog = $('#approval-dialog')
      await dialog.waitForDisplayed()
      await expect(dialog.$$('.approval-body')).toBeElementsArrayOfSize(1)
      assert.equal(await dialog.$('.approval-body').getText(), fixture.url)
      await expect(dialog.$('.approval-advice')).toHaveText(expect.stringContaining(fixture.effect))
      await expect(dialog.$('.approval-footer')).toHaveText(expect.stringContaining(fixture.grant))
      await expect(dialog.$('.approval-approve')).toHaveText(fixture.action)
      const layout = await dialog.getSize()
      assert.ok(layout.width > 200)
      await saveElementScreenshot('#approval-dialog', `${fixture.id}.png`)
    })
  }
})
