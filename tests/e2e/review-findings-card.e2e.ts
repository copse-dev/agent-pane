import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedReviewReportFixture } from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

// Visual eval for Copse Reviewer's findings card (docs/plans/copse-reviewer.md,
// Shell B): a completed review renders inside the scrolling `.messages-list`
// as its trailing card, with the Stage 0 ground as chips, one ranked row per
// finding that expands to its verdict, anchored source, evidence and
// provenance, a dismissed finding behind a toggle, and Dismiss on each live
// finding. Component tests cover the DOM shape; this spec proves it in the
// real Electron renderer, drives a dismissal through main's knowledge store,
// and captures screenshots for visual inspection.
describe('review findings card inline in transcript', () => {
  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedReviewReportFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the ranked findings as the trailing card with ground chips and evidence', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    await $('.messages-list [data-review-report-card]').waitForExist({ timeout: 30_000 })

    const shape = await browser.execute(() => {
      const list = document.querySelector('.messages-list')
      const card = document.querySelector('[data-review-report-card]')
      const rows = [
        ...(card?.querySelectorAll(
          '.review-report-findings:not(.review-report-dismissed) .review-finding',
        ) ?? []),
      ]
      return {
        cardInList: !!list && !!card && list.contains(card),
        cardIsLast: !!list && list.lastElementChild === card,
        title: card?.querySelector('.review-report-title')?.textContent ?? '',
        meta: card?.querySelector('.review-report-meta')?.textContent ?? '',
        cost: card?.querySelector('.review-report-cost')?.textContent ?? '',
        checks: [...(card?.querySelectorAll('.review-report-check') ?? [])].map(
          (node) => node.textContent ?? '',
        ),
        rows: rows.map((row) => ({
          id: row.getAttribute('data-finding-id'),
          severity: row.getAttribute('data-severity'),
          verdict: row.querySelector('.review-finding-verdict')?.textContent ?? '',
          location: row.querySelector('.review-finding-location')?.textContent ?? '',
        })),
        footer: card?.querySelector('.review-report-footer')?.textContent ?? '',
        dismissedHidden:
          card?.querySelector<HTMLElement>('.review-report-dismissed')?.hidden ?? null,
      }
    })

    expect(shape.cardInList).toBe(true)
    expect(shape.cardIsLast).toBe(true)
    expect(shape.title).toBe('Review')
    expect(shape.meta).toContain('gpt-5, challenged by claude-opus-4-8')
    expect(shape.meta).toContain('working tree against HEAD')
    expect(shape.cost).toBe('~$0.06')
    expect(shape.checks).toEqual([
      'build ✓ clean',
      'typecheck ✓ clean',
      'lint ✓ clean',
      'test ✗ regressed',
    ])
    expect(shape.rows).toEqual([
      {
        id: '0123456789abcdef',
        severity: 'high',
        verdict: 'confirmed by reproducer',
        location: 'src/math.ts:3',
      },
      {
        id: 'fedcba9876543210',
        severity: 'medium',
        verdict: 'survived challenge',
        location: 'src/timer.ts:10–14',
      },
    ])
    expect(shape.footer).toContain('1 more below the cut')
    expect(shape.footer).toContain('1 refuted by the challenger')
    expect(shape.footer).toContain('1 dismissed')
    expect(shape.dismissedHidden).toBe(true)

    // Finding rows and ground chips sit on a translucent base-surface backing
    // that quiets the hatch behind them. Both used to mix an undefined token
    // (`--bg-primary`), which drops the whole color-mix() to transparent (#3065).
    const backing = await browser.execute(() => {
      const fill = (selector: string): string | null => {
        const node = document.querySelector(`[data-review-report-card] ${selector}`)
        return node ? getComputedStyle(node).backgroundColor : null
      }
      return { finding: fill('.review-finding'), check: fill('.review-report-check') }
    })
    for (const [part, color] of Object.entries(backing)) {
      assert.ok(color, `${part} should render`)
      assert.notEqual(color, 'rgba(0, 0, 0, 0)', `${part} should not be transparent`)
    }

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'review-findings-card.png'))
  })

  it('expands a finding to its evidence, then dismisses it and can show it again', async () => {
    const first = $('[data-review-report-card] [data-finding-id="0123456789abcdef"]')
    await first.$('summary').click()

    const expanded = await browser.execute(() => {
      const row = document.querySelector('[data-finding-id="0123456789abcdef"]')
      return {
        open: row?.querySelector('details')?.open ?? false,
        reason: row?.querySelector('.review-finding-reason')?.textContent ?? '',
        anchor: row?.querySelector('.review-finding-anchor')?.textContent ?? '',
        evidence: [...(row?.querySelectorAll('.review-finding-evidence') ?? [])].map((node) =>
          node.getAttribute('data-kind'),
        ),
        excerpt: row?.querySelector('.review-finding-excerpt')?.textContent ?? '',
        provenance: row?.querySelector('.review-finding-provenance')?.textContent ?? '',
      }
    })
    expect(expanded.open).toBe(true)
    expect(expanded.reason).toContain('fails on head and passes on base')
    expect(expanded.anchor).toContain('=> a - b')
    expect(expanded.evidence).toEqual(['reproducer', 'command'])
    expect(expanded.excerpt).toContain('3 !== -1')
    expect(expanded.provenance).toBe('Raised by gpt-5 (correctness); corroborated by stage0.')

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'review-findings-card-expanded.png'))

    // Dismiss: the row leaves the live list at once and the counter grows; the
    // persisted note lands in main's knowledge store for the next review.
    await first.$('.review-finding-dismiss').click()
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelectorAll(
              '[data-review-report-card] .review-report-findings:not(.review-report-dismissed) .review-finding',
            ).length,
        )) === 1,
      { timeout: 5_000, timeoutMsg: 'expected the dismissed finding to leave the live list' },
    )
    const toggle = $('[data-review-report-card] .review-report-dismissed-toggle')
    await expect(toggle).toHaveText('2 dismissed')

    await toggle.click()
    const shown = await browser.execute(() => {
      const dismissed = document.querySelector<HTMLElement>('.review-report-dismissed')
      return {
        hidden: dismissed?.hidden ?? null,
        ids: [...(dismissed?.querySelectorAll('.review-finding') ?? [])].map((row) =>
          row.getAttribute('data-finding-id'),
        ),
        restoreButtons: dismissed?.querySelectorAll('.review-finding-restore').length ?? 0,
      }
    })
    expect(shown.hidden).toBe(false)
    expect(shown.ids).toEqual(['0123456789abcdef', '1111222233334444'])
    expect(shown.restoreButtons).toBe(2)

    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'review-findings-card-dismissed.png'))
  })

  it('keeps the dismissal after an app restart', async () => {
    // The card's own autosave is debounced (250ms); give it a moment to land in
    // the thread store before restarting the app.
    await browser.pause(1_000)
    await browser.reloadSession()
    await $('.messages-list [data-review-report-card]').waitForExist({ timeout: 30_000 })
    const live = await browser.execute(
      () =>
        document.querySelectorAll(
          '[data-review-report-card] .review-report-findings:not(.review-report-dismissed) .review-finding',
        ).length,
    )
    expect(live).toBe(1)
    await expect($('[data-review-report-card] .review-report-dismissed-toggle')).toHaveText(
      '2 dismissed',
    )
  })
})
