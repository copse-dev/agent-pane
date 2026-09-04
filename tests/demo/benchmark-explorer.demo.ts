import { expect } from '@wdio/globals'
import { saveAppScreenshot, saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

async function restoreScrollableApp(): Promise<void> {
  await browser.execute(() => {
    const app = document.getElementById('app')
    if (!app) return
    app.style.width = ''
    app.style.height = ''
    app.style.overflow = ''
  })
}

describe('Copse Benchmarks', () => {
  it('browses successive runs and safely compares trial traces', async () => {
    await browser.url('/benchmarks/index.html')

    await expect($('h1')).toHaveText('Benchmark runs, with receipts.')
    await expect($('#catalog-status')).toHaveText(expect.stringContaining('2 runs · 5 trials'))
    await expect($$('.run-row')).toBeElementsArrayOfSize(2)
    const terminalRun = $('.run-row[data-run-slug^="terminal-nightly-7-"]')
    await expect(terminalRun).toBeDisplayed()
    await expect(terminalRun.$('.variant-pill')).toHaveText('terminal-bench 2.1')
    await saveAppScreenshot('benchmark-catalog.png')
    await restoreScrollableApp()

    const skillsRun = $('.run-row[data-run-slug^="skills-study-a-"]')
    await skillsRun.$('.run-link').click()
    await expect($('h1')).toHaveText('skills-study-a')
    await expect($$('.group-row')).toBeElementsArrayOfSize(2)
    await expect($('.result-meta')).toHaveText(expect.stringContaining('4/4 trials shown'))

    const productRow = $('.group-row[data-variant="skills-product@1"]')
    await expect(productRow.$('.flag')).toHaveText('1 flagged')
    await productRow.$('.group-toggle').click()
    await expect($$('.trial-row')).toBeElementsArrayOfSize(2)
    await saveAppScreenshot('benchmark-run.png')
    await restoreScrollableApp()

    await $('.trial-row .trial-link').click()
    await expect($('.detail-heading h1')).toHaveText('court-form-filling')
    await expect($('.badge*=low-work')).toBeDisplayed()
    await expect($('.tab[data-tab="trace"]')).toHaveText('Trace · 3 steps')
    await expect($$('.step-card')).toBeElementsArrayOfSize(3)
    await browser.execute(() => window.scrollTo({ top: 0 }))
    await saveAppScreenshot('benchmark-trial.png')
    await restoreScrollableApp()

    await $('.tool-call summary').click()
    const argumentText = await $('.tool-call pre').getText()
    expect(argumentText).toContain('</pre><img src=x onerror=')
    await expect($$('.tool-call img')).toBeElementsArrayOfSize(0)
    expect(await $('body').getAttribute('data-injected')).toBeNull()
    await saveElementScreenshot('.tool-call', 'benchmark-trial-tool-call.png')

    const comparison = $('.compare-panel')
    await comparison.$('summary').click()
    await expect(comparison.$('.compare-grid')).toBeDisplayed()
    await expect(comparison.$('.divergence-note')).toHaveText(
      expect.stringContaining('First message-level divergence'),
    )
    await saveElementScreenshot('.compare-panel', 'benchmark-trial-comparison.png')

    await $('.tab[data-tab="verifier"]').click()
    await expect($('.verifier-grid')).toBeDisplayed()
    await expect($('.verifier-card h3')).toHaveText('Verifier completed')
  })
})
