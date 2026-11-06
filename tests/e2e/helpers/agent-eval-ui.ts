import { $, browser } from '@wdio/globals'

/** Accept through the current Changes UI; a single proposal has no bulk action. */
export async function acceptEvalProposals(projectId: string): Promise<boolean> {
  const threadId = await browser.execute(
    () => document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId'],
  )
  if (!threadId) return false
  const queuedCount = await browser.execute(
    async (owner) => (await window.api.diff.queue(owner.projectId, owner.threadId)).length,
    { projectId, threadId },
  )
  if (queuedCount === 0) return false
  if (!(await $('#git-changes-host').isDisplayed())) {
    await $('.titlebar-btn[aria-label="Open changes"]').click()
  }
  if (queuedCount > 1) {
    const acceptAll = $('#git-changes-host').$('button*=Accept all')
    await acceptAll.waitForDisplayed({ timeout: 10_000 })
    await acceptAll.click()
  } else {
    await $('.git-change-row-proposed').waitForDisplayed({ timeout: 10_000 })
    await $('.git-change-row-proposed').click()
    await $('.diff-accept-btn').waitForDisplayed({ timeout: 10_000 })
    await $('.diff-accept-btn').click()
  }
  return true
}

/** Choose the operator's branch through the same picker a person uses. */
export async function selectEvalBranch(branch: string): Promise<void> {
  await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
  const picker = $('.branch-picker.is-picker-mode')
  await picker.waitForDisplayed({ timeout: 30_000 })
  await picker.$('.branch-picker-trigger').click()
  const menu = picker.$('.branch-picker-menu')
  await menu.waitForDisplayed({ timeout: 10_000 })
  await menu.$('.branch-picker-filter').setValue(branch)
  await browser.waitUntil(
    () =>
      browser.execute(
        (name) =>
          [...document.querySelectorAll('.branch-picker-option-label')].some(
            (label) => label.textContent === name,
          ),
        branch,
      ),
    { timeout: 30_000, timeoutMsg: `The requested eval branch ${branch} was not listed` },
  )
  for (const option of await menu.$$('.branch-picker-option').getElements()) {
    const label = option.$('.branch-picker-option-label')
    if ((await label.isExisting()) && (await label.getText()) === branch) {
      await option.click()
      return
    }
  }
  throw new Error(`Could not select the requested eval branch ${branch}`)
}
