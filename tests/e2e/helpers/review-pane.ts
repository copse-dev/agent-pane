import { $, browser } from '@wdio/globals'

/** Browse local changes and PRs through the same subject picker as the user. */
export async function openReviewPicker(): Promise<void> {
  if (!(await $('.review-header').isDisplayed())) {
    await $('.titlebar-panel-controls [data-panel-control="changes"]').click()
  }
  await $('.review-subject-picker').waitForClickable({ timeout: 20_000 })
  if (!(await $('.review-subject-choices').isDisplayed())) {
    await $('.review-subject-picker').click()
  }
  await $('.review-subject-choices').waitForDisplayed()
}

/** Open the first available PR, matching the former PR pane's default selection. */
export async function openReviewPr(): Promise<void> {
  await openReviewPicker()
  await $('.pr-list-row').waitForClickable({ timeout: 20_000 })
  await $('.pr-list-row').click()
  await $('#pr-viewer-host').waitForDisplayed()
}

export async function closeReviewPicker(): Promise<void> {
  if (await $('.review-subject-choices').isDisplayed()) {
    // Focus the current local/PR choice so Escape dismisses rather than clears
    // a non-empty PR filter.
    await browser.execute(() =>
      document.querySelector<HTMLElement>('.review-local-choice')?.focus(),
    )
    await browser.keys('Escape')
  }
}
