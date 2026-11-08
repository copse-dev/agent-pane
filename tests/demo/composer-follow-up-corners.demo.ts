import { $, $$, browser } from '@wdio/globals'
import assert from 'node:assert/strict'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Full pill rounding is reserved for the primary action (docs/ui-taste.md). The
// follow-ups above the composer — Changes, Create PR, Review changes — are
// secondary actions and take the kit corner; Send keeps its pill.
describe('composer follow-up actions', () => {
  it('take the kit corner while Send stays the one pill', async () => {
    await browser.url('/?scenario=site-create-pr')
    await $('.follow-up-bubble[data-id="create-pr"]').waitForDisplayed({ timeout: 30_000 })

    const radii = await $$('.follow-up-bubble').map((bubble) =>
      bubble.getCSSProperty('border-top-left-radius').then((value) => value.value),
    )
    assert.ok(radii.length >= 3, 'Changes, Create PR and Review changes all render')
    assert.deepEqual(new Set(radii), new Set(['6px']))
    const send = await $('.submit-btn').getCSSProperty('border-top-left-radius')
    assert.ok(Number.parseFloat(String(send.value)) > 12, 'Send keeps its pill')

    await saveElementScreenshot('#input-bar', 'composer-follow-up-actions.png')
  })
})
