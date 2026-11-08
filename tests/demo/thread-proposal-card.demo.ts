import { $, browser, expect } from '@wdio/globals'
import assert from 'node:assert/strict'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// The standing offer's look (docs/proposed-threads.md): the title leads from the
// header with no eyebrow above it, the accent rail and raised fill set the card
// apart without an outline, the checkout line is text rather than a framed chip,
// and Start / Not now take the kit's default button box.
describe('a proposed-thread card', () => {
  it('leads with its title and keeps its decision buttons full size', async () => {
    await browser.url('/?scenario=bridged-thread-proposals&autoplay=0')
    const card = $('.messages-list .thread-proposal')
    await card.$('.thread-proposal-start').waitForDisplayed({ timeout: 30_000 })

    await expect(card.$('summary > h4.thread-proposal-title')).toHaveText(
      'Fix Codex readiness detection',
    )

    const look = await browser.execute(() => {
      const proposal = document.querySelector('.messages-list .thread-proposal')
      const chip = proposal?.querySelector('[data-chip="worktree"]')
      const start = proposal?.querySelector('.thread-proposal-start')
      const dismiss = proposal?.querySelector('.thread-proposal-dismiss')
      if (!proposal || !chip || !start || !dismiss) return null
      const card = getComputedStyle(proposal)
      return {
        headerText: proposal.querySelector('summary')?.textContent.trim() ?? '',
        titles: proposal.querySelectorAll('.thread-proposal-title').length,
        borderTop: card.borderTopWidth,
        borderRight: card.borderRightWidth,
        borderLeft: card.borderLeftWidth,
        chipBorder: getComputedStyle(chip).borderTopWidth,
        startHeight: start.getBoundingClientRect().height,
        dismissHeight: dismiss.getBoundingClientRect().height,
        startPadding: getComputedStyle(start).paddingTop,
      }
    })
    assert.ok(look, 'the pending card and its controls render')
    assert.equal(look.headerText, 'Fix Codex readiness detection', 'no eyebrow beside the title')
    assert.equal(look.titles, 1, 'the title is not repeated in the body')
    assert.equal(look.borderTop, '0px', 'no outline above the card')
    assert.equal(look.borderRight, '0px', 'no outline beside the card')
    assert.equal(look.borderLeft, '2px', 'the accent rail stays')
    assert.equal(look.chipBorder, '0px', 'the checkout line is text, not a framed chip')
    assert.equal(look.startPadding, '8px', 'Start takes the kit .ui-btn padding')
    // The cap-trimmed label plus the kit's 8px block padding; the private 4px
    // padding this replaced made the pair 18px tall.
    assert.ok(look.startHeight >= 25, `Start is a full-size button (${String(look.startHeight)}px)`)
    assert.equal(look.dismissHeight, look.startHeight, 'Not now matches Start')

    await saveElementScreenshot(
      '.messages-list .thread-proposal',
      'thread-proposal-standing-offer.png',
    )
  })
})
