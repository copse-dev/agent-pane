import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedVisualEvidenceFixture } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// Focused visual proof for durable assistant-owned evidence. Unit tests cover
// event ownership and blob folding; this reaches the persisted thread through
// real Electron, asserts the compact/expanded geometry, and leaves both states
// as reviewable screenshots.
describe('assistant visual evidence', () => {
  before(async () => {
    resetUserData()
    seedVisualEvidenceFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('rests as a compact, meaningful before/after card', async () => {
    await $('.messages-list').waitForExist({ timeout: 30_000 })
    const card = $('.visual-evidence-card')
    await card.waitForDisplayed({ timeout: 30_000 })

    const state = await browser.execute(() => {
      const evidence = document.querySelector<HTMLDetailsElement>('.visual-evidence-card')
      return {
        open: evidence?.open ?? false,
        kind: evidence?.dataset['evidenceKind'] ?? '',
        caption: evidence?.querySelector('.visual-evidence-caption')?.textContent ?? '',
        summaryMeta: evidence?.querySelector('.visual-evidence-summary-meta')?.textContent ?? '',
        thumbnails: evidence?.querySelectorAll('.visual-evidence-thumbnail').length ?? 0,
        text: evidence?.textContent ?? '',
      }
    })

    expect(state.open).toBe(false)
    expect(state.kind).toBe('comparison')
    expect(state.caption).toContain('Project order updates immediately')
    expect(state.summaryMeta).toContain('2 captures')
    expect(state.thumbnails).toBe(2)
    // Chromium retains computed style and layout rectangles for descendants of
    // a closed <details>, but skips painting them through content-visibility.
    // WebdriverIO's displayedness check uses Element.checkVisibility with the
    // content-visibility flag, matching what a user can actually see.
    await expect($('.visual-evidence-body')).not.toBeDisplayed()
    expect(state.text).not.toContain('expired-before')

    await saveElementScreenshot('.visual-evidence-card', 'visual-evidence-collapsed.png')
  })

  it('expands into labelled, inspectable captures with provenance', async () => {
    await $('.visual-evidence-summary').click()
    const card = $('.visual-evidence-card')
    await expect(card).toHaveAttribute('open')

    const state = await browser.execute(() => {
      const evidence = document.querySelector<HTMLDetailsElement>('.visual-evidence-card')
      const images = Array.from(
        evidence?.querySelectorAll<HTMLImageElement>('.visual-evidence-image') ?? [],
      )
      return {
        labels: Array.from(
          evidence?.querySelectorAll('.visual-evidence-label') ?? [],
          (node) => node.textContent ?? '',
        ),
        sourceUrls: Array.from(
          evidence?.querySelectorAll('.visual-evidence-source-url') ?? [],
          (node) => node.textContent ?? '',
        ),
        imageCount: images.length,
        loaded: images.every((image) => image.complete && image.naturalWidth === 480),
        expandable: images.every((image) => image.tabIndex === 0),
      }
    })

    expect(state.labels).toEqual(['Before', 'After'])
    expect(state.sourceUrls).toEqual([
      'https://copse.local/projects',
      'https://copse.local/projects',
    ])
    expect(state.imageCount).toBe(2)
    expect(state.loaded).toBe(true)
    expect(state.expandable).toBe(true)

    await saveElementScreenshot('.visual-evidence-card', 'visual-evidence-expanded.png')
  })
})
